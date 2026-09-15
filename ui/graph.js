/* Раскладка SVG-графа миссии по слоям — чистая функция без DOM/canvas, чтобы её можно
   было юнит-тестировать через node require (как ui/floor.js экспортирует чистые функции
   для теста dwight'а). Рендер (SVG-разметка, клики) живёт в app.js — здесь только геометрия. */
(function () {
  'use strict';

  const STEP_X = 160;
  const STEP_Y = 90;

  // Слой задачи: 0, если внутри набора нет зависимостей, иначе 1+max(слой зависимости)
  // среди depends_on, входящих в тот же набор id. Зависимости на задачи вне набора и
  // самоссылки игнорируются; на узле, который сейчас обходится (цикл), слой считается 0 —
  // это не даёт DFS зациклиться на побитой/циклической цепочке depends_on.
  function computeGraphLayout(tasks) {
    const ids = new Set(tasks.map((t) => t.id));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const layer = new Map();
    const visiting = new Set();

    function layerOf(id) {
      if (layer.has(id)) return layer.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const t = byId.get(id);
      const deps = ((t && t.depends_on) || []).filter((d) => d !== id && ids.has(d));
      let l = 0;
      for (const d of deps) l = Math.max(l, layerOf(d) + 1);
      visiting.delete(id);
      layer.set(id, l);
      return l;
    }

    for (const t of tasks) layerOf(t.id);

    const rowOfLayer = new Map();   // сколько узлов уже поставлено в этот слой -> следующая строка
    return tasks.map((t) => {
      const l = layer.get(t.id);
      const row = rowOfLayer.get(l) || 0;
      rowOfLayer.set(l, row + 1);
      return { id: t.id, layer: l, x: l * STEP_X, y: row * STEP_Y };
    });
  }

  const api = { computeGraphLayout, STEP_X, STEP_Y };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.Graph = api;
})();
