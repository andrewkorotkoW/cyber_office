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

  // ---------------------------------------------------------------- именные персонажи (michael/dwight/pam)
  // три агента получают собственный силуэт/палитру вместо процедурной причёски — по описаниям cyberpunk-портретов
  // (ui/assets/portraits/*.png). Для незнакомых имён используется прежний генератор (HAIRSTYLES/FACE_ROWS выше).
  const CHAR_PALETTE = {
    michael: { skin: P.s, hair: '#2e2013', eye: '#4fa8ff', jacket: '#1d3a66', neon: '#7ec8ff' },
    dwight: { skin: '#dfe4ec', hair: '#dfe4ec', eye: '#ffd23f', jacket: '#c9cfd8', neon: '#3fe0c8', emblem: '#f2c14e' },
    pam: { skin: P.s, hair: '#ff4fa3', eye: '#3fe0c8', jacket: '#15161d', neon: '#3fe0c8', shoulder: '#ff4fa3' },
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
    pam: [ // розовый ирокез, правый висок выбрит (полоска кожи 's' вместо волос)
      rb(['.', 3], ['h', 8], ['.', 5]),
      rb(['.', 2], ['h', 9], ['s', 1], ['.', 4]),
      rb(['.', 1], ['h', 10], ['s', 2], ['.', 3]),
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
    if (THEME_NAME === 'cyberpunk') return computeDeskPositions(n, sceneObstacleRects());
    return Array.from({ length: n }, (_, i) => ({ x: deskX(i, n), y: DESK_HOME_Y }));
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

  // реплика над головой агента на ms миллисекунд (например, Оскар: «Считаю…» / «Сводка готова») —
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
    if (THEME_NAME === 'cyberpunk') { o.lineWidth = 3; o.strokeStyle = 'rgba(8,9,20,0.85)'; o.strokeText(text, x, y); }
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

  // ---- старый рисованный этаж (arcade/gameboy) — та же геометрия, что и раньше, просто в мире 768×432
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
    sprite(CAT_BED, Math.round(catBed.x - 7), Math.round(catBed.y - 5)); // лежанка котов в углу
    // офисные коты, гуляющие по полу — до столов/подписей; коты в прыжке или уже на столе рисуются позже, поверх стола и человека
    drawCats(t, c => !c.jump && !c.onDesk);
    drawDog(t); // кибер-пёс всегда на полу — под стол не запрыгивает, только гуляет/сидит/лежит рядом
    // столы (сначала — что позади человечка: стул, монитор), потом человечек, потом стол поверх ног;
    // на cyberpunk-сцене та же геометрия перекрашена в палитру CY (CYBER_DESK/CHAIR/MONITOR_COLORS) —
    // рабочие места агентов выглядят частью сцены, а не наложенным арт-стилем arcade/gameboy
    const cyber = THEME_NAME === 'cyberpunk';
    for (const a of agents) {
      const on = a.state === 'working';
      const failed = a.state === 'failed';
      const failBlink = Math.floor(t / 300) % 2 === 0;
      sprite(CHAIR, a.home.x - S(4), a.home.y - S(6), cyber ? CYBER_CHAIR_COLORS : null, HS);
      let monitorRows = on ? MONITOR_ON : MONITOR_OFF, monitorColors = cyber ? CYBER_MONITOR_COLORS : null;
      if (failed) { monitorRows = failBlink ? MONITOR_ON : MONITOR_OFF; monitorColors = MONITOR_FAIL_COLORS; }
      sprite(monitorRows, a.home.x - S(10), a.home.y - S(44), monitorColors, HS);
      if (on && !failed) { // «бегущие строчки» — три полосы мигают с разным периодом, имитируя скролл кода
        o.fillStyle = cyber ? CY.neonBlue : '#9cc4ff';
        if (Math.floor(t / 120) % 2) o.fillRect(a.home.x - S(6), a.home.y - S(40), S(6), S(2));
        if (Math.floor(t / 160) % 2) o.fillRect(a.home.x - S(6), a.home.y - S(36), S(10), S(2));
        if (Math.floor(t / 200) % 2) o.fillRect(a.home.x - S(6), a.home.y - S(32), S(4), S(2));
      }
      if (cyber && on) { // неоновое свечение экрана — пульсирует, как неоновый кант колонны/подсветка декоративного стола
        const glow = 0.3 + 0.3 * Math.sin(t / 260 + a.home.x);
        o.globalAlpha = glow; o.fillStyle = CY.neonBlue;
        o.fillRect(a.home.x - S(12), a.home.y - S(46), S(24), S(4));
        o.globalAlpha = 1;
      }
      if (failed && failBlink) { // красное свечение монитора вместо синего, пока моргает
        o.globalAlpha = 0.5; o.fillStyle = '#ff4b4b';
        o.fillRect(a.home.x - S(12), a.home.y - S(46), S(24), S(4));
        o.globalAlpha = 1;
      }
      if (a.state === 'planning') {
        sprite(BOARD, a.home.x - S(16), a.home.y - S(72), null, HS);
        const glow = 0.25 + 0.25 * Math.sin(t / 500); // доска/голограмма подсвечивается, пока агент планирует
        o.globalAlpha = glow; o.fillStyle = cyber ? CY.neonBlue : TH.win;
        o.fillRect(a.home.x - S(16), a.home.y - S(74), S(32), S(4));
        o.globalAlpha = 1;
      }
      if (a.mail) { // конверт/документ прилетел на стол — короткое падение сверху, затем лежит до конца life
        const spec = MAIL_SPECS[a.mail.kind];
        const dropped = Math.min(1, (spec.total - a.mail.life) / MAIL_DROP_FRAMES);
        const yOff = -S(16) - Math.round((1 - dropped) * S(24));
        sprite(spec.sprite, a.home.x + S(16), a.home.y + yOff, null, HS);
      }
    }
    for (const a of agents) drawHuman(a, t);
    for (const a of agents) sprite(DESK, a.home.x - S(28), a.home.y - S(8), cyber ? CYBER_DESK_COLORS : null, HS);
    // коты, запрыгнувшие на стол (или летящие туда/обратно) — поверх стола и человека
    drawCats(t, c => c.jump || c.onDesk);
    // подписи
    o.font = '600 14px "Pixelify Sans", monospace'; o.textAlign = 'center'; o.textBaseline = 'top';
    const STATE_LABELS = { idle: 'свободен', working: 'работает', review: 'ждёт ревью', planning: 'планирует', failed: 'ошибка', done: 'готово' };
    for (const a of agents) {
      drawLabel(a.title.split('·')[0].trim(), a.home.x, a.home.y + S(6), TH.text);
      o.font = '13px "Pixelify Sans", monospace';
      drawLabel(STATE_LABELS[a.state] || a.state, a.home.x, a.home.y + S(24), TH.mute);
      o.font = '600 14px "Pixelify Sans", monospace';
      if (a.speech) drawSpeechBubble(a.speech.text, a.home.x, a.home.y - S(78));
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
    if (THEME_NAME === 'cyberpunk') drawCyberBackground(t); else drawLegacyBackground();
    drawActors(t);
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
      const sh = pixelBox(11, 8, HS); o.fillStyle = pal.shoulder; o.fillRect(x + sh.x, y + sh.y, S(3), S(3)); // розовый наплечник
      const glow = 0.55 + 0.45 * Math.sin(t / 480); // бирюзовый неон-воротник
      const c1 = pixelBox(4, 8, HS), c2 = pixelBox(11, 8, HS);
      o.globalAlpha = glow; o.fillStyle = pal.neon;
      o.fillRect(x + c1.x, y + c1.y, (c2.x + c2.w) - c1.x, c1.h);
      o.globalAlpha = 1;
      const er = pixelBox(2, 5, HS); o.fillStyle = pal.neon; o.fillRect(x + er.x, y + er.y, S(1), S(1)); // серьга
    }
  }

  // короткий взгляд в сторону, пока агент простаивает — не более ~0.4с раз в ~6.5с, сдвинут по фазе на seed,
  // чтобы соседние агенты не поворачивали голову синхронно; чистая функция от t, без своего состояния
  function idleGlanceDir(t, seed) {
    const period = 6500, phase = (t + seed * 2200) % period;
    return phase < 400 ? -1 : 1;
  }

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
    const { w, h } = spriteSize(rows, HS);
    // агент всегда на своём месте (a.home) — не ходит; дефолтная поза смотрит вперёд (dir=1). Пока кот
    // визитит его стол (cat.deskGoal === a.name), агент поворачивается к коту и возвращается после его ухода —
    // направление считается заново каждый кадр, отдельное поле на агенте не нужно
    const visitingCat = cats.find(c => c.deskGoal === a.name);
    const dir = visitingCat ? visitingCat.deskSide : (a.state === 'idle' ? idleGlanceDir(t, i) : 1);
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
