---
version: "alpha"
name: "cyber_office"
description: "Дизайн-система cyber_office — пиксельный офис ИИ-агентов: три темы (arcade/gameboy/cyberpunk), неоновые акценты персонажей, семантические цвета статусов задач"
colors:
  # поверхности и акцент — тема arcade (по умолчанию, :root)
  arcade:
    bg: "#0b0616"
    grid: "#1a1030"
    panel: "#160c2a"
    line: "#4b2a7a"
    text: "#f3e9ff"
    mute: "#a78bd6"
    accent: "#ff3f8f"
    ok: "#ffe135"
    blue: "#37d0ff"
    warn: "#ffb020"
    shadow: "#ff3f8f"
    card: "#1e1140"
  # поверхности и акцент — тема gameboy (монохромная светло-зелёная палитра)
  gameboy:
    bg: "#c5d0a0"
    grid: "#b7c493"
    panel: "#9bbc0f"
    line: "#306230"
    text: "#0f380f"
    mute: "#306230"
    accent: "#306230"
    ok: "#0f380f"
    blue: "#306230"
    warn: "#0f380f"
    shadow: "#0f380f"
    card: "#8bac0f"
  # поверхности и акцент — тема cyberpunk
  cyberpunk:
    bg: "#05060f"
    grid: "#0d1226"
    panel: "#0a0f22"
    line: "#1f3a66"
    text: "#d9f7ff"
    mute: "#6fa8c9"
    accent: "#ff2fd0"
    ok: "#35f0ff"
    blue: "#35f0ff"
    warn: "#ffd23f"
    shadow: "#35f0ff"
    card: "#0f1a36"
  # цвета персонажей (workspace/roster.json, поле color) — не зависят от темы
  characters:
    michael:
      title: "Майкл · генералист"
      color: "#4f8cff"
    dwight:
      title: "Дуайт · тесты и качество"
      color: "#ff9a3c"
    pam:
      title: "Пэм · документация"
      color: "#ff4fa3"
    ralph:
      title: "Ральф · дайджест «Что происходит?»"
      color: "#39ff88"
  # палитра статусов задач (ui/app.js STATUS_COLOR + подписи STATUS_RU) — семантика, темой не красится
  status:
    todo:
      label: "в очереди"
      color: "#8a93a3"
    running:
      label: "в работе"
      color: "#5b8def"
    review:
      label: "на ревью"
      color: "#f2c14e"
    done:
      label: "готово"
      color: "#5acd96"
    failed:
      label: "ошибка"
      color: "#f05a46"
    rejected:
      label: "отклонено"
      color: "#8a93a3"
typography:
  fontFamily: "Pixelify Sans, ui-monospace, monospace"
  fontFamilyMono: "ui-monospace, Menlo, monospace"
  fontFamilySign: "Chakra Petch, Orbitron, sans-serif"
  h1:
    fontSize: 18px
    textTransform: uppercase
    letterSpacing: 1px
  sign:
    fontSize: 24px
    fontFamily: "{typography.fontFamilySign}"
    fontStyle: italic
    letterSpacing: 2px
    textTransform: uppercase
  label:
    fontSize: 12px
    textTransform: uppercase
    letterSpacing: 1px
  body:
    fontSize: 14px
    lineHeight: 1.45
  small:
    fontSize: 12px
  tiny:
    fontSize: 10.5px
  code:
    fontSize: 12px
    fontFamily: "{typography.fontFamilyMono}"
spacing:
  xs: 4px
  sm: 8px
  md: 10px
  lg: 14px
  xl: 16px
rounded:
  none: 0
  pill: 0
  avatar: 50%
elevation:
  button: "3px 3px 0 {colors.arcade.line}"
  buttonSmall: "2px 2px 0 {colors.arcade.line}"
  card: "3px 3px 0 {colors.arcade.line}"
  panel: "5px 5px 0 {colors.arcade.line}"
  dialog: "8px 8px 0 {colors.arcade.line}"
  # неоновая вывеска в шапке — цвет совпадает с {colors.characters.pam}
  glow: "0 0 3px {colors.characters.pam}, 0 0 8px {colors.characters.pam}aa"
  # кнопка «Что происходит?» светится цветом Ральфа, когда собрана новая сводка
  glowDigest: "3px 3px 0 {colors.arcade.line}, 0 0 8px {colors.characters.ralph}aa, 0 0 18px {colors.characters.ralph}66"
  # критический путь графа миссии — та же розовая вывеска, что в шапке
  glowCritical: "0 0 3px {colors.characters.pam}, 0 0 7px {colors.characters.pam}aa"
  # портрет агента в работе светится его собственным цветом (по умолчанию — {colors.characters.pam})
  glowAvatarBusy: "0 0 3px {colors.characters.pam}, 0 0 8px {colors.characters.pam}"
components:
  status-pill:
    rounded: "{rounded.none}"
    padding: "1px 8px"
    fontSize: "{typography.small.fontSize}"
    textTransform: uppercase
    backgroundColor: "{colors.status.*.color}"
    textColor: "#0b0616"
  card:
    backgroundColor: "{colors.arcade.card}"
    borderColor: "{colors.arcade.line}"
    borderLeftColor: "{colors.arcade.mute}"
    rounded: "{rounded.none}"
    boxShadow: "{elevation.card}"
    padding: "8px 10px"
  dialog:
    backgroundColor: "{colors.arcade.panel}"
    borderColor: "{colors.arcade.line}"
    rounded: "{rounded.none}"
    boxShadow: "{elevation.dialog}"
    width: "min(820px, 92vw)"
  graph-node:
    strokeColor: "{colors.arcade.mute}"
    strokeColorCritical: "{colors.characters.pam}"
    boxShadowCritical: "{elevation.glowCritical}"
  badge-design:
    text: "design"
    color: "{colors.arcade.ok}"
---

## Overview

cyber_office — пиксельный «офис» ИИ-агентов: этаж со спрайтами, доска задач, терминал событий,
граф миссии. Стиль — ретро-аркада (сетка 16×16, `image-rendering:pixelated`, шрифт Pixelify Sans),
поверх которого неоном светятся персонажи и состояния, требующие внимания. Интерфейс работает в
трёх темах (`data-theme="arcade|gameboy|cyberpunk"`, переключатель в шапке, выбор в `localStorage`),
но геометрия и логика статусов одинаковы во всех трёх — меняется только палитра поверхностей.

Источники токенов: `ui/style.css` (переменные тем, строки 2–13, и вёрстка компонентов),
`workspace/roster.json` (цвета персонажей) и `ui/app.js` (`STATUS_COLOR`/`STATUS_RU`, строки 10–11).
Ральф — не агент-исполнитель из `roster.json` (он вне диспетчера задач), его цвет `#39ff88` взят
из `ui/style.css` (`.head-person.ralph`, дайджест «Что происходит?»).

## Colors

- **Три темы, одна структура токенов.** `arcade` (по умолчанию), `gameboy` (монохромная
  светло-зелёная, «геймбой») и `cyberpunk` (холодная сине-голубая) — у каждой свой набор
  `{colors.<theme>.bg|grid|panel|line|text|mute|accent|ok|blue|warn|shadow|card}`. Смена темы —
  это подмена CSS-переменных в `[data-theme]`, компоненты их не знают.
- **Статусы задач — семантика, темой не красятся.** `{colors.status.*}` (todo/running/review/
  done/failed/rejected) фиксированы и одинаковы во всех трёх темах — иначе «ошибка» в теме
  gameboy потеряется на монохромном зелёном фоне. Не путать с `{colors.arcade.warn}` и т.п. —
  это цвета поверхности темы, а не статуса.
  Актуальный цвет status-pill.
- **Цвета персонажей — фирменный неон, а не тема.** `{colors.characters.*}` (michael `#4f8cff`,
  dwight `#ff9a3c`, pam `#ff4fa3`, ralph `#39ff88`) красят портрет, подпись и реплику в диалогах
  и на доске — независимо от активной темы приложения.
- **Розовая вывеска — общий неоновый акцент.** `#ff4fa3` (= `{colors.characters.pam}`) используется
  не только у Пэм: та же вывеска в шапке (`header h1.neon`) и критический путь графа миссии
  (`.graph-node.critical`) — оба через `{elevation.glow}`/`{elevation.glowCritical}`.
- **`accent`/`shadow` темы — рабочий цвет UI**, а не персонажа: кнопки primary, обводка активного
  проекта, курсор ввода. В теме gameboy `accent`, `ok`, `blue`, `warn`, `shadow` совпадают
  (`#306230`/`#0f380f`) — так и задумано, монохромная палитра геймбоя не различает их.

## Typography

- Основной шрифт `{typography.fontFamily}` — пиксельный Pixelify Sans с моно-фолбэком. Для кода,
  диффа и терминала — чистый моно без пиксельного шрифта: `{typography.fontFamilyMono}`.
- Неоновая вывеска в шапке — отдельный декоративный шрифт `{typography.fontFamilySign}`
  (курсив, 24px, есть варианты Monoton/Tilt Neon через классы `.f-monoton`/`.f-tilt`).
- Шкала: h1 18px (капс), вывеска 24px, заголовок панели (label) 12px капс с разрядкой 1px,
  body 14px, small 12px, tiny 10.5px (счётчики, теги).
- Заголовки панелей и диалогов — всегда `{typography.label}`: капс, `letter-spacing`, цвет `mute`.

## Layout

- Каркас: шапка (вывеска + режим + переключатели тем/видов) + `main` с сеткой `view-content`,
  своей для каждого вида (Планёрка/Офис/Тесты). Колонка проектов слева — фиксированные 210px.
- Мобильная раскладка ≤768px: шапка сворачивается в бургер-меню, сетки становятся одной колонкой,
  диалоги — на весь экран, кнопки не меньше 44px (тач-таргеты).
- Порядок в диалоге персонажа: заголовок → портрет + реплика (`.head-person`) → вкладки контента.

## Elevation & Depth

- Никаких размытых теней — только жёсткие пиксельные сдвиги без blur: кнопка `{elevation.button}`
  (мелкая — `{elevation.buttonSmall}`), карточка `{elevation.card}`, панель `{elevation.panel}`,
  диалог `{elevation.dialog}`. При `:active` сдвиг «проваливается» (`translate` на ту же величину,
  тень пропадает) — имитация нажатой пиксельной кнопки.
- Неон поверх пиксельной тени, не вместо неё: `{elevation.glow}` (вывеска), `{elevation.glowDigest}`
  (кнопка «Что происходит?», пульсирует, пока сводка не открыта), `{elevation.glowCritical}`
  (критический путь графа), `{elevation.glowAvatarBusy}` (портрет агента в работе, цвет — его
  собственный `{colors.characters.*}`, по умолчанию `{colors.characters.pam}`).
- Пульсация — это `prefers-reduced-motion`-чувствительный декор: у пользователя с этой настройкой
  анимация должна выключаться, а статичное свечение — оставаться (уже сделано для
  `{elevation.glowDigest}` и мимики живого портрета; остальные пульсирующие элементы к этому
  правилу нужно привести).

## Shapes

- Острые углы везде: `{rounded.none}` = 0 у кнопок, панелей, карточек, диалогов, полей ввода,
  status-pill. Единственное исключение — круглый аватар персонажа (`{rounded.avatar}` = 50%).
- Толщина рамки растёт с «весом» элемента: поле/кнопка 2px, панель/диалог 3px, критический узел
  графа — акцентная обводка 2.5px поверх обычной.

## Components

- **status-pill**: фон и текст берутся из `{colors.status.*}` для текущего статуса задачи
  (todo/running/review/done/failed/rejected), подпись — `{colors.status.*.label}`
  («в очереди», «в работе», «на ревью», «готово», «ошибка», «отклонено»); текст всегда тёмный
  (`{components.status-pill.textColor}`), т.к. все статусные цвета — светлые/яркие.
- **card**: доска задач и лента прогонов — фон `{colors.arcade.card}` темы, левая полоса-акцент
  цветом `mute` (или цветом персонажа/проекта), тень `{elevation.card}`.
- **dialog**: карточка задачи, «Что происходит?», подтверждения — рамка 3px, без скруглений,
  тень `{elevation.dialog}`; на телефоне становится полноэкранной без тени.
- **graph-node**: узел графа миссии — заливка цветом статуса задачи; узлы в работе пульсируют
  (`graph-pulse`), узлы на критическом пути дополнительно обведены и светятся
  `{components.graph-node.boxShadowCritical}`.
- **badge-design**: значок «design» на карточке репозитория (означает, что у проекта описан
  DESIGN.md) — цвет `{components.badge-design.color}` (тон `ok` активной темы); токен зафиксирован
  здесь, отрисовку добавляет отдельная задача в `ui/`.

## Do's and Don'ts

- Делать: брать цвета только из токенов этого файла; проверять читаемость в теме gameboy отдельно
  (она монохромная — то, что различимо в arcade/cyberpunk по цвету, может слиться в gameboy);
  сохранять `prefers-reduced-motion` у любой новой пульсации/анимации; квадратные углы везде,
  кроме аватара.
- Не делать: не красить статус задачи цветом темы или персонажа — только `{colors.status.*}`;
  не давать персонажу «чужой» неоновый цвет вне `{colors.characters.*}`; не добавлять
  `border-radius` кнопкам/панелям/диалогам; не заводить второй набор цветов в JS — источник
  правды один: CSS-переменные `ui/style.css` (+ `roster.json` для персонажей).
