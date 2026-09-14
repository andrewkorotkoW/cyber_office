// Headless-прогон ui/floor.js для тестов (без браузера/jsdom).
// floor.js сам проверяет hasDOM = typeof document/window !== 'undefined' и не трогает
// ни один DOM-объект, если их нет — поэтому require можно делать напрямую, без заглушек.
// Скрипт: (1) убеждается, что document/window отсутствуют и до, и после require —
// то есть модуль не создаёт их сам и безопасен для node; (2) вызывает экспортированные
// чистые функции расстановки столов/препятствий и печатает результат одним JSON в stdout,
// чтобы pytest мог проверить реальные расчёты, а не просто факт отсутствия исключения.
'use strict';

const assert = require('assert');
const path = require('path');

assert.strictEqual(typeof document, 'undefined', 'document не должен быть определён до require');
assert.strictEqual(typeof window, 'undefined', 'window не должен быть определён до require');

const floorPath = path.join(__dirname, '..', '..', 'ui', 'floor.js');
const floor = require(floorPath);

assert.strictEqual(typeof document, 'undefined', 'require(floor.js) не должен создавать global document');
assert.strictEqual(typeof window, 'undefined', 'require(floor.js) не должен создавать global window');

const { LW, LH, deskX, computeDeskPositions, isInsideObstacle, sceneObstacleRects } = floor;

const rects = sceneObstacleRects();

const legacyDeskX = {};
for (let n = 1; n <= 6; n++) {
  legacyDeskX[n] = Array.from({ length: n }, (_, i) => deskX(i, n));
}

const cyberDesks = {};
for (let n = 1; n <= 6; n++) {
  cyberDesks[n] = computeDeskPositions(n, rects);
}

const insideKnownRect = isInsideObstacle({ x: 40, y: 200 }, rects); // внутри стеллажа {x:0,y:160,w:86,h:100}
const outsideAllRects = isInsideObstacle({ x: 400, y: 50 }, rects); // выше всех препятствий

const result = {
  domGlobalsAbsent: typeof document === 'undefined' && typeof window === 'undefined',
  LW, LH,
  obstacleRects: rects,
  legacyDeskX,
  cyberDesks,
  insideKnownRect,
  outsideAllRects,
  exportedKeys: Object.keys(floor).sort(),
};

process.stdout.write(JSON.stringify(result));
