/* Состояние приходит одним снимком (/api/state) и живыми событиями (/ws). */
const $ = (s) => document.querySelector(s);
let STATE = { agents: [], tasks: [], repos: [], missions: [] };
let REPO_FILTER = (() => { try { return localStorage.getItem('ao_repo') || ''; } catch (e) { return ''; } })();   // '' = все
const STATUS_COL = { todo: 'todo', running: 'running', review: 'review', done: 'done', failed: 'done', rejected: 'done' };
const STATUS_RU = { todo: 'в очереди', running: 'в работе', review: 'на ревью', done: 'готово', failed: 'ошибка', rejected: 'отклонено' };
const STATUS_COLOR = { todo: '#8a93a3', running: '#5b8def', review: '#f2c14e', done: '#5acd96', failed: '#f05a46', rejected: '#8a93a3' };

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch {} throw new Error(m); }
  return r.json();
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// мини-markdown: **жирный**, `код`, ```блоки```, списки, абзацы — достаточно для резюме агента
function md(text) {
  let h = esc(text);
  h = h.replace(/```[a-z]*\n([\s\S]*?)```/g, (_, c) => `<pre class="code">${c}</pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/^(?:[-•*]\s.+\n?)+/gm, blk => '<ul>' + blk.trim().split('\n').map(l => `<li>${l.replace(/^[-•*]\s/, '')}</li>`).join('') + '</ul>');
  return h.split(/\n{2,}/).map(p => p.startsWith('<') ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
const summary = (text, n = 150) => { const t = String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).trim() + '…' : t; };
const MAX_AUTO_RETRIES = 3;
const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };
const costLabel = (usd) => usd ? ` · ≈$${usd.toFixed(2)} по API` : '';
const agentTitle = (n) => (STATE.agents.find(a => a.name === n) || { title: n }).title.split('·')[0].trim();
// круглый аватар-портрет агента (лента событий, карточки задач, шапка миссии) — пусто, если у агента нет avatar
const avatarImg = (n, size = 24) => { const a = STATE.agents.find(x => x.name === n); return a && a.avatar ? `<img class="avatar${a.state && a.state !== 'idle' ? ' busy' : ''}" data-agent="${esc(a.name)}" style="--ac:${esc(a.color || '#ff4fa3')}" width="${size}" height="${size}" src="/ui/assets/portraits/${esc(a.avatar)}" alt="">` : ''; };


// Свой диалог вместо системных prompt/confirm/alert (у системных — чужой шрифт и питоновская ракета).
function uiAsk(message, { input = false, placeholder = '', ok = 'OK', cancel = 'Отмена', cancelable = true } = {}) {
  return new Promise((resolve) => {
    const d = document.getElementById('dlg-ask'); if (!d || !d.showModal) { resolve(input ? prompt(message) : confirm(message)); return; }
    const msg = d.querySelector('#ask-msg'), inp = d.querySelector('#ask-input'), bOk = d.querySelector('#ask-ok'), bCancel = d.querySelector('#ask-cancel');
    msg.textContent = message; inp.hidden = !input; inp.value = ''; inp.placeholder = placeholder; bOk.textContent = ok; bCancel.textContent = cancel; bCancel.hidden = !cancelable;
    const done = (v) => { d.close(); bOk.onclick = bCancel.onclick = null; inp.onkeydown = null; d.oncancel = null; resolve(v); };
    bOk.onclick = () => done(input ? inp.value : true);
    bCancel.onclick = () => done(input ? null : false);
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); bOk.click(); } };
    d.oncancel = (e) => { e.preventDefault(); done(input ? null : false); };
    d.showModal(); if (input) inp.focus(); else bOk.focus();
  });
}
const uiPrompt = (message, placeholder = '') => uiAsk(message, { input: true, placeholder });
const uiConfirm = (message) => uiAsk(message, { ok: 'Да', cancel: 'Нет' });
const uiAlert = (message) => uiAsk(message, { ok: 'Понятно', cancelable: false });
window.alert = (m) => { uiAlert(String(m)); };

async function loadState() {
  STATE = await api('/api/state');
  Floor.setAgents(STATE.agents.map(a => ({ ...a })));
  const m = $('#mode'); m.textContent = STATE.mode === 'fake' ? 'режим: имитация агентов' : 'режим: Claude Code';
  m.className = 'mode' + (STATE.mode === 'fake' ? ' fake' : '');
  updateModeBusy();
  renderRepoTabs(); renderMissions(); renderBoard(); fillForm(); syncAgentAvatar(); renderTestsRepoTabs();
}

function renderRepoTabs() {
  const box = $('#repo-tabs'); box.innerHTML = '';
  const mk = (label, val) => { const b = document.createElement('button'); b.textContent = label; b.className = REPO_FILTER === val ? 'on' : ''; b.onclick = () => { REPO_FILTER = val; try { localStorage.setItem('ao_repo', val); } catch (e) {} renderRepoTabs(); renderMissions(); renderBoard(); fillForm(); }; box.appendChild(b); };
  mk('все', '');
  for (const r of STATE.repos) mk(r.split('/').pop(), r);
}
const visibleTask = (t) => !REPO_FILTER || t.repo === REPO_FILTER;
const visibleMission = (m) => !REPO_FILTER || m.repo === REPO_FILTER;

const MISSION_RU = { planning: 'Майкл планирует…', active: 'в работе', done: 'выполнена', failed: 'ошибка' };
function renderMissions() {
  const box = $('#missions'); box.innerHTML = '';
  for (const m of [...STATE.missions].filter(visibleMission).sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const ts = STATE.tasks.filter(t => t.mission_id === m.id); const done = ts.filter(t => t.status === 'done').length;
    const d = document.createElement('div'); d.className = 'mission ' + m.status;
    d.innerHTML = `<div class="g">${avatarImg('michael', 24)}🎯 ${esc(m.goal.slice(0, 90))}</div>
      <div class="s">${MISSION_RU[m.status] || m.status}${m.summary ? ' · ' + esc(m.summary) : ''}${m.error ? ' · ' + esc(m.error) : ''} · ${done}/${ts.length}${m.cost_usd ? ' · $' + m.cost_usd.toFixed(2) : ''}
        <button class="small" style="float:right" data-del="${m.id}">✕</button></div>
      <div class="bar"><i style="width:${ts.length ? Math.round(done / ts.length * 100) : 0}%"></i></div>`;
    d.querySelector('[data-del]').addEventListener('click', async (e) => { e.stopPropagation(); if (!(await uiConfirm('Удалить миссию и все её задачи?'))) return; try { await api(`/api/missions/${m.id}`, 'DELETE'); await loadState(); } catch (err) { alert(err.message); } });
    box.appendChild(d);
  }
}

function renderBoard() {
  const cols = { todo: [], running: [], review: [], done: [] };
  for (const t of STATE.tasks.filter(visibleTask)) cols[STATUS_COL[t.status]].push(t);
  for (const [k, list] of Object.entries(cols)) {
    const col = document.querySelector(`.col[data-col="${k}"]`);
    col.querySelectorAll('.card').forEach(e => e.remove());
    $(`#n-${k}`).textContent = list.length || '';
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (const t of list) {
      const c = document.createElement('div'); c.className = 'card'; c.style.borderLeftColor = STATUS_COLOR[t.status];
      const waiting = t.status === 'todo' && t.depends_on.some(d => (STATE.tasks.find(x => x.id === d) || {}).status !== 'done');
      const depNames = t.depends_on.map(d => (STATE.tasks.find(x => x.id === d) || { title: d }).title);
      c.innerHTML = `<div class="t">${t.mission_id ? '🎯 ' : ''}${esc(t.title)}</div>
        <div class="m">${avatarImg(t.agent, 16)}${esc(agentTitle(t.agent))} · ${STATUS_RU[t.status]} · ${esc(t.repo.split('/').pop())}${costLabel(t.cost_usd)}</div>
        ${waiting ? `<div class="dep">⏳ ждёт: ${esc(depNames.join(', '))}</div>` : ''}
        ${t.status === 'review' && t.overlap_files && t.overlap_files.length ? `<div class="dep">⚠️ отстала от main на ${t.behind_main}, пересекается: ${esc(t.overlap_files.slice(0, 3).join(', '))}</div>` : (t.status === 'review' && t.behind_main ? `<div class="m">↻ main ушёл вперёд на ${t.behind_main}, файлы не пересекаются</div>` : '')}
        ${t.result && t.status !== 'todo' ? `<div class="res">💬 ${esc(summary(t.result))}</div>` : ''}
        ${t.diff_stat && t.status === 'review' ? `<div class="m">${esc(t.diff_stat.trim().split('\n').pop())}</div>` : ''}
        ${t.status === 'failed' && t.error ? `<div class="dep">⚠️ ${esc(summary(t.error, 200))}</div>` : ''}
        ${t.status === 'failed' && t.auto_retry_at ? `<div class="m">🔁 автоповтор ${t.auto_retries}/${MAX_AUTO_RETRIES} в ${fmtTime(t.auto_retry_at)}</div>` : ''}
        ${t.status === 'review' ? `<div class="actions"><button class="small ok" data-act="approve">Одобрить</button><button class="small" data-act="reject">Отклонить</button></div>` : ''}
        ${(t.status === 'rejected' || t.status === 'failed') ? `<div class="actions"><button class="small" data-act="retry">Повторить</button><button class="small" data-act="delete">Удалить</button></div>` : ''}
        ${t.status === 'done' ? `<div class="actions"><button class="small" data-act="delete">Убрать</button></div>` : ''}`;
      c.addEventListener('click', (e) => { const act = e.target.dataset.act; if (act) { e.stopPropagation(); action(t, act); } else openTask(t.id); });
      col.appendChild(c);
    }
  }
}

async function action(t, act) {
  try {
    if (act === 'approve') { await api(`/api/tasks/${t.id}/approve`, 'POST'); }
    if (act === 'reject') { const text = (await uiPrompt('Почему отклоняешь? (пойдёт агенту при повторе)')) ?? ''; await api(`/api/tasks/${t.id}/reject`, 'POST', { text }); }
    if (act === 'retry') { const text = (await uiPrompt('Уточнение для агента (можно пусто)')) ?? ''; await api(`/api/tasks/${t.id}/retry`, 'POST', { text }); }
    if (act === 'delete') { await api(`/api/tasks/${t.id}`, 'DELETE'); }
    await loadState(); $('#dlg-task').close();
  } catch (e) { alert(e.message); }
}

function colorDiff(d) {
  return esc(d).split('\n').map(l => {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')) return `<span class="file">${l}</span>`;
    if (l.startsWith('@@')) return `<span class="hunk">${l}</span>`;
    if (l.startsWith('+')) return `<span class="add">${l}</span>`;
    if (l.startsWith('-')) return `<span class="del">${l}</span>`;
    return l;
  }).join('\n');
}

async function openTask(id) {
  const t = STATE.tasks.find(x => x.id === id); if (!t) return;
  $('#t-title').textContent = t.title;
  const body = $('#t-body');
  body.innerHTML = `<span class="tag">${esc(agentTitle(t.agent))}</span><span class="tag">${STATUS_RU[t.status]}</span><span class="tag">${esc(t.repo)}</span>${t.branch ? `<span class="tag">${esc(t.branch)}</span>` : ''}
    <label>Описание</label><div class="log" style="color:#d7dce3">${esc(t.prompt)}</div>
    ${t.status === 'failed' && t.error ? `<label>Причина</label><div class="log">⚠️ ${esc(t.error)}</div>` : ''}
    ${t.status === 'failed' && t.auto_retry_at ? `<div class="log">🔁 автоповтор ${t.auto_retries}/${MAX_AUTO_RETRIES} в ${fmtTime(t.auto_retry_at)}</div>` : ''}
    ${t.result ? `<label>Ответ агента</label><div class="answer">${md(t.result)}</div>` : ''}
    ${t.cost_usd ? `<div class="log">Расход: ≈$${t.cost_usd.toFixed(2)} по тарифу API · ${t.turns} ходов · подписка Max, деньги не списываются</div>` : ''}
    ${t.diff_stat ? `<label>Изменения</label><div class="log">${esc(t.diff_stat)}</div>` : ''}
    <div id="t-diff"></div>
    <label>Терминал агента ${t.status === 'running' ? '· live' : ''}</label><div class="term" id="t-term"></div>
    <label>Хроника</label><div class="log">${esc(t.log.join('\n'))}</div>
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end" id="t-actions"></div>`;
  const acts = $('#t-actions');
  if (t.status === 'review') acts.innerHTML = `<button onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'reject')">Отклонить</button><button class="ok" onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'approve')">Одобрить и влить в main</button>`;
  if (t.status === 'rejected' || t.status === 'failed') acts.innerHTML = `<button onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'retry')">Повторить с уточнением</button>`;
  $('#dlg-task').showModal();
  OPEN_TASK = t.id;
  const evs = await api(`/api/tasks/${t.id}/events`);
  const termBox = $('#t-term'); termBox.innerHTML = '';
  for (const ev of evs) termAppend(termBox, ev);
  termBox.scrollTop = termBox.scrollHeight;
  if (t.branch && (t.status === 'review' || t.status === 'failed')) {
    const { diff } = await api(`/api/tasks/${t.id}/diff`);
    $('#t-diff').innerHTML = `<label>Diff к main</label><pre class="diff">${diff ? colorDiff(diff) : '(пусто)'}</pre>`;
  }
}

let OPEN_TASK = null;
$('#dlg-task').addEventListener('close', () => { OPEN_TASK = null; });
function termAppend(box, ev) {
  let cls, text;
  if (ev.kind === 'agent.tool') { cls = 'tool'; text = '⚙ ' + ev.data.summary; }
  else if (ev.kind === 'agent.text') { cls = 'text'; text = ev.data.text; }
  else if (ev.kind === 'agent.state') { cls = 'state'; text = '■ ' + ev.data.state; }
  else if (ev.kind === 'run.output') { cls = 'text'; text = ev.data.line; }
  else if (ev.kind === 'run.state') { cls = 'state'; text = '■ ' + ev.data.state; }
  else return;
  const d = document.createElement('div'); d.className = 'line ' + cls;
  d.textContent = text; box.appendChild(d);
  while (box.children.length > 400) box.firstChild.remove();
}

function fillForm() {
  $('#f-agent').innerHTML = STATE.agents.map(a => `<option value="${a.name}">${esc(a.title)}</option>`).join('');
  const opts = STATE.repos.map(r => `<option value="${esc(r)}">${esc(r.replace(/^\/Users\/[^/]+/, '~'))}</option>`).join('');
  $('#f-repo').innerHTML = opts; $('#m-repo').innerHTML = opts;
  if (REPO_FILTER) { $('#f-repo').value = REPO_FILTER; $('#m-repo').value = REPO_FILTER; }
}

$('#btn-new').addEventListener('click', () => { $('#dlg-new').showModal(); syncAgentAvatar(); });
$('#f-submit').addEventListener('click', async () => {
  try {
    await api('/api/tasks', 'POST', { title: $('#f-title').value, prompt: $('#f-prompt').value, repo: $('#f-repo').value, agent: $('#f-agent').value });
    $('#f-title').value = ''; $('#f-prompt').value = ''; $('#dlg-new').close(); await loadState();
  } catch (e) { alert(e.message); }
});
$('#btn-mission').addEventListener('click', () => $('#dlg-mission').showModal());
$('#m-submit').addEventListener('click', async () => {
  try {
    await api('/api/missions', 'POST', { goal: $('#m-goal').value, repo: $('#m-repo').value });
    $('#m-goal').value = ''; $('#dlg-mission').close(); await loadState();
  } catch (e) { alert(e.message); }
});
$('#btn-repo').addEventListener('click', async () => {
  const path = await uiPrompt('Путь к git-репозиторию', '~/PycharmProjects/bike_fit'); if (!path) return;
  try { await api('/api/repos', 'POST', { path }); await loadState(); } catch (e) { alert(e.message); }
});

// ---- лента + события
const term = $('#term');
function termLine(cls, who, text, agent) {
  const d = document.createElement('div'); d.className = 'line ' + cls;
  d.innerHTML = `${agent ? avatarImg(agent, 18) : ''}<span class="who">${esc(who)}</span>${esc(text)}`;
  term.appendChild(d); while (term.children.length > 300) term.firstChild.remove();
  term.scrollTop = term.scrollHeight;
}
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onmessage = (m) => {
    const ev = JSON.parse(m.data); const who = ev.agent ? agentTitle(ev.agent) : 'офис';
    if (OPEN_TASK && ev.task_id === OPEN_TASK) { const box = $('#t-term'); if (box) { termAppend(box, ev); box.scrollTop = box.scrollHeight; } }
    if (ev.kind === 'agent.tool') termLine('tool', who, '⚙ ' + ev.data.summary, ev.agent);
    else if (ev.kind === 'agent.text') termLine('text', who, ev.data.text, ev.agent);
    else if (ev.kind === 'agent.state') { const ag = STATE.agents.find(a => a.name === ev.agent); if (ag) ag.state = ev.data.state; updateModeBusy(); Floor.setState(ev.agent, ev.data.state); termLine('state', who, { working: '▶ взял задачу', planning: '🧭 планирует миссию', idle: '■ свободен' }[ev.data.state] || ev.data.state, ev.agent); }
    else if (ev.kind === 'mission.created' || ev.kind === 'mission.updated') { termLine('state', 'офис', `🎯 миссия ${MISSION_RU[ev.data.mission.status] || ev.data.mission.status}: ${ev.data.mission.goal.slice(0, 80)}`, 'michael'); loadState(); }
    else if (ev.kind === 'task.created') { Floor.envelope('in', ev.agent); termLine('state', 'ты', '✉ задача: ' + ev.data.task.title, ev.agent); loadState(); }
    else if (ev.kind === 'task.updated') {
      const t = ev.data.task; if (t.status === 'review') { Floor.envelope('out', ev.agent); Floor.setState(ev.agent, 'review'); setTimeout(() => Floor.setState(ev.agent, 'idle'), 4000); }
      if (t.status === 'done') { Floor.envelope('banana', ev.agent); Floor.setState(ev.agent, 'done'); setTimeout(() => Floor.setState(ev.agent, 'idle'), 4000); }
      if (t.status === 'failed') { Floor.setState(ev.agent, 'failed'); setTimeout(() => Floor.setState(ev.agent, 'idle'), 4000); }
      termLine('state', who, `→ ${STATUS_RU[t.status]}: ${t.title}`, ev.agent);
      if ((t.status === 'review' || t.status === 'failed') && t.result) termLine('text', who, '💬 ' + summary(t.result, 400), ev.agent);
      loadState();
    }
    else if (ev.kind.startsWith('run.')) {
      if (ev.task_id === CURRENT_RUN) {
        const box = $('#tests-run-log'); if (box) { termAppend(box, ev); box.scrollTop = box.scrollHeight; }
        if (ev.kind === 'run.state') {
          const label = $('#tests-run-live-label'); if (label) label.textContent = (CURRENT_RUN_TARGET || 'весь набор') + ' · ' + (RUN_STATUS_RU[ev.data.state] || ev.data.state);
        }
      }
      if (ev.kind === 'run.state' && ev.data.state !== 'running' && TESTS_REPO) loadTestsRuns();
    }
    else if (ev.kind === 'scenario.recorded') {
      if (ev.data.error) alert('Запись сценария: ' + ev.data.error);
      else termLine('state', 'офис', '🎬 сценарий записан: ' + ev.data.name);
      if (isBikeFit(TESTS_REPO)) loadScenarios();
    }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
loadState().then(() => { connect(); initView(); });


// ---- тесты
let TESTS_REPO = (() => { try { return localStorage.getItem('ao_tests_repo') || ''; } catch (e) { return ''; } })();
const isBikeFit = (repo) => !!repo && repo.split('/').pop() === 'bike_fit';
let CURRENT_RUN = null;
let CURRENT_RUN_TARGET = null;
const RUN_STATUS_RU = { running: 'выполняется', passed: 'пройдено', failed: 'провалено', error: 'ошибка' };
const RUN_STATUS_COLOR = { running: '#5b8def', passed: '#5acd96', failed: '#f05a46', error: '#f05a46' };

function switchView(view) {
  document.body.dataset.view = view;
  try { localStorage.setItem('ao_view', view); } catch (e) {}
  document.querySelectorAll('#view-switch button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'tests') {
    if (!TESTS_REPO || !STATE.repos.includes(TESTS_REPO)) TESTS_REPO = STATE.repos[0] || '';
    renderTestsRepoTabs(); loadTestsTree(); loadTestsRuns(); updateScenariosPanel();
  }
}
function initView() {
  let view = 'office'; try { view = localStorage.getItem('ao_view') || 'office'; } catch (e) {}
  switchView(view);
}
document.querySelectorAll('#view-switch button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

function renderTestsRepoTabs() {
  const box = $('#tests-repo-tabs'); box.innerHTML = '';
  for (const r of STATE.repos) {
    const b = document.createElement('button'); b.textContent = r.split('/').pop();
    b.className = TESTS_REPO === r ? 'on' : '';
    b.onclick = () => { TESTS_REPO = r; try { localStorage.setItem('ao_tests_repo', r); } catch (e) {} renderTestsRepoTabs(); loadTestsTree(); loadTestsRuns(); updateScenariosPanel(); $('#tests-run-live').hidden = true; };
    box.appendChild(b);
  }
}

async function loadTestsTree() {
  const box = $('#tests-tree');
  if (!TESTS_REPO) { box.innerHTML = '<div class="log">Нет ни одного репозитория.</div>'; return; }
  box.innerHTML = '<div class="log">Загрузка…</div>';
  try { renderTestsTree(await api('/api/tests?repo=' + encodeURIComponent(TESTS_REPO))); }
  catch (e) { box.innerHTML = `<div class="log" style="color:var(--accent)">${esc(e.message)}</div>`; }
}

function renderTestsTree(tree) {
  const box = $('#tests-tree'); box.innerHTML = '';
  if (tree.error) { box.innerHTML = `<div class="log" style="color:var(--accent)">${esc(tree.error)}</div>`; return; }
  const files = Object.keys(tree.tree || {}).sort();
  if (!files.length) { box.innerHTML = '<div class="log">Тесты не найдены.</div>'; return; }
  for (const file of files) {
    const g = document.createElement('div'); g.className = 'test-file';
    g.innerHTML = `<div class="test-file-head"><button class="small" data-run="${esc(file)}">▶ файл</button><span>${esc(file)}</span></div>`;
    const list = document.createElement('div'); list.className = 'test-list';
    for (const name of tree.tree[file]) {
      const row = document.createElement('div'); row.className = 'test-row';
      row.innerHTML = `<button class="small" data-run="${esc(file)}::${esc(name)}">▶</button><span>${esc(name)}</span>`;
      list.appendChild(row);
    }
    g.appendChild(list); box.appendChild(g);
  }
  box.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runTests(b.dataset.run)));
}

async function runTests(target) {
  if (!TESTS_REPO) return;
  try {
    const { run_id } = await api('/api/tests/run', 'POST', { repo: TESTS_REPO, target: target || null });
    openLiveRun(run_id, target || null);
  } catch (e) { alert(e.message); }
}

function openLiveRun(run_id, target) {
  CURRENT_RUN = run_id; CURRENT_RUN_TARGET = target;
  $('#tests-run-live').hidden = false;
  $('#tests-run-live-label').textContent = (target || 'весь набор') + ' · выполняется';
  $('#tests-run-log').innerHTML = '';
}

async function loadTestsRuns() {
  if (!TESTS_REPO) { $('#tests-runs').innerHTML = ''; return; }
  try { renderTestsRuns(await api('/api/tests/runs?repo=' + encodeURIComponent(TESTS_REPO))); }
  catch (e) { $('#tests-runs').innerHTML = `<div class="log" style="color:var(--accent)">${esc(e.message)}</div>`; }
}

function renderTestsRuns(runs) {
  const box = $('#tests-runs'); box.innerHTML = '';
  if (!runs.length) { box.innerHTML = '<div class="log">Прогонов ещё не было.</div>'; return; }
  for (const r of runs) {
    const d = document.createElement('div'); d.className = 'run-row'; d.style.borderLeftColor = RUN_STATUS_COLOR[r.status] || 'var(--mute)';
    d.innerHTML = `<div class="t"><span>${esc(r.target || 'весь набор')}</span><button class="small" data-report="${esc(r.id)}">📊 Отчёт</button></div>
      <div class="m">${esc(r.started_at)} · ${RUN_STATUS_RU[r.status] || r.status}${r.duration ? ' · ' + r.duration.toFixed(1) + 'с' : ''}</div>`;
    d.querySelector('[data-report]').addEventListener('click', (e) => { e.stopPropagation(); openReport(r.id, r.repo || TESTS_REPO); });
    d.addEventListener('click', () => openRunDetail(r.id));
    box.appendChild(d);
  }
}

async function openRunDetail(run_id) {
  let r; try { r = await api(`/api/tests/runs/${run_id}`); } catch (e) { alert(e.message); return; }
  $('#run-title').textContent = r.target || 'весь набор';
  const out = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
  $('#run-body').innerHTML = `<span class="tag">${esc(r.repo.split('/').pop())}</span><span class="tag" style="border-color:${RUN_STATUS_COLOR[r.status] || 'var(--line)'};color:${RUN_STATUS_COLOR[r.status] || 'var(--mute)'}">${esc(RUN_STATUS_RU[r.status] || r.status)}</span><span class="tag">${esc(r.command)}</span>
    <label>Время</label><div class="log">${esc(r.started_at)}${r.finished_at ? ' → ' + esc(r.finished_at) : ''}${r.duration ? ' · ' + r.duration.toFixed(1) + 'с' : ''}</div>
    ${r.failed && r.failed.length ? `<label>Провалившиеся тесты</label><div class="log" style="color:var(--accent)">${esc(r.failed.join('\n'))}</div>` : ''}
    ${r.screenshot ? `<label>Скриншот падения</label><img class="screenshot" src="/api/scenarios/screenshot/${encodeURIComponent(r.id)}/${encodeURIComponent(r.screenshot)}">` : ''}
    <details ${r.status === 'failed' || r.status === 'error' ? 'open' : ''}><summary>Трейсбек / вывод (stdout/stderr)</summary><pre class="diff">${esc(out) || '(пусто)'}</pre></details>
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end"><button class="primary" id="run-retry">↻ Повторить</button></div>`;
  $('#run-retry').addEventListener('click', async () => {
    $('#dlg-run').close();
    if (r.repo !== TESTS_REPO) { TESTS_REPO = r.repo; try { localStorage.setItem('ao_tests_repo', r.repo); } catch (e) {} renderTestsRepoTabs(); loadTestsTree(); updateScenariosPanel(); }
    if (r.target && r.target.includes('/tests/bike_fit/scenarios/')) await runScenario(r.target.split('/').pop());
    else await runTests(r.target);
  });
  $('#dlg-run').showModal();
}

$('#btn-tests-refresh').addEventListener('click', loadTestsTree);
$('#btn-tests-run-all').addEventListener('click', () => runTests(null));

// ---- отчёт по прогону (Allure-style)
const STATUS_COLORS = { passed: '#5acd96', failed: '#f05a46', broken: '#f2c14e', skipped: '#8a93a3', unknown: '#8a93a3' };
const STATUS_RU_ALLURE = { passed: 'пройдено', failed: 'провалено', broken: 'сломано', skipped: 'пропущено', unknown: 'неизвестно' };
let REPORT = null;
let REPORT_FILTER = new Set(['passed', 'failed', 'broken', 'skipped', 'unknown']);
let REPORT_SEARCH = '';

function donutSvg(counts) {
  const order = ['passed', 'failed', 'broken', 'skipped', 'unknown'];
  const total = order.reduce((s, k) => s + (counts[k] || 0), 0);
  const R = 42, C = 2 * Math.PI * R;
  if (!total) return `<svg viewBox="0 0 120 120" width="120" height="120"><circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--line)" stroke-width="16"></circle></svg>`;
  let offset = 0;
  const arcs = order.filter(k => counts[k]).map(k => {
    const dash = (counts[k] / total) * C;
    const el = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${STATUS_COLORS[k]}" stroke-width="16" stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)"><title>${STATUS_RU_ALLURE[k]}: ${counts[k]}</title></circle>`;
    offset += dash; return el;
  }).join('');
  return `<svg viewBox="0 0 120 120" width="120" height="120">${arcs}<text x="60" y="66" text-anchor="middle" font-size="20" fill="var(--text)">${total}</text></svg>`;
}

function trendSvg(trend) {
  if (!trend.length) return '<div class="log">Прогонов ещё не было.</div>';
  const W = Math.max(240, trend.length * 26), H = 90, PAD = 6;
  const bw = (W - PAD * 2) / trend.length;
  const maxDur = Math.max(...trend.map(r => r.duration || 0), 0.001);
  const bars = trend.map((r, i) => {
    const h = Math.max(2, r.pass_rate * (H - PAD * 2));
    const x = PAD + i * bw, y = H - PAD - h;
    const color = STATUS_COLORS[r.status] || RUN_STATUS_COLOR[r.status] || 'var(--mute)';
    return `<rect x="${x + 2}" y="${y}" width="${Math.max(1, bw - 4)}" height="${h}" fill="${color}"><title>${esc(r.started_at)} · ${Math.round(r.pass_rate * 100)}% passed</title></rect>`;
  }).join('');
  const pt = (i, r) => `${PAD + i * bw + bw / 2},${H - PAD - ((r.duration || 0) / maxDur) * (H - PAD * 2)}`;
  const pts = trend.map((r, i) => pt(i, r)).join(' ');
  const dots = trend.map((r, i) => { const [x, y] = pt(i, r).split(','); return `<circle cx="${x}" cy="${y}" r="2.5" fill="var(--blue)"><title>${esc(r.started_at)} · ${(r.duration || 0).toFixed(1)}с</title></circle>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}<polyline points="${pts}" fill="none" stroke="var(--blue)" stroke-width="2"></polyline>${dots}</svg>`;
}

function renderReportCounts() {
  $('#report-counts').innerHTML = ['passed', 'failed', 'broken', 'skipped'].map(k =>
    `<div class="report-chip" style="border-color:${STATUS_COLORS[k]};color:${STATUS_COLORS[k]}">${STATUS_RU_ALLURE[k]}: ${REPORT.counts[k] || 0}</div>`
  ).join('');
}

function renderReportFilters() {
  const box = $('#report-filters'); box.innerHTML = '';
  for (const k of ['passed', 'failed', 'broken', 'skipped', 'unknown']) {
    const n = REPORT.counts[k] || 0;
    if (!n && k === 'unknown') continue;
    const on = REPORT_FILTER.has(k);
    const b = document.createElement('button'); b.className = 'small' + (on ? ' on' : '');
    b.style.borderColor = STATUS_COLORS[k];
    if (on) { b.style.background = STATUS_COLORS[k]; b.style.color = '#0b0616'; }
    b.textContent = `${STATUS_RU_ALLURE[k]} (${n})`;
    b.addEventListener('click', () => { if (REPORT_FILTER.has(k)) REPORT_FILTER.delete(k); else REPORT_FILTER.add(k); renderReportFilters(); renderReportTable(); });
    box.appendChild(b);
  }
}

function renderStepsHtml(steps) {
  if (!steps || !steps.length) return '';
  return `<ul class="steps">${steps.map(s => `<li><span class="status-dot" style="background:${STATUS_COLORS[s.status] || 'var(--mute)'}"></span>${esc(s.name)}${renderStepsHtml(s.steps)}</li>`).join('')}</ul>`;
}

function attachmentHtml(runId, a) {
  const url = `/api/tests/attachments/${encodeURIComponent(runId)}/${encodeURIComponent(a.source)}`;
  if ((a.type || '').startsWith('image/')) return `<img class="screenshot" src="${url}" alt="${esc(a.name)}">`;
  return `<div><a href="${url}" target="_blank" rel="noopener">📎 ${esc(a.name || a.source)}</a></div>`;
}

function toggleReportDetail(tr, t) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('report-detail')) { next.remove(); return; }
  document.querySelectorAll('.report-detail').forEach(e => e.remove());
  const d = document.createElement('tr'); d.className = 'report-detail';
  d.innerHTML = `<td colspan="5">${renderStepsHtml(t.steps)}
    ${t.message ? `<label>Сообщение</label><div class="log" style="color:var(--accent)">${esc(t.message)}</div>` : ''}
    ${t.trace ? `<details open><summary>Трейсбек</summary><pre class="diff">${esc(t.trace)}</pre></details>` : ''}
    ${t.attachments && t.attachments.length ? `<label>Вложения</label><div class="attachments">${t.attachments.map(a => attachmentHtml(REPORT.run_id, a)).join('')}</div>` : ''}
    ${!t.steps.length && !t.message && !t.trace && !(t.attachments && t.attachments.length) ? '<div class="log">Подробностей нет.</div>' : ''}</td>`;
  tr.after(d);
}

function renderReportTable() {
  const tbody = $('#report-table-body'); tbody.innerHTML = '';
  const q = REPORT_SEARCH.toLowerCase();
  const rows = (REPORT.tests || []).filter(t => REPORT_FILTER.has(t.status) &&
    (!q || (t.name + ' ' + t.suite + ' ' + t.file).toLowerCase().includes(q)));
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" class="log">Ничего не найдено.</td></tr>'; return; }
  for (const t of rows) {
    const row = document.createElement('tr'); row.className = 'report-row';
    row.innerHTML = `<td>${esc(t.name)}</td><td>${esc(t.suite || '')}</td><td>${esc(t.file || '')}</td>
      <td>${t.duration != null ? t.duration.toFixed(2) + 'с' : '—'}</td>
      <td><span class="status-pill" style="background:${STATUS_COLORS[t.status] || 'var(--mute)'}">${STATUS_RU_ALLURE[t.status] || t.status}</span></td>`;
    row.addEventListener('click', () => toggleReportDetail(row, t));
    tbody.appendChild(row);
  }
}

async function openReport(runId, repo) {
  let report; try { report = await api(`/api/tests/report?repo=${encodeURIComponent(repo)}&run_id=${encodeURIComponent(runId)}`); }
  catch (e) { alert(e.message); return; }
  REPORT = report; REPORT_FILTER = new Set(['passed', 'failed', 'broken', 'skipped', 'unknown']); REPORT_SEARCH = '';
  $('#report-search').value = '';
  $('#report-title').textContent = 'Отчёт: ' + (report.target || 'весь набор');
  $('#report-meta').innerHTML = `<span class="tag">${esc(repo.split('/').pop())}</span>
    <span class="tag" style="border-color:${RUN_STATUS_COLOR[report.status] || 'var(--line)'};color:${RUN_STATUS_COLOR[report.status] || 'var(--mute)'}">${esc(RUN_STATUS_RU[report.status] || report.status)}</span>
    ${report.duration ? `<span class="tag">${report.duration.toFixed(1)}с</span>` : ''}
    ${report.source === 'fallback' ? `<span class="tag" style="color:var(--warn);border-color:var(--warn)">без Allure${report.allure_error ? ': ' + esc(report.allure_error) : ''}</span>` : ''}`;
  $('#report-donut').innerHTML = donutSvg(report.counts);
  renderReportCounts();
  renderReportFilters();
  renderReportTable();
  $('#btn-open-allure').hidden = true;
  $('#report-trend').innerHTML = '<div class="log">Загрузка тренда…</div>';
  $('#dlg-report').showModal();
  try {
    const trend = await api(`/api/tests/trend?repo=${encodeURIComponent(repo)}&limit=20`);
    $('#report-trend').innerHTML = trendSvg(trend);
  } catch (e) { $('#report-trend').innerHTML = `<div class="log" style="color:var(--accent)">${esc(e.message)}</div>`; }
  try {
    const { available } = await api(`/api/tests/allure-available?repo=${encodeURIComponent(repo)}&run_id=${encodeURIComponent(runId)}`);
    $('#btn-open-allure').hidden = !available;
  } catch (e) {}
}

$('#report-search').addEventListener('input', (e) => { REPORT_SEARCH = e.target.value; if (REPORT) renderReportTable(); });
$('#btn-open-allure').addEventListener('click', async () => {
  if (!REPORT) return;
  try { await api('/api/tests/allure-open', 'POST', { repo: REPORT.repo, run_id: REPORT.run_id }); }
  catch (e) { alert(e.message); }
});

// ---- сценарии bike_fit (Playwright)
function updateScenariosPanel() {
  const show = isBikeFit(TESTS_REPO);
  $('#scenarios-panel').hidden = !show;
  if (show) loadScenarios();
}

async function loadScenarios() {
  const box = $('#scenarios-list');
  if (!isBikeFit(TESTS_REPO)) return;
  box.innerHTML = '<div class="log">Загрузка…</div>';
  try { renderScenarios((await api('/api/scenarios?repo=' + encodeURIComponent(TESTS_REPO))).scenarios); }
  catch (e) { box.innerHTML = `<div class="log" style="color:var(--accent)">${esc(e.message)}</div>`; }
}

function renderScenarios(names) {
  const box = $('#scenarios-list'); box.innerHTML = '';
  if (!names.length) { box.innerHTML = '<div class="log">Сценариев ещё нет — запиши первый.</div>'; return; }
  for (const name of names) {
    const row = document.createElement('div'); row.className = 'test-row';
    row.innerHTML = `<button class="small" data-run="${esc(name)}">▶</button><span>${esc(name)}</span>`;
    box.appendChild(row);
  }
  box.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runScenario(b.dataset.run)));
}

async function runScenario(name) {
  if (!isBikeFit(TESTS_REPO)) return;
  try {
    const { run_id } = await api('/api/scenarios/run', 'POST', { repo: TESTS_REPO, name });
    openLiveRun(run_id, name);
  } catch (e) { alert(e.message); }
}

$('#btn-scenarios-refresh').addEventListener('click', loadScenarios);
$('#btn-scenario-record').addEventListener('click', async () => {
  if (!isBikeFit(TESTS_REPO)) return;
  try {
    await api('/api/scenarios/record', 'POST', { repo: TESTS_REPO });
    alert('Идёт запись сценария — в отдельном окне открылся браузер. Кликай по bike_fit как обычный пользователь, затем закрой это окно, когда закончишь.');
  } catch (e) { alert(e.message); }
});


// ---- темы
const THEMES = {
  arcade:    { floor1: '#1a1030', floor2: '#170d2b', wall: '#2a1650', wallLine: '#3b2070', win: '#5a2d9a', winLite: '#ff3f8f', desk: '#3b2070', deskTop: '#2a1650', text: '#f3e9ff', mute: '#a78bd6', tray: '#ff3f8f', tray2: '#ffe135' },
  gameboy:   { floor1: '#9bbc0f', floor2: '#8bac0f', wall: '#306230', wallLine: '#0f380f', win: '#8bac0f', winLite: '#9bbc0f', desk: '#0f380f', deskTop: '#306230', text: '#0f380f', mute: '#306230', tray: '#0f380f', tray2: '#0f380f' },
  cyberpunk: { floor1: '#0d1226', floor2: '#0a0f1f', wall: '#101a3a', wallLine: '#1f3a66', win: '#1f3a66', winLite: '#35f0ff', desk: '#1f3a66', deskTop: '#142a4d', text: '#d9f7ff', mute: '#6fa8c9', tray: '#ff2fd0', tray2: '#35f0ff' },
};
function applyTheme(name) {
  if (!THEMES[name]) name = 'arcade';
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('ao_theme', name); } catch (e) {}
  document.querySelectorAll('#themes button').forEach(b => b.classList.toggle('on', b.dataset.theme === name));
  if (window.Floor && Floor.setTheme) Floor.setTheme(THEMES[name], name);
}
document.querySelectorAll('#themes button').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
applyTheme((() => { try { return localStorage.getItem('ao_theme'); } catch (e) { return null; } })() || 'arcade');

// Прототип выбора фона этажа: картинка из ui/assets поверх которой рисуется сцена.
(function () {
  const sel = document.getElementById('bg'); if (!sel) return;
  let saved = ''; try { saved = localStorage.getItem('ao_bg') || ''; } catch (e) {}
  sel.value = saved; if (window.Floor) Floor.setBackground(saved || null);
  sel.addEventListener('change', () => { try { localStorage.setItem('ao_bg', sel.value); } catch (e) {} Floor.setBackground(sel.value || null); });
})();

// Кнопка режима светится, пока хоть один сотрудник работает или планирует.
function updateModeBusy() {
  const m = document.getElementById('mode'); if (!m) return;
  const busy = (STATE.agents || []).some(a => a.state && a.state !== 'idle');
  m.classList.toggle('busy', busy);
  const n = (STATE.agents || []).filter(a => a.state && a.state !== 'idle').length;
  m.title = busy ? `работают: ${n}` : 'все свободны';
  // портреты в ленте и на карточках светятся цветом агента, пока он работает
  for (const a of (STATE.agents || [])) document.querySelectorAll(`.avatar[data-agent="${a.name}"]`).forEach(el => el.classList.toggle('busy', !!a.state && a.state !== 'idle'));
}

// Аватар выбранного агента в окне новой задачи.
function syncAgentAvatar() {
  const sel = document.getElementById('f-agent'), img = document.getElementById('f-agent-avatar'); if (!sel || !img) return;
  const a = (STATE.agents || []).find(x => x.name === sel.value);
  if (a && a.avatar) { img.src = '/ui/assets/portraits/' + a.avatar; img.hidden = false; } else img.hidden = true;
}
document.getElementById('f-agent')?.addEventListener('change', syncAgentAvatar);
