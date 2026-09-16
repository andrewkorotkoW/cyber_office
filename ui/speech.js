/* Реплики Дуайта/Майкла в шапках dlg-new/dlg-mission + переиспользуемый typewriter (печать
 * по буквам, тот же приём, что был только у Пэм в dlg-ask). Вынесено из ui/app.js в отдельный
 * файл по образцу ui/portrait_anim.js: там DOM-код app.js (document.getElementById и т.п.)
 * выполняется сразу при загрузке, так что require('app.js') в node упал бы без браузера —
 * а тут только чистые функции, и их можно смоук-тестить через node (tests/test_speech_js.py). */
(function () {
  'use strict';

  const DWIGHT_LINES = [
    'Что делаем? Опиши как коллеге: что, где и когда считать готовым.',
    'Чем точнее задание — тем меньше правок. Пиши пути к файлам.',
    'Тесты будут? Если да — скажи, какие.',
    'Я принял. Кому отдаём — выбери агента справа.',
    'Название короткое, описание — подробное. Формальности важны.',
    'Критерии готовности — в студию. Без них ревью затянется.',
  ];
  const MICHAEL_LINES = [
    'Расскажи цель, а я разобью её на задачи для команды.',
    'Одна цель — одна миссия. Что должно получиться в конце?',
    'Укажи репозиторий, остальное спланирую сам.',
    'Чем шире цель — тем больше подзадач. Не бойся формулировать смело.',
    'Я изучу репозиторий и соберу план. Дай мне направление.',
  ];

  // случайная реплика из набора; rnd — источник [0,1), по умолчанию Math.random,
  // передаётся seeded-генератором в node-тесте для детерминированности
  function pickLine(lines, rnd) {
    rnd = rnd || Math.random;
    const i = Math.min(lines.length - 1, Math.floor(rnd() * lines.length));
    return lines[i];
  }

  // печать текста посимвольно (~18мс/символ по умолчанию); клик по элементу — пропустить печать.
  // Возвращает Promise<void>, у которого есть .cancel() — тот же эффект, что и у клика (мгновенно
  // показать целиком и остановить дальнейшие setTimeout), нужен для остановки печати при закрытии диалога.
  function typeMessage(el, text, msPerChar) {
    msPerChar = msPerChar || 18;
    let finishRef = null;
    const p = new Promise((resolve) => {
      el.textContent = '';
      const s = String(text == null ? '' : text);
      if (!s) { resolve(); return; }
      let i = 0, done = false;
      const finish = () => { if (done) return; done = true; el.textContent = s; el.removeEventListener('click', skip); resolve(); };
      finishRef = finish;
      const skip = () => finish();
      el.addEventListener('click', skip);
      const step = () => {
        if (done) return;
        i++; el.textContent = s.slice(0, i);
        if (i >= s.length) finish(); else setTimeout(step, msPerChar);
      };
      step();
    });
    p.cancel = () => { if (finishRef) finishRef(); };
    return p;
  }

  const api = { DWIGHT_LINES, MICHAEL_LINES, pickLine, typeMessage };
  if (typeof window !== 'undefined') window.Speech = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
