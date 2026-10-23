/* Пиксельный офис. Логическое разрешение 768×432 «пикселей», рисуется в offscreen-canvas
   и масштабируется целым числом без сглаживания — так пиксели остаются чёткими.
   Люди сидят на своих местах (a.home) и не ходят — задача/документ прилетают на стол короткой
   анимацией (envelope), а сидячая поза меняется по a.state (idle/working/review/planning/failed/done).
   Тема cyberpunk рисует отдельную ночную сцену вместо старого рисованного этажа (arcade/gameboy). */
(function () {
  const hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  const canvas = hasDOM ? document.getElementById('floor-canvas') : null;
  const ctx = canvas ? canvas.getContext('2d') : null;
  const LW = 768, LH = 432;
  const off = hasDOM ? document.createElement('canvas') : null;
  if (off) { off.width = LW; off.height = LH; }
  const o = off ? off.getContext('2d') : null;
  let W = 0, H = 0, scale = 1, ox = 0, oy = 0;
  let TH = { floor1: '#1a2231', floor2: '#182030', wall: '#243049', wallLine: '#1d2740', win: '#5b7fb4', winLite: '#8fb3e6', desk: '#3a465c', deskTop: '#2c364a', text: '#e6edf3', mute: '#8a93a3', tray: '#f05a46', tray2: '#5acd96', rug: '#2f3b52', rugEdge: '#44536d' };
  let THEME_NAME = 'arcade'; // имя текущей темы — определяет, рисовать старую сцену или cyberpunk
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

  // ---------------------------------------------------------------- именные персонажи (michael/dwight/pam/ralph)
  // четыре агента получают собственный силуэт/палитру вместо процедурной причёски — по описаниям cyberpunk-портретов
  // (ui/assets/portraits/*.png). Для незнакомых имён используется прежний генератор (HAIRSTYLES/FACE_ROWS выше).
  const CHAR_PALETTE = {
    // Майкл: тёмная кожаная куртка (jacket), голубой акцент воротника (neon) — цвет его карточки в roster.py (#4f8cff)
    michael: { skin: P.s, hair: '#2e2013', eye: '#4fa8ff', jacket: '#241a15', neon: '#5fa6ff' },
    // Дуайт: оливковый QA-жилет вместо куртки, янтарный глаз — цвет его карточки (#ff9a3c); implant-акценты ниже уже тёплого/бирюзового
    dwight: { skin: '#dfe4ec', hair: '#dfe4ec', eye: '#ff9a3c', jacket: '#4b5245', neon: '#3fe0c8', emblem: '#c7ccd3' },
    // Пэм: тёплый кардиган вместо чёрной куртки, каштановые волосы в пучке — её цвет (#ff4fa3) остался на пуговице/блике
    pam: { skin: P.s, hair: '#6b3d2e', eye: '#5a8a52', jacket: '#b5607d', neon: '#ff8fc4', shoulder: '#ff4fa3' },
    // корги-докладчик: рыжая шерсть (hair) на ушах/щеках, кремово-белая (skin/jacket) на морде и теле —
    // portrait ui/assets/portraits/ralph.png того же рыже-белого окраса
    ralph: { skin: '#f6e2c4', hair: '#c9772f', eye: '#3a2712', jacket: '#f5ead9' },
  };
  const CHAR_HAIRSTYLES = {
    michael: [ // длинные тёмно-каштановые волосы, зачёсаны назад — закрывают весь верх головы
      rb(['.', 1], ['h', 14], ['.', 1]),
      rb(['h', 16]),
      rb(['h', 16]),
    ],
    dwight: [ // лысый — силуэт скальпа залит цветом кожи (CHAR_PALETTE.dwight.hair === .skin), имплант рисуется поверх отдельно
      rb(['.', 5], ['h', 6], ['.', 5]),
      rb(['.', 3], ['h', 10], ['.', 3]),
      rb(['.', 2], ['h', 12], ['.', 2]),
    ],
    pam: [ // каштановые волосы, собранные в пучок — небольшая шишка на самой макушке, ниже обычная
      // причёска во всю ширину головы (как у dwight/generic), без выбритого виска
      rb(['.', 6], ['h', 4], ['.', 6]),
      rb(['.', 2], ['h', 12], ['.', 2]),
      rb(['.', 1], ['h', 14], ['.', 1]),
    ],
    ralph: [ // стоячие остроконечные уши корги: узкие рыжие кончики сверху, у основания шире с белой
      // внутренней стороной ('w' — не входит в CHAR_PALETTE, берётся из общей палитры P как обычный белый)
      rb(['.', 2], ['h', 1], ['.', 10], ['h', 1], ['.', 2]),
      rb(['.', 1], ['h', 2], ['.', 9], ['h', 2], ['.', 2]),
      rb(['h', 2], ['w', 1], ['.', 10], ['w', 1], ['h', 2]),
    ],
  };
  // общие лицевые ряды для именных персонажей — глаза получают отдельный цветовой код 'z' (голубой/жёлтый/бирюзовый),
  // а не общий 'd' (тёмный — им остаются только рот и обувь)
  const CHAR_FACE_ROWS = FACE_ROWS.map((row, idx) => idx === 1
    ? rb(['.', 1], ['h', 2], ['.', 1], ['s', 2], ['z', 1], ['s', 2], ['z', 1], ['s', 2], ['.', 1], ['h', 2], ['.', 1])
    : row);
  // борода Майкла — щёки/подбородок перекрашены в цвет волос (код h), рот остаётся тёмным по центру
  const MICHAEL_FACE_ROWS = [
    CHAR_FACE_ROWS[0], CHAR_FACE_ROWS[1],
    rb(['.', 2], ['h', 1], ['.', 1], ['h', 2], ['s', 4], ['h', 2], ['.', 1], ['h', 1], ['.', 2]),
    rb(['.', 4], ['h', 3], ['d', 2], ['h', 3], ['.', 4]),
    rb(['.', 4], ['h', 2], ['s', 4], ['h', 2], ['.', 4]),
  ];
  const CHAR_HEADS = {
    michael: CHAR_HAIRSTYLES.michael.concat(MICHAEL_FACE_ROWS),
    dwight: CHAR_HAIRSTYLES.dwight.concat(CHAR_FACE_ROWS),
    pam: CHAR_HAIRSTYLES.pam.concat(CHAR_FACE_ROWS),
    ralph: CHAR_HAIRSTYLES.ralph.concat(CHAR_FACE_ROWS),
  };
  function characterFor(name) { return Object.prototype.hasOwnProperty.call(CHAR_PALETTE, name) ? name : null; }
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
  // откинулся в кресле (review): руки заведены за голову — кисти видны у самых плеч, а не по бокам
  const TORSO_LEAN = [rb(['e', 1], ['s', 2], ['.', 1], ['f', 8], ['.', 1], ['s', 2], ['e', 1])].concat(TORSO.slice(1));
  // обхватил голову руками (failed): кисти подняты к лицу, у нижнего края головы
  const TORSO_FAILED = [rb(['e', 2], ['s', 3], ['.', 6], ['s', 3], ['e', 2])].concat(TORSO.slice(1));
  // жест «победа» сидя (done): руки прямо вверх, кисти над плечами
  const TORSO_DONE = [rb(['s', 2], ['e', 1], ['f', 10], ['e', 1], ['s', 2])].concat(TORSO.slice(1));
  // ноги: k — брюки, d — обувь (ходьбы больше нет — люди всегда сидят/стоят на своём месте, поза только одна)
  const LEGS_BODY = [rb(['f', 16])].concat(Array(7).fill(rb(['k', 6], ['.', 4], ['k', 6])));
  const LEGS_STAND = LEGS_BODY.concat([rb(['d', 6], ['.', 4], ['d', 6]), rb(['d', 6], ['.', 4], ['d', 6])]);

  function humanRows(pose, head) {
    if (pose === 'type1') return head.concat(TORSO_TYPE1, LEGS_STAND);
    if (pose === 'type2') return head.concat(TORSO_TYPE2, LEGS_STAND);
    if (pose === 'lean') return head.concat(TORSO_LEAN, LEGS_STAND);
    if (pose === 'failed') return head.concat(TORSO_FAILED, LEGS_STAND);
    if (pose === 'done') return head.concat(TORSO_DONE, LEGS_STAND);
    return head.concat(TORSO, LEGS_STAND);
  }

  const DESK = scale2(['tttttttttttttttttttttttttttt', 'tTTTTTTTTTTTTTTTTTTTTTTTTTTt', 'tTTTTTTTTTTTTTTTTTTTTTTTTTTt', '.tt......................tt.', '.tt......................tt.']);
  const CHAIR = ['.tttttt.', '.tTTTTt.', '.tTTTTt.', '.tttttt.', '..t..t..', '..t..t..']; // стул позади стола
  const MONITOR_ON = scale2(['kkkkkkkkkk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kbbbbbbbbk', 'kkkkkkkkkk', '....kk....', '...kkkk...']);
  const MONITOR_OFF = MONITOR_ON.map(r => r.replace(/b/g, 'T'));
  const ENVELOPE = scale2(['wwwwww', 'wdwwdw', 'wwddww', 'wwwwww']);
  const PLANT = scale2(['..pp..', '.pqpp.', 'pqppqp', '.ppqp.', '..tt..', '.tttt.']);
  const BOARD = scale2(['tttttttttttttttt', 'tyyyyyyyyyyyyyyt', 'tydyyydydyyydyyt', 'tyyyyyyyyyyyyyyt', 'tydydyyydyyydyyt', 'tyyyyyyyyyyyyyyt', 'tttttttttttttttt']);
  // документ с галочкой — прилетает на стол короткой анимацией (envelope('out'/'banana', name))
  const DOC_ICON = ['wwwwww', 'wddddw', 'wwwwww', 'wdddw.', 'wwwwww', 'wwwggw'];

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
  const DESK_HOME_Y = 288;
  let agents = [];   // {name,title,color,state, x,y, home:{x,y}, frame, mail:null} — люди больше не ходят, стоят на home
  // формула столов для рисованного этажа (arcade/gameboy) — не задевает декоративную мебель cyberpunk-сцены
  const deskX = (i, n) => Math.round(LW / 2 + (i - (n - 1) / 2) * Math.min(255, (LW - 150) / Math.max(1, n)));

  // ---------------------------------------------------------------- препятствия cyberpunk-сцены и обход их чистыми функциями
  // прямоугольники декоративной мебели новой сцены: стеллаж, колонна, два кресла, декоративный стол, растение —
  // используются и для расстановки столов агентов, и для проверки точек ходьбы людей/котов
  function sceneObstacleRects() {
    return [
      { x: 0, y: 160, w: 86, h: 100 },    // стеллаж у левой стены
      { x: 682, y: 160, w: 86, h: 100 },  // колонна у правой стены
      { x: 110, y: 300, w: 100, h: 90 },  // кресло слева
      { x: 558, y: 300, w: 100, h: 90 },  // кресло справа
      { x: 300, y: 190, w: 170, h: 70 },  // декоративный стол с мониторами
      { x: 246, y: 210, w: 50, h: 110 },  // растение в кадке
    ];
  }
  function isInsideObstacle(point, rects) {
    return (rects || []).some(r => point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h);
  }
  // сдвигает точку наружу через ближайшую грань прямоугольника — не pathfinding, просто «не попадать внутрь»
  function pushOutsideRect(point, r) {
    const dLeft = point.x - r.x, dRight = (r.x + r.w) - point.x, dTop = point.y - r.y, dBottom = (r.y + r.h) - point.y;
    const m = Math.min(dLeft, dRight, dTop, dBottom);
    if (m === dLeft) return { x: r.x - 1, y: point.y };
    if (m === dRight) return { x: r.x + r.w + 1, y: point.y };
    if (m === dTop) return { x: point.x, y: r.y - 1 };
    return { x: point.x, y: r.y + r.h + 1 };
  }
  function pointOutsideObstacles(point, rects) {
    let p = point;
    for (const r of (rects || [])) if (isInsideObstacle(p, [r])) p = pushOutsideRect(p, r);
    return p;
  }
  // полосы, в которых расставляются столы агентов на cyberpunk-сцене: один ряд для ≤3, два ряда для 4–6
  const CYBER_DESK_BANDS = {
    single: { y: 372, x0: 230, x1: 538 },
    row1: { y: 350, x0: 230, x1: 538 },
    row2: { y: 410, x0: 150, x1: 618 },
  };
  // footprint стола вокруг точки home — тот же прямоугольник, что рисует drawActors() через
  // sprite(DESK, home.x - S(28), home.y - S(8), ..., HS): половина ширины по x, отступы вверх/вниз по y.
  // Нужен, чтобы проверять препятствия по фактическому прямоугольнику стола, а не только по точке home —
  // иначе стол мог «повиснуть» над препятствием, даже если сама точка home снаружи (старый баг).
  const DESK_FOOT = (() => {
    const size = spriteSize(DESK, HS);
    return { halfW: size.w / 2, top: S(8), bottom: size.h - S(8) };
  })();
  const DESK_MIN_GAP = spriteSize(DESK, HS).w; // минимальное расстояние между соседними столами — не меньше ширины стола
  // раздувает препятствие на половину ширины стола по x и на верхний/нижний отступ по y (сумма Минковского) —
  // после этого достаточно оттолкнуть от раздутого прямоугольника саму точку home, чтобы весь прямоугольник
  // стола оказался снаружи исходного препятствия
  function inflateRectForDesk(r) {
    return { x: r.x - DESK_FOOT.halfW, y: r.y - DESK_FOOT.bottom, w: r.w + DESK_FOOT.halfW * 2, h: r.h + DESK_FOOT.top + DESK_FOOT.bottom };
  }
  // раздвигает столы одного ряда так, чтобы соседние не пересекались (сортировка по x не нужна — точки
  // ряда уже строятся по возрастанию x), и повторно проверяет препятствия — сдвиг вправо мог вернуть точку в одно из них
  function enforceRowSpacing(points, inflatedObstacles) {
    for (let i = 1; i < points.length; i++) {
      const minX = points[i - 1].x + DESK_MIN_GAP;
      if (points[i].x < minX) points[i] = pointOutsideObstacles({ x: minX, y: points[i].y }, inflatedObstacles);
    }
    return points;
  }
  function computeDeskPositions(n, obstacles) {
    obstacles = obstacles || [];
    const inflated = obstacles.map(inflateRectForDesk);
    const rows = n <= 3
      ? [{ count: n, band: CYBER_DESK_BANDS.single }]
      : [{ count: Math.ceil(n / 2), band: CYBER_DESK_BANDS.row1 }, { count: Math.floor(n / 2), band: CYBER_DESK_BANDS.row2 }];
    const positions = [];
    for (const row of rows) {
      const { count, band } = row;
      if (!count) continue;
      let rowPoints = [];
      for (let i = 0; i < count; i++) {
        const x = Math.round(count === 1 ? (band.x0 + band.x1) / 2 : band.x0 + (band.x1 - band.x0) * i / (count - 1));
        rowPoints.push(pointOutsideObstacles({ x, y: band.y }, inflated));
      }
      positions.push(...enforceRowSpacing(rowPoints, inflated));
    }
    return positions;
  }
  function computeHomes(n) {
    // раскладка станций теперь всегда идёт через изометрическую сетку (ISO.stationsFor) — старая ветка
    // THEME_NAME==='cyberpunk' (computeDeskPositions/sceneObstacleRects) больше не используется для
    // реальной расстановки, но сами эти функции остаются экспортированными и протестированными как есть.
    // home несёт и пиксельный якорь (x,y — для конвертов/подписей/речевых пузырей), и исходные grid-
    // координаты (gx,gy — для отрисовки изо-стола и билборда персонажа в drawActors)
    return ISO.stationsFor(n).map(({ gx, gy }) => {
      const p = ISO.anchorFor(gx, gy);
      return { x: p.x, y: p.y, gx, gy };
    });
  }

  function setAgents(list) {
    const n = list.length;
    const homes = computeHomes(n);
    agents = list.map((a, i) => {
      const prev = agents.find(x => x.name === a.name);
      const home = homes[i];
      return Object.assign({ x: home.x, y: home.y, frame: 0, mail: null, speech: null }, prev || {}, a, { home });
    });
  }
  function setState(name, state) { const a = agents.find(x => x.name === name); if (a) a.state = state; }
  // конверт/документ прилетает прямо на стол агента короткой анимацией — без похода к лоткам:
  // envelope() лишь заводит временное поле a.mail (тип + счётчик кадров), drawActors рисует его у a.home
  // несколько кадров (с коротким «падением» сверху) и гасит, когда кадры кончаются
  const MAIL_SPECS = {
    in: { sprite: ENVELOPE, life: 40 },     // новая задача — конверт
    out: { sprite: DOC_ICON, life: 40 },    // отправлено на ревью — документ
    banana: { sprite: DOC_ICON, life: 600 }, // одобрено — документ с галочкой лежит на столе подольше
  };
  function envelope(kind, name) {
    const a = agents.find(x => x.name === name); if (!a) return;
    const spec = MAIL_SPECS[kind]; if (!spec) return;
    a.mail = { kind, life: spec.life, total: spec.life };
    // kind 'out' — задача ушла на ревью (task.review), 'banana' — одобрена (task.done): это и есть
    // событийная шина, о которой просила задача — отдельного Floor.notify() не нужно, эти два вызова
    // envelope() уже приходят из app.js на статусы review/done (см. app.js: Floor.envelope('out'/'banana', ...))
    if (kind === 'out' || kind === 'banana') dogReactTo(name);
  }

  // реплика над головой агента на ms миллисекунд (например, Ральф: «Считаю…» / «Сводка готова») —
  // тот же приём, что и a.mail: временное поле, drawActors рисует и гасит его по истечении жизни
  function say(name, text, ms) {
    const a = agents.find(x => x.name === name); if (!a) return;
    a.speech = { text, life: Math.max(1, Math.round((ms || 2000) / 16)) };
  }

  // площадь пола для прогулок котов — считается от LW/LH, не от текущих чисел
  const catMinX = Math.round(LW * 0.03), catMaxX = LW - Math.round(LW * 0.03);
  const catMinY = Math.round(LH * 0.32), catMaxY = LH - Math.round(LH * 0.05);
  function catRandomPoint() {
    const draw = () => ({ x: catMinX + Math.random() * (catMaxX - catMinX), y: catMinY + Math.random() * (catMaxY - catMinY) });
    let p = draw();
    if (THEME_NAME !== 'cyberpunk') return p;
    const rects = sceneObstacleRects();
    // ре-сэмпл — основной способ обойти препятствие; клэмп после нуджа наружу — запасной вариант
    // на случай, если 20 попыток подряд попали в препятствие (у самой стены область прогулки уже с ним пересекается)
    for (let i = 0; i < 20 && isInsideObstacle(p, rects); i++) p = draw();
    if (isInsideObstacle(p, rects)) {
      const q = pointOutsideObstacles(p, rects);
      p = { x: Math.min(catMaxX, Math.max(catMinX, q.x)), y: Math.min(catMaxY, Math.max(catMinY, q.y)) };
    }
    return p;
  }
  // лежанка в углу — коты иногда выбирают её вместо случайной точки и охотнее ложатся, оказавшись там
  const catBed = { x: catMinX + 33, y: catMaxY - 12 };
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
    const approach = { x: desk.home.x + side * CAT_DESK_X_OFFSET, y: desk.home.y + CAT_DESK_APPROACH_Y_OFFSET };
    cat.deskApproach = THEME_NAME === 'cyberpunk' ? pointOutsideObstacles(approach, sceneObstacleRects()) : approach;
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

  // ---------------------------------------------------------------- подгонка сцены под контейнер (letterbox 16:9)
  // чистая функция: масштаб — дробный (не только целые кратные), чтобы сцена вписывалась в контейнер любого
  // размера без обрезки и без искажения пропорций; если дробный масштаб близок к целому — снапаем к целому,
  // чтобы пиксели spriteов оставались ровными (без размытия на дробных долях пикселя)
  function fitScale(W, H, LW, LH) {
    let s = Math.min(W / LW, H / LH);
    const r = Math.round(s);
    if (r > 0 && Math.abs(s - r) < 0.08) s = r;
    s = Math.max(0.5, s);
    return { scale: s, ox: (W - LW * s) / 2, oy: (H - LH * s) / 2 };
  }

  // ---------------------------------------------------------------- подписи с читаемостью на тёмной cyberpunk-сцене
  // на cyberpunk — тёмная обводка под текстом перед заливкой; на arcade/gameboy — как раньше, без обводки
  function drawLabel(text, x, y, color) {
    // тёмная обводка текста всегда (раньше — только на cyberpunk-теме): единая изо-сцена под всеми темами
    // пёстрая и светящаяся местами (неон окон, bloom вывески, хаб), обычный текст без обводки теряется
    o.lineWidth = 3; o.strokeStyle = 'rgba(8,9,20,0.85)'; o.strokeText(text, x, y);
    o.fillStyle = color; o.fillText(text, x, y);
  }

  // ---------------------------------------------------------------- отрисовка
  let bgImg = null; // фон-картинка (прототип выбора фона), null = рисованный этаж
  function setBackground(url) {
    if (!url) { bgImg = null; return; }
    const im = new Image(); im.onload = () => { bgImg = im; }; im.src = url;
  }
  // фон рисуется в мировых координатах offscreen-канваса (768×432) — тогда он масштабируется вместе
  // со сценой через общий drawImage в frame(), а не отдельным CSS background на самом <canvas>.
  // cover: фото обрезается по короткой стороне и центрируется, пропорции фото не искажаются.
  function drawCoverImage(g, img, dx, dy, dw, dh) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const ir = iw / ih, tr = dw / dh;
    let sx, sy, sw, sh;
    if (ir > tr) { sh = ih; sw = sh * tr; sx = (iw - sw) / 2; sy = 0; }
    else { sw = iw; sh = sw / tr; sx = 0; sy = (ih - sh) / 2; }
    g.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  // ---- cyberpunk: ночной кабинет с панорамным окном; статичные слои кэшируются в отдельный canvas
  // и перерисовываются не чаще раза в секунду, поверх каждый кадр идут только дешёвые динамические эффекты
  const CY = {
    skyTop: '#0f1226', skyMid: '#1a1f3a', sunset: '#ff8a5b', sunsetLite: '#ffd27a',
    neonPink: '#ff4fa3', neonBlue: '#4fd8ff', shadow: '#3b2a66',
    frame: '#0a0d1c', frameLite: '#161c36',
    buildingA: '#141a33', buildingB: '#0c0f22', windowLit: '#ffd27a', windowLit2: '#4fd8ff',
    floorA: '#141a30', floorB: '#10152a',
    wood: '#2a1d3a', shelf: '#3b2a55',
    chair: '#5a2450', chairShade: '#421a3c',
    monitorBlue: '#1f3a66',
    plant: '#2f8f5c', plantDark: '#215f3f', pot: '#3a2a1c',
  };
  // рабочие места агентов на cyberpunk-сцене — те же спрайты DESK/CHAIR/MONITOR_ON/OFF (общая геометрия
  // и footprint для computeDeskPositions), но перекрашенные в палитру CY вместо DESK/CHAIR/MONITOR_ON —
  // так стол/кресло/монитор агента выглядят как декоративный стол T в renderCyberStatic
  const CYBER_DESK_COLORS = { t: CY.frame, T: CY.wood };
  const CYBER_CHAIR_COLORS = { t: CY.chairShade, T: CY.chair };
  const CYBER_MONITOR_COLORS = { k: CY.frame, b: CY.monitorBlue, T: CY.buildingB };
  const WINDOW_BOTTOM = 144, SILL_Y = 144, SILL_H = 10, NEON_Y = SILL_Y + SILL_H;
  function generateBuildings() {
    const list = []; let x = 0;
    while (x < LW) {
      const w = 40 + Math.floor(Math.random() * 46);
      const h = 30 + Math.floor(Math.random() * 90);
      const windows = [];
      for (let wy = 6; wy < h - 6; wy += 10) for (let wx = 6; wx < w - 6; wx += 10) {
        if (Math.random() < 0.35) windows.push({ x: wx, y: wy, w: 4, h: 5, lit: Math.random() < 0.6 });
      }
      list.push({ x, w, h, windows, shade: list.length % 2 });
      x += w + 6 + Math.floor(Math.random() * 12);
    }
    return list;
  }
  const CYBER_BUILDINGS = generateBuildings();
  let cyberStatic = null, cyberStaticAt = -Infinity;
  let cyberFlashes = [];

  function renderCyberStatic(g) {
    g.clearRect(0, 0, LW, LH);
    const sky = g.createLinearGradient(0, 0, 0, WINDOW_BOTTOM);
    sky.addColorStop(0, CY.skyTop); sky.addColorStop(0.55, CY.skyMid); sky.addColorStop(1, CY.sunset);
    g.fillStyle = sky; g.fillRect(0, 0, LW, WINDOW_BOTTOM);
    g.fillStyle = CY.sunset; g.globalAlpha = 0.5; g.beginPath(); g.arc(150, 108, 34, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    g.fillStyle = CY.sunsetLite; g.beginPath(); g.arc(150, 108, 26, 0, Math.PI * 2); g.fill();
    for (const b of CYBER_BUILDINGS) {
      g.fillStyle = b.shade ? CY.buildingA : CY.buildingB;
      g.fillRect(b.x, WINDOW_BOTTOM - b.h, b.w, b.h);
      for (const win of b.windows) if (win.lit) {
        g.fillStyle = Math.random() < 0.5 ? CY.windowLit : CY.windowLit2;
        g.fillRect(b.x + win.x, WINDOW_BOTTOM - b.h + win.y, win.w, win.h);
      }
    }
    g.fillStyle = CY.frame; g.fillRect(0, 0, LW, 8);
    const sectionW = LW / 5;
    for (let i = 0; i <= 5; i++) g.fillRect(Math.round(i * sectionW) - 3, 0, 6, WINDOW_BOTTOM);
    g.fillStyle = CY.frame; g.fillRect(0, SILL_Y, LW, SILL_H);
    g.fillStyle = CY.neonPink; g.fillRect(0, NEON_Y, LW, 3);
    for (let y = NEON_Y + 3; y < LH; y += 24) for (let x = 0; x < LW; x += 24) {
      g.fillStyle = ((x + y) / 24) % 2 ? CY.floorA : CY.floorB; g.fillRect(x, y, 24, 24);
    }
    const refl = g.createLinearGradient(0, NEON_Y + 3, 0, NEON_Y + 70);
    refl.addColorStop(0, 'rgba(255,79,163,0.18)'); refl.addColorStop(1, 'rgba(255,79,163,0)');
    g.fillStyle = refl; g.fillRect(0, NEON_Y + 3, LW, 70);
    const shadowGrad = g.createLinearGradient(0, LH - 40, 0, LH);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0)'); shadowGrad.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = shadowGrad; g.fillRect(0, LH - 40, LW, 40);

    const [SH, CO, AL, AR, T, PL] = sceneObstacleRects();
    // левый стеллаж с книгами
    g.fillStyle = CY.shelf; g.fillRect(SH.x, SH.y, SH.w, SH.h);
    for (let sy = SH.y + 8; sy < SH.y + SH.h - 6; sy += 22) {
      g.fillStyle = CY.frame; g.fillRect(SH.x + 2, sy, SH.w - 4, 4);
      const books = [CY.neonPink, CY.neonBlue, CY.sunsetLite, CY.shadow, '#8a6d1f'];
      let bx = SH.x + 6;
      while (bx < SH.x + SH.w - 8) { g.fillStyle = books[Math.floor(Math.random() * books.length)]; const bw = 4 + Math.floor(Math.random() * 4); g.fillRect(bx, sy - 14, bw, 14); bx += bw + 2; }
    }
    // правая колонна с неоновым кантом и экраном-автоматом (сам кант пульсирует динамически поверх)
    g.fillStyle = CY.frame; g.fillRect(CO.x, CO.y, CO.w, CO.h);
    g.fillStyle = CY.neonBlue; g.fillRect(CO.x, CO.y, 3, CO.h);
    g.fillStyle = CY.monitorBlue; g.fillRect(CO.x + 14, CO.y + CO.h - 46, 28, 30);
    g.fillStyle = CY.frame; g.fillRect(CO.x + 12, CO.y + CO.h - 16, 32, 10);
    // декоративный длинный стол с двумя мониторами и креслом
    g.fillStyle = CY.wood; g.fillRect(T.x, T.y + T.h - 10, T.w, 10);
    g.fillStyle = CY.frameLite; g.fillRect(T.x + 4, T.y + T.h - 4, 6, 20); g.fillRect(T.x + T.w - 10, T.y + T.h - 4, 6, 20);
    g.fillStyle = CY.frame; g.fillRect(T.x + 14, T.y + 6, 40, 30);
    g.fillStyle = CY.monitorBlue; g.fillRect(T.x + 17, T.y + 9, 34, 22);
    g.fillStyle = CY.frame; g.fillRect(T.x + T.w - 54, T.y + 6, 40, 30);
    g.fillStyle = CY.neonPink;
    for (let i = 0; i < 60; i++) g.fillRect(T.x + T.w - 51 + Math.random() * 34, T.y + 9 + Math.random() * 22, 2, 2);
    g.fillStyle = CY.chairShade; g.fillRect(T.x + T.w / 2 - 8, T.y + T.h + 6, 16, 20);
    g.fillStyle = CY.chair; g.fillRect(T.x + T.w / 2 - 8, T.y + T.h + 6, 16, 6);
    // растение в кадке
    g.fillStyle = CY.pot; g.fillRect(PL.x + 8, PL.y + PL.h - 26, PL.w - 16, 26);
    g.fillStyle = CY.plantDark; g.beginPath(); g.arc(PL.x + PL.w / 2, PL.y + 30, 26, 0, Math.PI * 2); g.fill();
    g.fillStyle = CY.plant;
    g.beginPath(); g.arc(PL.x + PL.w / 2 - 6, PL.y + 22, 20, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(PL.x + PL.w / 2 + 8, PL.y + 26, 18, 0, Math.PI * 2); g.fill();
    // два бордово-фиолетовых кресла по краям сцены
    for (const rect of [AL, AR]) {
      g.fillStyle = CY.chairShade; g.fillRect(rect.x, rect.y + 14, rect.w, rect.h - 14);
      g.fillStyle = CY.chair; g.fillRect(rect.x, rect.y, rect.w, rect.h - 20);
      g.fillStyle = CY.chairShade; g.fillRect(rect.x, rect.y, 12, rect.h - 6); g.fillRect(rect.x + rect.w - 12, rect.y, 12, rect.h - 6);
    }
  }

  function stepCyberFlashes() {
    if (Math.random() < 0.04 && CYBER_BUILDINGS.length) {
      const b = CYBER_BUILDINGS[Math.floor(Math.random() * CYBER_BUILDINGS.length)];
      if (b.windows.length) {
        const win = b.windows[Math.floor(Math.random() * b.windows.length)];
        cyberFlashes.push({ b, win, life: 40 + Math.random() * 50 });
      }
    }
    cyberFlashes = cyberFlashes.filter(f => --f.life > 0);
  }
  function drawCyberDynamicFX(t) {
    stepCyberFlashes();
    o.fillStyle = '#fff2c8';
    for (const f of cyberFlashes) o.fillRect(f.b.x + f.win.x, WINDOW_BOTTOM - f.b.h + f.win.y, f.win.w, f.win.h);
    const pulse = 0.55 + 0.45 * Math.sin(t / 900);
    o.fillStyle = CY.neonPink; o.globalAlpha = pulse; o.fillRect(0, NEON_Y, LW, 3); o.globalAlpha = 1;
    const CO = sceneObstacleRects()[1];
    const pulse2 = 0.5 + 0.5 * Math.sin(t / 700 + 1.3);
    o.fillStyle = CY.neonBlue; o.globalAlpha = pulse2; o.fillRect(CO.x, CO.y, 3, CO.h); o.globalAlpha = 1;
    const reflAlpha = 0.08 + 0.05 * Math.sin(t / 1400);
    o.fillStyle = `rgba(255,79,163,${reflAlpha.toFixed(3)})`; o.fillRect(0, NEON_Y + 3, LW, 70);
  }
  function drawCyberBackground(t) {
    if (!cyberStatic) { cyberStatic = document.createElement('canvas'); cyberStatic.width = LW; cyberStatic.height = LH; }
    if (t - cyberStaticAt >= 1000) { cyberStaticAt = t; renderCyberStatic(cyberStatic.getContext('2d')); }
    o.drawImage(cyberStatic, 0, 0);
    drawCyberDynamicFX(t);
  }

  // ---------------------------------------------------------------- офисный кибер-пёс (третий постоянный питомец)
  // спрайты — тот же приём scale2(), что и у котов: авторим маленькую ASCII-сетку, каждый символ
  // становится блоком 2×2. f — тело, y — глаза, n — нос, k — тёмный ошейник, p — розовый огонёк ошейника.
  const DOG_STAND = scale2(['.f.........f.', '.ff.......ff.', '.fffffffffff.', '.ffyffnffyff.', '.fffkkpkkfff.', '..ff.....ff..']);
  const DOG_WALK1 = scale2(['.f.........f.', '.ff.......ff.', '.fffffffffff.', '.ffyffnffyff.', '.fffkkpkkfff.', '.ff.......ff.']);
  const DOG_WALK2 = scale2(['.f.........f.', '.ff.......ff.', '.fffffffffff.', '.ffyffnffyff.', '.fffkkpkkfff.', '...ff...ff...']);
  const DOG_SIT = scale2(['.f.........f.', '.ff.......ff.', '.fffffffffff.', '.ffyffnffyff.', '.fffkkpkkfff.', '.fffffffffff.', '..ff.....ff..']);
  const DOG_LIE = scale2(['.fffffffffff.', '.ffyffnffyff.', '..fffkpkfff..', '..fffffffff..', '...fffffff...']);
  // палитры: cyberpunk — неоновая (переиспользует CY.neonBlue/neonPink остальной сцены), arcade/gameboy —
  // упрощённый монохромный пёс без свечения (задание допускает это явно)
  const DOG_COLORS_CYBER = { f: '#141c2e', y: CY.neonBlue, n: '#05060c', k: '#05060c', p: '#7a2350' };
  const DOG_COLORS_MONO = { f: '#242e42', y: '#c9d3e0', n: '#0e131e', k: '#0e131e', p: '#0e131e' };
  const DOG_CHASE_RADIUS = 60;          // «кот рядом» — дистанция начала погони
  const DOG_CHASE_COOLDOWN_MS = 120000; // не чаще раза в 2 минуты
  const DOG_ROUTE_MARGIN = 10;          // запас вокруг препятствий при обходе маршрута (чуть больше полутуловища пса)
  const DOG_WALK_SPEED = 1.1, DOG_RUN_SPEED = 2.0; // быстрее кота (v=0.9)
  const DOG_REST_MIN = 180, DOG_REST_RANGE = 150;  // 3–5с при 60fps: пауза у стола / «смотрит вверх» после погони
  const DOG_WAG_TICKS = 120;                        // ~2с виляния хвостом после task.review/task.done
  const DOG_BARK_CHANCE = 0.0004;

  // сегмент p1→p2 пересекает прямоугольник rect? Стандартный slab-метод (без тригонометрии, без сэмплинга) —
  // используется computeDogRoute(), чтобы понять, что прямой путь до цели проходит сквозь мебель.
  function segmentIntersectsRect(p1, p2, rect) {
    let tmin = 0, tmax = 1;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const axes = [[p1.x, dx, rect.x, rect.x + rect.w], [p1.y, dy, rect.y, rect.y + rect.h]];
    for (const [p, d, lo, hi] of axes) {
      if (d === 0) { if (p < lo || p > hi) return false; continue; }
      let t1 = (lo - p) / d, t2 = (hi - p) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    return true;
  }
  function inflateRect(r, margin) { return { x: r.x - margin, y: r.y - margin, w: r.w + margin * 2, h: r.h + margin * 2 }; }
  const ptDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ROUTE_CELL = 24; // размер ячейки сетки для BFS-обхода препятствий — совпадает с шагом клетки пола сцены
  // BFS по грубой сетке 24×24 (768×432 ⇒ 32×18 клеток): надёжнее, чем обход препятствий по их углам
  // (тот подход давал ложные пересечения на почти касательных траекториях и зацикливался между двумя
  // соседними препятствиями) — возвращает центры клеток маршрута без from/to или null, если пути нет
  // (в этой сцене препятствия не образуют замкнутых стен, так что null практически не случается)
  function dogGridRoute(from, to, rects, margin) {
    const inflated = rects.map(r => inflateRect(r, margin));
    const cols = Math.ceil(LW / ROUTE_CELL), rows = Math.ceil(LH / ROUTE_CELL);
    const clamp = (v, max) => Math.min(max - 1, Math.max(0, v));
    const cellOf = p => ({ cx: clamp(Math.floor(p.x / ROUTE_CELL), cols), cy: clamp(Math.floor(p.y / ROUTE_CELL), rows) });
    const cellCenter = c => ({ x: c.cx * ROUTE_CELL + ROUTE_CELL / 2, y: c.cy * ROUTE_CELL + ROUTE_CELL / 2 });
    // клетка «занята», если весь её квадрат (а не только центр) пересекается с раздутым препятствием —
    // тогда прямая между центрами двух СВОБОДНЫХ соседних клеток гарантированно не задевает препятствие
    // (объединение двух соседних клеток — тоже прямоугольник; если бы препятствие резало границу между
    // ними, оно задело бы хотя бы одну из клеток целиком, а не только точку-центр)
    const blocked = (cx, cy) => {
      const cr = { x: cx * ROUTE_CELL, y: cy * ROUTE_CELL, w: ROUTE_CELL, h: ROUTE_CELL };
      return inflated.some(r => cr.x < r.x + r.w && cr.x + cr.w > r.x && cr.y < r.y + r.h && cr.y + cr.h > r.y);
    };
    // from/to — гарантированно свободные точки вызывающего кода, но их клетка сетки может целиком
    // перекрыться раздутым препятствием (точка стоит близко к краю мебели, а клетка крупнее зазора) —
    // тогда ищем ближайшую реально свободную клетку с прямой видимостью от точки, расширяя кольцо поиска
    function anchor(p) {
      const base = cellOf(p);
      for (let r = 0; r <= 6; r++) {
        let bestC = null, bestD = Infinity;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = base.cx + dx, cy = base.cy + dy;
          if (cx < 0 || cy < 0 || cx >= cols || cy >= rows || blocked(cx, cy)) continue;
          const c = cellCenter({ cx, cy });
          // видимость от самой точки p проверяем по «сырым» (не раздутым) препятствиям: p — гарантированно
          // не внутри мебели, но вполне может лежать внутри margin-буфера (например, кот у самого края
          // стола) — раздутый прямоугольник в этом случае «накрывает» саму точку p, и любой отрезок из неё
          // формально «пересекает» его, хотя реального препятствия там нет
          if (rects.some(rr => segmentIntersectsRect(p, c, rr))) continue;
          const d = ptDist(p, c);
          if (d < bestD) { bestD = d; bestC = { cx, cy }; }
        }
        if (bestC) return bestC;
      }
      return base;
    }
    const start = anchor(from), goal = anchor(to);
    const key = c => c.cy * cols + c.cx;
    const seen = new Set([key(start)]);
    const prev = new Map();
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      if (cur.cx === goal.cx && cur.cy === goal.cy) {
        const path = [cur]; let c = cur;
        while (key(c) !== key(start)) { c = prev.get(key(c)); path.push(c); }
        path.reverse();
        return path.map(cc => ({ x: cc.cx * ROUTE_CELL + ROUTE_CELL / 2, y: cc.cy * ROUTE_CELL + ROUTE_CELL / 2 }));
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.cx + dx, ny = cur.cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const k = ny * cols + nx;
        if (seen.has(k) || blocked(nx, ny)) continue;
        seen.add(k); prev.set(k, cur); queue.push({ cx: nx, cy: ny });
      }
    }
    return null;
  }
  // «string pulling»: жадно спрямляет ломаную сетки — из каждой сохранённой точки ищет самую дальнюю
  // точку маршрута, до которой прямая ещё не задевает ни одного (раздутого) препятствия; путь остаётся
  // гарантированно свободным (проверяется той же segmentIntersectsRect, что и тест), но короче и глаже
  function simplifyRoute(points, inflated) {
    const clear = (a, b) => !inflated.some(r => segmentIntersectsRect(a, b, r));
    const out = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
      let j = points.length - 1;
      while (j > i + 1 && !clear(points[i], points[j])) j--;
      out.push(points[j]);
      i = j;
    }
    return out;
  }
  // главная точка входа: если прямая from→to уже свободна — она и есть маршрут; иначе прокладывает путь
  // по сетке в обход препятствий и спрямляет его. Пустой/отсутствующий obstacles ⇒ прямая линия (легаси-темы).
  function computeDogRoute(from, to, obstacles, margin) {
    margin = margin == null ? DOG_ROUTE_MARGIN : margin;
    const rects = obstacles || [];
    if (!rects.length) return [from, to];
    const inflated = rects.map(r => inflateRect(r, margin));
    if (!inflated.some(r => segmentIntersectsRect(from, to, r))) return [from, to];
    const cellPts = dogGridRoute(from, to, rects, margin);
    if (!cellPts) return [from, to];
    return simplifyRoute([from, ...cellPts, to], inflated);
  }
  // «начинать погоню?» — чистая функция для теста лимита частоты: дистанция меньше радиуса и с прошлой
  // погони прошло не меньше кулдауна (lastChaseAt=-Infinity ⇒ погони ещё не было, кулдаун пройден сразу)
  function dogShouldChase(now, lastChaseAt, dist) {
    return dist < DOG_CHASE_RADIUS && (now - lastChaseAt) >= DOG_CHASE_COOLDOWN_MS;
  }

  function dogRestPoint() {
    if (!agents.length) return catRandomPoint();
    const a = agents[Math.floor(Math.random() * agents.length)];
    const p = { x: a.home.x + (Math.random() < 0.5 ? -26 : 26), y: a.home.y + 14 };
    return THEME_NAME === 'cyberpunk' ? pointOutsideObstacles(p, sceneObstacleRects()) : p;
  }
  function pickDogPlan() {
    if (agents.length && Math.random() < 0.3) return { point: dogRestPoint(), kind: Math.random() < 0.5 ? 'sit' : 'lie' };
    return { point: catRandomPoint(), kind: 'wander' };
  }
  const dog = {
    x: 0, y: 0, target: null, route: [], plan: null, dir: 1, walking: false, running: false,
    sitting: false, lying: false, restTimer: 0, phase: Math.random() * Math.PI * 2, bark: 0,
    chasing: null, chaseApproach: null, chaseCooldownUntil: -Infinity, reactTo: null, wagTimer: 0,
  };
  function dogSetTarget(point) {
    dog.target = point;
    const from = { x: dog.x, y: dog.y };
    dog.route = (THEME_NAME === 'cyberpunk' ? computeDogRoute(from, point, sceneObstacleRects()) : [from, point]).slice(1);
  }
  (function initDog() { const p = catRandomPoint(); dog.x = p.x; dog.y = p.y; dog.plan = pickDogPlan(); dogSetTarget(dog.plan.point); })();
  // шаг к следующей путевой точке маршрута; возвращает true, когда маршрут пройден целиком (пёс на месте)
  function dogAdvance(speed) {
    if (!dog.route.length) { dog.walking = false; return true; }
    const wp = dog.route[0];
    const dx = wp.x - dog.x, dy = wp.y - dog.y, d = Math.hypot(dx, dy);
    if (d < 1.5) { dog.x = wp.x; dog.y = wp.y; dog.route.shift(); dog.walking = dog.route.length > 0; return dog.route.length === 0; }
    dog.x += dx / d * speed; dog.y += dy / d * speed; dog.dir = dx < 0 ? -1 : 1; dog.walking = true; return false;
  }
  // кот удирает от пса: если есть свободный стол — прыжок туда (та же механика, что и обычный визит на
  // стол), иначе — просто убегает по полу в случайную дальнюю точку
  function catFleeFromDog(cat) {
    if (cat.jump || cat.onDesk) return;
    cat.lying = false; cat.lieTimer = 0;
    if (!cat.deskGoal) startCatDeskTrip(cat);
    if (!cat.deskGoal) cat.target = catRandomPoint();
  }
  function nearestCat() {
    let best = null, bestD = Infinity;
    for (const cat of cats) { const d = ptDist(cat, dog); if (d < bestD) { bestD = d; best = cat; } }
    return { cat: best, dist: bestD };
  }
  // реакция на task.review/task.done — подбегает к столу автора и виляет хвостом; вызывается из envelope()
  function dogReactTo(name) {
    const a = agents.find(x => x.name === name); if (!a) return;
    dog.chasing = null; dog.chaseApproach = null; dog.sitting = false; dog.lying = false; dog.restTimer = 0;
    dog.reactTo = name;
    const p = { x: a.home.x + (Math.random() < 0.5 ? -22 : 22), y: a.home.y + 16 };
    dogSetTarget(THEME_NAME === 'cyberpunk' ? pointOutsideObstacles(p, sceneObstacleRects()) : p);
  }
  function stepDog(t) {
    if (dog.reactTo) {
      dog.sitting = false; dog.lying = false;
      if (dogAdvance(DOG_RUN_SPEED)) { dog.reactTo = null; dog.wagTimer = DOG_WAG_TICKS; dog.plan = pickDogPlan(); dogSetTarget(dog.plan.point); }
    } else if (dog.restTimer > 0 || dog.sitting || dog.lying) {
      dog.restTimer--;
      if (dog.restTimer <= 0) { dog.sitting = false; dog.lying = false; dog.plan = pickDogPlan(); dogSetTarget(dog.plan.point); }
    } else if (dog.chasing) {
      const cat = dog.chasing;
      if (cat.onDesk) {
        // кот уже на столе — пёс должен добежать до подхода к нему, а не сесть мгновенно там, где стоял;
        // цель ставим один раз (chaseApproach), дальше только продолжаем идти по уже проложенному маршруту
        if (!dog.chaseApproach) { dog.chaseApproach = cat.deskApproach || { x: cat.x, y: cat.y }; dogSetTarget(dog.chaseApproach); }
        if (dogAdvance(DOG_RUN_SPEED)) {
          dog.chasing = null; dog.chaseApproach = null;
          dog.sitting = true; dog.restTimer = DOG_REST_MIN + Math.random() * DOG_REST_RANGE; // садится под столом и «смотрит вверх»
        }
      } else {
        dogSetTarget({ x: cat.x, y: cat.y }); // кот ещё бежит — пёс преследует его текущую позицию каждый кадр
        dogAdvance(DOG_RUN_SPEED);
        if (ptDist(cat, dog) < 8) { dog.chasing = null; dog.plan = pickDogPlan(); dogSetTarget(dog.plan.point); }
      }
    } else {
      const { cat, dist } = nearestCat();
      if (cat && dogShouldChase(t, dog.chaseCooldownUntil, dist)) {
        dog.chaseCooldownUntil = t; dog.chasing = cat; catFleeFromDog(cat);
      } else if (dogAdvance(dog.running ? DOG_RUN_SPEED : DOG_WALK_SPEED)) {
        if (dog.plan.kind === 'wander') { dog.running = Math.random() < 0.3; dog.plan = pickDogPlan(); dogSetTarget(dog.plan.point); }
        else { dog.sitting = dog.plan.kind === 'sit'; dog.lying = dog.plan.kind === 'lie'; dog.restTimer = DOG_REST_MIN + Math.random() * DOG_REST_RANGE; }
      }
    }
    if (dog.wagTimer > 0) dog.wagTimer--;
    if (dog.bark > 0) dog.bark--; else if (Math.random() < DOG_BARK_CHANCE) dog.bark = 70 + Math.random() * 50;
  }

  function drawDogNeon(x, y, t) {
    const glow = 0.35 + 0.35 * Math.sin(t / 1100); // «схемы»-дорожки на теле — мигают медленно, как остальной неон сцены
    o.globalAlpha = glow; o.fillStyle = CY.neonBlue;
    o.fillRect(x + 6, y + 3, 8, 1); o.fillRect(x + 13, y + 3, 1, 4); o.fillRect(x + 15, y + 6, 7, 1);
    o.fillRect(x + 5, y + 2, 2, 2); o.fillRect(x + 16, y + 5, 2, 2); o.fillRect(x + 21, y + 7, 2, 2);
    o.globalAlpha = 1;
    const cGlow = 0.5 + 0.5 * Math.sin(t / 650 + 0.8); // розовый огонёк ошейника
    o.globalAlpha = cGlow; o.fillStyle = CY.neonPink; o.fillRect(x + 12, y + 8, 2, 2);
    o.globalAlpha = 1;
  }
  function drawBarkBubble(entity, topY) {
    const bw = 40, bh = 20;
    const bx = Math.round(entity.x) - Math.round(bw / 2), by = topY - bh - 10;
    o.fillStyle = '#1c2433'; o.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    o.fillStyle = '#ffffff'; o.fillRect(bx, by, bw, bh);
    const tipX = Math.round(entity.x) + (entity.dir === -1 ? -4 : 4);
    o.fillRect(tipX - 4, by + bh, 8, 2); o.fillRect(tipX - 2, by + bh + 2, 4, 2); o.fillRect(tipX, by + bh + 4, 2, 2);
    o.save();
    o.font = '11px "Pixelify Sans", monospace'; o.textAlign = 'center'; o.textBaseline = 'middle';
    o.fillStyle = '#1c2433'; o.fillText('гав', bx + bw / 2, by + bh / 2 + 1);
    o.restore();
  }
  function drawDog(t) {
    const cyber = THEME_NAME === 'cyberpunk';
    const colors = cyber ? DOG_COLORS_CYBER : DOG_COLORS_MONO;
    let rows = DOG_STAND;
    if (dog.lying) rows = DOG_LIE;
    else if (dog.sitting) rows = DOG_SIT;
    else if (dog.walking) rows = Math.floor(t / (dog.running ? 90 : 140)) % 2 ? DOG_WALK1 : DOG_WALK2;
    const w = rows[0].length, h = rows.length;
    const x = Math.round(dog.x) - Math.round(w / 2), y = Math.round(dog.y) - h;
    o.fillStyle = 'rgba(0,0,0,0.25)'; o.fillRect(x + 2, y + h, Math.max(1, w - 4), 1);
    if (!dog.lying) { // хвост: быстрое виляние 2с после события, иначе спокойная синусоида на ходу/стоя
      const wag = dog.wagTimer > 0 ? (Math.floor(t / 90) % 3 - 1) * 3 : Math.sin(t / 260 + dog.phase) * 2.4;
      const tailX = dog.dir === -1 ? x + w : x - 1, tailY = y + Math.round(h * 0.35 + wag);
      o.fillStyle = colors.f; o.fillRect(tailX, tailY, 2, 4);
    }
    const draw = () => sprite(rows, x, y, colors);
    if (dog.dir === -1) { o.save(); o.translate(x * 2 + w, 0); o.scale(-1, 1); draw(); o.restore(); } else draw();
    if (cyber) drawDogNeon(x, y, t);
    if (dog.bark > 0) drawBarkBubble(dog, y);
  }
  const PET_COUNT = cats.length + 1; // два кота + кибер-пёс

  // ================================================================== BIG: детальный рендер (замена стиля)
  // Новый художественный стиль целиком: вместо спрайтов-строк 16×26 — персонажи и стол, нарисованные через
  // градиенты/кривые canvas (та же техника, что в артефактах hero-anchor/office-scene этой сессии), заранее
  // отрисованные ОДИН раз в офскрин-битмапы при загрузке и затем просто вставляемые (`drawImage`) каждый кадр —
  // дорогая отрисовка (градиенты/суперсэмплинг) не повторяется 60 раз в секунду. CHAR_PALETTE/CHAR_HEADS/
  // humanRows() выше НЕ трогаем и не удаляем — они больше не используются для отрисовки, но тесты (test_floor_js.py)
  // явно проверяют их форму, и ломать уже протестированный контракт незачем.
  const BIG = {};
  (function buildBig() {
    function seg(x, w, base, sh, shW) { shW = shW == null ? 2 : shW; if (w <= shW) return [[x, w, sh]]; return [[x, w - shW, base], [x + (w - shW), shW, sh]]; }
    function row(blocks, y, segs) { for (const [x, w, color] of segs) blocks.push({ x, y, w, h: 1, color }); }
    function rect(blocks, x, y, w, h, color) { blocks.push({ x, y, w, h, color }); }
    function scaleBlocks(list, k) { return list.map(b => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k, color: b.color })); }
    function mix(hex, amt) {
      const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const f = c => Math.max(0, Math.min(255, amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
      return `rgb(${f(r) | 0},${f(g) | 0},${f(b) | 0})`;
    }
    function renderBody(ctx, doll, px, outline) {
      ctx.save(); ctx.fillStyle = outline;
      for (const blk of doll.blocks) ctx.fillRect((blk.x - 1) * px, (blk.y - 1) * px, (blk.w + 2) * px, (blk.h + 2) * px);
      for (const blk of doll.blocks) { ctx.fillStyle = blk.color; ctx.fillRect(blk.x * px, blk.y * px, blk.w * px, blk.h * px); }
      for (const d of (doll.fine || [])) { ctx.fillStyle = d.color; ctx.fillRect(d.x * px, d.y * px, d.w * px, d.h * px); }
      ctx.restore();
    }
    const GRID = 40, ROWS = 60;

    function poseHands(pose, P) {
      if (pose === 'type') return [[16, [[3, 2, P.skin], [14, 2, P.skinSh]]], [17, [[7, 2, P.skin], [11, 2, P.skinSh]]], [18, [[8, 2, P.skin], [10, 2, P.skinSh]]]];
      if (pose === 'lean') return [[14, [[7, 2, P.skin], [11, 2, P.skinSh]]], [15, [[8, 2, P.skin], [10, 2, P.skinSh]]]];
      if (pose === 'failed') return [[19, [[4, 2, P.skin], [14, 2, P.skinSh]]], [20, [[4, 2, P.skin], [14, 2, P.skinSh]]]];
      return [[16, [[3, 2, P.skin], [14, 2, P.skinSh]]], [17, [[4, 2, P.skin], [13, 2, P.skinSh]]], [18, [[4, 2, P.skin], [12, 2, P.skinSh]]]];
    }
    function poseFaceOverlay(ctx, px, P, pose, my) {
      if (pose !== 'failed' && pose !== 'done') return;
      const cx = 20 * px, rx = 11 * px, ry = 5.5 * px;
      ctx.save();
      if (pose === 'failed') {
        ctx.strokeStyle = P.mouth; ctx.lineWidth = px * 0.22; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cx - rx * 0.18, my + ry * 0.06); ctx.quadraticCurveTo(cx, my - ry * 0.12, cx + rx * 0.18, my + ry * 0.06); ctx.stroke();
        ctx.fillStyle = 'rgba(150,205,255,.85)';
        ctx.beginPath(); ctx.ellipse(cx + rx * 0.62, my - ry * 1.5, rx * 0.06, rx * 0.09, 0, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.strokeStyle = P.mouth; ctx.lineWidth = px * 0.24; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cx - rx * 0.22, my - ry * 0.02); ctx.quadraticCurveTo(cx, my + ry * 0.3, cx + rx * 0.22, my - ry * 0.02); ctx.stroke();
        ctx.fillStyle = 'rgba(255,225,140,.9)';
        for (const [sx, sy] of [[-1, -1.8], [1.1, -2.1], [0.2, -2.5]]) { ctx.beginPath(); ctx.arc(cx + sx * rx * 0.5, my + sy * ry * 0.5, rx * 0.035, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
    }

    // ---- Michael ----
    function buildDollMichael(P, pose) {
      const b = [];
      row(b, 0, [[6, 8, P.hair]]); row(b, 1, [[4, 12, P.hair]]); row(b, 2, [[3, 14, P.hair]]);
      row(b, 3, [[2, 3, P.hairSh], ...seg(5, 10, P.skin, P.skinSh), [15, 3, P.hair]]);
      row(b, 4, [[2, 2, P.hairSh], ...seg(4, 12, P.skin, P.skinSh), [16, 2, P.hair]]);
      row(b, 5, [[2, 1, P.hair], ...seg(3, 14, P.skin, P.skinSh), [17, 1, P.hairSh]]);
      row(b, 6, seg(2, 16, P.skin, P.skinSh, 3)); row(b, 7, seg(4, 12, P.skin, P.skinSh, 3));
      row(b, 8, seg(5, 10, P.skin, P.skinSh, 3)); row(b, 9, seg(6, 8, P.skin, P.skinSh, 2));
      row(b, 10, seg(7, 6, P.skin, P.skinSh, 2));
      const torso = [[11, 3, 13], [12, 3, 13], [13, 4, 12], [14, 4, 11], [15, 5, 10], [16, 5, 9], [17, 6, 8], [18, 6, 8]];
      for (const [y, x, w] of torso) row(b, y, seg(x, w, P.jacket, P.jacketSh, 2));
      for (let y = 12; y <= 18; y++) row(b, y, seg(8, 3, P.tshirt, P.tshirtSh, 1));
      b.push({ x: 4, y: 11, w: 1, h: 1, color: P.accent }); b.push({ x: 14, y: 11, w: 1, h: 1, color: P.accent });
      for (const [y, segs] of poseHands(pose, P)) row(b, y, segs);
      for (let y = 19; y <= 25; y++) { row(b, y, seg(6, 4, P.pants, P.pantsSh, 2)); row(b, y, seg(11, 4, P.pants, P.pantsSh, 2)); }
      for (let y = 26; y <= 29; y++) { row(b, y, seg(6, 4, P.shoe, P.shoeSh, 2)); row(b, y, seg(11, 4, P.shoe, P.shoeSh, 2)); }
      return { blocks: b };
    }
    function buildDoll2xMichael(P, pose) {
      const blocks = scaleBlocks(buildDollMichael(P, pose).blocks, 2);
      blocks.push({ x: 4, y: 9, w: 2, h: 4, color: P.skinSh }); blocks.push({ x: 34, y: 9, w: 2, h: 4, color: P.skinSh });
      const fine = [{ x: 19, y: 0, w: 2, h: 6, color: P.hairSh }];
      fine.push({ x: 14, y: 24, w: 1, h: 14, color: P.jacketHi }); fine.push({ x: 22, y: 24, w: 1, h: 14, color: P.jacketHi });
      fine.push({ x: 18, y: 25, w: 2, h: 13, color: '#232323' }); fine.push({ x: 17, y: 30, w: 4, h: 3, color: P.metal });
      fine.push({ x: 9, y: 30, w: 5, h: 2, color: P.jacketSh }); fine.push({ x: 24, y: 30, w: 5, h: 2, color: P.jacketSh });
      fine.push({ x: 12, y: 37, w: 16, h: 1, color: P.jacketHi });
      fine.push({ x: 12, y: 38, w: 18, h: 2, color: P.belt }); fine.push({ x: 19, y: 38, w: 2, h: 2, color: P.metal });
      fine.push({ x: 12, y: 59, w: 8, h: 1, color: P.sole }); fine.push({ x: 22, y: 59, w: 8, h: 1, color: P.sole });
      fine.push({ x: 14, y: 54, w: 2, h: 2, color: P.metal }); fine.push({ x: 26, y: 54, w: 2, h: 2, color: P.metal });
      return { blocks, fine };
    }
    function paintFaceMichael(ctx, px, P) {
      const cx = 20 * px, cy = 10.5 * px, rx = 11 * px, ry = 5.5 * px;
      ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
      const base = ctx.createRadialGradient(cx - rx * 0.4, cy - ry * 0.6, rx * 0.15, cx, cy, rx * 1.4);
      base.addColorStop(0, mix(P.skin, 0.22)); base.addColorStop(0.5, P.skin); base.addColorStop(1, mix(P.skin, -0.28));
      ctx.fillStyle = base; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      const side = ctx.createLinearGradient(cx - rx * 0.1, 0, cx + rx * 1.1, 0);
      side.addColorStop(0, 'rgba(0,0,0,0)'); side.addColorStop(0.75, 'rgba(0,0,0,0)'); side.addColorStop(1, 'rgba(10,6,4,.4)');
      ctx.fillStyle = side; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      const hot = ctx.createRadialGradient(cx - rx * 0.15, cy - ry * 0.55, 0, cx - rx * 0.15, cy - ry * 0.55, rx * 0.55);
      hot.addColorStop(0, 'rgba(255,240,215,.4)'); hot.addColorStop(1, 'rgba(255,240,215,0)');
      ctx.fillStyle = hot; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      const eyeY = cy - ry * 0.05;
      for (const sx of [-1, 1]) {
        const ex = cx + sx * rx * 0.42;
        ctx.fillStyle = mix(P.skin, -0.22); ctx.beginPath(); ctx.ellipse(ex, eyeY + ry * 0.2, rx * 0.2, ry * 0.12, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = mix(P.skin, -0.18); ctx.beginPath(); ctx.ellipse(ex, eyeY - ry * 0.08, rx * 0.22, ry * 0.13, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ece2d2'; ctx.beginPath(); ctx.ellipse(ex, eyeY, rx * 0.17, ry * 0.1, 0, 0, Math.PI * 2); ctx.fill();
        const iris = ctx.createRadialGradient(ex, eyeY, 1, ex, eyeY, rx * 0.1);
        iris.addColorStop(0, '#5aa6d8'); iris.addColorStop(0.6, '#2a5f8a'); iris.addColorStop(1, '#13283a');
        ctx.fillStyle = iris; ctx.beginPath(); ctx.arc(ex, eyeY, rx * 0.085, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0b0e13'; ctx.beginPath(); ctx.arc(ex, eyeY, rx * 0.04, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(ex - rx * 0.03, eyeY - ry * 0.05, rx * 0.02, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = mix(P.skin, -0.35); ctx.lineWidth = px * 0.28; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(ex - rx * 0.2, eyeY - ry * 0.02); ctx.quadraticCurveTo(ex, eyeY - ry * 0.26, ex + rx * 0.2, eyeY - ry * 0.06); ctx.stroke();
        const inX = ex - sx * rx * 0.1, inY = eyeY - ry * 0.4, outX = ex + sx * rx * 0.34, outY = eyeY - ry * 0.7;
        const midX = (inX + outX) / 2, midY = (inY + outY) / 2 - ry * 0.06;
        const nrm = { x: -(outY - inY), y: (outX - inX) }; const nl = Math.hypot(nrm.x, nrm.y) || 1;
        const t1 = (ry * 0.2) / nl, t2 = (ry * 0.1) / nl;
        ctx.fillStyle = P.hairSh;
        ctx.beginPath();
        ctx.moveTo(inX + nrm.x * t2, inY + nrm.y * t2);
        ctx.quadraticCurveTo(midX + nrm.x * t1, midY + nrm.y * t1, outX + nrm.x * t2 * 0.6, outY + nrm.y * t2 * 0.6);
        ctx.quadraticCurveTo(midX - nrm.x * t1 * 0.5, midY - nrm.y * t1 * 0.5, inX - nrm.x * t2 * 0.5, inY - nrm.y * t2 * 0.5);
        ctx.closePath(); ctx.fill();
      }
      const nx = cx + rx * 0.02, nTop = cy - ry * 0.25, nBot = cy + ry * 0.6;
      ctx.beginPath(); ctx.moveTo(nx - rx * 0.06, nTop); ctx.lineTo(nx - rx * 0.15, nBot - ry * 0.1);
      ctx.quadraticCurveTo(nx - rx * 0.03, nBot + ry * 0.08, nx + rx * 0.13, nBot - ry * 0.1); ctx.lineTo(nx + rx * 0.07, nTop); ctx.closePath();
      const noseGrad = ctx.createLinearGradient(nx - rx * 0.15, 0, nx + rx * 0.15, 0);
      noseGrad.addColorStop(0, mix(P.skin, 0.32)); noseGrad.addColorStop(0.5, P.skin); noseGrad.addColorStop(1, mix(P.skin, -0.5));
      ctx.fillStyle = noseGrad; ctx.fill();
      ctx.fillStyle = mix(P.skin, -0.5);
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(nx + sx * rx * 0.12, nBot, rx * 0.05, 0, Math.PI * 2); ctx.fill(); }
      const my = cy + ry * 0.95;
      ctx.strokeStyle = P.mouth; ctx.lineWidth = px * 0.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - rx * 0.2, my); ctx.quadraticCurveTo(cx, my + ry * 0.02, cx + rx * 0.2, my); ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.82, my - ry * 0.5);
      ctx.quadraticCurveTo(cx - rx * 0.3, my - ry * 0.12, cx, my + ry * 0.08);
      ctx.quadraticCurveTo(cx + rx * 0.3, my - ry * 0.12, cx + rx * 0.82, my - ry * 0.5);
      ctx.quadraticCurveTo(cx + rx * 0.9, my + ry * 0.3, cx + rx * 0.55, my + ry * 0.82);
      ctx.quadraticCurveTo(cx + rx * 0.25, my + ry * 1.15, cx, my + ry * 1.2);
      ctx.quadraticCurveTo(cx - rx * 0.25, my + ry * 1.15, cx - rx * 0.55, my + ry * 0.82);
      ctx.quadraticCurveTo(cx - rx * 0.9, my + ry * 0.3, cx - rx * 0.82, my - ry * 0.5);
      ctx.closePath();
      const beardFill = ctx.createLinearGradient(cx - rx * 0.8, 0, cx + rx * 0.8, 0);
      beardFill.addColorStop(0, P.beardSh); beardFill.addColorStop(0.45, P.beard); beardFill.addColorStop(1, P.beardSh);
      ctx.fillStyle = beardFill; ctx.fill();
      for (const sx of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(cx + sx * rx * 0.15, my - ry * 0.2, rx * 0.19, ry * 0.16, sx * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = mix(P.beardSh, -0.3); ctx.fill();
      }
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(214,180,120,.55)'; ctx.lineWidth = px * 0.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - rx * 0.85, cy - ry * 2.8); ctx.quadraticCurveTo(cx - rx * 0.55, cy - ry * 1.6, cx - rx * 1.05, cy + ry * 0.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + rx * 0.5, cy - ry * 3.1); ctx.quadraticCurveTo(cx + rx * 0.9, cy - ry * 1.8, cx + rx * 1.0, cy + ry * 0.2); ctx.stroke();
      ctx.restore();
      poseFaceOverlay(ctx, px, P, P.__pose, my);
    }
    const MICHAEL = {
      skin: '#e8b382', skinSh: '#c98f61', hair: '#4a3225', hairSh: '#32211a',
      beard: '#4a3225', beardSh: '#32211a', jacket: '#241a15', jacketSh: '#17120f', jacketHi: '#4a3d33',
      tshirt: '#17171b', tshirtSh: '#0b0b0e', pants: '#2b2f3d', pantsSh: '#1b1e28',
      shoe: '#6b4a30', shoeSh: '#4a3220', sole: '#2e2015',
      accent: '#4f8cff', mouth: '#8a5a52', metal: '#b9bec7', belt: '#1a1510',
    };

    // ---- Dwight ----
    function buildDollDwight(P) {
      const b = [];
      row(b, 0, [[7, 6, P.skin]]); row(b, 1, [[5, 10, P.skin]]); row(b, 2, [[4, 12, P.skin]]);
      row(b, 3, [[2, 2, P.skinSh], ...seg(5, 10, P.skin, P.skinSh), [15, 3, P.skin]]);
      row(b, 4, [[2, 1, P.skinSh], ...seg(4, 12, P.skin, P.skinSh), [16, 1, P.skinSh]]);
      row(b, 5, seg(3, 14, P.skin, P.skinSh, 1));
      row(b, 6, seg(2, 16, P.skin, P.skinSh, 3)); row(b, 7, seg(4, 12, P.skin, P.skinSh, 3));
      row(b, 8, seg(5, 10, P.skin, P.skinSh, 3)); row(b, 9, seg(6, 8, P.skin, P.skinSh, 2));
      row(b, 10, seg(7, 6, P.skin, P.skinSh, 2));
      const torso = [[11, 3, 13], [12, 3, 13], [13, 4, 12], [14, 4, 11], [15, 5, 10], [16, 5, 9], [17, 6, 8], [18, 6, 8]];
      for (const [y, x, w] of torso) row(b, y, seg(x, w, P.jacket, P.jacketSh, 2));
      for (let y = 12; y <= 18; y++) row(b, y, seg(8, 3, P.tshirt, P.tshirtSh, 1));
      b.push({ x: 4, y: 11, w: 1, h: 1, color: P.accent }); b.push({ x: 14, y: 11, w: 1, h: 1, color: P.accent });
      row(b, 16, [[3, 2, P.skin], [14, 2, P.skinSh]]); row(b, 17, [[4, 2, P.skin], [13, 2, P.skinSh]]); row(b, 18, [[4, 2, P.skin], [12, 2, P.skinSh]]);
      for (let y = 19; y <= 25; y++) { row(b, y, seg(6, 4, P.pants, P.pantsSh, 2)); row(b, y, seg(11, 4, P.pants, P.pantsSh, 2)); }
      for (let y = 26; y <= 29; y++) { row(b, y, seg(6, 4, P.shoe, P.shoeSh, 2)); row(b, y, seg(11, 4, P.shoe, P.shoeSh, 2)); }
      return { blocks: b };
    }
    function buildDoll2xDwight(P) {
      const blocks = scaleBlocks(buildDollDwight(P).blocks, 2);
      blocks.push({ x: 4, y: 9, w: 2, h: 4, color: P.skinSh }); blocks.push({ x: 34, y: 9, w: 2, h: 4, color: P.skinSh });
      const fine = [];
      fine.push({ x: 14, y: 24, w: 1, h: 14, color: P.jacketHi }); fine.push({ x: 22, y: 24, w: 1, h: 14, color: P.jacketHi });
      fine.push({ x: 18, y: 25, w: 1, h: 4, color: P.jacketSh });
      fine.push({ x: 15, y: 29, w: 8, h: 6, color: P.jacketHi }); fine.push({ x: 16, y: 30, w: 6, h: 4, color: '#15171a' });
      fine.push({ x: 17, y: 31, w: 4, h: 2, color: P.accent });
      fine.push({ x: 9, y: 34, w: 3, h: 3, color: P.jacketSh });
      fine.push({ x: 9, y: 30, w: 5, h: 2, color: P.jacketSh }); fine.push({ x: 24, y: 30, w: 5, h: 2, color: P.jacketSh });
      fine.push({ x: 12, y: 37, w: 16, h: 1, color: P.jacketHi });
      fine.push({ x: 12, y: 38, w: 18, h: 2, color: P.belt }); fine.push({ x: 19, y: 38, w: 2, h: 2, color: P.metal });
      fine.push({ x: 12, y: 59, w: 8, h: 1, color: P.sole }); fine.push({ x: 22, y: 59, w: 8, h: 1, color: P.sole });
      fine.push({ x: 13, y: 54, w: 6, h: 1, color: P.metal }); fine.push({ x: 23, y: 54, w: 6, h: 1, color: P.metal });
      fine.push({ x: 31, y: 18, w: 2, h: 6, color: P.cyborgDark }); fine.push({ x: 32, y: 19, w: 1, h: 1, color: P.accent });
      fine.push({ x: 24, y: 32, w: 8, h: 6, color: P.metal }); fine.push({ x: 27, y: 32, w: 1, h: 6, color: P.cyborgDark });
      fine.push({ x: 25, y: 35, w: 2, h: 2, color: P.cyborgScreen });
      return { blocks, fine };
    }
    function paintFaceDwight(ctx, px, P) {
      const cx = 20 * px, cy = 10.5 * px, rx = 11 * px, ry = 5.5 * px;
      ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
      const base = ctx.createRadialGradient(cx - rx * 0.4, cy - ry * 0.6, rx * 0.15, cx, cy, rx * 1.4);
      base.addColorStop(0, mix(P.skin, 0.2)); base.addColorStop(0.5, P.skin); base.addColorStop(1, mix(P.skin, -0.26));
      ctx.fillStyle = base; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      const side = ctx.createLinearGradient(cx - rx * 0.1, 0, cx + rx * 1.1, 0);
      side.addColorStop(0, 'rgba(0,0,0,0)'); side.addColorStop(0.7, 'rgba(0,0,0,0)'); side.addColorStop(1, 'rgba(10,6,4,.35)');
      ctx.fillStyle = side; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      const hot = ctx.createRadialGradient(cx - rx * 0.15, cy - ry * 0.55, 0, cx - rx * 0.15, cy - ry * 0.55, rx * 0.5);
      hot.addColorStop(0, 'rgba(255,240,215,.35)'); hot.addColorStop(1, 'rgba(255,240,215,0)');
      ctx.fillStyle = hot; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      ctx.fillStyle = P.metal; ctx.fillRect(cx + rx * 0.16, cy - ry * 0.62, rx * 0.5, ry * 0.12);
      function trace(x, y, dir, color) {
        ctx.strokeStyle = color; ctx.lineWidth = rx * 0.03; ctx.lineCap = 'square';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dir * rx * 0.16, y); ctx.lineTo(x + dir * rx * 0.16, y - ry * 0.22); ctx.lineTo(x + dir * rx * 0.3, y - ry * 0.22); ctx.stroke();
        ctx.fillStyle = color;
        for (const [tx, ty] of [[x, y], [x + dir * rx * 0.16, y - ry * 0.22], [x + dir * rx * 0.3, y - ry * 0.22]]) { ctx.beginPath(); ctx.arc(tx, ty, rx * 0.018, 0, Math.PI * 2); ctx.fill(); }
      }
      for (const sx of [-1, 1]) {
        const tcol = sx === 1 ? 'rgba(58,217,176,.6)' : mix(P.cyborgScreen, -0.1);
        trace(cx + sx * rx * 0.58, cy - ry * 0.5, sx, tcol); trace(cx + sx * rx * 0.64, cy - ry * 0.1, sx, tcol);
      }
      const eyeY = cy - ry * 0.05;
      for (const sx of [-1, 1]) {
        const ex = cx + sx * rx * 0.42;
        if (sx === 1) {
          ctx.fillStyle = mix(P.cyborgDark, -0.1); ctx.beginPath(); ctx.ellipse(ex, eyeY, rx * 0.24, ry * 0.18, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#0b0c0e'; ctx.beginPath(); ctx.ellipse(ex, eyeY, rx * 0.19, ry * 0.13, 0, 0, Math.PI * 2); ctx.fill();
          const slit = ctx.createLinearGradient(ex - rx * 0.16, eyeY, ex + rx * 0.16, eyeY);
          slit.addColorStop(0, '#7a3c0a'); slit.addColorStop(0.5, '#ffd36a'); slit.addColorStop(1, '#7a3c0a');
          ctx.fillStyle = slit; ctx.beginPath(); ctx.ellipse(ex, eyeY, rx * 0.16, ry * 0.045, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,230,180,.8)'; ctx.fillRect(ex - rx * 0.1, eyeY - ry * 0.015, rx * 0.2, ry * 0.03);
          continue;
        }
        ctx.fillStyle = mix(P.skin, -0.2); ctx.beginPath(); ctx.ellipse(ex, eyeY + ry * 0.2, rx * 0.2, ry * 0.12, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = mix(P.skin, -0.16); ctx.beginPath(); ctx.ellipse(ex, eyeY - ry * 0.08, rx * 0.22, ry * 0.13, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ece2d2'; ctx.beginPath(); ctx.ellipse(ex, eyeY, rx * 0.17, ry * 0.1, 0, 0, Math.PI * 2); ctx.fill();
        const iris = ctx.createRadialGradient(ex, eyeY, 1, ex, eyeY, rx * 0.1);
        iris.addColorStop(0, '#9a7249'); iris.addColorStop(0.6, '#5c4024'); iris.addColorStop(1, '#2a1c10');
        ctx.fillStyle = iris; ctx.beginPath(); ctx.arc(ex, eyeY, rx * 0.085, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0b0e13'; ctx.beginPath(); ctx.arc(ex, eyeY, rx * 0.04, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(ex - rx * 0.03, eyeY - ry * 0.05, rx * 0.02, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,170,70,.35)'; ctx.fillRect(ex - rx * 0.12, eyeY + ry * 0.07, rx * 0.24, ry * 0.025);
        ctx.strokeStyle = mix(P.skin, -0.35); ctx.lineWidth = px * 0.26; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(ex - rx * 0.2, eyeY - ry * 0.02); ctx.quadraticCurveTo(ex, eyeY - ry * 0.24, ex + rx * 0.2, eyeY - ry * 0.06); ctx.stroke();
        const inX = ex - sx * rx * 0.1, inY = eyeY - ry * 0.55, outX = ex + sx * rx * 0.3, outY = eyeY - ry * 0.68;
        const midX = (inX + outX) / 2, midY = (inY + outY) / 2 - ry * 0.04;
        ctx.fillStyle = P.hairSh;
        ctx.beginPath(); ctx.moveTo(inX, inY - ry * 0.08); ctx.quadraticCurveTo(midX, midY - ry * 0.08, outX, outY - ry * 0.06);
        ctx.quadraticCurveTo(midX, midY + ry * 0.08, inX, inY + ry * 0.06); ctx.closePath(); ctx.fill();
      }
      const nx = cx + rx * 0.02, nTop = cy - ry * 0.3, nBot = cy + ry * 0.6;
      ctx.beginPath(); ctx.moveTo(nx - rx * 0.06, nTop); ctx.lineTo(nx - rx * 0.15, nBot - ry * 0.1);
      ctx.quadraticCurveTo(nx - rx * 0.03, nBot + ry * 0.08, nx + rx * 0.13, nBot - ry * 0.1); ctx.lineTo(nx + rx * 0.07, nTop); ctx.closePath();
      const noseGrad = ctx.createLinearGradient(nx - rx * 0.15, 0, nx + rx * 0.15, 0);
      noseGrad.addColorStop(0, mix(P.skin, 0.3)); noseGrad.addColorStop(0.5, P.skin); noseGrad.addColorStop(1, mix(P.skin, -0.45));
      ctx.fillStyle = noseGrad; ctx.fill();
      ctx.fillStyle = mix(P.skin, -0.45);
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(nx + sx * rx * 0.12, nBot, rx * 0.05, 0, Math.PI * 2); ctx.fill(); }
      const my = cy + ry * 0.7;
      ctx.beginPath(); ctx.moveTo(cx - rx * 0.24, my + ry * 0.05); ctx.quadraticCurveTo(cx, my - ry * 0.12, cx + rx * 0.24, my + ry * 0.05);
      ctx.quadraticCurveTo(cx, my + ry * 0.2, cx - rx * 0.24, my + ry * 0.05); ctx.closePath();
      ctx.fillStyle = mix(P.mouth, -0.3); ctx.fill();
      ctx.fillStyle = mix(P.mouth, 0.15); ctx.beginPath(); ctx.ellipse(cx, my + ry * 0.15, rx * 0.18, ry * 0.06, 0, 0, Math.PI * 2); ctx.fill();
      const seamX = cx + rx * 0.14;
      ctx.strokeStyle = 'rgba(10,8,6,.5)'; ctx.lineWidth = rx * 0.07; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(seamX - rx * 0.05, cy - ry * 0.95); ctx.quadraticCurveTo(seamX + rx * 0.06, cy + ry * 0.1, seamX, cy + ry * 1.15); ctx.stroke();
      ctx.strokeStyle = mix(P.cyborgScreen, -0.1); ctx.lineWidth = rx * 0.025;
      ctx.beginPath(); ctx.moveTo(seamX - rx * 0.05, cy - ry * 0.95); ctx.quadraticCurveTo(seamX + rx * 0.06, cy + ry * 0.1, seamX, cy + ry * 1.15); ctx.stroke();
      for (const t of [0.15, 0.45, 0.75]) { const sy = cy - ry * 0.95 + t * (ry * 2.1); ctx.fillStyle = P.cyborgScreen; ctx.beginPath(); ctx.arc(seamX, sy, rx * 0.02, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx + rx * 0.5, cy - ry * 1.05);
      ctx.quadraticCurveTo(cx + rx * 1.3, cy - ry * 1.15, cx + rx * 1.35, cy - ry * 0.3);
      ctx.quadraticCurveTo(cx + rx * 1.32, cy + ry * 0.55, cx + rx * 0.62, cy + ry * 0.5);
      ctx.quadraticCurveTo(cx + rx * 0.78, cy - ry * 0.3, cx + rx * 0.5, cy - ry * 1.05);
      ctx.closePath();
      const shell = ctx.createLinearGradient(cx + rx * 0.6, cy - ry, cx + rx * 1.3, cy + ry * 0.4);
      shell.addColorStop(0, mix(P.cyborgShell, 0.18)); shell.addColorStop(1, mix(P.cyborgShell, -0.25));
      ctx.fillStyle = shell; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + rx * 0.82, cy - ry * 0.8); ctx.quadraticCurveTo(cx + rx * 1.18, cy - ry * 0.78, cx + rx * 1.2, cy - ry * 0.1);
      ctx.quadraticCurveTo(cx + rx * 1.16, cy + ry * 0.2, cx + rx * 0.84, cy + ry * 0.18); ctx.closePath();
      ctx.fillStyle = '#0c1210'; ctx.fill();
      for (let i = 0; i < 3; i++) { ctx.fillStyle = i === 1 ? P.cyborgScreen : mix(P.cyborgScreen, -0.3); ctx.fillRect(cx + rx * 0.87, cy - ry * (0.68 - i * 0.22), rx * 0.28, ry * 0.1); }
      ctx.fillStyle = P.cyborgScreen;
      ctx.beginPath(); ctx.arc(cx + rx * 0.93, cy + ry * 0.02, rx * 0.025, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + rx * 1.02, cy + ry * 0.02, rx * 0.025, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = mix(P.cyborgShell, -0.4); ctx.lineWidth = rx * 0.025; ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(cx + rx * (0.68 + i * 0.07), cy + ry * 0.3); ctx.lineTo(cx + rx * (0.68 + i * 0.07), cy + ry * 0.42); ctx.stroke(); }
      const port = ctx.createRadialGradient(cx + rx * 0.68, cy + ry * 0.33, 0, cx + rx * 0.68, cy + ry * 0.33, rx * 0.09);
      port.addColorStop(0, P.cyborgScreen); port.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = port; ctx.beginPath(); ctx.arc(cx + rx * 0.68, cy + ry * 0.33, rx * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.save();
      for (let i = 0; i < 3; i++) {
        const jy = cy + ry * (0.5 + i * 0.34);
        ctx.beginPath();
        ctx.moveTo(cx + rx * (0.42 - i * 0.06), jy); ctx.lineTo(cx + rx * (0.92 - i * 0.12), jy - ry * 0.1);
        ctx.lineTo(cx + rx * (0.88 - i * 0.12), jy + ry * 0.26); ctx.lineTo(cx + rx * (0.36 - i * 0.06), jy + ry * 0.3); ctx.closePath();
        ctx.fillStyle = i === 1 ? P.cyborgScreen : mix(P.cyborgDark, i === 0 ? 0.08 : -0.1);
        ctx.globalAlpha = i === 1 ? 0.85 : 1; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = mix(P.cyborgDark, -0.4); ctx.lineWidth = rx * 0.015; ctx.stroke();
        ctx.fillStyle = P.metal; ctx.beginPath(); ctx.arc(cx + rx * (0.75 - i * 0.1), jy + ry * 0.08, rx * 0.025, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = mix(P.cyborgDark, -0.3); ctx.lineWidth = rx * 0.045; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx + rx * 0.55, cy + ry * 1.35); ctx.quadraticCurveTo(cx + rx * 0.4, cy + ry * 1.7, cx + rx * 0.35, cy + ry * 2.1); ctx.stroke();
      ctx.fillStyle = P.cyborgScreen; ctx.beginPath(); ctx.arc(cx + rx * 0.35, cy + ry * 2.1, rx * 0.05, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      poseFaceOverlay(ctx, px, P, P.__pose, my);
    }
    const DWIGHT = {
      skin: '#e3b088', skinSh: '#c4906a', hair: '#262628', hairSh: '#141416',
      jacket: '#4b5245', jacketSh: '#33382f', jacketHi: '#6b7560', tshirt: '#8a9099', tshirtSh: '#5f6670',
      pants: '#33363f', pantsSh: '#20222a', shoe: '#2a2c30', shoeSh: '#17181b', sole: '#454850',
      accent: '#ff9a3c', mouth: '#8a5a48', metal: '#c7ccd3', belt: '#1a1510',
      cyborgDark: '#2a2e33', cyborgShell: '#5b4a66', cyborgScreen: '#3ad9b0',
    };

    // ---- Pam ----
    function buildDollPam(P, pose) {
      const b = [];
      row(b, 0, [[7, 6, P.hair]]); row(b, 1, [[5, 10, P.hair]]); row(b, 2, [[4, 12, P.hair]]);
      row(b, 3, [[2, 3, P.hairSh], ...seg(5, 10, P.skin, P.skinSh), [15, 3, P.hair]]);
      row(b, 4, [[2, 2, P.hairSh], ...seg(4, 12, P.skin, P.skinSh), [16, 2, P.hair]]);
      row(b, 5, [[2, 1, P.hair], ...seg(3, 14, P.skin, P.skinSh), [17, 1, P.hairSh]]);
      row(b, 6, seg(2, 16, P.skin, P.skinSh, 3)); row(b, 7, seg(4, 12, P.skin, P.skinSh, 3));
      row(b, 8, seg(5, 10, P.skin, P.skinSh, 3)); row(b, 9, seg(6, 8, P.skin, P.skinSh, 2));
      row(b, 10, seg(7, 6, P.skin, P.skinSh, 2));
      const torso = [[11, 3, 13], [12, 3, 13], [13, 4, 12], [14, 4, 11], [15, 5, 10], [16, 5, 9], [17, 6, 8], [18, 6, 8]];
      for (const [y, x, w] of torso) row(b, y, seg(x, w, P.cardigan, P.cardiganSh, 2));
      for (let y = 12; y <= 18; y++) row(b, y, seg(8, 3, P.blouse, P.blouseSh, 1));
      b.push({ x: 4, y: 11, w: 1, h: 1, color: P.accent }); b.push({ x: 14, y: 11, w: 1, h: 1, color: P.accent });
      for (const [y, segs] of poseHands(pose, P)) row(b, y, segs);
      for (let y = 19; y <= 25; y++) { row(b, y, seg(6, 4, P.pants, P.pantsSh, 2)); row(b, y, seg(11, 4, P.pants, P.pantsSh, 2)); }
      for (let y = 26; y <= 29; y++) { row(b, y, seg(6, 4, P.shoe, P.shoeSh, 2)); row(b, y, seg(11, 4, P.shoe, P.shoeSh, 2)); }
      return { blocks: b };
    }
    function buildDoll2xPam(P, pose) {
      const blocks = scaleBlocks(buildDollPam(P, pose).blocks, 2);
      blocks.push({ x: 4, y: 9, w: 2, h: 4, color: P.skinSh }); blocks.push({ x: 34, y: 9, w: 2, h: 4, color: P.skinSh });
      blocks.push({ x: 35, y: 7, w: 2, h: 7, color: '#e8b64a' }); blocks.push({ x: 35, y: 6, w: 2, h: 1, color: '#2a2a2e' });
      const fine = [];
      fine.push({ x: 14, y: 24, w: 1, h: 14, color: P.cardiganHi }); fine.push({ x: 22, y: 24, w: 1, h: 14, color: P.cardiganHi });
      for (let y = 26; y <= 36; y += 5) fine.push({ x: 18, y, w: 2, h: 2, color: P.accent });
      fine.push({ x: 9, y: 31, w: 6, h: 5, color: P.cardiganHi }); fine.push({ x: 10, y: 32, w: 4, h: 3, color: P.cardiganSh });
      fine.push({ x: 11, y: 29, w: 1, h: 4, color: P.accent });
      fine.push({ x: 9, y: 30, w: 5, h: 2, color: P.cardiganSh }); fine.push({ x: 24, y: 30, w: 5, h: 2, color: P.cardiganSh });
      fine.push({ x: 12, y: 37, w: 16, h: 1, color: P.cardiganHi });
      fine.push({ x: 14, y: 38, w: 12, h: 1, color: P.cardiganSh });
      fine.push({ x: 13, y: 55, w: 6, h: 1, color: P.accent }); fine.push({ x: 23, y: 55, w: 6, h: 1, color: P.accent });
      fine.push({ x: 12, y: 59, w: 8, h: 1, color: P.shoeSh }); fine.push({ x: 22, y: 59, w: 8, h: 1, color: P.shoeSh });
      return { blocks, fine };
    }
    function paintFacePam(ctx, px, P) {
      const cx = 20 * px, cy = 10.5 * px, rx = 11 * px, ry = 5.5 * px;
      ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
      const base = ctx.createRadialGradient(cx - rx * 0.4, cy - ry * 0.6, rx * 0.15, cx, cy, rx * 1.4);
      base.addColorStop(0, mix(P.skin, 0.22)); base.addColorStop(0.5, P.skin); base.addColorStop(1, mix(P.skin, -0.22));
      ctx.fillStyle = base; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      const hot = ctx.createRadialGradient(cx - rx * 0.1, cy - ry * 0.5, 0, cx - rx * 0.1, cy - ry * 0.5, rx * 0.6);
      hot.addColorStop(0, 'rgba(255,240,215,.3)'); hot.addColorStop(1, 'rgba(255,240,215,0)');
      ctx.fillStyle = hot; ctx.fillRect(cx - rx * 1.5, cy - ry * 1.5, rx * 3, ry * 3);
      for (const sx of [-1, 1]) {
        const bx = cx + sx * rx * 0.5, by = cy + ry * 0.3;
        const bg = ctx.createRadialGradient(bx, by, 1, bx, by, rx * 0.28);
        bg.addColorStop(0, 'rgba(242,140,150,.3)'); bg.addColorStop(1, 'rgba(242,140,150,0)');
        ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(bx, by, rx * 0.28, 0, Math.PI * 2); ctx.fill();
      }
      const eyeY = cy - ry * 0.05;
      for (const sx of [-1, 1]) {
        const ex = cx + sx * rx * 0.4;
        ctx.fillStyle = '#ece2d2'; ctx.beginPath(); ctx.ellipse(ex, eyeY, rx * 0.19, ry * 0.13, 0, 0, Math.PI * 2); ctx.fill();
        const iris = ctx.createRadialGradient(ex, eyeY, 1, ex, eyeY, rx * 0.11);
        iris.addColorStop(0, '#8fae5c'); iris.addColorStop(0.6, '#55713a'); iris.addColorStop(1, '#2c3a1e');
        ctx.fillStyle = iris; ctx.beginPath(); ctx.arc(ex, eyeY, rx * 0.095, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#10151c'; ctx.beginPath(); ctx.arc(ex, eyeY, rx * 0.04, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(ex - rx * 0.03, eyeY - ry * 0.05, rx * 0.025, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = mix(P.skin, -0.3); ctx.lineWidth = px * 0.22; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(ex - rx * 0.19, eyeY - ry * 0.08); ctx.quadraticCurveTo(ex, eyeY - ry * 0.3, ex + rx * 0.19, eyeY - ry * 0.1); ctx.stroke();
        const inX = ex - sx * rx * 0.08, inY = eyeY - ry * 0.52, outX = ex + sx * rx * 0.28, outY = eyeY - ry * 0.68;
        const midX = (inX + outX) / 2, midY = (inY + outY) / 2 - ry * 0.06;
        ctx.fillStyle = P.hairSh;
        ctx.beginPath(); ctx.moveTo(inX, inY - ry * 0.07); ctx.quadraticCurveTo(midX, midY - ry * 0.07, outX, outY - ry * 0.05);
        ctx.quadraticCurveTo(midX, midY + ry * 0.07, inX, inY + ry * 0.05); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = '#2a2a2e'; ctx.lineWidth = px * 0.16; ctx.lineCap = 'round';
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * rx * 0.4, eyeY, rx * 0.26, ry * 0.2, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(cx - rx * 0.14, eyeY - ry * 0.02); ctx.lineTo(cx + rx * 0.14, eyeY - ry * 0.02); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + rx * 0.66, eyeY - ry * 0.04); ctx.lineTo(cx + rx * 0.85, eyeY - ry * 0.16); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.1)';
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * rx * 0.4, eyeY, rx * 0.24, ry * 0.18, 0, 0, Math.PI * 2); ctx.fill(); }
      const nx = cx + rx * 0.01, nTop = cy - ry * 0.25, nBot = cy + ry * 0.5;
      ctx.beginPath(); ctx.moveTo(nx - rx * 0.05, nTop); ctx.lineTo(nx - rx * 0.1, nBot - ry * 0.08);
      ctx.quadraticCurveTo(nx - rx * 0.02, nBot + ry * 0.06, nx + rx * 0.09, nBot - ry * 0.08); ctx.lineTo(nx + rx * 0.05, nTop); ctx.closePath();
      const noseGrad = ctx.createLinearGradient(nx - rx * 0.1, 0, nx + rx * 0.1, 0);
      noseGrad.addColorStop(0, mix(P.skin, 0.25)); noseGrad.addColorStop(0.5, P.skin); noseGrad.addColorStop(1, mix(P.skin, -0.3));
      ctx.fillStyle = noseGrad; ctx.fill();
      ctx.fillStyle = mix(P.skin, -0.35);
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(nx + sx * rx * 0.09, nBot, rx * 0.035, 0, Math.PI * 2); ctx.fill(); }
      const my = cy + ry * 0.65;
      ctx.beginPath(); ctx.moveTo(cx - rx * 0.24, my); ctx.quadraticCurveTo(cx, my + ry * 0.32, cx + rx * 0.24, my);
      ctx.quadraticCurveTo(cx, my + ry * 0.12, cx - rx * 0.24, my); ctx.closePath();
      ctx.fillStyle = mix(P.mouth, -0.15); ctx.fill();
      ctx.fillStyle = mix(P.mouth, 0.3); ctx.beginPath(); ctx.ellipse(cx, my + ry * 0.1, rx * 0.16, ry * 0.08, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.save();
      const bunCx = cx - rx * 0.05, bunCy = ry * 0.55;
      const bun = ctx.createRadialGradient(bunCx - rx * 0.1, bunCy - ry * 0.15, rx * 0.05, bunCx, bunCy, rx * 0.4);
      bun.addColorStop(0, mix(P.hair, 0.2)); bun.addColorStop(1, mix(P.hair, -0.25));
      ctx.fillStyle = bun; ctx.beginPath(); ctx.ellipse(bunCx, bunCy, rx * 0.38, ry * 0.72, -0.08, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = mix(P.hair, 0.15); ctx.lineWidth = px * 0.14; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(bunCx - rx * 0.3, bunCy + ry * 0.2); ctx.quadraticCurveTo(bunCx - rx * 0.5, bunCy + ry * 0.5, bunCx - rx * 0.4, bunCy + ry * 0.9); ctx.stroke();
      ctx.strokeStyle = P.accent; ctx.lineWidth = px * 0.3;
      ctx.beginPath(); ctx.ellipse(bunCx, bunCy + ry * 0.55, rx * 0.3, ry * 0.18, -0.05, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      poseFaceOverlay(ctx, px, P, P.__pose, my);
    }
    const PAM = {
      skin: '#f0c49a', skinSh: '#d9a271', hair: '#6b3d2e', hairSh: '#4a2a1f',
      cardigan: '#b5607d', cardiganSh: '#8a4460', cardiganHi: '#d98aa5', blouse: '#f3ead9', blouseSh: '#d9cdb8',
      pants: '#4a4440', pantsSh: '#332e2b', shoe: '#8a5a42', shoeSh: '#5e3b2a',
      mouth: '#c9596e', accent: '#ff4fa3',
    };

    // ---- Ralph (отдельная решётка 48×34, своя сторона-вид) ----
    const RGRID = 48, RROWS = 34;
    function buildDollRalph(P) {
      const b = [];
      row(b, 0, [[22, 2, P.black], [30, 2, P.black]]);
      row(b, 1, [[21, 3, P.black], [29, 3, P.black]]);
      row(b, 2, [[21, 1, P.black], [22, 1, P.furIn], [29, 1, P.furIn], [30, 1, P.black]]);
      row(b, 3, [[20, 4, P.fur], [28, 4, P.fur]]);
      row(b, 4, seg(19, 14, P.fur, P.furSh, 2)); row(b, 5, seg(18, 16, P.fur, P.furSh, 2)); row(b, 6, seg(18, 17, P.fur, P.furSh, 2));
      row(b, 7, [...seg(17, 10, P.fur, P.furSh, 2), [27, 7, P.white]]);
      row(b, 8, [...seg(17, 9, P.fur, P.furSh, 2), [26, 9, P.white]]);
      row(b, 9, [...seg(18, 8, P.fur, P.furSh, 2), [26, 10, P.white]]);
      row(b, 10, [...seg(19, 6, P.fur, P.furSh, 1), [25, 11, P.white]]);
      row(b, 11, [[20, 5, P.fur], [25, 11, P.white]]);
      row(b, 12, [[21, 4, P.fur], [25, 10, P.white]]);
      row(b, 13, [[22, 3, P.fur], [25, 8, P.white]]);
      row(b, 6, [[10, 2, P.fur]]); row(b, 7, [[8, 3, P.fur]]); row(b, 8, [[7, 4, P.fur]]); row(b, 9, [[6, 5, P.fur]]);
      row(b, 10, [[5, 5, P.fur]]); row(b, 11, [[5, 6, P.fur]]); row(b, 12, [[5, 7, P.white]]); row(b, 13, [[6, 7, P.white]]);
      for (let y = 13; y <= 22; y++) {
        const t = (y - 13) / 9; const top = 11 + Math.round(t * 2); const full = 24 - Math.round(t * 2);
        row(b, y, y <= 16 ? [[top, full, P.black]] : seg(top, full, P.fur, P.furSh, 2));
      }
      for (let y = 19; y <= 23; y++) row(b, y, [[14, 16, P.white]]);
      for (let y = 24; y <= 29; y++) row(b, y, [[11, 3, P.furSh], [15, 4, P.fur], [25, 3, P.furSh], [29, 4, P.fur]]);
      for (let y = 28; y <= 29; y++) row(b, y, [[11, 3, P.white], [15, 4, P.white], [25, 3, P.white], [29, 4, P.white]]);
      return { blocks: b };
    }
    function buildDoll2xRalph(P) {
      const blocks = buildDollRalph(P).blocks;
      const fine = [];
      fine.push({ x: 24, y: 13, w: 3, h: 2, color: P.accent }); fine.push({ x: 24, y: 15, w: 1, h: 3, color: P.accent });
      fine.push({ x: 22, y: 17, w: 5, h: 4, color: '#15171a' }); fine.push({ x: 23, y: 18, w: 3, h: 2, color: P.accent });
      return { blocks, fine };
    }
    function paintFaceRalph(ctx, px, P) {
      const hx = 34 * px, hy = 9 * px;
      ctx.save(); ctx.beginPath(); ctx.ellipse(hx, hy, 13 * px, 10 * px, 0, 0, Math.PI * 2); ctx.clip();
      const hot = ctx.createRadialGradient(hx - 4 * px, hy - 4 * px, 1, hx - 4 * px, hy - 4 * px, 14 * px);
      hot.addColorStop(0, 'rgba(255,235,210,.3)'); hot.addColorStop(1, 'rgba(255,235,210,0)');
      ctx.fillStyle = hot; ctx.fillRect(hx - 16 * px, hy - 16 * px, 32 * px, 32 * px);
      const sideSh = ctx.createLinearGradient(hx, hy - 8 * px, hx, hy + 10 * px);
      sideSh.addColorStop(0, 'rgba(0,0,0,0)'); sideSh.addColorStop(1, 'rgba(20,12,6,.3)');
      ctx.fillStyle = sideSh; ctx.fillRect(hx - 16 * px, hy - 16 * px, 32 * px, 32 * px);
      const ex = 29 * px, ey = 9 * px;
      ctx.fillStyle = mix(P.fur, -0.35); ctx.beginPath(); ctx.ellipse(ex, ey, 1.6 * px, 1.3 * px, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a140f'; ctx.beginPath(); ctx.ellipse(ex + 0.2 * px, ey, 1.1 * px, 1.1 * px, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(ex - 0.2 * px, ey - 0.35 * px, 0.35 * px, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = mix(P.white, -0.12); ctx.beginPath(); ctx.ellipse(37 * px, 11.5 * px, 4 * px, 2.4 * px, -0.15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#20140f'; ctx.beginPath(); ctx.ellipse(40.5 * px, 11.3 * px, 1.3 * px, 1 * px, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e07a82';
      ctx.beginPath(); ctx.moveTo(37.5 * px, 13.2 * px); ctx.quadraticCurveTo(37 * px, 16 * px, 38.2 * px, 16.4 * px);
      ctx.quadraticCurveTo(39 * px, 15.5 * px, 38.3 * px, 13 * px); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    const RALPH = { fur: '#d97b3f', furSh: '#a85a2a', furIn: '#8a4a2a', white: '#f5ecd9', black: '#2a2420', accent: '#39ff88' };

    // ---- битмапы персонажей: строятся один раз, дальше только drawImage. Стол (раньше — такой же готовый
    // битмап 100×60 с разрезом back/front под старую фронтальную сцену) в изометрической сцене больше НЕ
    // нужен как битмап: стол теперь — дешёвая живая векторная отрисовка через isoBox() (см. drawIsoDesk
    // ниже, перед drawWorld), которая и так пересчитывается по изометрической проекции каждый кадр
    function buildCharacterBitmap(buildFn, paintFn, P, outline, pose) {
      const S = 6;
      const sup = document.createElement('canvas'); sup.width = GRID * S; sup.height = ROWS * S;
      const sc = sup.getContext('2d');
      renderBody(sc, buildFn(P, pose), S, outline);
      paintFn(sc, S, Object.assign({}, P, { __pose: pose }));
      const off = document.createElement('canvas'); off.width = GRID; off.height = ROWS;
      const oc = off.getContext('2d'); oc.imageSmoothingEnabled = true; oc.imageSmoothingQuality = 'high';
      oc.drawImage(sup, 0, 0, GRID, ROWS);
      return off;
    }
    function buildRalphBitmap() {
      const S = 6;
      const sup = document.createElement('canvas'); sup.width = RGRID * S; sup.height = RROWS * S;
      const sc = sup.getContext('2d');
      renderBody(sc, buildDoll2xRalph(RALPH), S, '#2a1a10');
      paintFaceRalph(sc, S, RALPH);
      const off = document.createElement('canvas'); off.width = RGRID; off.height = RROWS;
      const oc = off.getContext('2d'); oc.imageSmoothingEnabled = true; oc.imageSmoothingQuality = 'high';
      oc.drawImage(sup, 0, 0, RGRID, RROWS);
      return off;
    }
    const POSES = ['stand', 'type', 'lean', 'failed', 'done'];
    const PEOPLE = {
      michael: { build: buildDoll2xMichael, paint: paintFaceMichael, P: MICHAEL, outline: '#23160f' },
      dwight: { build: buildDoll2xDwight, paint: paintFaceDwight, P: DWIGHT, outline: '#1c2420' },
      pam: { build: buildDoll2xPam, paint: paintFacePam, P: PAM, outline: '#2e1420' },
    };
    // построение самих битмапов требует canvas/document — в тестовом окружении (node, без DOM, см. hasDOM
    // выше) этого нет, а он лишь require()-ит модуль ради чистых экспортов, не рисуя кадр; поэтому держим
    // BIG.sprites пустым без DOM, не роняя require() модуля
    const sprites = {};
    if (hasDOM) {
      for (const name in PEOPLE) {
        sprites[name] = {};
        for (const pose of POSES) sprites[name][pose] = buildCharacterBitmap(PEOPLE[name].build, PEOPLE[name].paint, PEOPLE[name].P, PEOPLE[name].outline, pose);
      }
      sprites.ralph = buildRalphBitmap();
    }

    BIG.GRID = GRID; BIG.ROWS = ROWS; BIG.RGRID = RGRID; BIG.RROWS = RROWS;
    BIG.sprites = sprites;
    BIG.accents = { michael: MICHAEL.accent, dwight: DWIGHT.accent, pam: PAM.accent, ralph: RALPH.accent };
    // поза по a.state — то же сопоставление, что в drawHuman()/STATE_TO_POSES теста, но здесь без
    // раздельных type1/type2 (один кадр «печати» вместо чередования пальцев — анимация чуть беднее,
    // такова цена разового построения битмапов вместо отрисовки вживую каждый кадр)
    BIG.poseFor = (state) => {
      if (state === 'working') return 'type';
      if (state === 'review') return 'lean';
      if (state === 'failed') return 'failed';
      if (state === 'done') return 'done';
      return 'stand';
    };
  })();

  // ================================================================== ISO: изометрическая сцена-локация
  // Полная замена прежней фронтальной сцены (панорамное окно + вид анфас) по просьбе пользователя —
  // референс с видом сверху/под углом (top-down isometric cyberpunk-офис). Канва остаётся 768×432 (LW×LH,
  // тесты это пином не трогают), поэтому вся геометрия подобрана под этот размер, а не скопирована из
  // прототипа 1:1 (там холст был 1400×900). Персонажи — те же готовые фронтальные битмапы (BIG.sprites),
  // просто вставленные как «билборды» в изометрию — так все игры с честной 3D/изо геометрией мебели и
  // плоскими спрайтами персонажей и делают, иначе лицо (ради которого всё и затевалось) было бы не видно.
  const ISO = {};
  (function buildIso() {
    const TW = 56, TH = 28, GRID = 7;
    const originX = LW / 2, originY = 128;
    const WALL_H = 100;
    function iso(gx, gy, gz) {
      gz = gz || 0;
      return { x: originX + (gx - gy) * TW / 2, y: originY + (gx + gy) * TH / 2 - gz };
    }
    function isoMix(hex, amt) {
      const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const f = c => Math.max(0, Math.min(255, amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
      return `rgb(${f(r) | 0},${f(g) | 0},${f(b) | 0})`;
    }

    ISO.iso = iso; ISO.GRID = GRID; ISO.WALL_H = WALL_H;
    // раскладка станций на сетке пола: 1-2 колонки, без обхода препятствий (у сцены нет колонн/мебели,
    // мешающих столам) — просто симметричный паркинг у задних стен
    ISO.stationsFor = (n) => {
      const cols = n <= 1 ? 1 : 2, rows = Math.ceil(n / cols);
      const lo = 1.0, hi = GRID - 2.3;
      const xs = cols === 1 ? [(lo + hi) / 2] : [lo, hi];
      const out = [];
      for (let i = 0; i < n; i++) {
        const col = i % cols, r = Math.floor(i / cols);
        const gy = rows === 1 ? (lo + hi) / 2 : lo + (hi - lo) * (r / (rows - 1 || 1));
        out.push({ gx: xs[col], gy });
      }
      return out;
    };
    // пиксельная точка-якорь персонажа на полу (та же формула, что в drawBillboard) — используется как
    // a.home.{x,y} для совместимости со всем остальным кодом (конверты/доска планирования/речевые
    // пузыри/визиты котов — они все адресуются через a.home.x/y, без разницы, как эта точка вычислена)
    ISO.anchorFor = (gx, gy) => iso(gx + 0.5, gy + 0.08, 0);

    // ---- фон: ночной киберпанк-город вокруг здания (за стенами и под полом)
    function drawCitySky() {
      const g = o.createLinearGradient(0, 0, 0, LH);
      g.addColorStop(0, '#0d0a1a'); g.addColorStop(0.6, '#140f24'); g.addColorStop(1, '#1a1428');
      o.fillStyle = g; o.fillRect(0, 0, LW, LH);
      const rand = (seed) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); };
      for (let i = 0; i < 30; i++) {
        const left = i % 2 === 0;
        const bw = 22 + rand(i) * 38;
        const bx = left ? rand(i + 50) * (LW * 0.32) : LW - rand(i + 50) * (LW * 0.32) - bw;
        const bh = 60 + rand(i + 99) * 230;
        const by = LH - bh;
        o.fillStyle = `rgba(${10 + rand(i) * 10 | 0},${8 + rand(i) * 8 | 0},${22 + rand(i) * 14 | 0},1)`;
        o.fillRect(bx, by, bw, bh);
        for (let wy = by + 4; wy < LH - 4; wy += 7) {
          for (let wx = bx + 2; wx < bx + bw - 2; wx += 6) {
            const r = rand(wx * 3.1 + wy * 7.7 + i);
            if (r < 0.10) { o.fillStyle = 'rgba(255,217,160,.65)'; o.fillRect(wx, wy, 2, 3); }
            else if (r < 0.14) { o.fillStyle = 'rgba(255,79,163,.5)'; o.fillRect(wx, wy, 2, 3); }
            else if (r < 0.17) { o.fillStyle = 'rgba(120,220,255,.45)'; o.fillRect(wx, wy, 2, 3); }
          }
        }
      }
    }

    // ---- здание под полом: фасад вдоль двух ПЕРЕДНИХ рёбер (задние уже закрыты стенами) — без этого
    // пол выглядел бы плоской парящей картой, а не срезом настоящего здания
    function drawBuildingFascia() {
      const FH = 38;
      const edges = [[iso(GRID, 0), iso(GRID, GRID)], [iso(0, GRID), iso(GRID, GRID)]];
      const rand = (seed) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); };
      edges.forEach(([a, b], ei) => {
        o.save();
        o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.lineTo(b.x, b.y + FH); o.lineTo(a.x, a.y + FH); o.closePath();
        const g = o.createLinearGradient(a.x, a.y, a.x, a.y + FH);
        g.addColorStop(0, ei === 0 ? '#1b2030' : '#161b28'); g.addColorStop(1, '#0c0e16');
        o.fillStyle = g; o.fill();
        o.clip();
        for (let i = 0; i < 12; i++) {
          const t0 = i / 12, t1 = (i + 1) / 12;
          const x0 = a.x + (b.x - a.x) * t0, y0 = a.y + (b.y - a.y) * t0;
          const x1 = a.x + (b.x - a.x) * t1, y1 = a.y + (b.y - a.y) * t1;
          const r = rand(i + ei * 50);
          if (r < 0.4) {
            o.fillStyle = r < 0.15 ? 'rgba(255,217,160,.5)' : 'rgba(120,180,255,.4)';
            o.fillRect((x0 + x1) / 2 - 2, (y0 + y1) / 2 + 8 + rand(i + 9) * 12, 4, 5);
          }
        }
        o.strokeStyle = 'rgba(140,170,220,.3)'; o.lineWidth = 2;
        o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.stroke();
        o.restore();
      });
    }
    function drawDepthHaze() {
      const a = iso(GRID, GRID);
      const g = o.createLinearGradient(0, a.y + 30, 0, a.y + 100);
      g.addColorStop(0, 'rgba(10,9,18,0)'); g.addColorStop(1, 'rgba(10,9,18,.75)');
      o.fillStyle = g; o.fillRect(0, a.y + 30, LW, 100);
    }

    // ---- задние стены (левая вдоль gy=0, правая вдоль gx=0) — сходятся в угол над вывеской
    function drawBackWalls() {
      const wallGrad = o.createLinearGradient(0, originY - WALL_H, 0, originY);
      wallGrad.addColorStop(0, '#171b2a'); wallGrad.addColorStop(1, '#232a3d');
      for (let gx = 0; gx < GRID; gx++) {
        const b0 = iso(gx, 0), b1 = iso(gx + 1, 0);
        const t0 = { x: b0.x, y: b0.y - WALL_H }, t1 = { x: b1.x, y: b1.y - WALL_H };
        o.beginPath(); o.moveTo(b0.x, b0.y); o.lineTo(b1.x, b1.y); o.lineTo(t1.x, t1.y); o.lineTo(t0.x, t0.y); o.closePath();
        o.fillStyle = wallGrad; o.fill(); o.strokeStyle = 'rgba(0,0,0,.35)'; o.lineWidth = 1; o.stroke();
      }
      const wallGrad2 = o.createLinearGradient(0, originY - WALL_H, 0, originY);
      wallGrad2.addColorStop(0, '#11141f'); wallGrad2.addColorStop(1, '#1b2030');
      for (let gy = 0; gy < GRID; gy++) {
        const b0 = iso(0, gy), b1 = iso(0, gy + 1);
        const t0 = { x: b0.x, y: b0.y - WALL_H }, t1 = { x: b1.x, y: b1.y - WALL_H };
        o.beginPath(); o.moveTo(b0.x, b0.y); o.lineTo(b1.x, b1.y); o.lineTo(t1.x, t1.y); o.lineTo(t0.x, t0.y); o.closePath();
        o.fillStyle = wallGrad2; o.fill(); o.strokeStyle = 'rgba(0,0,0,.35)'; o.lineWidth = 1; o.stroke();
      }
    }
    function wallWindow(gx0, gy0, side, w, h, yOff, color, bright) {
      const b = side === 'left' ? iso(gx0, 0) : iso(0, gy0);
      const b2 = side === 'left' ? iso(gx0 + w, 0) : iso(0, gy0 + w);
      const topY = b.y - WALL_H + yOff;
      const dx = (b2.x - b.x), dy = (b2.y - b.y);
      const x0 = b.x + dx * 0.12, y0 = topY + dy * 0.12;
      const x1 = b.x + dx * 0.88, y1 = topY + dy * 0.88;
      const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
      o.save();
      o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.lineTo(x1, y1 + h); o.lineTo(x0, y0 + h); o.closePath();
      const g = o.createLinearGradient(x0, y0, x0, y0 + h);
      g.addColorStop(0, isoMix(color, 0.3 * bright)); g.addColorStop(1, isoMix(color, -0.3));
      o.fillStyle = g; o.fill(); o.strokeStyle = 'rgba(5,6,10,.7)'; o.lineWidth = 2; o.stroke();
      o.strokeStyle = 'rgba(5,6,10,.55)'; o.lineWidth = 1.5;
      o.beginPath(); o.moveTo(xm, ym); o.lineTo(xm, ym + h); o.stroke();
      if (bright > 0.75) {
        o.save(); o.globalAlpha = 0.35; o.fillStyle = color;
        o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.lineTo(x1, y1 + h); o.lineTo(x0, y0 + h); o.closePath(); o.fill();
        o.restore();
      }
      o.restore();
    }
    function drawWindows() {
      const rand = (seed) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); };
      let i = 0;
      for (let gx = 0; gx < GRID; gx += 2) wallWindow(gx, 0, 'left', 1.3, 26, 26, '#3a6fd8', 0.5 + rand(i++) * 0.6);
      for (let gy = 0; gy < GRID; gy += 2) wallWindow(0, gy, 'right', 1.3, 26, 26, '#8a3ad8', 0.5 + rand(i++ + 99) * 0.6);
    }
    // трубы/кабели под потолком вдоль стен, со свисающими проводами-огоньками — заполняют верх кадра
    function drawCeilingPipes() {
      o.save();
      for (const side of ['left', 'right']) {
        const a = iso(0, 0);
        const b = side === 'left' ? iso(GRID, 0) : iso(0, GRID);
        const yOff = -WALL_H - 12;
        o.strokeStyle = '#2a2f3e'; o.lineWidth = 5; o.lineCap = 'round';
        o.beginPath(); o.moveTo(a.x, a.y + yOff); o.lineTo(b.x, b.y + yOff); o.stroke();
        o.strokeStyle = '#3a4156'; o.lineWidth = 1.5;
        o.beginPath(); o.moveTo(a.x, a.y + yOff - 2); o.lineTo(b.x, b.y + yOff - 2); o.stroke();
        for (let i = 1; i < GRID; i += 2) {
          const t = i / GRID;
          const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t + yOff;
          o.strokeStyle = 'rgba(40,46,60,.9)'; o.lineWidth = 1.5;
          o.beginPath(); o.moveTo(px, py); o.lineTo(px, py + 10 + (i % 3) * 3); o.stroke();
          o.fillStyle = i % 4 === 1 ? 'rgba(255,90,138,.9)' : 'rgba(120,220,255,.9)';
          o.beginPath(); o.arc(px, py + 10 + (i % 3) * 3, 1.6, 0, Math.PI * 2); o.fill();
        }
      }
      o.restore();
    }
    function drawSign() {
      const p = iso(GRID / 2, 0);
      const x = p.x, y = p.y - WALL_H - 10;
      o.save();
      o.font = '700 18px "Orbitron","Pixelify Sans",sans-serif';
      o.textAlign = 'center'; o.textBaseline = 'middle';
      o.shadowColor = '#ff5a8a'; o.shadowBlur = 12;
      o.fillStyle = '#ff5a8a'; o.fillText('CYBER OFFICE', x, y);
      o.shadowBlur = 0; o.restore();
      o.save(); o.strokeStyle = 'rgba(255,90,138,.5)'; o.lineWidth = 1.5; o.strokeRect(x - 92, y - 13, 184, 26); o.restore();
    }

    // ---- пол: шахматная сетка ромбов + блеск + контактная тень у стен
    const FLOOR_LINE = 'rgba(140,170,220,.14)';
    function tilePath(gx, gy) {
      const p0 = iso(gx, gy), p1 = iso(gx + 1, gy), p2 = iso(gx + 1, gy + 1), p3 = iso(gx, gy + 1);
      o.beginPath(); o.moveTo(p0.x, p0.y); o.lineTo(p1.x, p1.y); o.lineTo(p2.x, p2.y); o.lineTo(p3.x, p3.y); o.closePath();
    }
    function drawFloor() {
      for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
        tilePath(gx, gy); o.fillStyle = (gx + gy) % 2 ? TH.floor1 : TH.floor2; o.fill();
        o.strokeStyle = FLOOR_LINE; o.lineWidth = 1; o.stroke();
      }
    }
    function drawFloorSheen() {
      o.save();
      o.beginPath();
      for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
        const p0 = iso(gx, gy), p1 = iso(gx + 1, gy), p2 = iso(gx + 1, gy + 1), p3 = iso(gx, gy + 1);
        o.moveTo(p0.x, p0.y); o.lineTo(p1.x, p1.y); o.lineTo(p2.x, p2.y); o.lineTo(p3.x, p3.y); o.closePath();
      }
      o.clip();
      const topC = iso(GRID / 2, 0), botC = iso(GRID, GRID);
      const sheen = o.createLinearGradient(topC.x, topC.y, botC.x, botC.y);
      sheen.addColorStop(0, 'rgba(160,190,255,.10)'); sheen.addColorStop(0.45, 'rgba(160,190,255,0)');
      sheen.addColorStop(0.75, 'rgba(160,190,255,0)'); sheen.addColorStop(1, 'rgba(230,180,90,.08)');
      o.fillStyle = sheen; o.fillRect(0, 0, LW, LH);
      o.restore();
    }
    function drawWallBaseShadow() {
      for (const [a, b] of [[iso(0, 0), iso(GRID, 0)], [iso(0, 0), iso(0, GRID)]]) {
        o.save();
        o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.lineTo(b.x, b.y + 16); o.lineTo(a.x, a.y + 16); o.closePath();
        o.fillStyle = 'rgba(0,0,0,.32)'; o.fill();
        o.restore();
      }
    }
    function floorGlow(gx, gy, color, r) {
      const p = iso(gx, gy);
      const g = o.createRadialGradient(p.x, p.y, 2, p.x, p.y, r);
      g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
      o.fillStyle = g; o.beginPath(); o.ellipse(p.x, p.y, r, r * 0.5, 0, 0, Math.PI * 2); o.fill();
    }
    function drawCeilingLamp(gx, gy) {
      floorGlow(gx, gy, 'rgba(255,217,160,.35)', 42);
      const p = iso(gx, gy, 0);
      o.fillStyle = 'rgba(255,230,190,.9)'; o.beginPath(); o.arc(p.x, p.y, 3, 0, Math.PI * 2); o.fill();
    }
    function drawPlantTop(gx, gy) {
      const p = iso(gx, gy, 0);
      o.save();
      o.fillStyle = 'rgba(0,0,0,.3)'; o.beginPath(); o.ellipse(p.x, p.y, 11, 5.5, 0, 0, Math.PI * 2); o.fill();
      const potTop = iso(gx, gy, 11);
      o.fillStyle = '#3a2f26'; o.beginPath(); o.ellipse(potTop.x, potTop.y, 7.5, 4, 0, 0, Math.PI * 2); o.fill();
      for (const [dx, dy, r, col] of [[-4, -4, 11, '#2f6b45'], [4, -7, 12, '#357a4d'], [0, -11, 10, '#3f8a57'], [3, -3, 9, '#2a5f3d']]) {
        const lp = iso(gx, gy, 11);
        o.fillStyle = col; o.beginPath(); o.ellipse(lp.x + dx, lp.y + dy, r, r * 0.8, 0, 0, Math.PI * 2); o.fill();
      }
      o.restore();
    }
    function drawServerRack(gx, gy) {
      isoBox(gx, gy, 0.46, 0.46, 0, 54, { top: '#2c3240', left: '#15171f', right: '#1e212b' });
      const p = iso(gx + 0.23, gy + 0.0, 54);
      for (let i = 0; i < 4; i++) {
        o.fillStyle = i % 2 ? 'rgba(120,220,255,.9)' : 'rgba(255,90,138,.8)';
        o.fillRect(p.x - 6, p.y - 6 - i * 6, 10, 3);
      }
    }
    function drawEntrance() {
      const corner = iso(GRID, GRID);
      const doorW = 16, doorH = 42;
      const cx = corner.x, baseY = corner.y;
      o.save();
      o.fillStyle = '#15171f';
      o.beginPath();
      o.moveTo(cx - doorW - 6, baseY + 5); o.lineTo(cx + doorW + 6, baseY + 5);
      o.lineTo(cx + doorW + 6, baseY - doorH - 7); o.lineTo(cx - doorW - 6, baseY - doorH - 7);
      o.closePath(); o.fill();
      o.strokeStyle = 'rgba(230,180,90,.55)'; o.lineWidth = 1.5; o.stroke();
      const glass = o.createLinearGradient(0, baseY - doorH, 0, baseY);
      glass.addColorStop(0, 'rgba(120,170,220,.28)'); glass.addColorStop(1, 'rgba(70,110,160,.4)');
      o.fillStyle = glass;
      o.fillRect(cx - doorW, baseY - doorH, doorW * 2, doorH);
      o.strokeStyle = 'rgba(230,180,90,.8)'; o.lineWidth = 1;
      o.beginPath(); o.moveTo(cx, baseY - doorH); o.lineTo(cx, baseY); o.stroke();
      o.shadowColor = 'rgba(230,180,90,.9)'; o.shadowBlur = 7;
      o.beginPath(); o.moveTo(cx, baseY - doorH); o.lineTo(cx, baseY); o.stroke();
      o.shadowBlur = 0;
      o.restore();
      floorGlow(GRID - 0.2, GRID - 0.2, 'rgba(230,180,90,.22)', 50);
    }
    function drawEntranceRunner() {
      const a = iso(GRID - 0.5, GRID - 0.5, 1), b = iso(GRID / 2, GRID / 2, 2);
      o.save();
      o.strokeStyle = 'rgba(230,190,110,.35)'; o.lineWidth = 10; o.lineCap = 'round';
      o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.stroke();
      o.strokeStyle = 'rgba(255,220,160,.5)'; o.lineWidth = 1.5;
      o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.stroke();
      o.restore();
    }
    function drawCableHub(stationsList, accents) {
      const hub = iso(GRID / 2, GRID / 2, 4);
      for (const s of stationsList) {
        const from = iso(s.gx + 0.5, s.gy + 0.3, 2);
        o.save();
        o.strokeStyle = accents[s.name]; o.globalAlpha = 0.35; o.lineWidth = 1.4;
        o.beginPath();
        o.moveTo(from.x, from.y);
        o.quadraticCurveTo((from.x + hub.x) / 2, (from.y + hub.y) / 2 + 8, hub.x, hub.y);
        o.stroke();
        o.restore();
      }
      o.save();
      const g = o.createRadialGradient(hub.x, hub.y, 1, hub.x, hub.y, 20);
      g.addColorStop(0, 'rgba(180,210,255,.5)'); g.addColorStop(1, 'rgba(180,210,255,0)');
      o.fillStyle = g; o.beginPath(); o.ellipse(hub.x, hub.y, 20, 10, 0, 0, Math.PI * 2); o.fill();
      o.fillStyle = '#12151f'; o.beginPath(); o.ellipse(hub.x, hub.y, 12, 6, 0, 0, Math.PI * 2); o.fill();
      o.strokeStyle = 'rgba(180,210,255,.8)'; o.lineWidth = 1.2;
      o.beginPath(); o.ellipse(hub.x, hub.y, 9, 4.5, 0, 0, Math.PI * 2); o.stroke();
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 2) * i;
        o.beginPath(); o.moveTo(hub.x + Math.cos(a) * 4, hub.y + Math.sin(a) * 2); o.lineTo(hub.x + Math.cos(a) * 10, hub.y + Math.sin(a) * 5); o.stroke();
      }
      o.fillStyle = '#dfe8ff'; o.beginPath(); o.arc(hub.x, hub.y, 2.5, 0, Math.PI * 2); o.fill();
      o.restore();
    }

    // ---- изометрическая коробка (стол/тумба) — заливка top/left/right граней по проекции iso()
    function isoBox(gx, gy, gw, gh, gz0, gz1, colors) {
      const top = [iso(gx, gy, gz1), iso(gx + gw, gy, gz1), iso(gx + gw, gy + gh, gz1), iso(gx, gy + gh, gz1)];
      const frontL = [iso(gx, gy + gh, gz0), iso(gx + gw, gy + gh, gz0), iso(gx + gw, gy + gh, gz1), iso(gx, gy + gh, gz1)];
      const frontR = [iso(gx + gw, gy, gz0), iso(gx + gw, gy + gh, gz0), iso(gx + gw, gy + gh, gz1), iso(gx + gw, gy, gz1)];
      function poly(pts, fill) { o.beginPath(); o.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) o.lineTo(pts[i].x, pts[i].y); o.closePath(); o.fillStyle = fill; o.fill(); o.strokeStyle = 'rgba(0,0,0,.4)'; o.lineWidth = 1; o.stroke(); }
      poly(frontL, colors.left); poly(frontR, colors.right); poly(top, colors.top);
    }
    // стол агента: столешница+монитор+клавиатура+лампа+мышь, живой векторной отрисовкой (дешевле, чем
    // отдельный битмап под каждого — геометрия всё равно пересчитывается через iso() за кадр)
    ISO.drawDesk = function (gx, gy, accent) {
      isoBox(gx + 0.15, gy + 0.75, 0.5, 0.4, 0, 34, { top: '#262b3a', left: '#181b26', right: '#20242f' });
      isoBox(gx + 0.15, gy + 0.68, 0.5, 0.12, 34, 70, { top: '#2e3446', left: '#1c2130', right: '#242a3a' });
      isoBox(gx, gy, 1, 0.62, 0, 30, { top: '#4a3626', left: '#2c2015', right: '#39291c' });
      isoBox(gx + 0.04, gy + 0.04, 0.92, 0.54, 30, 34, { top: '#5a4330', left: '#2c2015', right: '#39291c' });
      for (const [lx, ly] of [[gx + 0.06, gy + 0.08], [gx + 0.9, gy + 0.08], [gx + 0.06, gy + 0.5], [gx + 0.9, gy + 0.5]]) {
        isoBox(lx, ly, 0.06, 0.06, -4, 0, { top: '#1a130d', left: '#120d09', right: '#15100b' });
      }
      const base = iso(gx + 0.5, gy + 0.18, 34);
      const topPt = iso(gx + 0.5, gy + 0.18, 34 + 46);
      o.save();
      o.strokeStyle = '#13151c'; o.lineWidth = 6; o.lineCap = 'round';
      o.beginPath(); o.moveTo(base.x, base.y); o.lineTo(topPt.x, topPt.y); o.stroke();
      const scr = o.createLinearGradient(topPt.x - 14, topPt.y - 16, topPt.x + 14, topPt.y + 16);
      scr.addColorStop(0, isoMix(accent, 0.2)); scr.addColorStop(1, isoMix(accent, -0.3));
      o.fillStyle = scr; o.fillRect(topPt.x - 15, topPt.y - 18, 30, 22);
      o.shadowColor = accent; o.shadowBlur = 16; o.fillRect(topPt.x - 15, topPt.y - 18, 30, 22); o.shadowBlur = 0;
      o.restore();
      return { screenX: topPt.x - 15, screenY: topPt.y - 18, screenW: 30, screenH: 22 };
    };

    const BILLBOARD_PX = 1.0;
    const DISPLAY_NAME = { michael: 'MICHAEL', dwight: 'DWIGHT', pam: 'PAM', ralph: 'RALPH' };
    // персонаж как «билборд»: уже готовый фронтальный битмап (BIG.sprites) ставится в изо-сцену, подножием
    // на пол у заднего края стола, лицом к зрителю — через стол, как ресепшионисты в референсе
    ISO.drawBillboard = function (gx, gy, name, pose, accent, dir, breathe) {
      const p = iso(gx + 0.5, gy + 0.08, 0);
      o.save();
      o.fillStyle = 'rgba(0,0,0,.35)';
      o.beginPath(); o.ellipse(p.x, p.y, 22, 10, 0, 0, Math.PI * 2); o.fill();
      o.restore();
      const isRalph = name === 'ralph';
      const spr = BIG.sprites[name];
      const img = isRalph ? spr : (spr[pose] || spr.stand);
      const gridW = isRalph ? BIG.RGRID : BIG.GRID, gridH = isRalph ? BIG.RROWS : BIG.ROWS;
      const w = gridW * BILLBOARD_PX, h = gridH * BILLBOARD_PX;
      o.save();
      o.globalAlpha = 0.22;
      const glow = o.createRadialGradient(p.x, p.y - h * 0.5, 4, p.x, p.y - h * 0.5, w * 0.85);
      glow.addColorStop(0, accent); glow.addColorStop(1, 'rgba(0,0,0,0)');
      o.fillStyle = glow; o.beginPath(); o.ellipse(p.x, p.y - h * 0.5, w * 0.85, h * 0.6, 0, 0, Math.PI * 2); o.fill();
      o.restore();
      o.imageSmoothingEnabled = false;
      const dy = (breathe || 0) - (isRalph ? 14 : 0);
      if (dir === -1) {
        const x = Math.round(p.x - w / 2), y = Math.round(p.y - h + dy);
        o.save(); o.translate(x * 2 + w, 0); o.scale(-1, 1);
        o.drawImage(img, x, y, w, h);
        o.restore();
      } else {
        o.drawImage(img, Math.round(p.x - w / 2), Math.round(p.y - h + dy), w, h);
      }
      return { x: p.x, y: p.y, name, accent };
    };
    ISO.drawNameplate = function (x, y, name, accent) {
      o.save();
      o.font = '700 10px "Segoe UI",monospace'; o.textAlign = 'center'; o.textBaseline = 'middle';
      const label = DISPLAY_NAME[name] || name.toUpperCase();
      const tw = Math.round(o.measureText(label).width) + 10;
      o.fillStyle = 'rgba(8,9,14,.82)'; o.fillRect(x - tw / 2, y + 4, tw, 13);
      o.strokeStyle = accent; o.globalAlpha = 0.7; o.lineWidth = 1; o.strokeRect(x - tw / 2 + 0.5, y + 4.5, tw - 1, 12);
      o.globalAlpha = 1; o.fillStyle = '#e8ecf4'; o.fillText(label, x, y + 10.5);
      o.restore();
    };
    // лёгкое «цветение» ярких источников — блюрим копии вывески/экранов и складываем в режиме lighter,
    // имитируя bloom без честного постпроцессинга движка
    ISO.drawBloomPass = function (draws) {
      o.save();
      o.globalCompositeOperation = 'lighter';
      o.filter = 'blur(8px)';
      o.globalAlpha = 0.5;
      draws();
      o.filter = 'none'; o.globalAlpha = 1; o.globalCompositeOperation = 'source-over';
      o.restore();
    };

    ISO.drawScene = function () {
      drawCitySky();
      drawBuildingFascia();
      drawDepthHaze();
      drawBackWalls();
      drawWindows();
      drawCeilingPipes();
      drawSign();
      drawFloor();
      drawEntranceRunner();
      drawFloorSheen();
      drawWallBaseShadow();
      drawCeilingLamp(1.2, 5.4);
      drawCeilingLamp(5.4, 1.2);
      drawCeilingLamp(3.5, 3.5);
      drawPlantTop(0.4, 6.2);
      drawPlantTop(6.2, 0.4);
      drawServerRack(0.2, 2.1);
      drawServerRack(2.1, 0.2);
      drawEntrance();
    };
    ISO.drawCableHub = drawCableHub;
    ISO.drawSign = drawSign; // для повторного прохода bloom поверх готовой сцены
  })();

  // ---- старый рисованный этаж (arcade/gameboy) — та же геометрия, что и раньше, просто в мире 768×432;
  // больше не вызывается из drawWorld (заменена ISO.drawScene), оставлена нетронутой как есть
  function drawLegacyBackground() {
    for (let y = 120; y < LH; y += 24) for (let x = 0; x < LW; x += 24) {
      o.fillStyle = ((x + y) / 24) % 2 ? TH.floor1 : TH.floor2; o.fillRect(x, y, 24, 24);
    }
    o.fillStyle = TH.wall; o.fillRect(0, 0, LW, 120); o.fillStyle = TH.wallLine; o.fillRect(0, 114, LW, 6);
    for (let x = 36; x < LW - 60; x += 120) {
      o.fillStyle = TH.win; o.fillRect(x, 24, 66, 54); o.fillStyle = TH.winLite; o.fillRect(x + 6, 30, 24, 18); o.fillRect(x + 36, 30, 24, 18);
      o.fillStyle = TH.winLite; o.globalAlpha = 0.7; o.fillRect(x + 6, 54, 24, 18); o.fillRect(x + 36, 54, 24, 18); o.globalAlpha = 1;
    }
    sprite(CLOCK, 239, 30, null, HS); // часы на стене между окнами
    sprite(PLANT, LW - 42, 90, null, HS); sprite(PLANT, 12, 90, null, HS);
    sprite(COOLER, 66, 126, null, HS);          // кулер с бутылкой
    sprite(CABINET, 300, 126, null, HS);        // шкаф-стеллаж с папками
    sprite(COFFEE_MACHINE, 630, 126, null, HS); // кофемашина на тумбе
    // коврик у входа
    o.fillStyle = TH.rugEdge; o.fillRect(342, 366, 84, 39);
    o.fillStyle = TH.rug; o.fillRect(348, 372, 72, 27);
    o.fillStyle = TH.rugEdge;
    for (let sx = 354; sx < 414; sx += 15) o.fillRect(sx, 378, 6, 15);
  }

  // подвижные объекты и мебель агентов — общие для всех тем, рисуются каждый кадр поверх фона
  const MONITOR_FAIL_COLORS = { k: '#3a1010', b: '#ff4b4b' };
  // «падение» конверта/документа на стол — первые MAIL_DROP_FRAMES кадров он опускается сверху, затем лежит неподвижно
  const MAIL_DROP_FRAMES = 12;
  function drawActors(t) {
    o.imageSmoothingEnabled = false; // битмапы персонажей уже пикселизованы; без этого drawImage их размажет
    sprite(CAT_BED, Math.round(catBed.x - 7), Math.round(catBed.y - 5)); // лежанка котов в углу
    // офисные коты, гуляющие по полу — до столов/подписей; коты в прыжке или уже на столе рисуются позже, поверх стола и человека
    drawCats(t, c => !c.jump && !c.onDesk);
    drawDog(t); // кибер-пёс всегда на полу — под стол не запрыгивает, только гуляет/сидит/лежит рядом
    const cyber = THEME_NAME === 'cyberpunk';
    const pending = []; // { a, hasBig, accent } — чтобы отрисовать персонажей отдельным проходом поверх столов
    for (const a of agents) {
      const failed = a.state === 'failed';
      const failBlink = Math.floor(t / 300) % 2 === 0;
      const hasBig = !!BIG.sprites[a.name] && a.home.gx != null; // michael/dwight/pam/ralph с местом в изо-сетке
      const accent = BIG.accents[a.name] || a.color;
      if (hasBig) {
        const d = ISO.drawDesk(a.home.gx, a.home.gy, accent); // стол рисуется живой векторной изометрией
        if (failed && failBlink) { o.globalAlpha = 0.55; o.fillStyle = '#ff4b4b'; o.fillRect(d.screenX, d.screenY, d.screenW, d.screenH); o.globalAlpha = 1; }
        else if (a.state === 'working') {
          const glow = 0.12 + 0.12 * Math.sin(t / 260 + a.home.x);
          o.globalAlpha = glow; o.fillStyle = '#6fd9ff'; o.fillRect(d.screenX, d.screenY, d.screenW, d.screenH); o.globalAlpha = 1;
        }
      } else {
        // неназванный агент без своего детального битмапа — старое плоское оформление стола (fallback)
        sprite(CHAIR, a.home.x - S(4), a.home.y - S(6), cyber ? CYBER_CHAIR_COLORS : null, HS);
        const on = a.state === 'working';
        let monitorRows = on ? MONITOR_ON : MONITOR_OFF, monitorColors = cyber ? CYBER_MONITOR_COLORS : null;
        if (failed) { monitorRows = failBlink ? MONITOR_ON : MONITOR_OFF; monitorColors = MONITOR_FAIL_COLORS; }
        sprite(monitorRows, a.home.x - S(10), a.home.y - S(44), monitorColors, HS);
      }
      if (a.state === 'planning') {
        // билборд персонажа в изо-сцене заметно ниже, чем в прежней фронтальной (~60px против ~120px) —
        // доска подвешена ближе к голове, чем раньше, но всё ещё явно выше нового, более компактного силуэта
        sprite(BOARD, a.home.x - S(16), a.home.y - 80, null, HS);
        const glow = 0.25 + 0.25 * Math.sin(t / 500); // доска/голограмма подсвечивается, пока агент планирует
        o.globalAlpha = glow; o.fillStyle = cyber ? CY.neonBlue : '#6fd9ff';
        o.fillRect(a.home.x - S(16), a.home.y - 82, S(32), S(4));
        o.globalAlpha = 1;
      }
      if (a.mail) { // конверт/документ прилетел на стол — короткое падение сверху, затем лежит до конца life
        const spec = MAIL_SPECS[a.mail.kind];
        const dropped = Math.min(1, (spec.total - a.mail.life) / MAIL_DROP_FRAMES);
        const yOff = -S(10) - Math.round((1 - dropped) * S(16));
        sprite(spec.sprite, a.home.x + S(10), a.home.y + yOff, null, HS);
      }
      pending.push({ a, hasBig, accent });
    }
    const labels = [];
    for (const { a, hasBig, accent } of pending) {
      if (hasBig) {
        const i = agents.indexOf(a);
        const visitingCat = cats.find(c => c.deskGoal === a.name);
        const dir = visitingCat ? visitingCat.deskSide : (a.state === 'idle' ? idleGlanceDir(t, i) : 1);
        const breathe = a.state === 'idle' ? Math.round(Math.sin(t / 900 + i) * 1.2) : 0;
        labels.push(ISO.drawBillboard(a.home.gx, a.home.gy, a.name, BIG.poseFor(a.state), accent, dir, breathe));
      } else {
        drawHuman(a, t); // фолбэк — старый плоский рендер
      }
    }
    // коты, запрыгнувшие на стол (или летящие туда/обратно) — поверх стола и человека
    drawCats(t, c => c.jump || c.onDesk);
    // таблички с именем — отдельным финальным проходом: если рисовать их сразу в ISO.drawBillboard,
    // столб-монитор СОСЕДНЕГО (позже отрисованного) стола может лечь поверх чужой таблички
    for (const l of labels) ISO.drawNameplate(l.x, l.y, l.name, l.accent);
    // подписи состояния (имя для безымянных — отдельно, у именных его уже показывает табличка выше)
    o.font = '600 14px "Pixelify Sans", monospace'; o.textAlign = 'center'; o.textBaseline = 'top';
    const STATE_LABELS = { idle: 'свободен', working: 'работает', review: 'ждёт ревью', planning: 'планирует', failed: 'ошибка', done: 'готово' };
    for (const { a, hasBig } of pending) {
      if (!hasBig) { drawLabel(a.title.split('·')[0].trim(), a.home.x, a.home.y + S(6), TH.text); o.font = '13px "Pixelify Sans", monospace'; }
      else o.font = '11px "Pixelify Sans", monospace';
      drawLabel(STATE_LABELS[a.state] || a.state, a.home.x, a.home.y + (hasBig ? 18 : S(24)), TH.mute);
      o.font = '600 14px "Pixelify Sans", monospace';
      if (a.speech) drawSpeechBubble(a.speech.text, a.home.x, a.home.y - (hasBig ? 92 : 150));
    }
  }

  // короткая реплика-заглушка над головой (a.speech, см. say()) — пиксельный прямоугольник с текстом,
  // тот же принцип читаемости, что и drawLabel (обводка на cyberpunk-сцене)
  function drawSpeechBubble(text, cx, y) {
    o.font = '600 12px "Pixelify Sans", monospace';
    const w = Math.round(o.measureText(text).width) + S(12), h = S(18);
    const x = Math.round(cx - w / 2);
    o.fillStyle = 'rgba(10,12,24,0.82)'; o.fillRect(x, y, w, h);
    o.strokeStyle = TH.mute; o.lineWidth = 1; o.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    o.textBaseline = 'middle';
    drawLabel(text, cx, y + h / 2, TH.text);
    o.textBaseline = 'top';
    o.font = '600 14px "Pixelify Sans", monospace';
  }

  function drawWorld(t) {
    if (bgImg) { // картинка вместо пола/стены; мебель и люди рисуются поверх
      drawCoverImage(o, bgImg, 0, 0, LW, LH);
      sprite(CAT_BED, Math.round(catBed.x - 7), Math.round(catBed.y - 5));
      return;
    }
    // изометрическая сцена (ISO) — единая для всех тем, по референсу top-down cyberpunk-офиса;
    // drawCyberBackground/drawLegacyBackground выше остаются в файле нетронутыми (на случай старого
    // кода/тестов, которые могли бы к ним обращаться), но больше не вызываются отсюда
    ISO.drawScene();
    const accentsByName = {};
    for (const a of agents) accentsByName[a.name] = BIG.accents[a.name] || a.color;
    const isoStations = agents.filter(a => a.home.gx != null).map(a => ({ gx: a.home.gx, gy: a.home.gy, name: a.name }));
    ISO.drawCableHub(isoStations, accentsByName);
    drawActors(t);
    ISO.drawBloomPass(() => ISO.drawSign()); // мягкое цветение вывески поверх уже готовой сцены
  }

  // именные акценты поверх спрайта (волосы на плечах, имплант, led-полосы, наплечник, неоновые воротники) —
  // неон мигает синусоидой по t, тем же приёмом, что и неоновый кант колонны в cyberpunk-сцене
  function drawCharAccents(name, x, y, t, pal) {
    if (name === 'michael') {
      o.fillStyle = pal.hair; // длинные волосы спадают на плечи — по краям воротника
      const l = pixelBox(0, 8, HS), r = pixelBox(15, 8, HS);
      o.fillRect(x + l.x, y + l.y, l.w, l.h * 2);
      o.fillRect(x + r.x, y + r.y, r.w, r.h * 2);
      const glow = 0.55 + 0.45 * Math.sin(t / 500); // светящийся голубой воротник куртки
      const c1 = pixelBox(3, 8, HS), c2 = pixelBox(12, 8, HS);
      o.globalAlpha = glow; o.fillStyle = pal.neon;
      o.fillRect(x + c1.x, y + c1.y, (c2.x + c2.w) - c1.x, c1.h);
      o.globalAlpha = 1;
    } else if (name === 'dwight') {
      const earGlow = 0.5 + 0.5 * Math.sin(t / 380 + 0.7); // хромированный модуль-наушник на виске
      const ear = pixelBox(3, 1, HS);
      o.globalAlpha = earGlow; o.fillStyle = pal.neon; o.fillRect(x + ear.x, y + ear.y, S(2), S(2)); o.globalAlpha = 1;
      const p1 = 0.5 + 0.5 * Math.sin(t / 420), p2 = 0.5 + 0.5 * Math.sin(t / 420 + 1.6); // led-полосы на броне
      const l1 = pixelBox(4, 10, HS), l2 = pixelBox(9, 10, HS);
      o.globalAlpha = p1; o.fillStyle = '#ff9a3c'; o.fillRect(x + l1.x, y + l1.y, S(2), l1.h);
      o.globalAlpha = p2; o.fillStyle = '#ff4fa3'; o.fillRect(x + l2.x, y + l2.y, S(2), l2.h);
      o.globalAlpha = 1;
      const em = pixelBox(7, 9, HS); o.fillStyle = pal.emblem; o.fillRect(x + em.x, y + em.y, S(2), S(2)); // жёлтая эмблема
    } else if (name === 'pam') {
      const sh = pixelBox(11, 8, HS); o.fillStyle = pal.shoulder; o.fillRect(x + sh.x, y + sh.y, S(3), S(3)); // розовая пуговица кардигана
      const glow = 0.5 + 0.3 * Math.sin(t / 480); // тёплый блик на отвороте кардигана (вместо неон-пульса)
      const c1 = pixelBox(4, 8, HS), c2 = pixelBox(11, 8, HS);
      o.globalAlpha = glow; o.fillStyle = pal.neon;
      o.fillRect(x + c1.x, y + c1.y, (c2.x + c2.w) - c1.x, c1.h);
      o.globalAlpha = 1;
      const pen = pixelBox(2, 5, HS); o.fillStyle = '#e8b64a'; o.fillRect(x + pen.x, y + pen.y, S(1), S(1)); // кончик карандаша за ухом
    }
  }

  // короткий взгляд в сторону, пока агент простаивает — не более ~0.4с раз в ~6.5с, сдвинут по фазе на seed,
  // чтобы соседние агенты не поворачивали голову синхронно; чистая функция от t, без своего состояния
  function idleGlanceDir(t, seed) {
    const period = 6500, phase = (t + seed * 2200) % period;
    return phase < 400 ? -1 : 1;
  }

  // фолбэк-рендер для безымянного агента без своего детального битмапа (BIG.sprites) — старый плоский
  // 16-колоночный спрайт, как до изометрической переделки. Именные агенты (michael/dwight/pam/ralph)
  // рисуются не отсюда, а напрямую из drawActors через ISO.drawBillboard — этот путь для них не используется
  function drawHuman(a, t) {
    const i = agents.indexOf(a);
    const pal = CHAR_PALETTE[a.name];
    const head = pal ? CHAR_HEADS[a.name] : HAIRSTYLES[i % HAIRSTYLES.length].concat(FACE_ROWS);
    const colors = pal
      ? { f: pal.jacket, e: shade(pal.jacket, 0.78), h: pal.hair, s: pal.skin, d: P.d, k: P.k, z: pal.eye }
      : { f: a.color, e: shade(a.color, 0.72), h: HAIR_COLORS[i % HAIR_COLORS.length], s: P.s, d: P.d, k: P.k };
    let pose = 'stand';
    if (a.state === 'working') pose = Math.floor(t / 160) % 2 ? 'type1' : 'type2';
    else if (a.state === 'review') pose = 'lean';
    else if (a.state === 'failed') pose = 'failed';
    else if (a.state === 'done') pose = 'done';
    const rows = humanRows(pose, head);
    // агент всегда на своём месте (a.home) — не ходит; дефолтная поза смотрит вперёд (dir=1). Пока кот
    // визитит его стол (cat.deskGoal === a.name), агент поворачивается к коту и возвращается после его ухода —
    // направление считается заново каждый кадр, отдельное поле на агенте не нужно
    const visitingCat = cats.find(c => c.deskGoal === a.name);
    const dir = visitingCat ? visitingCat.deskSide : (a.state === 'idle' ? idleGlanceDir(t, i) : 1);
    const { w, h } = spriteSize(rows, HS);
    // лёгкое дыхание в простое — синусоидальное покачивание всего силуэта по вертикали на 1 «пиксель»
    const breathe = a.state === 'idle' ? Math.round(Math.sin(t / 900 + i) * S(1)) : 0;
    const x = Math.round(a.x) - Math.round(w / 2), y = Math.round(a.y) - h - S(8) + breathe;
    // тень
    o.fillStyle = 'rgba(0,0,0,0.25)'; o.fillRect(x + S(3), y + S(25), S(10), S(2));
    if (dir === -1) {
      o.save(); o.translate(x * 2 + S(15), 0); o.scale(-1, 1);
      sprite(rows, x, y, colors, HS);
      if (pal) drawCharAccents(a.name, x, y, t, pal);
      o.restore();
    } else {
      sprite(rows, x, y, colors, HS);
      if (pal) drawCharAccents(a.name, x, y, t, pal);
    }
    if (a.state === 'idle' && Math.floor(t / 2800) % 4 === 0 && (t % 2800) < 120) {
      // моргание — закрываем глаза цветом кожи персонажа, позиция глаз считается через тот же масштаб, что и весь спрайт
      o.fillStyle = colors.s;
      const eye1 = pixelBox(6, 4, HS), eye2 = pixelBox(9, 4, HS);
      o.fillRect(x + eye1.x, y + eye1.y, eye1.w, eye1.h);
      o.fillRect(x + eye2.x, y + eye2.y, eye2.w, eye2.h);
    }
  }

  // размеры контейнера 0×0 бывают, пока панель/вкладка скрыта (display:none) — тогда просто пропускаем
  // пересчёт и оставляем прежние W/H/scale/ox/oy (следующий ResizeObserver-тик с реальным размером
  // пересчитает всё как надо; писать в canvas.width=0 здесь незачем, лишь оставит холст «протухшим»)
  function applyResize(w, h) {
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    W = w; H = h;
    const fit = fitScale(W, H, LW, LH);
    scale = fit.scale; ox = fit.ox; oy = fit.oy;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    applyResize(box.width, box.height);
  }

  function frame(t) {
    if (!W) resize();
    for (const a of agents) { if (a.mail && --a.mail.life <= 0) a.mail = null; }
    for (const a of agents) { if (a.speech && --a.speech.life <= 0) a.speech = null; }
    for (const cat of cats) stepCat(cat);
    stepDog(t);
    o.clearRect(0, 0, LW, LH);
    drawWorld(t);
    ctx.fillStyle = TH.floor2; ctx.fillRect(0, 0, W, H);
    // дробный масштаб < 1 без сглаживания даёт «дырки» между пикселями спрайта — включаем сглаживание
    // только для уменьшения; при масштабе ≥1 (в т.ч. дробном, например 1.4) чёткие грани важнее
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(off, ox, oy, LW * scale, LH * scale);
    requestAnimationFrame(frame);
  }

  function setTheme(colors, name) {
    TH = Object.assign({}, TH, colors);
    if (name && name !== THEME_NAME) {
      THEME_NAME = name;
      if (agents.length) {
        const homes = computeHomes(agents.length);
        agents.forEach((a, i) => { a.home = homes[i]; });
      }
    }
  }

  if (hasDOM) {
    window.addEventListener('resize', resize);
    // ResizeObserver ловит и изменение размера окна, и смену вкладки Планёрка/Офис (display:none → flex),
    // и раскрытие мобильной полоски (.expanded) — везде, где меняется реальный размер контейнера, а не
    // только window — window.resize один этот случай не покрывает.
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          applyResize(cr.width, cr.height);
        }
      });
      ro.observe(canvas.parentElement);
    }
    window.Floor = { setAgents, setState, envelope, setBackground, setTheme, say };
    document.fonts && document.fonts.load('8px "Pixelify Sans"').catch(() => {});
    requestAnimationFrame(frame);
  }

  // экспорт чистых функций для тестов в node (dwight) — безопасен для браузера: typeof module там undefined,
  // так что этот блок в браузере не выполняется и window.Floor не затрагивает
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      LW, LH, deskX, computeDeskPositions, isInsideObstacle, pointOutsideObstacles, sceneObstacleRects, CYBER_DESK_BANDS,
      characterFor, CHAR_PALETTE, CHAR_HEADS, humanRows, DESK_FOOT, DESK_MIN_GAP,
      PET_COUNT, segmentIntersectsRect, computeDogRoute, dogShouldChase, DOG_CHASE_RADIUS, DOG_CHASE_COOLDOWN_MS, DOG_ROUTE_MARGIN,
      fitScale,
    };
  }
})();
