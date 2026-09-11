/* Состояние приходит одним снимком (/api/state) и живыми событиями (/ws). */
const $ = (s) => document.querySelector(s);
let STATE = { agents: [], tasks: [], repos: [], missions: [] };
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
const costLabel = (usd) => usd ? ` · ≈$${usd.toFixed(2)} по API` : '';
const agentTitle = (n) => (STATE.agents.find(a => a.name === n) || { title: n }).title.split('·')[0].trim();

async function loadState() {
  STATE = await api('/api/state');
  Floor.setAgents(STATE.agents.map(a => ({ ...a })));
  const m = $('#mode'); m.textContent = STATE.mode === 'fake' ? 'режим: имитация агентов' : 'режим: Claude Code';
  m.className = 'mode' + (STATE.mode === 'fake' ? ' fake' : '');
  renderMissions(); renderBoard(); fillForm();
}

const MISSION_RU = { planning: 'Майкл планирует…', active: 'в работе', done: 'выполнена', failed: 'ошибка' };
function renderMissions() {
  const box = $('#missions'); box.innerHTML = '';
  for (const m of [...STATE.missions].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const ts = STATE.tasks.filter(t => t.mission_id === m.id); const done = ts.filter(t => t.status === 'done').length;
    const d = document.createElement('div'); d.className = 'mission ' + m.status;
    d.innerHTML = `<div class="g">🎯 ${esc(m.goal.slice(0, 90))}</div>
      <div class="s">${MISSION_RU[m.status] || m.status}${m.summary ? ' · ' + esc(m.summary) : ''}${m.error ? ' · ' + esc(m.error) : ''} · ${done}/${ts.length}${m.cost_usd ? ' · $' + m.cost_usd.toFixed(2) : ''}
        <button class="small" style="float:right" data-del="${m.id}">✕</button></div>
      <div class="bar"><i style="width:${ts.length ? Math.round(done / ts.length * 100) : 0}%"></i></div>`;
    d.querySelector('[data-del]').addEventListener('click', async (e) => { e.stopPropagation(); if (!confirm('Удалить миссию и все её задачи?')) return; try { await api(`/api/missions/${m.id}`, 'DELETE'); await loadState(); } catch (err) { alert(err.message); } });
    box.appendChild(d);
  }
}

function renderBoard() {
  const cols = { todo: [], running: [], review: [], done: [] };
  for (const t of STATE.tasks) cols[STATUS_COL[t.status]].push(t);
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
        <div class="m">${esc(agentTitle(t.agent))} · ${STATUS_RU[t.status]} · ${esc(t.repo.split('/').pop())}${costLabel(t.cost_usd)}</div>
        ${waiting ? `<div class="dep">⏳ ждёт: ${esc(depNames.join(', '))}</div>` : ''}
        ${t.result && t.status !== 'todo' ? `<div class="res">💬 ${esc(summary(t.result))}</div>` : ''}
        ${t.diff_stat && t.status === 'review' ? `<div class="m">${esc(t.diff_stat.trim().split('\n').pop())}</div>` : ''}
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
    if (act === 'reject') { const text = prompt('Почему отклоняешь? (пойдёт агенту при повторе)') ?? ''; await api(`/api/tasks/${t.id}/reject`, 'POST', { text }); }
    if (act === 'retry') { const text = prompt('Уточнение для агента (можно пусто)') ?? ''; await api(`/api/tasks/${t.id}/retry`, 'POST', { text }); }
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
    ${t.result ? `<label>Ответ агента</label><div class="answer">${md(t.result)}</div>` : ''}
    ${t.cost_usd ? `<div class="log">Расход: ≈$${t.cost_usd.toFixed(2)} по тарифу API · ${t.turns} ходов · подписка Max, деньги не списываются</div>` : ''}
    ${t.diff_stat ? `<label>Изменения</label><div class="log">${esc(t.diff_stat)}</div>` : ''}
    <div id="t-diff"></div>
    <label>Хроника</label><div class="log">${esc(t.log.join('\n'))}</div>
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end" id="t-actions"></div>`;
  const acts = $('#t-actions');
  if (t.status === 'review') acts.innerHTML = `<button onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'reject')">Отклонить</button><button class="ok" onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'approve')">Одобрить и влить в main</button>`;
  if (t.status === 'rejected' || t.status === 'failed') acts.innerHTML = `<button onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'retry')">Повторить с уточнением</button>`;
  $('#dlg-task').showModal();
  if (t.branch && (t.status === 'review' || t.status === 'failed')) {
    const { diff } = await api(`/api/tasks/${t.id}/diff`);
    $('#t-diff').innerHTML = `<label>Diff к main</label><pre class="diff">${diff ? colorDiff(diff) : '(пусто)'}</pre>`;
  }
}

function fillForm() {
  $('#f-agent').innerHTML = STATE.agents.map(a => `<option value="${a.name}">${esc(a.title)}</option>`).join('');
  const opts = STATE.repos.map(r => `<option value="${esc(r)}">${esc(r.replace(/^\/Users\/[^/]+/, '~'))}</option>`).join('');
  $('#f-repo').innerHTML = opts; $('#m-repo').innerHTML = opts;
}

$('#btn-new').addEventListener('click', () => $('#dlg-new').showModal());
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
  const path = prompt('Путь к git-репозиторию (например ~/PycharmProjects/bike_fit)'); if (!path) return;
  try { await api('/api/repos', 'POST', { path }); await loadState(); } catch (e) { alert(e.message); }
});

// ---- лента + события
const term = $('#term');
function termLine(cls, who, text) {
  const d = document.createElement('div'); d.className = 'line ' + cls;
  d.innerHTML = `<span class="who">${esc(who)}</span>${esc(text)}`;
  term.appendChild(d); while (term.children.length > 300) term.firstChild.remove();
  term.scrollTop = term.scrollHeight;
}
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onmessage = (m) => {
    const ev = JSON.parse(m.data); const who = ev.agent ? agentTitle(ev.agent) : 'офис';
    if (ev.kind === 'agent.tool') termLine('tool', who, '⚙ ' + ev.data.summary);
    else if (ev.kind === 'agent.text') termLine('text', who, ev.data.text);
    else if (ev.kind === 'agent.state') { Floor.setState(ev.agent, ev.data.state); termLine('state', who, { working: '▶ взял задачу', planning: '🧭 планирует миссию', idle: '■ свободен' }[ev.data.state] || ev.data.state); }
    else if (ev.kind === 'mission.created' || ev.kind === 'mission.updated') { termLine('state', 'офис', `🎯 миссия ${MISSION_RU[ev.data.mission.status] || ev.data.mission.status}: ${ev.data.mission.goal.slice(0, 80)}`); loadState(); }
    else if (ev.kind === 'task.created') { Floor.envelope('in', ev.agent); termLine('state', 'ты', '✉ задача: ' + ev.data.task.title); loadState(); }
    else if (ev.kind === 'task.updated') {
      const t = ev.data.task; if (t.status === 'review') { Floor.envelope('out', ev.agent); Floor.setState(ev.agent, 'review'); setTimeout(() => Floor.setState(ev.agent, 'idle'), 4000); }
      if (t.status === 'done') Floor.envelope('banana', ev.agent);   // одобрили — банан на стол
      termLine('state', who, `→ ${STATUS_RU[t.status]}: ${t.title}`);
      if ((t.status === 'review' || t.status === 'failed') && t.result) termLine('text', who, '💬 ' + summary(t.result, 400));
      loadState();
    }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
loadState().then(connect);


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
  if (window.Floor && Floor.setTheme) Floor.setTheme(THEMES[name]);
}
document.querySelectorAll('#themes button').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
applyTheme((() => { try { return localStorage.getItem('ao_theme'); } catch (e) { return null; } })() || 'arcade');
