/* Раскладка SVG-графа миссии по слоям и критический путь — чистые функции без DOM/canvas,
   чтобы их можно было юнит-тестировать через node require (как ui/floor.js экспортирует чистые
   функции для теста dwight'а). Рендер (SVG-разметка, клики, тултип, длительности) живёт в
   app.js — здесь только геометрия и поиск самой длинной цепочки по весам узлов. */
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

  // Критический путь: самая длинная по суммарному весу цепочка от корня до листа.
  // nodes — массив id, edges — пары [fromId, toId] (зависимость -> зависящая задача, как рёбра
  // на графе), weights — {id: число}. Раз узлы обходятся только вперёд по edges и вес >= 0,
  // самый длинный путь из любого узла не короче любого его продолжения из более раннего узла —
  // поэтому не нужно отдельно искать корни, максимум по всем стартам уже даёт нужный ответ.
  // Цикл (побитые depends_on) не даёт зациклиться так же, как в computeGraphLayout — узел,
  // который сейчас обходится, на этой ветке возвращает путь длиной в себя самого.
  function criticalPath(nodes, edges, weights) {
    const idSet = new Set(nodes);
    const outgoing = new Map(nodes.map((id) => [id, []]));
    for (const [from, to] of edges || []) {
      if (from === to || !idSet.has(from) || !idSet.has(to)) continue;
      outgoing.get(from).push(to);
    }
    const weightOf = (id) => (weights && typeof weights[id] === 'number' ? weights[id] : 0);
    const memo = new Map();
    const visiting = new Set();

    function longestFrom(id) {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) return { total: weightOf(id), path: [id] };
      visiting.add(id);
      let best = { total: weightOf(id), path: [id] };
      for (const next of outgoing.get(id)) {
        const sub = longestFrom(next);
        const total = weightOf(id) + sub.total;
        // >= (не >): на равных весах предпочитаем более длинную цепочку зависимостей —
        // узел с весом 0 (например, задача без оценки) не должен «обрубать» путь раньше срока.
        if (total >= best.total) best = { total, path: [id, ...sub.path] };
      }
      visiting.delete(id);
      memo.set(id, best);
      return best;
    }

    let best = { total: -Infinity, path: [] };
    for (const id of nodes) {
      const r = longestFrom(id);
      if (r.total > best.total) best = r;
    }
    return best.path;
  }

  const api = { computeGraphLayout, criticalPath, STEP_X, STEP_Y };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.Graph = api;
})();
