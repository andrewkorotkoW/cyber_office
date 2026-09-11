/* Пиксельный офис. Логическое разрешение 256×144 «пикселей», рисуется в offscreen-canvas
   и масштабируется целым числом без сглаживания — так пиксели остаются чёткими.
   Обезьяны ходят: за задачей к лотку «входящие», с готовой работой — к лотку «ревью». */
(function () {
  const canvas = document.getElementById('floor-canvas');
  const ctx = canvas.getContext('2d');
  const LW = 256, LH = 144;
  const off = document.createElement('canvas'); off.width = LW; off.height = LH;
  const o = off.getContext('2d');
  let W = 0, H = 0, scale = 1, ox = 0, oy = 0;
  let TH = { floor1: '#1a2231', floor2: '#182030', wall: '#243049', wallLine: '#1d2740', win: '#5b7fb4', winLite: '#8fb3e6', desk: '#3a465c', deskTop: '#2c364a', text: '#e6edf3', mute: '#8a93a3', tray: '#f05a46', tray2: '#5acd96' };

  // ---------------------------------------------------------------- палитра и спрайты
  const P = { s: '#e8c39e', d: '#2a1d14', m: '#5a3a28', w: '#ffffff', y: '#f2c14e', b: '#4f8ef7', k: '#222b38',
              t: '#3a465c', T: '#2c364a', g: '#5acd96', r: '#f05a46', o: '#8a6d1f', p: '#3fa36b', q: '#2c7a4b' };
  // f — шерсть цвета агента; f2 — та же, темнее (подменяются при рисовании)
  const MONKEY = {
    stand: [
      '......ffffff......',
      '.....ffffffff.....',
      '..f..ffffffff..f..',
      '.fsf.fssssssf.fsf.',
      '.fsf.fsdssdsf.fsf.',
      '..f..fssssssf..f..',
      '.....ffsmmsff.....',
      '......ffffff......',
      '.....ffffffff.....',
      '....fffssssfff....',
      '....fffssssfff....',
      '.....ffffffff.....',
      '......ff..ff......',
      '......ff..ff......',
    ],
    walk1: [
      '......ffffff......',
      '.....ffffffff.....',
      '..f..ffffffff..f..',
      '.fsf.fssssssf.fsf.',
      '.fsf.fsdssdsf.fsf.',
      '..f..fssssssf..f..',
      '.....ffsmmsff.....',
      '......ffffff......',
      '.....ffffffff.....',
      '....fffssssfff....',
      '....fffssssfff....',
      '.....ffffffff.....',
      '.....ff....ff.....',
      '....ff......ff....',
    ],
    walk2: [
      '......ffffff......',
      '.....ffffffff.....',
      '..f..ffffffff..f..',
      '.fsf.fssssssf.fsf.',
      '.fsf.fsdssdsf.fsf.',
      '..f..fssssssf..f..',
      '.....ffsmmsff.....',
      '......ffffff......',
      '.....ffffffff.....',
      '....fffssssfff....',
      '....fffssssfff....',
      '.....ffffffff.....',
      '.......ffff.......',
      '.......ffff.......',
    ],
    type1: [
      '......ffffff......',
      '.....ffffffff.....',
      '..f..ffffffff..f..',
      '.fsf.fssssssf.fsf.',
      '.fsf.fsdssdsf.fsf.',
      '..f..fssssssf..f..',
      '.....ffs..sff.....',
      '......ffffff......',
      '....fffffffffff...',
      '...ffffssssffff...',
      '..ff.ffssssff.ff..',
      '.....ffffffff.....',
      '......ff..ff......',
      '......ff..ff......',
    ],
    type2: [
      '......ffffff......',
      '.....ffffffff.....',
      '..f..ffffffff..f..',
      '.fsf.fssssssf.fsf.',
      '.fsf.fsdssdsf.fsf.',
      '..f..fssssssf..f..',
      '.....ffs..sff.....',
      '......ffffff......',
      '....fffffffffff...',
      '..ffffffssssffff..',
      '.....ffssssff.....',
      '.....ffffffff.....',
      '......ff..ff......',
      '......ff..ff......',
    ],
  };
  const DESK = [
    'tttttttttttttttttttttttttttt',
    'tTTTTTTTTTTTTTTTTTTTTTTTTTTt',
    'tTTTTTTTTTTTTTTTTTTTTTTTTTTt',
    '.tt......................tt.',
    '.tt......................tt.',
  ];
  const MONITOR_ON = ['kkkkkkkkkk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kkkkkkkkkk', '....kk....', '...kkkk...'];
  const MONITOR_OFF = MONITOR_ON.map(r => r.replace(/b/g, 'T'));
  const TRAY = ['..tttttttttttt..', '.tTTTTTTTTTTTTt.', 'tTTTTTTTTTTTTTTt', 'tTTTTTTTTTTTTTTt', 'tttttttttttttttt'];
  const ENVELOPE = ['wwwwww', 'wdwwdw', 'wwddww', 'wwwwww'];
  const BANANA = ['....yy', '..yyyo', 'yyyy..', 'yy....'];
  const PLANT = ['..pp..', '.pqpp.', 'pqppqp', '.ppqp.', '..tt..', '.tttt.'];
  const BOARD = ['tttttttttttttttt', 'tyyyyyyyyyyyyyyt', 'tydyyydydyyydyyt', 'tyyyyyyyyyyyyyyt', 'tydydyyydyyydyyt', 'tyyyyyyyyyyyyyyt', 'tttttttttttttttt'];

  // ---------------------------------------------------------------- офисные коты (постоянные, не через Floor API)
  // цвета — инлайн через colors-объект sprite(), палитра P не трогается
  const CAT_STAND = [
    '..f.....f..',
    '.fffffffff.',
    '.fyffnffyf.',
    '.fffffffff.',
    '..ff...ff..',
  ];
  const CAT_WALK1 = [
    '..f.....f..',
    '.fffffffff.',
    '.fyffnffyf.',
    '.fffffffff.',
    '.ff.....ff.',
  ];
  const CAT_WALK2 = [
    '..f.....f..',
    '.fffffffff.',
    '.fyffnffyf.',
    '.fffffffff.',
    '...ff.ff...',
  ];
  const CAT_LIE = [
    '..f..........',
    '.fffffffff...',
    '.ffkfffffff..',
    '...ffffff....',
  ];

  function sprite(rows, x, y, colors) {
    for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
      const c = rows[j][i]; if (c === '.') continue;
      o.fillStyle = (colors && colors[c]) || (c === 't' ? TH.desk : c === 'T' ? TH.deskTop : P[c]) || '#f0f'; o.fillRect(x + i, y + j, 1, 1);
    }
  }
  const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return `rgb(${r * k | 0},${g * k | 0},${b * k | 0})`; };

  // ---------------------------------------------------------------- мир
  const TRAY_IN = { x: 14, y: 92 }, TRAY_OUT = { x: LW - 30, y: 92 };
  let agents = [];   // {name,title,color,state, x,y, home:{x,y}, queue:[], carry:null, frame, banana:0}
  const deskX = (i, n) => Math.round(LW / 2 + (i - (n - 1) / 2) * Math.min(72, (LW - 80) / Math.max(1, n)));

  function setAgents(list) {
    const n = list.length;
    agents = list.map((a, i) => {
      const prev = agents.find(x => x.name === a.name);
      const home = { x: deskX(i, n), y: 96 };
      return Object.assign({ x: home.x, y: home.y, queue: [], carry: null, frame: 0, banana: 0, walking: false }, prev || {}, a, { home });
    });
  }
  function setState(name, state) { const a = agents.find(x => x.name === name); if (a) a.state = state; }
  function envelope(kind, name) {
    const a = agents.find(x => x.name === name); if (!a) return;
    if (kind === 'in') a.queue.push({ walk: { x: TRAY_IN.x + 18, y: TRAY_IN.y + 4 } }, { pick: 'env' }, { walk: a.home }, { drop: true });
    else if (kind === 'out') a.queue.push({ pick: 'env' }, { walk: { x: TRAY_OUT.x - 8, y: TRAY_OUT.y + 4 } }, { drop: true }, { walk: a.home });
    else if (kind === 'banana') a.banana = 600;
  }

  // площадь пола для прогулок котов — считается от LW/LH, не от текущих чисел
  const catMinX = Math.round(LW * 0.03), catMaxX = LW - Math.round(LW * 0.03);
  const catMinY = Math.round(LH * 0.32), catMaxY = LH - Math.round(LH * 0.05);
  function catRandomPoint() { return { x: catMinX + Math.random() * (catMaxX - catMinX), y: catMinY + Math.random() * (catMaxY - catMinY) }; }
  function makeCat(colors) {
    const start = catRandomPoint();
    return { x: start.x, y: start.y, target: catRandomPoint(), dir: 1, walking: false, lying: false, lieTimer: 0, meow: 0, phase: Math.random() * Math.PI * 2, colors };
  }
  const cats = [
    makeCat({ f: '#e8823c', y: '#2f6b3a', n: '#d9536b', k: '#5a3a1f', w: '#fff3e0' }), // рыжий
    makeCat({ f: '#9099a6', y: '#e2c94a', n: '#d9536b', k: '#454b55', w: '#eef1f4' }), // серый
  ];

  function stepCat(cat) {
    if (cat.lying) {
      cat.lieTimer--;
      if (cat.lieTimer <= 0) { cat.lying = false; cat.target = catRandomPoint(); }
    } else {
      const dx = cat.target.x - cat.x, dy = cat.target.y - cat.y, dist = Math.hypot(dx, dy);
      if (dist < 1) {
        cat.x = cat.target.x; cat.y = cat.target.y; cat.walking = false;
        if (Math.random() < 0.35) { cat.lying = true; cat.lieTimer = 180 + Math.random() * 240; }
        else cat.target = catRandomPoint();
      } else {
        const v = 0.45; cat.x += dx / dist * v; cat.y += dy / dist * v; cat.walking = true; cat.dir = dx < 0 ? -1 : 1;
      }
    }
    if (cat.meow > 0) cat.meow--;
    else if (Math.random() < 0.0006) cat.meow = 70 + Math.random() * 50;
  }

  function drawCats(t) { for (const cat of cats) drawCat(cat, t); }
  function drawCat(cat, t) {
    let rows = CAT_STAND;
    if (cat.lying) rows = CAT_LIE;
    else if (cat.walking) rows = Math.floor(t / 130) % 2 ? CAT_WALK1 : CAT_WALK2;
    const w = rows[0].length, h = rows.length;
    const x = Math.round(cat.x) - Math.round(w / 2), y = Math.round(cat.y) - h;
    // тень
    o.fillStyle = 'rgba(0,0,0,0.25)'; o.fillRect(x + 1, y + h, Math.max(1, w - 2), 1);
    // хвост — плавная синусоида по фазе t, без телепортации/рывков
    if (!cat.lying) {
      const wag = Math.sin(t / 260 + cat.phase) * 1.4;
      const tailX = cat.dir === -1 ? x + w : x - 1;
      const tailY = y + Math.round(h * 0.4 + wag);
      o.fillStyle = cat.colors.f; o.fillRect(tailX, tailY, 1, 2);
    }
    if (cat.dir === -1) { o.save(); o.translate(x * 2 + w, 0); o.scale(-1, 1); sprite(rows, x, y, cat.colors); o.restore(); }
    else sprite(rows, x, y, cat.colors);
    if (cat.meow > 0) drawMeowBubble(cat, y);
  }
  function drawMeowBubble(cat, topY) {
    const bw = 20, bh = 10;
    const bx = Math.round(cat.x) - Math.round(bw / 2), by = topY - bh - 5;
    o.fillStyle = '#1c2433'; o.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    o.fillStyle = '#ffffff'; o.fillRect(bx, by, bw, bh);
    const tipX = Math.round(cat.x) + (cat.dir === -1 ? -2 : 2);
    o.fillRect(tipX - 2, by + bh, 4, 1); o.fillRect(tipX - 1, by + bh + 1, 2, 1); o.fillRect(tipX, by + bh + 2, 1, 1);
    o.save();
    o.font = '6px "Pixelify Sans", monospace'; o.textAlign = 'center'; o.textBaseline = 'middle';
    o.fillStyle = '#1c2433'; o.fillText('мяу', bx + bw / 2, by + bh / 2 + 1);
    o.restore();
  }

  function step(a) {
    if (a.wait > 0) { a.wait--; return; }
    const act = a.queue[0]; if (!act) { a.walking = false; return; }
    if (act.walk) {
      const dx = act.walk.x - a.x, dy = act.walk.y - a.y, dist = Math.hypot(dx, dy);
      if (dist < 1) { a.x = act.walk.x; a.y = act.walk.y; a.queue.shift(); a.walking = false; return; }
      const v = 0.9; a.x += dx / dist * v; a.y += dy / dist * v; a.walking = true; a.dir = dx < 0 ? -1 : 1;
    } else if (act.pick) { a.carry = act.pick; a.wait = 18; a.queue.shift(); }
    else if (act.drop) { a.carry = null; a.wait = 12; a.queue.shift(); }
  }

  // ---------------------------------------------------------------- отрисовка
  function drawWorld(t) {
    // пол — плитка
    for (let y = 40; y < LH; y += 8) for (let x = 0; x < LW; x += 8) {
      o.fillStyle = ((x + y) / 8) % 2 ? TH.floor1 : TH.floor2; o.fillRect(x, y, 8, 8);
    }
    // стена с окнами
    o.fillStyle = TH.wall; o.fillRect(0, 0, LW, 40); o.fillStyle = TH.wallLine; o.fillRect(0, 38, LW, 2);
    for (let x = 12; x < LW - 20; x += 40) {
      o.fillStyle = TH.win; o.fillRect(x, 8, 22, 18); o.fillStyle = TH.winLite; o.fillRect(x + 2, 10, 8, 6); o.fillRect(x + 12, 10, 8, 6);
      o.fillStyle = TH.winLite; o.globalAlpha = 0.7; o.fillRect(x + 2, 18, 8, 6); o.fillRect(x + 12, 18, 8, 6); o.globalAlpha = 1;
    }
    sprite(PLANT, LW - 14, 30); sprite(PLANT, 4, 30);
    // лотки
    sprite(TRAY, TRAY_IN.x, TRAY_IN.y); sprite(TRAY, TRAY_OUT.x, TRAY_OUT.y);
    o.fillStyle = TH.tray; o.fillRect(TRAY_IN.x + 1, TRAY_IN.y - 3, 14, 2);
    o.fillStyle = TH.tray2; o.fillRect(TRAY_OUT.x + 1, TRAY_OUT.y - 3, 14, 2);
    // офисные коты — на полу, до столов/подписей
    drawCats(t);
    // столы (сначала — что позади обезьяны: монитор), потом обезьяна, потом стол поверх ног
    for (const a of agents) {
      const on = a.state === 'working';
      sprite(on ? MONITOR_ON : MONITOR_OFF, a.home.x - 5, a.home.y - 22);
      if (on && Math.floor(t / 120) % 2) { o.fillStyle = '#9cc4ff'; o.fillRect(a.home.x - 3, a.home.y - 20, 3, 1); o.fillRect(a.home.x - 3, a.home.y - 18, 5, 1); }
      if (a.state === 'planning') sprite(BOARD, a.home.x - 8, a.home.y - 36);
      if (a.banana > 0) sprite(BANANA, a.home.x + 8, a.home.y - 8);
    }
    for (const a of agents) drawMonkey(a, t);
    for (const a of agents) sprite(DESK, a.home.x - 14, a.home.y - 4);
    // подписи
    o.font = '600 8px "Pixelify Sans", monospace'; o.textAlign = 'center'; o.textBaseline = 'top';
    for (const a of agents) {
      o.fillStyle = TH.text; o.fillText(a.title.split('·')[0].trim(), a.home.x, a.home.y + 3);
      o.fillStyle = TH.mute; o.font = '8px "Pixelify Sans", monospace'; o.fillText({ idle: 'свободен', working: 'работает', review: 'ждёт ревью', planning: 'планирует' }[a.state] || a.state, a.home.x, a.home.y + 12); o.font = '600 8px "Pixelify Sans", monospace';
    }
    o.font = '600 8px "Pixelify Sans", monospace';
    o.fillStyle = TH.tray; o.fillText('задачи', TRAY_IN.x + 8, TRAY_IN.y + 7);
    o.fillStyle = TH.tray2; o.fillText('ревью', TRAY_OUT.x + 8, TRAY_OUT.y + 7);
  }

  function drawMonkey(a, t) {
    const fur = a.color, colors = { f: fur };
    let rows = MONKEY.stand;
    if (a.walking) rows = Math.floor(t / 140) % 2 ? MONKEY.walk1 : MONKEY.walk2;
    else if (a.state === 'working' && !a.queue.length) rows = Math.floor(t / 160) % 2 ? MONKEY.type1 : MONKEY.type2;
    const x = Math.round(a.x) - 9, y = Math.round(a.y) - 18;
    // тень
    o.fillStyle = 'rgba(0,0,0,0.25)'; o.fillRect(x + 4, y + 14, 10, 1);
    // хвост
    o.fillStyle = fur; o.fillRect(x - 2, y + 9, 2, 1); o.fillRect(x - 3, y + 7 + (Math.floor(t / 400) % 2), 1, 2);
    if (a.dir === -1) { o.save(); o.translate(x * 2 + 18, 0); o.scale(-1, 1); sprite(rows, x, y, colors); o.restore(); }
    else sprite(rows, x, y, colors);
    if (a.carry === 'env') sprite(ENVELOPE, x + (a.dir === -1 ? -2 : 14), y + 8);
    if (a.state === 'review' && !a.queue.length) sprite(BANANA, x + 14, y + 2);
    if (a.state === 'idle' && !a.walking && Math.floor(t / 2800) % 4 === 0 && (t % 2800) < 120) { o.fillStyle = fur; o.fillRect(x + 7, y + 4, 1, 1); o.fillRect(x + 10, y + 4, 1, 1); } // моргание
  }

  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = box.width; H = box.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.max(1, Math.floor(Math.min(W / LW, H / LH)));
    ox = Math.floor((W - LW * scale) / 2); oy = Math.floor((H - LH * scale) / 2);
  }
  window.addEventListener('resize', resize);

  function frame(t) {
    if (!W) resize();
    for (const a of agents) { step(a); if (a.banana > 0) a.banana--; }
    for (const cat of cats) stepCat(cat);
    o.clearRect(0, 0, LW, LH);
    drawWorld(t);
    ctx.fillStyle = TH.floor2; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, ox, oy, LW * scale, LH * scale);
    requestAnimationFrame(frame);
  }

  window.Floor = { setAgents, setState, envelope, setTheme(t) { TH = Object.assign({}, TH, t); } };
  document.fonts && document.fonts.load('8px "Pixelify Sans"').catch(() => {});
  requestAnimationFrame(frame);
})();
