/* Пиксельный офис. Логическое разрешение 512×288 «пикселей», рисуется в offscreen-canvas
   и масштабируется целым числом без сглаживания — так пиксели остаются чёткими.
   Люди ходят: за задачей к лотку «входящие», с готовой работой — к лотку «ревью». */
(function () {
  const canvas = document.getElementById('floor-canvas');
  const ctx = canvas.getContext('2d');
  const LW = 512, LH = 288;
  const off = document.createElement('canvas'); off.width = LW; off.height = LH;
  const o = off.getContext('2d');
  let W = 0, H = 0, scale = 1, ox = 0, oy = 0;
  let TH = { floor1: '#1a2231', floor2: '#182030', wall: '#243049', wallLine: '#1d2740', win: '#5b7fb4', winLite: '#8fb3e6', desk: '#3a465c', deskTop: '#2c364a', text: '#e6edf3', mute: '#8a93a3', tray: '#f05a46', tray2: '#5acd96', rug: '#2f3b52', rugEdge: '#44536d' };
  // общий масштаб людей/мебели (сетчатые спрайты рисуются крупнее ~в 1.5 раза), S() — округлённое смещение под этот масштаб
  const HS = 1.5;
  const S = n => Math.round(n * HS);

  // ---------------------------------------------------------------- палитра и спрайты
  const P = { s: '#e8c39e', d: '#2a1d14', m: '#5a3a28', w: '#ffffff', y: '#f2c14e', b: '#4f8ef7', k: '#222b38',
              t: '#3a465c', T: '#2c364a', g: '#5acd96', r: '#f05a46', o: '#8a6d1f', p: '#3fa36b', q: '#2c7a4b' };
  // причёски и их цвета — детерминированы по индексу агента в массиве agents
  const HAIR_COLORS = ['#2a1d14', '#1c1c22', '#caa26a', '#7a3b2e'];
  // склейка сегментов фиксированной длины в строку — чтобы не считать пиксели вручную
  const rb = (...segs) => segs.map(([c, n]) => c.repeat(n)).join('');
  // удвоение спрайта по обеим осям (каждый пиксель → блок 2×2) — для «мебели» и мелких предметов
  const scale2 = rows => rows.flatMap(r => { const s = [...r].map(c => c + c).join(''); return [s, s]; });

  // голова человечка: 3 верхних ряда — причёска (варианты по индексу), 5 нижних — лицо (общее)
  const HAIRSTYLES = [
    [rb(['.', 5], ['h', 6], ['.', 5]), rb(['.', 3], ['h', 10], ['.', 3]), rb(['.', 2], ['h', 12], ['.', 2])],
    [rb(['.', 3], ['h', 10], ['.', 3]), rb(['.', 1], ['h', 14], ['.', 1]), rb(['.', 1], ['h', 14], ['.', 1])],
    [rb(['.', 4], ['h', 1], ['.', 1], ['h', 3], ['.', 1], ['h', 1], ['.', 5]), rb(['.', 2], ['h', 2], ['.', 1], ['h', 6], ['.', 1], ['h', 2], ['.', 2]), rb(['.', 2], ['h', 12], ['.', 2])],
    [rb(['.', 6], ['h', 9], ['.', 1]), rb(['.', 2], ['h', 13], ['.', 1]), rb(['h', 1], ['.', 1], ['h', 13], ['.', 1])],
  ];
  const FACE_ROWS = [
    rb(['.', 1], ['h', 2], ['.', 1], ['s', 8], ['.', 1], ['h', 2], ['.', 1]),
    rb(['.', 1], ['h', 2], ['.', 1], ['s', 2], ['d', 1], ['s', 2], ['d', 1], ['s', 2], ['.', 1], ['h', 2], ['.', 1]), // глаза
    rb(['.', 2], ['h', 1], ['.', 1], ['s', 8], ['.', 1], ['h', 1], ['.', 2]),
    rb(['.', 4], ['s', 3], ['d', 2], ['s', 3], ['.', 4]), // рот
    rb(['.', 5], ['s', 6], ['.', 5]), // шея
  ];
  // торс: f — рубашка (цвет агента), e — рукав (темнее), s — кисти рук
  const TORSO_ARM_GAP = rb(['e', 3], ['.', 1], ['f', 8], ['.', 1], ['e', 3]);
  const TORSO = [
    rb(['e', 3], ['f', 10], ['e', 3]),
    rb(['e', 3], ['f', 10], ['e', 3]),
    TORSO_ARM_GAP, TORSO_ARM_GAP, TORSO_ARM_GAP, TORSO_ARM_GAP,
    rb(['e', 1], ['s', 2], ['.', 1], ['f', 8], ['.', 1], ['s', 2], ['e', 1]),
    rb(['e', 1], ['s', 2], ['.', 1], ['f', 8], ['.', 1], ['s', 2], ['e', 1]),
  ];
  // печать: руки убраны по бокам и вытянуты вперёд к клавиатуре (2 кадра — мигание пальцев)
  const TORSO_TYPE1 = TORSO.slice(0, 6).concat([TORSO_ARM_GAP, rb(['.', 2], ['f', 3], ['s', 6], ['f', 3], ['.', 2])]);
  const TORSO_TYPE2 = TORSO.slice(0, 6).concat([TORSO_ARM_GAP, rb(['.', 3], ['f', 2], ['s', 6], ['f', 2], ['.', 3])]);
  // ноги: k — брюки, d — обувь; меняются только последние 2 ряда (шаг при ходьбе)
  const LEGS_BODY = [rb(['f', 16])].concat(Array(7).fill(rb(['k', 6], ['.', 4], ['k', 6])));
  const LEGS_STAND = LEGS_BODY.concat([rb(['d', 6], ['.', 4], ['d', 6]), rb(['d', 6], ['.', 4], ['d', 6])]);
  const LEGS_WALK1 = LEGS_BODY.concat([rb(['d', 4], ['.', 8], ['d', 4]), rb(['d', 4], ['.', 8], ['d', 4])]);
  const LEGS_WALK2 = LEGS_BODY.concat([rb(['.', 2], ['d', 12], ['.', 2]), rb(['.', 2], ['d', 12], ['.', 2])]);

  function humanRows(pose, style) {
    const head = HAIRSTYLES[style].concat(FACE_ROWS);
    if (pose === 'walk1') return head.concat(TORSO, LEGS_WALK1);
    if (pose === 'walk2') return head.concat(TORSO, LEGS_WALK2);
    if (pose === 'type1') return head.concat(TORSO_TYPE1, LEGS_STAND);
    if (pose === 'type2') return head.concat(TORSO_TYPE2, LEGS_STAND);
    return head.concat(TORSO, LEGS_STAND);
  }

  const DESK = scale2(['tttttttttttttttttttttttttttt', 'tTTTTTTTTTTTTTTTTTTTTTTTTTTt', 'tTTTTTTTTTTTTTTTTTTTTTTTTTTt', '.tt......................tt.', '.tt......................tt.']);
  const CHAIR = ['.tttttt.', '.tTTTTt.', '.tTTTTt.', '.tttttt.', '..t..t..', '..t..t..']; // стул позади стола
  const MONITOR_ON = scale2(['kkkkkkkkkk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kkkkkkkkkk', '....kk....', '...kkkk...']);
  const MONITOR_OFF = MONITOR_ON.map(r => r.replace(/b/g, 'T'));
  const TRAY = scale2(['..tttttttttttt..', '.tTTTTTTTTTTTTt.', 'tTTTTTTTTTTTTTTt', 'tTTTTTTTTTTTTTTt', 'tttttttttttttttt']);
  const ENVELOPE = scale2(['wwwwww', 'wdwwdw', 'wwddww', 'wwwwww']);
  const PLANT = scale2(['..pp..', '.pqpp.', 'pqppqp', '.ppqp.', '..tt..', '.tttt.']);
  const BOARD = scale2(['tttttttttttttttt', 'tyyyyyyyyyyyyyyt', 'tydyyydydyyydyyt', 'tyyyyyyyyyyyyyyt', 'tydydyyydyyydyyt', 'tyyyyyyyyyyyyyyt', 'tttttttttttttttt']);
  // документ с галочкой — общая замена банана: маленький возле стола, поднятый над головой на ревью
  const DOC_ICON = ['wwwwww', 'wddddw', 'wwwwww', 'wdddw.', 'wwwwww', 'wwwggw'];
  const ARM_DOC = ['.www.', 'wdddw', '.www.', '..s..', '..s..', '..s..', '..f..'];

  // ---------------------------------------------------------------- доп. мебель, наполняющая офис (цвета — из TH/P, не хардкод)
  const CLOCK = [
    rb(['.', 2], ['k', 5], ['.', 2]),
    rb(['.', 1], ['k', 1], ['w', 5], ['k', 1], ['.', 1]),
    rb(['k', 1], ['w', 7], ['k', 1]),
    rb(['k', 1], ['w', 2], ['k', 1], ['w', 4], ['k', 1]),
    rb(['k', 1], ['w', 7], ['k', 1]),
    rb(['k', 1], ['w', 7], ['k', 1]),
    rb(['.', 1], ['k', 1], ['w', 5], ['k', 1], ['.', 1]),
    rb(['.', 2], ['k', 5], ['.', 2]),
  ];
  const COOLER = [
    '..wwwwww..', '.wbbbbbbw.', '.wbbbbbbw.', '.wbbbbbbw.', '.wbbbbbbw.', '.wbbbbbbw.',
    '.wwwwwwww.', '..tttttt..', '.tttttttt.', '.tbtttttt.', '.tttttttt.', '.tttttttt.',
    '.tttttttt.', '.tttttttt.', 'tttttttttt', 'tttttttttt',
  ];
  const CABINET = [
    rb(['t', 20]),
    rb(['t', 1], ['T', 18], ['t', 1]),
    rb(['t', 1], ['T', 1], ['r', 3], ['T', 1], ['g', 3], ['T', 1], ['b', 3], ['T', 1], ['y', 3], ['T', 2], ['t', 1]),
    rb(['t', 1], ['T', 18], ['t', 1]),
    rb(['t', 1], ['T', 1], ['y', 3], ['T', 1], ['b', 3], ['T', 1], ['g', 3], ['T', 1], ['r', 3], ['T', 2], ['t', 1]),
    rb(['t', 1], ['T', 18], ['t', 1]),
    rb(['t', 1], ['T', 18], ['t', 1]),
    rb(['t', 20]),
    rb(['.', 2], ['t', 4], ['.', 8], ['t', 4], ['.', 2]),
  ];
  const COFFEE_MACHINE = [
    rb(['.', 2], ['k', 6], ['.', 2]),
    rb(['.', 1], ['k', 8], ['.', 1]),
    rb(['.', 1], ['k', 1], ['w', 6], ['k', 1], ['.', 1]),
    rb(['.', 1], ['k', 1], ['r', 6], ['k', 1], ['.', 1]),
    rb(['.', 1], ['k', 8], ['.', 1]),
    rb(['.', 1], ['k', 2], ['.', 4], ['k', 2], ['.', 1]),
    rb(['.', 2], ['T', 6], ['.', 2]),
    rb(['t', 10]),
    rb(['t', 1], ['T', 8], ['t', 1]),
    rb(['t', 1], ['T', 8], ['t', 1]),
    rb(['t', 10]),
    rb(['.', 2], ['t', 2], ['.', 2], ['t', 2], ['.', 2]),
  ];
  const CAT_BED = scale2(['.ooooo.', 'ommmmmo', '.ooooo.']);

  // ---------------------------------------------------------------- офисные коты (постоянные, не через Floor API)
  // цвета — инлайн через colors-объект sprite(), палитра P не трогается
  const CAT_STAND = scale2([
    '..f.....f..',
    '.fffffffff.',
    '.fyffnffyf.',
    '.fffffffff.',
    '..ff...ff..',
  ]);
  const CAT_WALK1 = scale2([
    '..f.....f..',
    '.fffffffff.',
    '.fyffnffyf.',
    '.fffffffff.',
    '.ff.....ff.',
  ]);
  const CAT_WALK2 = scale2([
    '..f.....f..',
    '.fffffffff.',
    '.fyffnffyf.',
    '.fffffffff.',
    '...ff.ff...',
  ]);
  const CAT_LIE = scale2([
    '..f..........',
    '.fffffffff...',
    '.ffkfffffff..',
    '...ffffff....',
  ]);
  // прыжковая поза — лапы поджаты под тело (компактный силуэт, без выступающих ножек)
  const CAT_JUMP = scale2([
    '..f.....f..',
    '.fffffffff.',
    '.fyffnffyf.',
    '.fffffffff.',
    '.ffffffff..',
  ]);

  // s — необязательный масштаб (по умолчанию 1); при s=1 работает как раньше, при s>1 каждый пиксель растягивается
  // на неравномерную (nearest-neighbor) сетку — так спрайт можно увеличить в 1.5 раза без блюра и без перерисовки арта
  function sprite(rows, x, y, colors, s) {
    s = s || 1;
    for (let j = 0; j < rows.length; j++) {
      const py = y + Math.round(j * s), ph = Math.round((j + 1) * s) - Math.round(j * s);
      const row = rows[j];
      for (let i = 0; i < row.length; i++) {
        const c = row[i]; if (c === '.') continue;
        const px = x + Math.round(i * s), pw = Math.round((i + 1) * s) - Math.round(i * s);
        o.fillStyle = (colors && colors[c]) || (c === 't' ? TH.desk : c === 'T' ? TH.deskTop : P[c]) || '#f0f';
        o.fillRect(px, py, pw, ph);
      }
    }
  }
  function spriteSize(rows, s) { s = s || 1; return { w: Math.round(rows[0].length * s), h: Math.round(rows.length * s) }; }
  // прямоугольник, который займёт пиксель (col,row) спрайта после масштабирования — нужен для деталей поверх спрайта (моргание)
  function pixelBox(col, row, s) {
    const x = Math.round(col * s), y = Math.round(row * s);
    return { x, y, w: Math.round((col + 1) * s) - x, h: Math.round((row + 1) * s) - y };
  }
  const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return `rgb(${r * k | 0},${g * k | 0},${b * k | 0})`; };

  // ---------------------------------------------------------------- мир
  const TRAY_IN = { x: 28, y: 184 }, TRAY_OUT = { x: LW - 60, y: 184 };
  let agents = [];   // {name,title,color,state, x,y, home:{x,y}, queue:[], carry:null, frame, banana:0}
  const deskX = (i, n) => Math.round(LW / 2 + (i - (n - 1) / 2) * Math.min(170, (LW - 100) / Math.max(1, n)));

  function setAgents(list) {
    const n = list.length;
    agents = list.map((a, i) => {
      const prev = agents.find(x => x.name === a.name);
      const home = { x: deskX(i, n), y: 192 };
      return Object.assign({ x: home.x, y: home.y, queue: [], carry: null, frame: 0, banana: 0, walking: false }, prev || {}, a, { home });
    });
  }
  function setState(name, state) { const a = agents.find(x => x.name === name); if (a) a.state = state; }
  function envelope(kind, name) {
    const a = agents.find(x => x.name === name); if (!a) return;
    if (kind === 'in') a.queue.push({ walk: { x: TRAY_IN.x + S(36), y: TRAY_IN.y + S(8) } }, { pick: 'env' }, { walk: a.home }, { drop: true });
    else if (kind === 'out') a.queue.push({ pick: 'env' }, { walk: { x: TRAY_OUT.x - S(16), y: TRAY_OUT.y + S(8) } }, { drop: true }, { walk: a.home });
    else if (kind === 'banana') a.banana = 600;
  }

  // площадь пола для прогулок котов — считается от LW/LH, не от текущих чисел
  const catMinX = Math.round(LW * 0.03), catMaxX = LW - Math.round(LW * 0.03);
  const catMinY = Math.round(LH * 0.32), catMaxY = LH - Math.round(LH * 0.05);
  function catRandomPoint() { return { x: catMinX + Math.random() * (catMaxX - catMinX), y: catMinY + Math.random() * (catMaxY - catMinY) }; }
  // лежанка в углу — коты иногда выбирают её вместо случайной точки и охотнее ложатся, оказавшись там
  const catBed = { x: catMinX + 22, y: catMaxY - 8 };
  function catNextTarget() { return Math.random() < 0.22 ? catBed : catRandomPoint(); }
  function makeCat(colors) {
    const start = catRandomPoint();
    return {
      x: start.x, y: start.y, target: catNextTarget(), dir: 1, walking: false, lying: false, lieTimer: 0, meow: 0,
      phase: Math.random() * Math.PI * 2, colors,
      // прыжок на стол: deskGoal — имя агента-владельца стола (не ссылка на объект — agents пересоздаётся
      // при каждом setAgents, ссылка на старый объект «протухнет»), deskApproach/deskTop — точки на полу
      // перед столом и на столешнице, посчитанные один раз в момент выбора стола
      deskGoal: null, deskSide: 1, deskApproach: null, deskTop: null, deskPose: 'sit', deskTimer: 0, jump: null, onDesk: false,
    };
  }
  const cats = [
    makeCat({ f: '#e8823c', y: '#2f6b3a', n: '#d9536b', k: '#5a3a1f', w: '#fff3e0' }), // рыжий
    makeCat({ f: '#9099a6', y: '#e2c94a', n: '#d9536b', k: '#454b55', w: '#eef1f4' }), // серый
  ];

  // ---- «запрыгнуть на стол»: не чаще ~раза в 20–40 сек на кота (шанс проверяется, только пока кот
  // свободно гуляет — попытка «влезает» в общий бюджет, а не добавляется поверх него), столы —
  // эксклюзивно: имя стола резервируется в cat.deskGoal на всё время визита
  const CAT_DESK_CHANCE = 0.00055;              // ~1/1820 тиков ⇒ в среднем раз в ~30с при 60fps
  const CAT_DESK_X_OFFSET = 32;                 // от центра стола вбок — за пределами монитора (±15), у края столешницы (±42)
  const CAT_DESK_APPROACH_Y_OFFSET = 10;         // точка на полу перед столом
  const CAT_DESK_TOP_Y_OFFSET = -4;              // точка на столешнице (у переднего края)
  const CAT_DESK_SIT_MIN = 150, CAT_DESK_SIT_RANGE = 180; // 2.5–5.5с на столе при 60fps
  const CAT_JUMP_ARC = 10;                      // высота дуги прыжка сверх прямой линии
  const CAT_JUMP_STEP_TICKS = 6;                // держим каждый кадр дуги ~0.1с при 60fps
  const CAT_JUMP_UP_STEPS = 4;                  // 3–4 кадра подъёма по параболе
  const CAT_JUMP_DOWN_STEPS = 3;                // кадры спрыгивания вниз

  function pickFreeDesk() {
    if (!agents.length) return null;
    const free = agents.filter(x => !cats.some(c => c.deskGoal === x.name));
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }
  function startCatDeskTrip(cat) {
    const desk = pickFreeDesk(); if (!desk) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    cat.deskGoal = desk.name;
    cat.deskSide = side;
    cat.deskApproach = { x: desk.home.x + side * CAT_DESK_X_OFFSET, y: desk.home.y + CAT_DESK_APPROACH_Y_OFFSET };
    cat.deskTop = { x: desk.home.x + side * CAT_DESK_X_OFFSET, y: desk.home.y + CAT_DESK_TOP_Y_OFFSET };
    cat.target = cat.deskApproach;
  }
  function startCatJump(cat, phase) {
    const up = phase === 'up';
    cat.jump = { phase, from: { x: cat.x, y: cat.y }, to: up ? cat.deskTop : cat.deskApproach, step: 0, t: 0, steps: up ? CAT_JUMP_UP_STEPS : CAT_JUMP_DOWN_STEPS };
    cat.walking = false;
  }
  // прыжок анимируется отдельными «застывающими» кадрами (как шаги ходьбы), а не покадровой физикой —
  // каждый кадр сдвигает кота на очередную точку параболы; итог — короткая дуга без телепортации
  function stepCatJump(cat) {
    const j = cat.jump; j.t++;
    const idx = Math.min(j.steps, Math.floor(j.t / CAT_JUMP_STEP_TICKS) + 1);
    if (idx !== j.step) {
      j.step = idx;
      const p = idx / j.steps, arc = Math.sin(p * Math.PI) * CAT_JUMP_ARC;
      cat.x = j.from.x + (j.to.x - j.from.x) * p;
      cat.y = j.from.y + (j.to.y - j.from.y) * p - arc;
    }
    if (j.t >= j.steps * CAT_JUMP_STEP_TICKS) {
      cat.x = j.to.x; cat.y = j.to.y; cat.jump = null;
      if (j.phase === 'up') { cat.onDesk = true; cat.deskPose = Math.random() < 0.5 ? 'sit' : 'lie'; cat.deskTimer = CAT_DESK_SIT_MIN + Math.random() * CAT_DESK_SIT_RANGE; }
      else { cat.onDesk = false; cat.deskGoal = null; cat.target = catNextTarget(); }
    }
  }

  function stepCat(cat) {
    if (cat.jump) { stepCatJump(cat); return; }
    if (cat.onDesk) {
      cat.deskTimer--;
      if (cat.deskTimer <= 0) startCatJump(cat, 'down');
    } else if (cat.lying) {
      cat.lieTimer--;
      if (cat.lieTimer <= 0) { cat.lying = false; cat.target = catNextTarget(); }
    } else {
      if (!cat.deskGoal && Math.random() < CAT_DESK_CHANCE) startCatDeskTrip(cat);
      const dx = cat.target.x - cat.x, dy = cat.target.y - cat.y, dist = Math.hypot(dx, dy);
      if (dist < 1) {
        cat.x = cat.target.x; cat.y = cat.target.y; cat.walking = false;
        if (cat.deskGoal) { startCatJump(cat, 'up'); }
        else {
          const atBed = Math.abs(cat.x - catBed.x) < 3 && Math.abs(cat.y - catBed.y) < 3;
          if (Math.random() < (atBed ? 0.8 : 0.3)) { cat.lying = true; cat.lieTimer = 180 + Math.random() * 240; }
          else cat.target = catNextTarget();
        }
      } else {
        const v = 0.9; cat.x += dx / dist * v; cat.y += dy / dist * v; cat.walking = true; cat.dir = dx < 0 ? -1 : 1;
      }
    }
    if (cat.meow > 0) cat.meow--;
    else if (Math.random() < 0.0006) cat.meow = 70 + Math.random() * 50;
  }

  function drawCats(t, filter) { for (const cat of cats) if (!filter || filter(cat)) drawCat(cat, t); }
  function drawCat(cat, t) {
    let rows = CAT_STAND;
    if (cat.jump) rows = CAT_JUMP;
    else if (cat.onDesk) rows = cat.deskPose === 'lie' ? CAT_LIE : CAT_STAND;
    else if (cat.lying) rows = CAT_LIE;
    else if (cat.walking) rows = Math.floor(t / 130) % 2 ? CAT_WALK1 : CAT_WALK2;
    const w = rows[0].length, h = rows.length;
    const x = Math.round(cat.x) - Math.round(w / 2), y = Math.round(cat.y) - h;
    // тень — на полу или на столе; в прыжке не рисуем (кот в воздухе)
    if (!cat.jump) { o.fillStyle = 'rgba(0,0,0,0.25)'; o.fillRect(x + 1, y + h, Math.max(1, w - 2), 1); }
    // хвост — плавная синусоида по фазе t, без телепортации/рывков; поджат в прыжке
    if (!cat.lying && !cat.jump) {
      const wag = Math.sin(t / 260 + cat.phase) * 2.8;
      const tailX = cat.dir === -1 ? x + w : x - 1;
      const tailY = y + Math.round(h * 0.4 + wag);
      o.fillStyle = cat.colors.f; o.fillRect(tailX, tailY, 2, 4);
    }
    if (cat.dir === -1) { o.save(); o.translate(x * 2 + w, 0); o.scale(-1, 1); sprite(rows, x, y, cat.colors); o.restore(); }
    else sprite(rows, x, y, cat.colors);
    if (cat.meow > 0) drawMeowBubble(cat, y);
  }
  function drawMeowBubble(cat, topY) {
    const bw = 40, bh = 20;
    const bx = Math.round(cat.x) - Math.round(bw / 2), by = topY - bh - 10;
    o.fillStyle = '#1c2433'; o.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    o.fillStyle = '#ffffff'; o.fillRect(bx, by, bw, bh);
    const tipX = Math.round(cat.x) + (cat.dir === -1 ? -4 : 4);
    o.fillRect(tipX - 4, by + bh, 8, 2); o.fillRect(tipX - 2, by + bh + 2, 4, 2); o.fillRect(tipX, by + bh + 4, 2, 2);
    o.save();
    o.font = '11px "Pixelify Sans", monospace'; o.textAlign = 'center'; o.textBaseline = 'middle';
    o.fillStyle = '#1c2433'; o.fillText('мяу', bx + bw / 2, by + bh / 2 + 1);
    o.restore();
  }

  function step(a) {
    if (a.wait > 0) { a.wait--; return; }
    const act = a.queue[0]; if (!act) { a.walking = false; return; }
    if (act.walk) {
      const dx = act.walk.x - a.x, dy = act.walk.y - a.y, dist = Math.hypot(dx, dy);
      if (dist < 1) { a.x = act.walk.x; a.y = act.walk.y; a.queue.shift(); a.walking = false; return; }
      const v = 1.8; a.x += dx / dist * v; a.y += dy / dist * v; a.walking = true; a.dir = dx < 0 ? -1 : 1;
    } else if (act.pick) { a.carry = act.pick; a.wait = 18; a.queue.shift(); }
    else if (act.drop) { a.carry = null; a.wait = 12; a.queue.shift(); }
  }

  // ---------------------------------------------------------------- отрисовка
  let bgImg = null; // фон-картинка (прототип выбора фона), null = рисованный этаж
  function setBackground(url) {
    if (!url) { bgImg = null; return; }
    const im = new Image(); im.onload = () => { bgImg = im; }; im.src = url;
  }
  function drawWorld(t) {
    if (bgImg) { // картинка вместо пола/стены; мебель и люди рисуются поверх
      o.drawImage(bgImg, 0, 0, LW, LH);
      sprite(CAT_BED, Math.round(catBed.x - 7), Math.round(catBed.y - 5));
      return;
    }
    // пол — плитка
    for (let y = 80; y < LH; y += 16) for (let x = 0; x < LW; x += 16) {
      o.fillStyle = ((x + y) / 16) % 2 ? TH.floor1 : TH.floor2; o.fillRect(x, y, 16, 16);
    }
    // стена с окнами
    o.fillStyle = TH.wall; o.fillRect(0, 0, LW, 80); o.fillStyle = TH.wallLine; o.fillRect(0, 76, LW, 4);
    for (let x = 24; x < LW - 40; x += 80) {
      o.fillStyle = TH.win; o.fillRect(x, 16, 44, 36); o.fillStyle = TH.winLite; o.fillRect(x + 4, 20, 16, 12); o.fillRect(x + 24, 20, 16, 12);
      o.fillStyle = TH.winLite; o.globalAlpha = 0.7; o.fillRect(x + 4, 36, 16, 12); o.fillRect(x + 24, 36, 16, 12); o.globalAlpha = 1;
    }
    sprite(CLOCK, 159, 20, null, HS); // часы на стене между окнами
    sprite(PLANT, LW - 28, 60, null, HS); sprite(PLANT, 8, 60, null, HS);
    sprite(COOLER, 44, 84, null, HS);          // кулер с бутылкой
    sprite(CABINET, 200, 84, null, HS);        // шкаф-стеллаж с папками
    sprite(COFFEE_MACHINE, 420, 84, null, HS); // кофемашина на тумбе
    // коврик у входа
    o.fillStyle = TH.rugEdge; o.fillRect(228, 244, 56, 26);
    o.fillStyle = TH.rug; o.fillRect(232, 248, 48, 18);
    o.fillStyle = TH.rugEdge;
    for (let sx = 236; sx < 276; sx += 10) o.fillRect(sx, 252, 4, 10);
    sprite(CAT_BED, Math.round(catBed.x - 7), Math.round(catBed.y - 5)); // лежанка котов в углу
    // лотки
    sprite(TRAY, TRAY_IN.x, TRAY_IN.y, null, HS); sprite(TRAY, TRAY_OUT.x, TRAY_OUT.y, null, HS);
    o.fillStyle = TH.tray; o.fillRect(TRAY_IN.x + S(2), TRAY_IN.y - S(6), S(28), S(4));
    o.fillStyle = TH.tray2; o.fillRect(TRAY_OUT.x + S(2), TRAY_OUT.y - S(6), S(28), S(4));
    // офисные коты, гуляющие по полу — до столов/подписей; коты в прыжке или уже на столе рисуются позже, поверх стола и человека
    drawCats(t, c => !c.jump && !c.onDesk);
    // столы (сначала — что позади человечка: стул, монитор), потом человечек, потом стол поверх ног
    for (const a of agents) {
      const on = a.state === 'working';
      sprite(CHAIR, a.home.x - S(4), a.home.y - S(6), null, HS);
      sprite(on ? MONITOR_ON : MONITOR_OFF, a.home.x - S(10), a.home.y - S(44), null, HS);
      if (on && Math.floor(t / 120) % 2) { o.fillStyle = '#9cc4ff'; o.fillRect(a.home.x - S(6), a.home.y - S(40), S(6), S(2)); o.fillRect(a.home.x - S(6), a.home.y - S(36), S(10), S(2)); }
      if (a.state === 'planning') sprite(BOARD, a.home.x - S(16), a.home.y - S(72), null, HS);
      if (a.banana > 0) sprite(DOC_ICON, a.home.x + S(16), a.home.y - S(16), null, HS);
    }
    for (const a of agents) drawHuman(a, t);
    for (const a of agents) sprite(DESK, a.home.x - S(28), a.home.y - S(8), null, HS);
    // коты, запрыгнувшие на стол (или летящие туда/обратно) — поверх стола и человека
    drawCats(t, c => c.jump || c.onDesk);
    // подписи
    o.font = '600 14px "Pixelify Sans", monospace'; o.textAlign = 'center'; o.textBaseline = 'top';
    for (const a of agents) {
      o.fillStyle = TH.text; o.fillText(a.title.split('·')[0].trim(), a.home.x, a.home.y + S(6));
      o.fillStyle = TH.mute; o.font = '13px "Pixelify Sans", monospace'; o.fillText({ idle: 'свободен', working: 'работает', review: 'ждёт ревью', planning: 'планирует' }[a.state] || a.state, a.home.x, a.home.y + S(24)); o.font = '600 14px "Pixelify Sans", monospace';
    }
    o.font = '600 14px "Pixelify Sans", monospace';
    o.fillStyle = TH.tray; o.fillText('задачи', TRAY_IN.x + S(16), TRAY_IN.y + S(14));
    o.fillStyle = TH.tray2; o.fillText('ревью', TRAY_OUT.x + S(16), TRAY_OUT.y + S(14));
  }

  function drawHuman(a, t) {
    const i = agents.indexOf(a);
    const style = i % HAIRSTYLES.length, hair = HAIR_COLORS[i % HAIR_COLORS.length];
    const colors = { f: a.color, e: shade(a.color, 0.72), h: hair, s: P.s, d: P.d, k: P.k };
    let pose = 'stand';
    if (a.walking) pose = Math.floor(t / 140) % 2 ? 'walk1' : 'walk2';
    else if (a.state === 'working' && !a.queue.length) pose = Math.floor(t / 160) % 2 ? 'type1' : 'type2';
    const rows = humanRows(pose, style);
    const { w, h } = spriteSize(rows, HS);
    const x = Math.round(a.x) - Math.round(w / 2), y = Math.round(a.y) - h - S(8);
    // тень
    o.fillStyle = 'rgba(0,0,0,0.25)'; o.fillRect(x + S(3), y + S(25), S(10), S(2));
    if (a.dir === -1) { o.save(); o.translate(x * 2 + S(15), 0); o.scale(-1, 1); sprite(rows, x, y, colors, HS); o.restore(); }
    else sprite(rows, x, y, colors, HS);
    if (a.carry === 'env') sprite(ENVELOPE, x + (a.dir === -1 ? -S(12) : S(16)), y + S(14), null, HS);
    if (a.state === 'review' && !a.queue.length) sprite(ARM_DOC, x + (a.dir === -1 ? -S(6) : S(15)), y - S(2), { f: a.color, s: P.s }, HS);
    if (a.state === 'idle' && !a.walking && Math.floor(t / 2800) % 4 === 0 && (t % 2800) < 120) {
      // моргание — закрываем глаза цветом кожи, позиция глаз считается через тот же масштаб, что и весь спрайт
      o.fillStyle = P.s;
      const eye1 = pixelBox(6, 4, HS), eye2 = pixelBox(9, 4, HS);
      o.fillRect(x + eye1.x, y + eye1.y, eye1.w, eye1.h);
      o.fillRect(x + eye2.x, y + eye2.y, eye2.w, eye2.h);
    }
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

  window.Floor = { setAgents, setState, envelope, setBackground, setTheme(t) { TH = Object.assign({}, TH, t); } };
  document.fonts && document.fonts.load('8px "Pixelify Sans"').catch(() => {});
  requestAnimationFrame(frame);
})();
