/* Состояние приходит одним снимком (/api/state) и живыми событиями (/ws). */
const $ = (s) => document.querySelector(s);
let STATE = { agents: [], tasks: [], repos: [], missions: [] };
let REPO_FILTER = (() => { try { return localStorage.getItem('ao_repo') || ''; } catch (e) { return ''; } })();   // '' = все
let AGENT_LAST_TEXT = {};   // agent -> последний ev.data.text из agent.text (для блока "сейчас в работе")
let EVENTS_BUFFER = [];     // последние 10 событий ленты для блока "последние события" на Планёрке
const NOTIFY_KEY = 'ao_notifications';
let NOTIFICATIONS = (() => { try { return JSON.parse(localStorage.getItem(NOTIFY_KEY) || '[]'); } catch (e) { return []; } })();
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
const fmtTimeSec = (ts) => { try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); } catch (e) { return ''; } };
const costLabel = (usd) => usd ? ` · ≈$${usd.toFixed(2)} по API` : '';
const agentTitle = (n) => (STATE.agents.find(a => a.name === n) || { title: n }).title.split('·')[0].trim();
// круглый аватар-портрет агента (лента событий, карточки задач, шапка миссии) — пусто, если у агента нет avatar
const avatarImg = (n, size = 24) => { const a = STATE.agents.find(x => x.name === n); return a && a.avatar ? `<img class="avatar${a.state && a.state !== 'idle' ? ' busy' : ''}" data-agent="${esc(a.name)}" style="--ac:${esc(a.color || '#ff4fa3')}" width="${size}" height="${size}" src="/ui/assets/portraits/${esc(a.avatar)}" alt="">` : ''; };


// живые портреты в диалогах (ui/portrait_anim.js): моргание/речь/эмоции; #dlg-task и лента не трогаем — там
// портретов много, анимация замельтешит. PORTRAITS хранит инстансы, чтобы останавливать таймеры при close().
const PORTRAITS = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ERROR_TEXT_RE = /ошибк|error|failed|не удал/i;
// печать реплики персонажа в шапке диалога (Пэм в dlg-ask, Дуайт/Майкл в dlg-new/dlg-mission):
// Speech.typeMessage (ui/speech.js) печатает посимвольно и возвращает Promise с .cancel(), портрет
// key из PORTRAITS шевелит ртом ровно на время печати; SPEECH_TYPING хранит текущую печать для
// остановки при закрытии диалога (см. addEventListener('close', ...) ниже).
const SPEECH_TYPING = {};
function prefersReducedMotion() {
  try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}
function typeSpeech(key, el, text, msPerChar = 18, { error = false } = {}) {
  if (el) el.classList.toggle('error', !!error);
  const inst = PORTRAITS[key];
  if (prefersReducedMotion()) {
    if (el) el.textContent = String(text == null ? '' : text);
    if (inst) inst.talk(0);
    return Promise.resolve();
  }
  const ms = Math.max(300, String(text == null ? '' : text).length * msPerChar);
  if (inst) inst.talk(ms);
  const p = el ? Speech.typeMessage(el, text, msPerChar) : Promise.resolve();
  SPEECH_TYPING[key] = p;
  return p.then(() => { if (inst) inst.talk(0); });
}
const speakSpeech = (key, el, lines, msPerChar = 18) => typeSpeech(key, el, Speech.pickLine(lines), msPerChar);

// Свой диалог вместо системных prompt/confirm/alert (у системных — чужой шрифт и питоновская ракета).
function uiAsk(message, { input = false, placeholder = '', ok = 'OK', cancel = 'Отмена', cancelable = true } = {}) {
  return new Promise((resolve) => {
    const d = document.getElementById('dlg-ask'); if (!d || !d.showModal) { resolve(input ? prompt(message) : confirm(message)); return; }
    const msg = d.querySelector('#ask-msg'), inp = d.querySelector('#ask-input'), bOk = d.querySelector('#ask-ok'), bCancel = d.querySelector('#ask-cancel');
    inp.hidden = !input; inp.value = ''; inp.placeholder = placeholder; bOk.textContent = ok; bCancel.textContent = cancel; bCancel.hidden = !cancelable;
    const done = (v) => { d.close(); bOk.onclick = bCancel.onclick = null; inp.onkeydown = null; d.oncancel = null; resolve(v); };
    bOk.onclick = () => done(input ? inp.value : true);
    bCancel.onclick = () => done(input ? null : false);
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); bOk.click(); } };
    d.oncancel = (e) => { e.preventDefault(); done(input ? null : false); };
    d.showModal(); if (input) inp.focus(); else bOk.focus();
    const pam = window.LivePortrait ? (PORTRAITS.pam = window.LivePortrait.mount(document.getElementById('ask-avatar'), 'pink.png')) : null;
    if (pam) pam.mood(ERROR_TEXT_RE.test(String(message ?? '')) ? 'worried' : 'neutral');
    typeSpeech('pam', msg, message, 18);
  });
}
const uiPrompt = (message, placeholder = '') => uiAsk(message, { input: true, placeholder });
const uiConfirm = (message) => uiAsk(message, { ok: 'Да', cancel: 'Нет' });
const uiAlert = (message) => uiAsk(message, { ok: 'Понятно', cancelable: false });
window.alert = (m) => { uiAlert(String(m)); };
document.getElementById('dlg-ask')?.addEventListener('close', () => { PORTRAITS.pam?.stop(); SPEECH_TYPING.pam?.cancel?.(); });

async function loadState() {
  STATE = await api('/api/state');
  Floor.setAgents(STATE.agents.map(a => ({ ...a })));
  const m = $('#mode'); m.textContent = STATE.mode === 'fake' ? 'режим: имитация агентов' : 'режим: Claude Code';
  m.className = 'mode' + (STATE.mode === 'fake' ? ' fake' : '');
  updateModeBusy();
  renderProjects(); renderMissions(); renderBoard(); renderPlanerka(); fillForm(); syncAgentAvatar();
}

function setRepoFilter(val) {
  REPO_FILTER = val;
  try { localStorage.setItem('ao_repo', val); } catch (e) {}
  if (val) {
    TESTS_REPO = val; try { localStorage.setItem('ao_tests_repo', val); } catch (e) {}
    if (document.body.dataset.view === 'tests') { loadTestsTree(); loadTestsRuns(); updateScenariosPanel(); }
  }
  renderProjects(); renderMissions(); renderBoard(); renderPlanerka(); fillForm();
}

function projectCounts(repo) {
  const list = STATE.tasks.filter(t => t.repo === repo);
  return { review: list.filter(t => t.status === 'review').length, running: list.filter(t => t.status === 'running').length, total: list.length };
}
function renderProjects() {
  const list = $('#projects-list'), sel = $('#projects-select'); if (!list || !sel) return;
  list.innerHTML = ''; sel.innerHTML = '';
  const addOption = (label, val) => { const o = document.createElement('option'); o.value = val; o.textContent = label; if (REPO_FILTER === val) o.selected = true; sel.appendChild(o); };
  const addRow = (label, val, counts, hasDesignMd) => {
    const row = document.createElement('div'); row.className = 'project-row' + (REPO_FILTER === val ? ' on' : '');
    const badge = hasDesignMd ? '<span class="design-badge" title="В репозитории есть DESIGN.md">DESIGN.md</span>' : '';
    row.innerHTML = `<span class="project-name-wrap"><span class="project-name">${esc(label)}</span>${badge}</span>` + (counts ? `<span class="project-counts">${counts.review ? `<b class="c-review">${counts.review}</b>` : ''}${counts.running ? `<b class="c-running">${counts.running}</b>` : ''}<span class="c-total">${counts.total}</span></span>` : '');
    row.addEventListener('click', () => setRepoFilter(val));
    list.appendChild(row);
  };
  addOption('Все проекты', ''); addRow('Все проекты', '', null, false);
  for (const r of STATE.repos) { const name = r.split('/').pop(); addOption(name, r); addRow(name, r, projectCounts(r), (STATE.design_md_repos || []).includes(r)); }
  sel.onchange = () => setRepoFilter(sel.value);
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
      <div class="bar"><i style="width:${ts.length ? Math.round(done / ts.length * 100) : 0}%"></i></div>
      ${renderMissionGraph(ts, m.status)}`;
    d.querySelector('[data-del]').addEventListener('click', async (e) => { e.stopPropagation(); if (!(await uiConfirm('Удалить миссию и все её задачи?'))) return; try { await api(`/api/missions/${m.id}`, 'DELETE'); await loadState(); } catch (err) { alert(err.message); } });
    const byId = new Map(ts.map(t => [t.id, t]));
    d.querySelectorAll('.graph-node').forEach(el => {
      const t = byId.get(el.dataset.task); if (!t) return;
      el.addEventListener('mouseenter', () => { if (!GRAPH_TOUCH) { showGraphTip(el, t); GRAPH_TIP_NODE = el; } });
      el.addEventListener('mouseleave', () => { if (!GRAPH_TOUCH) hideGraphTip(); });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (GRAPH_TOUCH && GRAPH_TIP_NODE !== el) { showGraphTip(el, t); GRAPH_TIP_NODE = el; return; }
        openTask(t.id);
      });
    });
    box.appendChild(d);
  }
}

// ---- время на узлах графа + критический путь (ui/graph.js::criticalPath — чистая функция, тестируется отдельно)
// длительность в минутах: приоритет started_at/finished_at (полный ISO с датой); для старых задач,
// созданных до появления этих полей, — по HH:MM:SS в строках log (без даты — годится только на
// вычисление разницы в пределах одних суток, что для уже сделанных задач почти всегда верно)
function logSeconds(t, substr) {
  for (let i = t.log.length - 1; i >= 0; i--) {
    if (t.log[i].includes(substr)) { const m = t.log[i].match(/^(\d{2}):(\d{2}):(\d{2})/); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : null; }
  }
  return null;
}
function lastLogSeconds(t) {
  for (let i = t.log.length - 1; i >= 0; i--) { const m = t.log[i].match(/^(\d{2}):(\d{2}):(\d{2})/); if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3]; }
  return null;
}
function taskDurationMinutes(t, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  if (t.status === 'running') {
    if (t.started_at) return Math.max(0, Math.round((now - Date.parse(t.started_at)) / 60000));
    const s = logSeconds(t, 'агент начал работу'); if (s == null) return null;
    const d = new Date(); const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, s).getTime();
    return start > now ? null : Math.max(0, Math.round((now - start) / 60000));
  }
  if (!['done', 'review', 'failed'].includes(t.status)) return null;
  if (t.started_at && t.finished_at) return Math.max(0, Math.round((Date.parse(t.finished_at) - Date.parse(t.started_at)) / 60000));
  const startS = logSeconds(t, 'агент начал работу'), endS = lastLogSeconds(t);
  if (startS == null || endS == null || endS < startS) return null;
  return Math.round((endS - startS) / 60);
}
// медиана длительностей уже завершённых задач той же миссии — оценка для todo/текущей цели running-узла; 15 мин, если нечем оценить
function medianTaskEstimate(tasks) {
  const durations = tasks.filter(t => ['done', 'review', 'failed'].includes(t.status)).map(t => taskDurationMinutes(t)).filter(m => m != null).sort((a, b) => a - b);
  if (!durations.length) return 15;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2);
}
function graphNodeWeight(t, estimate, nowMs) { return taskDurationMinutes(t, nowMs) ?? estimate; }
function graphTimeLabel(t) {
  if (t.status === 'todo') return '⏱ —';
  const mins = taskDurationMinutes(t);
  if (mins == null) return '⏱ —';
  return t.status === 'running' ? `⏱ ${mins} мин…` : `⏱ ${mins} мин · ${t.turns} ходов`;
}
// сколько ещё осталось этому узлу критического пути: 0 для уже завершённых, оценка для todo,
// оценка минус уже прошедшее для running — используется для «ожидаемое окончание»
function remainingMinutes(t, estimate, nowMs) {
  if (!t) return 0;
  if (t.status === 'todo') return estimate;
  if (t.status === 'running') return Math.max(0, estimate - (taskDurationMinutes(t, nowMs) ?? 0));
  return 0;
}
function ruTasks(n) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return 'задача';
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 'задачи';
  return 'задач';
}

// плавающий тултип узла графа: hover на десктопе, тап на мобиле (см. GRAPH_TOUCH ниже —
// на тач-устройствах первый тап только показывает тултип, второй — открывает карточку задачи)
const GRAPH_TOUCH = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
let GRAPH_TIP_EL = null, GRAPH_TIP_NODE = null;
function graphTip() {
  if (!GRAPH_TIP_EL) { GRAPH_TIP_EL = document.createElement('div'); GRAPH_TIP_EL.className = 'graph-tip'; GRAPH_TIP_EL.hidden = true; document.body.appendChild(GRAPH_TIP_EL); }
  return GRAPH_TIP_EL;
}
function graphTipHtml(t) {
  const mins = taskDurationMinutes(t);
  const start = t.started_at ? fmtTime(t.started_at) : '—', end = t.finished_at ? fmtTime(t.finished_at) : '—';
  return `<div class="gt-t">${esc(t.title)}</div>
    <div>${avatarImg(t.agent, 14)}${esc(agentTitle(t.agent))} · ${STATUS_RU[t.status]}</div>
    <div>начало ${start} · конец ${end}</div>
    <div>${mins != null ? '⏱ ' + mins + ' мин' : '⏱ —'} · ${t.turns} ходов</div>
    ${t.branch ? `<div>⎇ ${esc(t.branch)}</div>` : ''}`;
}
function showGraphTip(el, t) {
  const tip = graphTip(); tip.innerHTML = graphTipHtml(t); tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.top = (r.bottom + 6) + 'px';
  tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 240)) + 'px';
}
function hideGraphTip() { if (GRAPH_TIP_EL) GRAPH_TIP_EL.hidden = true; GRAPH_TIP_NODE = null; }
document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.graph-node')) hideGraphTip(); });
// живой счётчик минут для running-узлов графа — сам renderMissions() ничего не анимирует,
// просто перерисовывается целиком раз в 30с, пока в какой-нибудь активной миссии есть running-задача
setInterval(() => { if (STATE.tasks.some(t => t.status === 'running' && t.mission_id)) renderMissions(); }, 30000);

// SVG-граф подзадач миссии: слои считает Graph.computeGraphLayout (ui/graph.js, тестируется отдельно),
// здесь разметка узлов (аватар, название, время) и рёбер depends_on, а также критический путь
// (Graph.criticalPath — тоже чистая функция, вес узла graphNodeWeight выше).
function renderMissionGraph(tasks, missionStatus) {
  if (!tasks.length || !window.Graph) return '';
  const nodes = Graph.computeGraphLayout(tasks.map(t => ({ id: t.id, depends_on: t.depends_on })));
  const pos = new Map(nodes.map(n => [n.id, n]));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const NW = 132, NH = 56, PAD = 14;
  const maxLayer = nodes.reduce((mx, n) => Math.max(mx, n.layer), 0);
  const rowsByLayer = {}; for (const n of nodes) rowsByLayer[n.layer] = (rowsByLayer[n.layer] || 0) + 1;
  const maxRows = Math.max(1, ...Object.values(rowsByLayer));
  const W = PAD * 2 + maxLayer * Graph.STEP_X + NW;
  const H = PAD * 2 + (maxRows - 1) * Graph.STEP_Y + NH;
  const left = (n) => PAD + n.x, right = (n) => PAD + n.x + NW, midY = (n) => PAD + n.y + NH / 2;

  const edgePairs = [];
  for (const t of tasks) for (const dep of (t.depends_on || [])) if (byId.has(dep)) edgePairs.push([dep, t.id]);
  const estimate = medianTaskEstimate(tasks);
  const weights = {}; for (const t of tasks) weights[t.id] = graphNodeWeight(t, estimate);
  const critPath = Graph.criticalPath(tasks.map(t => t.id), edgePairs, weights);
  const critNodes = new Set(critPath);
  const critEdges = new Set(); for (let i = 0; i < critPath.length - 1; i++) critEdges.add(critPath[i] + '>' + critPath[i + 1]);

  const edges = edgePairs.map(([dep, id]) => {
    const a = pos.get(dep), b = pos.get(id); if (!a || !b) return '';
    return `<line class="graph-edge${critEdges.has(dep + '>' + id) ? ' critical' : ''}" x1="${right(a)}" y1="${midY(a)}" x2="${left(b)}" y2="${midY(b)}"></line>`;
  }).join('');
  const nodesHtml = nodes.map(n => {
    const t = byId.get(n.id); if (!t) return '';
    const x = PAD + n.x, y = PAD + n.y, color = STATUS_COLOR[t.status] || STATUS_COLOR.todo;
    return `<g class="graph-node ${t.status}${critNodes.has(t.id) ? ' critical' : ''}" data-task="${t.id}" transform="translate(${x},${y})">
      <rect class="node-bg" width="${NW}" height="${NH}" rx="6" fill="${color}22" stroke="${color}"></rect>
      <foreignObject width="${NW}" height="${NH}"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;flex-direction:column;justify-content:center;gap:2px;height:100%;padding:0 8px;box-sizing:border-box;overflow:hidden">
        <div style="display:flex;align-items:center;gap:6px;overflow:hidden">${avatarImg(t.agent, 20)}<span style="font-size:10.5px;line-height:1.2;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;color:var(--text)">${esc(t.title)}</span></div>
        <div style="font-size:9.5px;color:var(--mute)">${esc(graphTimeLabel(t))}</div>
      </div></foreignObject></g>`;
  }).join('');

  let caption = '';
  if (critPath.length) {
    const totalMin = Math.round(critPath.reduce((s, id) => s + (weights[id] || 0), 0));
    caption = `Критический путь: ${critPath.length} ${ruTasks(critPath.length)} · ~${totalMin} мин`;
    if (missionStatus === 'active') {
      const remaining = critPath.reduce((s, id) => s + remainingMinutes(byId.get(id), estimate), 0);
      const eta = new Date(Date.now() + remaining * 60000);
      caption += ` · ожидаемое окончание ~${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  return `<div class="mission-graph"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${edges}${nodesHtml}</svg></div>
    ${caption ? `<div class="graph-caption">${esc(caption)}</div>` : ''}`;
}

function buildCard(t) {
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
    ${t.status === 'running' ? `<div class="actions"><button class="small" data-act="stop">⏹ Остановить</button></div>` : ''}
    ${t.status === 'review' ? `<div class="actions"><button class="small ok" data-act="approve">Одобрить</button><button class="small" data-act="reject">Отклонить</button></div>` : ''}
    ${(t.status === 'rejected' || t.status === 'failed') ? `<div class="actions"><button class="small" data-act="retry">Повторить</button><button class="small" data-act="delete">Удалить</button></div>` : ''}
    ${t.status === 'done' ? `<div class="actions"><button class="small" data-act="delete">Убрать</button></div>` : ''}`;
  c.addEventListener('click', (e) => { const act = e.target.dataset.act; if (act) { e.stopPropagation(); action(t, act); } else openTask(t.id); });
  return c;
}

function renderBoard() {
  const cols = { todo: [], running: [], review: [], done: [] };
  for (const t of STATE.tasks.filter(visibleTask)) cols[STATUS_COL[t.status]].push(t);
  for (const [k, list] of Object.entries(cols)) {
    const col = document.querySelector(`.col[data-col="${k}"]`);
    col.querySelectorAll('.card').forEach(e => e.remove());
    $(`#n-${k}`).textContent = list.length || '';
    const tabN = document.getElementById(`tab-n-${k}`); if (tabN) tabN.textContent = list.length ? `(${list.length})` : '';
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (const t of list) col.appendChild(buildCard(t));
  }
}

// ---- Планёрка: «ждёт тебя» / «сейчас в работе» / «за сегодня» / «последние события»
function renderPlanerka() {
  renderOnboardingHint();
  renderPlanerkaWaiting();
  renderPlanerkaRunning();
  renderPlanerkaEvents();
}

// первый запуск: workspace пуст (ни одной задачи ни разу) — подсказать про sandbox
function renderOnboardingHint() {
  const box = $('#plk-onboarding'); if (!box) return;
  box.hidden = STATE.tasks.length > 0;
}

function renderPlanerkaWaiting() {
  const box = $('#plk-waiting-body'); if (!box) return; box.innerHTML = '';
  const list = STATE.tasks.filter(visibleTask).filter(t => t.status === 'review' || t.status === 'failed')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (!list.length) { box.innerHTML = '<div class="log">Пусто — ревью и ошибок нет.</div>'; return; }
  for (const t of list) box.appendChild(buildCard(t));
}

// последняя строка «HH:MM:SS агент начал работу» в t.log → минут в работе (тот же день), иначе null
function runningMinutes(t) {
  let line = null;
  for (let i = t.log.length - 1; i >= 0; i--) { if (t.log[i].includes('агент начал работу')) { line = t.log[i]; break; } }
  if (!line) return null;
  const m = line.match(/^(\d{2}):(\d{2}):(\d{2})/); if (!m) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], +m[3]);
  if (start > now) return null;
  return Math.floor((now - start) / 60000);
}

function renderPlanerkaRunning() {
  const box = $('#plk-running-body'); if (!box) return; box.innerHTML = '';
  const list = STATE.tasks.filter(visibleTask).filter(t => t.status === 'running');
  if (!list.length) { box.innerHTML = '<div class="log">Сейчас никто не работает.</div>'; return; }
  for (const t of list) {
    const mins = runningMinutes(t);
    const lastText = AGENT_LAST_TEXT[t.agent];
    const row = document.createElement('div'); row.className = 'plk-running-row';
    row.innerHTML = `<div class="t">${avatarImg(t.agent, 22)}${esc(agentTitle(t.agent))} · ${esc(t.title)}</div>
      <div class="m">${t.turns} ходов${mins != null ? ' · ' + mins + ' мин в работе' : ''}</div>
      ${lastText ? `<div class="res">💬 ${esc(summary(lastText, 160))}</div>` : ''}`;
    row.addEventListener('click', () => openTask(t.id));
    box.appendChild(row);
  }
}

async function loadPlanerkaSummary() {
  const since = new Date().toISOString().slice(0, 10);
  try { renderPlanerkaSummary(await api('/api/summary?since=' + encodeURIComponent(since))); } catch (e) {}
}
function renderPlanerkaSummary(s) {
  const box = $('#plk-today-body'); if (!box) return;
  box.innerHTML = `<div class="plk-stat">✅ задач сделано: ${s.done_tasks}</div>
    <div class="plk-stat">🎯 миссий выполнено: ${s.done_missions}</div>
    <div class="plk-stat">💰 расход: ≈$${s.cost_usd.toFixed(2)}</div>`;
}

function renderPlanerkaEvents() {
  const box = $('#plk-events-body'); if (!box) return; box.innerHTML = '';
  const rows = EVENTS_BUFFER.filter(e => !REPO_FILTER || !e.repo || e.repo === REPO_FILTER).slice(-10).reverse();
  if (!rows.length) { box.innerHTML = '<div class="log">Событий пока нет.</div>'; return; }
  for (const e of rows) {
    const d = document.createElement('div'); d.className = 'line ' + e.cls;
    d.innerHTML = `<span class="plk-ev-time">${fmtTime(new Date(e.ts).toISOString())}</span>${e.agent ? avatarImg(e.agent, 16) : ''}<span class="who">${esc(e.who)}</span>${esc(e.text)}`;
    box.appendChild(d);
  }
}

// presetText — уже готовый текст (например, из поля «дописать агенту» в карточке задачи);
// если не передан, спрашиваем через uiPrompt как раньше.
async function action(t, act, presetText) {
  try {
    if (act === 'approve') {
      try { await api(`/api/tasks/${t.id}/approve`, 'POST'); }
      catch (e) {
        if (!/пустой дифф/.test(e.message)) throw e;
        if (!confirm('В задаче нет изменений — агент ничего не сделал. Всё равно принять?')) return;
        await api(`/api/tasks/${t.id}/approve?force=true`, 'POST');
      }
    }
    if (act === 'reject') { const text = presetText != null ? presetText : ((await uiPrompt('Почему отклоняешь? (пойдёт агенту при повторе)')) ?? ''); await api(`/api/tasks/${t.id}/reject`, 'POST', { text }); }
    if (act === 'retry') { const text = presetText != null ? presetText : ((await uiPrompt('Уточнение для агента (можно пусто)')) ?? ''); await api(`/api/tasks/${t.id}/retry`, 'POST', { text }); }
    if (act === 'stop') { await api(`/api/tasks/${t.id}/stop`, 'POST'); }
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

// diff --git a/X b/Y режет unified diff на блоки по файлам — для дерева файлов слева во вкладке «Дифф».
function splitDiffFiles(diffText) {
  if (!diffText) return [];
  const files = [];
  for (const line of diffText.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) files.push({ name: m[2] || m[1], lines: [line] });
    else if (files.length) files[files.length - 1].lines.push(line);
  }
  return files;
}
function renderDiffTab(diffText) {
  const tree = $('#t-diff-tree'), panel = $('#t-diff-panel'); if (!tree || !panel) return;
  const files = splitDiffFiles(diffText);
  if (!files.length) { tree.innerHTML = '<div class="log">Нет изменений.</div>'; panel.innerHTML = ''; return; }
  tree.innerHTML = files.map((f, i) => `<div class="diff-file-row" data-i="${i}">${esc(f.name)}</div>`).join('');
  panel.innerHTML = files.map((f, i) => `<div class="diff-block" id="t-diff-block-${i}"><pre class="diff">${colorDiff(f.lines.join('\n'))}</pre></div>`).join('');
  tree.querySelectorAll('.diff-file-row').forEach(el => el.addEventListener('click', () => {
    const block = document.getElementById(`t-diff-block-${el.dataset.i}`); if (!block) return;
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    block.classList.add('flash'); setTimeout(() => block.classList.remove('flash'), 900);
  }));
}

// события ленты (agent.tool/text/state, run.output/state) -> {cls, text} для строки лога;
// прочие события (task.updated и т.п.) в карточке задачи не показываем.
function eventLine(ev) {
  if (ev.kind === 'agent.tool') return { cls: 'tool', text: '⚙ ' + ev.data.summary };
  if (ev.kind === 'agent.text') return { cls: 'text', text: ev.data.text };
  if (ev.kind === 'agent.state') return { cls: 'state', text: '■ ' + ev.data.state };
  if (ev.kind === 'run.output') return { cls: 'text', text: ev.data.line };
  if (ev.kind === 'run.state') return { cls: 'state', text: '■ ' + ev.data.state };
  return null;
}
function termAppend(box, ev) {
  const line = eventLine(ev); if (!line) return;
  const d = document.createElement('div'); d.className = 'line ' + line.cls;
  d.innerHTML = `<span class="plk-ev-time">${esc(fmtTimeSec(ev.ts))}</span>${esc(line.text)}`;
  box.appendChild(d);
  while (box.children.length > 400) box.firstChild.remove();
}
// вкладка «Лог»: t.log (короткая хроника) + полная лента событий задачи, слитые в один список по времени.
function renderMergedLog(t, evs) {
  const box = $('#t-log-merged'); if (!box) return;
  const rows = [];
  for (const line of t.log) {
    const m = line.match(/^(\d{2}:\d{2}:\d{2})\s([\s\S]*)$/);
    rows.push({ time: m ? m[1] : '', text: m ? m[2] : line, cls: 'state' });
  }
  for (const ev of evs) { const line = eventLine(ev); if (line) rows.push({ time: fmtTimeSec(ev.ts), text: line.text, cls: line.cls }); }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  box.innerHTML = rows.length ? rows.map(r => `<div class="line ${r.cls}"><span class="plk-ev-time">${esc(r.time)}</span>${esc(r.text)}</div>`).join('') : '<div class="log">Пока пусто.</div>';
  box.scrollTop = box.scrollHeight;
}

async function copyTaskId(id) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard api');
    await navigator.clipboard.writeText(id);
  } catch (e) { uiAlert(id); }
}

async function openTask(id) {
  const t = STATE.tasks.find(x => x.id === id); if (!t) return;
  $('#t-title').textContent = t.title;
  const body = $('#t-body');
  // review не участвует: office.retry() принимает только rejected/failed (см. app/core/office.py),
  // а у review уже есть свой путь — одобрить/отклонить с комментарием.
  const noteApplicable = ['running', 'failed', 'rejected'].includes(t.status);
  body.innerHTML = `<span class="tag">${esc(agentTitle(t.agent))}</span><span class="tag">${STATUS_RU[t.status]}</span><span class="tag">${esc(t.repo)}</span>${t.branch ? `<span class="tag">${esc(t.branch)}</span>` : ''}${t.cost_usd ? `<span class="tag">≈$${t.cost_usd.toFixed(2)} · ${t.turns} ходов</span>` : ''}
    <div class="tabs" id="t-tabs">
      <button data-tab="summary" class="on">Резюме</button>
      <button data-tab="diff">Дифф</button>
      <button data-tab="log">Лог</button>
      <button data-tab="prompt">Промпт</button>
    </div>
    <div style="clear:both"></div>
    <div class="tab-panel" id="tp-summary">
      ${t.result ? `<div class="answer">${md(t.result)}</div>` : '<div class="log">Ответа пока нет.</div>'}
      ${t.status === 'failed' && t.error ? `<label>Причина</label><div class="log">⚠️ ${esc(t.error)}</div>` : ''}
      ${t.status === 'failed' && t.auto_retry_at ? `<div class="log">🔁 автоповтор ${t.auto_retries}/${MAX_AUTO_RETRIES} в ${fmtTime(t.auto_retry_at)}</div>` : ''}
    </div>
    <div class="tab-panel" id="tp-diff" hidden>
      ${t.diff_stat ? `<div class="log" style="margin-bottom:8px">${esc(t.diff_stat)}</div>` : ''}
      <div class="diff-layout"><div class="diff-tree" id="t-diff-tree"><div class="log">Загрузка…</div></div><div class="diff-panel" id="t-diff-panel"></div></div>
    </div>
    <div class="tab-panel" id="tp-log" hidden><div class="term" id="t-log-merged" style="max-height:56vh"><div class="log">Загрузка…</div></div></div>
    <div class="tab-panel" id="tp-prompt" hidden><div class="log" style="color:#d7dce3;white-space:pre-wrap">${esc(t.prompt)}</div></div>
    ${noteApplicable ? `<div class="note-box">
      <label>✍️ Дописать агенту</label>
      <textarea id="t-note-input" placeholder="${t.status === 'running' ? 'Увидит на следующем шаге' : 'Уточнение для повтора'}"></textarea>
      <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:6px"><span class="log msg" id="t-note-msg" hidden></span><button class="primary" id="t-note-send">Отправить</button></div>
    </div>` : ''}
    <div class="dialog-actions" style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end" id="t-actions"></div>`;

  document.querySelectorAll('#t-tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#t-tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('#t-body .tab-panel').forEach(p => p.hidden = p.id !== `tp-${b.dataset.tab}`);
  }));

  const acts = $('#t-actions');
  let actsHtml = '';
  if (t.status === 'review') actsHtml += `<button onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'reject')">Отклонить</button><button class="ok" onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'approve')">Одобрить и влить в main</button>`;
  if (t.status === 'rejected' || t.status === 'failed') actsHtml += `<button onclick="action(STATE.tasks.find(x=>x.id==='${t.id}'),'retry')">Повторить с уточнением</button>`;
  actsHtml += `<button id="t-copy-id">Скопировать id</button><button id="t-delete">Удалить</button>`;
  acts.innerHTML = actsHtml;
  $('#t-copy-id').addEventListener('click', () => copyTaskId(t.id));
  $('#t-delete').addEventListener('click', () => action(STATE.tasks.find(x => x.id === t.id) || t, 'delete'));
  const noteBtn = $('#t-note-send');
  if (noteBtn) noteBtn.addEventListener('click', async () => {
    const input = $('#t-note-input'), text = input.value.trim(); if (!text) return;
    const fresh = STATE.tasks.find(x => x.id === t.id) || t;
    try {
      if (fresh.status === 'running') {
        await api(`/api/tasks/${t.id}/note`, 'POST', { text });
        input.value = '';
        const msg = $('#t-note-msg'); if (msg) { msg.textContent = 'Будет учтено при повторе.'; msg.hidden = false; }
      } else {
        await action(fresh, 'retry', text);
      }
    } catch (e) { alert(e.message); }
  });

  $('#dlg-task').showModal();
  OPEN_TASK = t.id;
  const logBox = $('#t-log-merged'); if (logBox) logBox.innerHTML = '';

  const evs = await api(`/api/tasks/${t.id}/events`);
  renderMergedLog(t, evs);

  if (t.status === 'review' || t.status === 'failed' || t.status === 'done') {
    let diff = ''; try { ({ diff } = await api(`/api/tasks/${t.id}/diff`)); } catch (e) {}
    renderDiffTab(diff);
  } else {
    $('#t-diff-tree').innerHTML = '<div class="log">Появится после ревью.</div>'; $('#t-diff-panel').innerHTML = '';
  }
}

let OPEN_TASK = null;
$('#dlg-task').addEventListener('close', () => { OPEN_TASK = null; });

// value спецпункта «➕ Новый проект…» в селектах репозитория (dlg-new/dlg-mission/чистая
// логика ниже) — чистая функция и regex-константа, тестируемые смоук-тестом на node
// (см. tests/test_new_repo_ui.py), без DOM.
function isNewRepoOption(value) { return value === '__new__'; }
const MIX_WORDS_RE = /новый проект|сайт|приложени|бот/i;
// «Это точно в <repo>? Может, новый проект?» — не блокирует отправку, просто подсказка,
// когда текст похож на отдельную идею, а выбранный репозиторий — не sandbox и не «Новый проект».
function mixingWarning(text, repoPath) {
  if (!repoPath || isNewRepoOption(repoPath)) return null;
  const base = repoPath.replace(/\\/g, '/').split('/').pop();
  if (base === 'sandbox') return null;
  if (!MIX_WORDS_RE.test(text || '')) return null;
  return `Это точно в ${base}? Может, новый проект?`;
}

function fillForm() {
  $('#f-agent').innerHTML = STATE.agents.map(a => `<option value="${a.name}">${esc(a.title)}</option>`).join('');
  const opts = STATE.repos.map(r => `<option value="${esc(r)}">${esc(r.replace(/^\/Users\/[^/]+/, '~'))}</option>`).join('');
  const newOpt = `<option value="__new__">➕ Новый проект…</option>`;
  $('#f-repo').innerHTML = newOpt + opts; $('#m-repo').innerHTML = newOpt + opts;
  if (REPO_FILTER) { $('#f-repo').value = REPO_FILTER; $('#m-repo').value = REPO_FILTER; }
  toggleRepoNewFields('f'); toggleRepoNewFields('m');
  updateMixWarning('f'); updateMixWarning('m');
}

function toggleRepoNewFields(prefix) {
  const sel = document.getElementById(prefix + '-repo'), box = document.getElementById(prefix + '-repo-new');
  if (sel && box) box.hidden = !isNewRepoOption(sel.value);
}
function updateMixWarning(prefix) {
  const sel = document.getElementById(prefix + '-repo'), warn = document.getElementById(prefix + '-mix-warn');
  if (!sel || !warn) return;
  const textEl = prefix === 'm' ? document.getElementById('m-goal') : document.getElementById('f-prompt');
  const titleEl = prefix === 'f' ? document.getElementById('f-title') : null;
  const text = (titleEl ? titleEl.value + ' ' : '') + (textEl ? textEl.value : '');
  const msg = mixingWarning(text, sel.value);
  warn.hidden = !msg; warn.textContent = msg || '';
}
document.getElementById('f-repo')?.addEventListener('change', () => { toggleRepoNewFields('f'); updateMixWarning('f'); });
document.getElementById('m-repo')?.addEventListener('change', () => { toggleRepoNewFields('m'); updateMixWarning('m'); });
document.getElementById('f-title')?.addEventListener('input', () => updateMixWarning('f'));
document.getElementById('f-prompt')?.addEventListener('input', () => updateMixWarning('f'));
document.getElementById('m-goal')?.addEventListener('input', () => updateMixWarning('m'));

// репозиторий из селекта f-repo/m-repo — если выбран «Новый проект», сперва создаёт его
// (POST /api/repos/new) и возвращает свежий path; иначе просто value селекта как есть.
async function resolveRepo(prefix, description) {
  const sel = document.getElementById(prefix + '-repo');
  if (!isNewRepoOption(sel.value)) return sel.value;
  const name = document.getElementById(prefix + '-repo-new-name').value.trim();
  if (!name) throw new Error('укажи имя нового проекта');
  const template = document.getElementById(prefix + '-repo-new-template').value;
  const venv = document.getElementById(prefix + '-repo-new-venv').checked;
  const r = await api('/api/repos/new', 'POST', { name, description, template, venv });
  return r.path;
}

function mountHeadPortrait(key, elId, file) {
  if (!window.LivePortrait) return null;
  const inst = window.LivePortrait.mount(document.getElementById(elId), file);
  PORTRAITS[key] = inst;
  return inst;
}
document.getElementById('dlg-new')?.addEventListener('close', () => { PORTRAITS.dwight?.stop(); PORTRAITS.pick?.stop(); SPEECH_TYPING.dwight?.cancel?.(); });
document.getElementById('dlg-mission')?.addEventListener('close', () => { PORTRAITS.michael?.stop(); SPEECH_TYPING.michael?.cancel?.(); });

$('#btn-new').addEventListener('click', () => {
  $('#dlg-new').showModal();
  mountHeadPortrait('dwight', 'new-avatar', 'cyborg.png');
  speakSpeech('dwight', document.getElementById('new-speech'), Speech.DWIGHT_LINES);
  syncAgentAvatar();
});
// подсказка первого запуска: та же форма «Новая задача», но с примером под sandbox
$('#btn-onboarding-task')?.addEventListener('click', () => {
  $('#btn-new').click();
  const sandbox = STATE.repos.find(r => r.replace(/\\/g, '/').endsWith('/sandbox'));
  if (sandbox) $('#f-repo').value = sandbox;
  $('#f-title').value = 'percent() в calc.py';
  $('#f-prompt').value = 'В sandbox/calc.py добавь функцию percent(a, b) — сколько процентов a составляет от b — и тест на неё.';
});
$('#f-submit').addEventListener('click', async () => {
  try {
    const repo = await resolveRepo('f', $('#f-prompt').value);
    await api('/api/tasks', 'POST', { title: $('#f-title').value, prompt: $('#f-prompt').value, repo, agent: $('#f-agent').value });
    $('#f-title').value = ''; $('#f-prompt').value = '';
    PORTRAITS.dwight?.mood('happy', 1600);
    await typeSpeech('dwight', document.getElementById('new-speech'), 'Принял, отдаю в работу.', 10);
    await sleep(800);
    $('#dlg-new').close(); await loadState();
  } catch (e) {
    PORTRAITS.dwight?.mood('worried');
    await typeSpeech('dwight', document.getElementById('new-speech'), e.message, 10, { error: true });
  }
});
$('#btn-mission').addEventListener('click', () => {
  $('#dlg-mission').showModal();
  mountHeadPortrait('michael', 'mission-avatar', 'beard.png');
  speakSpeech('michael', document.getElementById('mission-speech'), Speech.MICHAEL_LINES);
});
$('#m-submit').addEventListener('click', async () => {
  try {
    const repo = await resolveRepo('m', $('#m-goal').value);
    await api('/api/missions', 'POST', { goal: $('#m-goal').value, repo });
    $('#m-goal').value = '';
    PORTRAITS.michael?.mood('happy', 1600);
    await typeSpeech('michael', document.getElementById('mission-speech'), 'Понял. Иду планировать.', 10);
    await sleep(800);
    $('#dlg-mission').close(); await loadState();
  } catch (e) {
    PORTRAITS.michael?.mood('worried');
    await typeSpeech('michael', document.getElementById('mission-speech'), e.message, 10, { error: true });
  }
});

// диалог «Репозиторий»: вкладка «Подключить существующий» (путь к готовому git-репо) или
// «Создать новый» (те же поля, что и в dlg-new/dlg-mission, см. resolveRepo выше).
function repoSwitchTab(tab) {
  document.querySelectorAll('#repo-tabs .repo-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#repo-tab-existing').hidden = tab !== 'existing';
  $('#repo-tab-new').hidden = tab !== 'new';
  $('#repo-submit').textContent = tab === 'new' ? 'Создать' : 'Добавить';
}
document.querySelectorAll('#repo-tabs .repo-tab').forEach(b => b.addEventListener('click', () => repoSwitchTab(b.dataset.tab)));

function openRepoDialog() {
  repoSwitchTab('existing');
  $('#repo-path').value = ''; $('#repo-new-name').value = ''; $('#repo-new-desc').value = '';
  $('#repo-new-template').value = 'python'; $('#repo-new-venv').checked = true;
  $('#dlg-repo').showModal();
}
$('#btn-repo').addEventListener('click', openRepoDialog);
$('#btn-projects-add').addEventListener('click', openRepoDialog);
$('#repo-submit').addEventListener('click', async () => {
  const tab = document.querySelector('#repo-tabs .repo-tab.on')?.dataset.tab || 'existing';
  try {
    if (tab === 'existing') {
      const path = $('#repo-path').value.trim(); if (!path) return;
      await api('/api/repos', 'POST', { path });
    } else {
      const name = $('#repo-new-name').value.trim(); if (!name) return;
      await api('/api/repos/new', 'POST', { name, description: $('#repo-new-desc').value,
                                             template: $('#repo-new-template').value, venv: $('#repo-new-venv').checked });
    }
    $('#dlg-repo').close(); await loadState();
  } catch (e) { alert(e.message); }
});

// ---- центр уведомлений (колокольчик) — независим от ленты, копит события в localStorage
function saveNotifications() {
  NOTIFICATIONS = NOTIFICATIONS.slice(0, 200);
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(NOTIFICATIONS)); } catch (e) {}
  renderNotifyBadge();
}
function pushNotification(text) {
  NOTIFICATIONS.unshift({ ts: Date.now(), text, read: false });
  saveNotifications();
  if ($('#dlg-notify').open) renderNotifyList();
}
function renderNotifyBadge() {
  const badge = $('#notify-badge'); if (!badge) return;
  const n = NOTIFICATIONS.filter(x => !x.read).length;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
}
function renderNotifyList() {
  const box = $('#notify-list'); if (!box) return; box.innerHTML = '';
  if (!NOTIFICATIONS.length) { box.innerHTML = '<div class="log">Пока ничего нет.</div>'; return; }
  for (const n of NOTIFICATIONS) {
    const d = document.createElement('div'); d.className = 'notify-row' + (n.read ? '' : ' unread');
    d.innerHTML = `<span class="ts">${fmtTime(new Date(n.ts).toISOString())}</span>${esc(n.text)}`;
    box.appendChild(d);
  }
}
$('#btn-notify').addEventListener('click', () => { renderNotifyList(); $('#dlg-notify').showModal(); });
$('#btn-notify-read-all').addEventListener('click', () => { NOTIFICATIONS.forEach(n => n.read = true); saveNotifications(); renderNotifyList(); });
renderNotifyBadge();

// ---- сводка «Что происходит?» (Ральф · докладчик): #btn-digest светится по digest.ready/fresh,
// клик — GET /api/digest, показываем модалку, гасим кнопку через POST /api/digest/seen
function mountDigestPortrait(agent) {
  const el = $('#digest-avatar'); if (!el) return;
  PORTRAITS.ralph?.stop();
  PORTRAITS.ralph = null;
  el.classList.remove('no-avatar');
  el.style.backgroundImage = ''; el.textContent = '';
  if (agent && agent.avatar && window.LivePortrait) {
    PORTRAITS.ralph = window.LivePortrait.mount(el, agent.avatar);
  } else {
    // avatar пуст — плашка с инициалом вместо картинки (см. ui/style.css .no-avatar), как «спрайт
    // без портрета», которым floor.js рисует агентов без собственной палитры (CHAR_PALETTE)
    el.classList.add('no-avatar');
    el.textContent = ((agent && agent.title) || 'О').trim().charAt(0);
  }
}
function renderDigestRepo(repo) {
  const missions = (repo.missions || []).map(m => `<div class="digest-mission"><div class="t">${esc(m.goal)}</div>
      <div class="bar"><i style="width:${m.total ? Math.round(m.done / m.total * 100) : 0}%"></i></div>
      <div class="m">${m.done}/${m.total} задач</div></div>`).join('');
  const running = (repo.running || []).map(t => `<div class="digest-item">🛠 ${esc(agentTitle(t.agent))}: ${esc(t.title)}</div>`).join('');
  const review = (repo.review || []).map(t => `<div class="digest-item digest-clickable" data-task-id="${esc(t.id)}">📝 ${esc(agentTitle(t.agent))}: ${esc(t.title)}</div>`).join('');
  const todo = (repo.todo || []).map(t => `<div class="digest-item">⏳ ${esc(t.title)}</div>`).join('');
  const failed = (repo.failed_24h || []).map(t => `<div class="digest-item digest-failed">❌ ${esc(t.title)}${t.error ? ' — ' + esc(t.error) : ''}</div>`).join('');
  const testhub = repo.testhub ? `<div class="digest-testhub">🧪 test_hub: ${repo.testhub.passed || 0} прошло / ${repo.testhub.failed || 0} упало${repo.testhub.stand ? ' · ' + esc(repo.testhub.stand) : ''}</div>` : '';
  const paused = repo.paused ? '<span class="tag" style="color:var(--warn);border-color:var(--warn)">⏸ на паузе</span>' : '';
  const empty = !missions && !running && !review && !todo && !failed ? '<div class="log">Тихо.</div>' : '';
  return `<div class="digest-repo"><h4>${esc(repo.name)}${paused}</h4>${missions}${running}${review}${todo}${failed}${testhub}${empty}</div>`;
}
function renderDigestFacts(facts) {
  const repos = Object.values(facts.repos || {});
  const since = facts.since_last || {};
  const repoHtml = repos.length ? repos.map(renderDigestRepo).join('') : '<div class="log">Пока нет данных по репозиториям.</div>';
  const sinceHtml = `<div class="digest-since"><label>С прошлой сводки</label>
    <span class="tag">✅ сдано: ${since.done_tasks || 0}</span>
    <span class="tag">🎯 миссий: ${since.done_missions || 0}</span>
    <span class="tag">⚠️ упало: ${since.failed_tasks || 0}</span>
    ${since.cost_usd ? `<span class="tag">≈$${since.cost_usd.toFixed(2)} по API</span>` : ''}</div>`;
  return `<div class="digest-repos">${repoHtml}</div>${sinceHtml}`;
}
function renderDigest(data) {
  const facts = data.facts || {};
  $('#digest-time').textContent = data.generated_at ? '· ' + fmtTime(data.generated_at) : '';
  mountDigestPortrait(STATE.agents.find(a => a.name === 'ralph'));
  typeSpeech('ralph', $('#digest-speech'), data.text || 'Ральф молчит: сводка ещё не собрана.', 14);
  $('#digest-facts').innerHTML = renderDigestFacts(facts);
  $('#digest-facts').querySelectorAll('[data-task-id]').forEach(el => el.addEventListener('click', () => openTask(el.dataset.taskId)));
}
async function markDigestSeen() {
  $('#btn-digest').classList.remove('fresh');
  try { await api('/api/digest/seen', 'POST'); } catch (e) {}
}
$('#btn-digest').addEventListener('click', async () => {
  let data;
  try { data = await api('/api/digest'); } catch (e) { uiAlert(e.message); return; }
  renderDigest(data);
  $('#dlg-digest').showModal();
  await markDigestSeen();
});
$('#digest-ok').addEventListener('click', () => { $('#dlg-digest').close(); markDigestSeen(); });
$('#dlg-digest').addEventListener('close', () => { PORTRAITS.ralph?.stop(); SPEECH_TYPING.ralph?.cancel?.(); });
$('#digest-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget, label = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Обновляю…';
  try { renderDigest(await api('/api/digest/refresh', 'POST')); await markDigestSeen(); }
  catch (e2) { uiAlert(e2.message); }
  finally { btn.disabled = false; btn.textContent = label; }
});
(async () => { try { const d = await api('/api/digest'); if (d.fresh) $('#btn-digest').classList.add('fresh'); } catch (e) {} })();

// ---- лента + события
const term = $('#term');
function termLine(cls, who, text, agent, repo) {
  const d = document.createElement('div'); d.className = 'line ' + cls;
  d.innerHTML = `${agent ? avatarImg(agent, 18) : ''}<span class="who">${esc(who)}</span>${esc(text)}`;
  term.appendChild(d); while (term.children.length > 300) term.firstChild.remove();
  term.scrollTop = term.scrollHeight;
  EVENTS_BUFFER.push({ ts: Date.now(), cls, who, text, agent, repo: repo || null });
  while (EVENTS_BUFFER.length > 10) EVENTS_BUFFER.shift();
  renderPlanerkaEvents();
}
// упрощённый рендер строки ленты для истории (без побочных эффектов: без pushNotification,
// Floor.*, повторных loadState()/loadPlanerkaSummary()) — та же логика построения текста, что и
// в живом обработчике ниже, но только термLine + EVENTS_BUFFER.
function renderHistoryEvent(ev) {
  const who = ev.agent ? agentTitle(ev.agent) : 'офис';
  if (ev.kind === 'agent.tool') termLine('tool', who, '⚙ ' + ev.data.summary, ev.agent, ev.data.task && ev.data.task.repo);
  else if (ev.kind === 'agent.text') termLine('text', who, ev.data.text, ev.agent);
  else if (ev.kind === 'agent.state') termLine('state', who, { working: '▶ взял задачу', planning: '🧭 планирует миссию', idle: '■ свободен' }[ev.data.state] || ev.data.state, ev.agent);
  else if (ev.kind === 'mission.created' || ev.kind === 'mission.updated') termLine('state', 'офис', `🎯 миссия ${MISSION_RU[ev.data.mission.status] || ev.data.mission.status}: ${ev.data.mission.goal.slice(0, 80)}`, 'michael', ev.data.mission.repo);
  else if (ev.kind === 'task.created') termLine('state', 'ты', '✉ задача: ' + ev.data.task.title, ev.agent, ev.data.task.repo);
  else if (ev.kind === 'task.updated') {
    const t = ev.data.task;
    termLine('state', who, `→ ${STATUS_RU[t.status]}: ${t.title}`, ev.agent, t.repo);
    if ((t.status === 'review' || t.status === 'failed') && t.result) termLine('text', who, '💬 ' + summary(t.result, 400), ev.agent, t.repo);
  }
  else if (ev.kind === 'scenario.recorded' && !ev.data.error) termLine('state', 'офис', '🎬 сценарий записан: ' + ev.data.name);
}

let RECONNECT_DELAY = 1500;
const RECONNECT_MAX = 30000;
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  let lastSeen = Date.now();
  ws.onopen = () => {
    RECONNECT_DELAY = 1500;
    lastSeen = Date.now();
    loadState();
  };
  const pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSeen > 65000) { ws.close(); return; }   // соединение "подвисло" (например, после сна ноутбука)
    try { ws.send('ping'); } catch (e) {}
  }, 30000);
  ws.onmessage = (m) => {
    lastSeen = Date.now();
    const data = JSON.parse(m.data);
    if (data.kind === 'history') { data.events.forEach(renderHistoryEvent); return; }
    const ev = data; const who = ev.agent ? agentTitle(ev.agent) : 'офис';
    if (OPEN_TASK && ev.task_id === OPEN_TASK) { const box = $('#t-log-merged'); if (box) { termAppend(box, ev); box.scrollTop = box.scrollHeight; } }
    if (ev.kind === 'agent.tool') termLine('tool', who, '⚙ ' + ev.data.summary, ev.agent, ev.data.task && ev.data.task.repo);
    else if (ev.kind === 'agent.text') { AGENT_LAST_TEXT[ev.agent] = ev.data.text; termLine('text', who, ev.data.text, ev.agent); renderPlanerkaRunning(); }
    else if (ev.kind === 'agent.state') { const ag = STATE.agents.find(a => a.name === ev.agent); if (ag) ag.state = ev.data.state; updateModeBusy(); Floor.setState(ev.agent, ev.data.state); termLine('state', who, { working: '▶ взял задачу', planning: '🧭 планирует миссию', idle: '■ свободен' }[ev.data.state] || ev.data.state, ev.agent); }
    else if (ev.kind === 'mission.created' || ev.kind === 'mission.updated') {
      termLine('state', 'офис', `🎯 миссия ${MISSION_RU[ev.data.mission.status] || ev.data.mission.status}: ${ev.data.mission.goal.slice(0, 80)}`, 'michael', ev.data.mission.repo);
      if (ev.kind === 'mission.updated' && ev.data.mission.status === 'done') pushNotification(`🏁 миссия выполнена: ${ev.data.mission.goal.slice(0, 80)}`);
      if (ev.kind === 'mission.updated') loadPlanerkaSummary();
      loadState();
    }
    else if (ev.kind === 'task.created') { Floor.envelope('in', ev.agent); termLine('state', 'ты', '✉ задача: ' + ev.data.task.title, ev.agent, ev.data.task.repo); loadState(); }
    else if (ev.kind === 'task.updated') {
      const t = ev.data.task; if (t.status === 'review') { Floor.envelope('out', ev.agent); Floor.setState(ev.agent, 'review'); setTimeout(() => Floor.setState(ev.agent, 'idle'), 4000); }
      if (t.status === 'done') { Floor.envelope('banana', ev.agent); Floor.setState(ev.agent, 'done'); setTimeout(() => Floor.setState(ev.agent, 'idle'), 4000); }
      if (t.status === 'failed') { Floor.setState(ev.agent, 'failed'); setTimeout(() => Floor.setState(ev.agent, 'idle'), 4000); }
      termLine('state', who, `→ ${STATUS_RU[t.status]}: ${t.title}`, ev.agent, t.repo);
      if ((t.status === 'review' || t.status === 'failed') && t.result) termLine('text', who, '💬 ' + summary(t.result, 400), ev.agent, t.repo);
      if (['review', 'failed', 'done'].includes(t.status)) pushNotification(`${STATUS_RU[t.status]}: ${t.title}`);
      loadPlanerkaSummary();
      loadState();
    }
    else if (ev.kind === 'task.infra_failure') {
      pushNotification(`⚠️ сбой API: ${(ev.data.task && ev.data.task.title) || ''}`);
    }
    else if (ev.kind === 'repo.after_merge') {
      pushNotification(`🔄 обновлён репозиторий: ${ev.data.repo ? ev.data.repo.split('/').pop() : ''}`);
    }
    else if (ev.kind === 'repo.created') {
      termLine('state', 'офис', '📁 создан проект: ' + (ev.data.name || (ev.data.path || '').split('/').pop()), null, ev.data.path);
      loadState();
    }
    else if (ev.kind === 'repo.ready') {
      pushNotification(ev.data.ok ? `✅ окружение готово: ${(ev.data.path || '').split('/').pop()}`
                                   : `⚠️ .venv не удалось поставить: ${(ev.data.path || '').split('/').pop()}`);
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
    else if (ev.kind === 'digest.ready') {
      $('#btn-digest').classList.add('fresh');
      // бэкенд шлёт только «сводка готова» — стадии «идёт сборка» отдельным событием нет, поэтому
      // «Считаю…» — короткая заглушка на клиенте перед финальной репликой (см. миссию Ральфа)
      Floor.setState('ralph', 'working');
      Floor.say('ralph', 'Считаю…', 1200);
      setTimeout(() => { Floor.setState('ralph', 'idle'); Floor.say('ralph', 'Сводка готова', 4000); }, 1200);
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    setTimeout(connect, RECONNECT_DELAY);
    RECONNECT_DELAY = Math.min(RECONNECT_DELAY * 2, RECONNECT_MAX);
  };
}
connect();
initView();


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
  if (view === 'planerka') { renderPlanerka(); loadPlanerkaSummary(); }
  if (view === 'tests') {
    if (!TESTS_REPO || !STATE.repos.includes(TESTS_REPO)) TESTS_REPO = REPO_FILTER || STATE.repos[0] || '';
    loadTestsTree(); loadTestsRuns(); updateScenariosPanel();
  }
  window.dispatchEvent(new Event('resize'));
}
function initView() {
  let view = 'planerka'; try { view = localStorage.getItem('ao_view') || 'planerka'; } catch (e) {}
  switchView(view);
}
document.querySelectorAll('#view-switch button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

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
    <div class="dialog-actions" style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end"><button class="primary" id="run-retry">↻ Повторить</button></div>`;
  $('#run-retry').addEventListener('click', async () => {
    $('#dlg-run').close();
    if (r.repo !== TESTS_REPO) { TESTS_REPO = r.repo; try { localStorage.setItem('ao_tests_repo', r.repo); } catch (e) {} loadTestsTree(); updateScenariosPanel(); }
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

// Аватар выбранного агента в окне новой задачи — тоже живой портрет (моргает), но без речи/эмоций.
function syncAgentAvatar() {
  const sel = document.getElementById('f-agent'), el = document.getElementById('f-agent-avatar'); if (!sel || !el) return;
  const a = (STATE.agents || []).find(x => x.name === sel.value);
  if (a && a.avatar) { el.hidden = false; if (window.LivePortrait) PORTRAITS.pick = window.LivePortrait.mount(el, a.avatar); }
  else { el.hidden = true; PORTRAITS.pick?.stop(); }
}
document.getElementById('f-agent')?.addEventListener('change', syncAgentAvatar);

// ---- мобильная раскладка (<=768px): бургер-меню, вкладки доски, сворачивание сцены офиса
(function () {
  const btnMenu = document.getElementById('btn-menu');
  const headerMenu = document.getElementById('header-menu');
  if (btnMenu && headerMenu) {
    btnMenu.addEventListener('click', () => {
      const open = headerMenu.classList.toggle('open');
      btnMenu.setAttribute('aria-expanded', String(open));
    });
    headerMenu.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') { headerMenu.classList.remove('open'); btnMenu.setAttribute('aria-expanded', 'false'); }
    });
  }

  document.querySelectorAll('.board-tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.board-tab').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.col').forEach(c => c.classList.toggle('active', c.dataset.col === b.dataset.col));
  }));

  const btnFloorToggle = document.getElementById('btn-floor-toggle');
  const floorPanel = document.getElementById('floor');
  if (btnFloorToggle && floorPanel) {
    btnFloorToggle.addEventListener('click', () => {
      const expanded = floorPanel.classList.toggle('expanded');
      btnFloorToggle.textContent = expanded ? '▲ свернуть офис' : '▼ показать офис';
      window.dispatchEvent(new Event('resize'));
    });
  }
})();

// Клик по затемнению вокруг любого модального окна закрывает его (для окна вопроса — как «Отмена»).
document.querySelectorAll('dialog').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;                       // клик внутри окна — не трогаем
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) return;                                  // клик по «пустому» месту самого окна (padding)
    if (dlg.id === 'dlg-ask') { const c = dlg.querySelector('#ask-cancel'); (c && !c.hidden ? c : dlg.querySelector('#ask-ok')).click(); return; }
    dlg.close();
  });
});
