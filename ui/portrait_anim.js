/* Живые портреты в диалогах: моргание, речь (по спрайт-ленте), простые эмоции.
 * Лента <name>_sheet.png — 1024x256, 4 кадра по 256px: neutral|blink|talk1|talk2.
 * Кадр меняется сдвигом background-position (без перерисовки <img>), background-size 400% 100%.
 *
 * Чистые функции (детерминированные при переданном rnd) экспортируются для node-смоук-теста;
 * DOM-часть (LivePortrait.mount) работает только в браузере. */
(function () {
  'use strict';
  const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';

  const FRAMES = ['neutral', 'blink', 'talk1', 'talk2'];
  const FRAME_INDEX = { neutral: 0, blink: 1, talk1: 2, talk2: 3 };

  // mulberry32 — маленький детерминированный PRNG: тот же seed даёт ту же последовательность,
  // что нужно и для теста расписания морганий, и для случайных, но воспроизводимых чередований речи.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; }
    return h >>> 0;
  }

  const BLINK_MIN_MS = 2500, BLINK_MAX_MS = 6000;
  const BLINK_DURATION_MS = 120;
  const DOUBLE_BLINK_CHANCE = 0.18;
  const DOUBLE_BLINK_GAP_MS = 200;
  const TALK_FRAME_MIN_MS = 90, TALK_FRAME_MAX_MS = 140;
  const TALK_NEUTRAL_CHANCE = 0.12;   // случайный «просвет» ртом закрыт — неровность речи

  function nextBlinkDelay(rnd, worried) {
    const base = BLINK_MIN_MS + rnd() * (BLINK_MAX_MS - BLINK_MIN_MS);
    return worried ? base * 0.5 : base;   // worried — «моргает чаще»
  }

  function isDoubleBlink(rnd) { return rnd() < DOUBLE_BLINK_CHANCE; }

  // Расписание кадров речи на durationMs: чередование talk1/talk2 с редкими вставками neutral,
  // интервалы 90-140мс (неровно, как реальная речь), всегда заканчивается кадром neutral.
  function talkFrameSequence(durationMs, rnd) {
    const seq = [];
    let elapsed = 0;
    while (elapsed < durationMs) {
      const remaining = durationMs - elapsed;
      if (remaining <= TALK_FRAME_MIN_MS) break;   // не втиснуть ещё кадр — оставляем место финальному neutral
      const delay = Math.min(TALK_FRAME_MIN_MS + rnd() * (TALK_FRAME_MAX_MS - TALK_FRAME_MIN_MS), remaining);
      const frame = rnd() < TALK_NEUTRAL_CHANCE ? 'neutral' : (rnd() < 0.5 ? 'talk1' : 'talk2');
      seq.push({ frame, delay });
      elapsed += delay;
    }
    seq.push({ frame: 'neutral', delay: 0 });
    return seq;
  }

  function frameBgPosition(frame) {
    return (FRAME_INDEX[frame] / (FRAMES.length - 1) * 100) + '%';
  }

  function fileBase(agentFile) { return String(agentFile || '').replace(/\.[^./]+$/, ''); }

  function reducedMotion() {
    try { return hasDOM && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  let mount = null;
  if (hasDOM) {
    const INSTANCES = new WeakMap();

    function setFrame(el, frame) {
      el.style.backgroundPosition = frameBgPosition(frame) + ' 0%';
      el.dataset.frame = frame;
    }

    function forceBlink(state) {
      if (state.talking) return;
      setFrame(state.el, 'blink');
      setTimeout(() => { if (!state.talking) setFrame(state.el, 'neutral'); }, BLINK_DURATION_MS);
      if (isDoubleBlink(state.rnd)) {
        setTimeout(() => {
          if (state.talking) return;
          setFrame(state.el, 'blink');
          setTimeout(() => { if (!state.talking) setFrame(state.el, 'neutral'); }, BLINK_DURATION_MS);
        }, DOUBLE_BLINK_GAP_MS);
      }
    }

    function scheduleBlink(state) {
      clearTimeout(state.blinkTimer);
      const delay = nextBlinkDelay(state.rnd, state.mood === 'worried');
      state.blinkTimer = setTimeout(() => { forceBlink(state); scheduleBlink(state); }, delay);
    }

    function talk(state, ms) {
      state.talkTimers.forEach(clearTimeout); state.talkTimers = [];
      if (!ms || ms <= 0 || reducedMotion()) { state.talking = false; setFrame(state.el, 'neutral'); return; }
      state.talking = true;
      const seq = talkFrameSequence(ms, state.rnd);
      let t = 0;
      for (const { frame, delay } of seq) {
        t += delay;
        state.talkTimers.push(setTimeout(() => setFrame(state.el, frame), t));
      }
      state.talkTimers.push(setTimeout(() => { state.talking = false; }, t + 1));
    }

    function setMood(state, name, ms) {
      clearTimeout(state.moodTimer);
      state.mood = name;
      state.el.classList.remove('mood-happy', 'mood-worried');
      if (name === 'happy') state.el.classList.add('mood-happy');
      else if (name === 'worried') state.el.classList.add('mood-worried');
      if (ms) state.moodTimer = setTimeout(() => setMood(state, 'neutral'), ms);
    }

    function stopAll(state) {
      clearTimeout(state.blinkTimer); state.blinkTimer = null;
      state.talkTimers.forEach(clearTimeout); state.talkTimers = [];
      clearTimeout(state.moodTimer); state.moodTimer = null;
      state.talking = false;
    }

    mount = function (el, agentFile) {
      if (!el) return null;
      const prev = INSTANCES.get(el);
      if (prev) prev.stop();
      const base = fileBase(agentFile);
      el.classList.add('live-portrait');
      el.classList.remove('mood-happy', 'mood-worried');
      el.style.backgroundImage = `url(ui/assets/portraits/anim/${base}_sheet.png)`;
      const state = {
        el, rnd: mulberry32((hashStr(base) ^ (Date.now() & 0xffffffff)) >>> 0),
        blinkTimer: null, talkTimers: [], moodTimer: null, mood: 'neutral', talking: false,
      };
      setFrame(el, 'neutral');
      const inst = {
        talk: (ms) => talk(state, ms),
        blink: () => forceBlink(state),
        mood: (name, ms) => setMood(state, name, ms),
        stop: () => stopAll(state),
      };
      INSTANCES.set(el, inst);
      scheduleBlink(state);
      return inst;
    };

    window.LivePortrait = { mount };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      FRAMES, mulberry32, hashStr, nextBlinkDelay, isDoubleBlink, talkFrameSequence, frameBgPosition, fileBase,
      BLINK_MIN_MS, BLINK_MAX_MS, DOUBLE_BLINK_CHANCE, TALK_FRAME_MIN_MS, TALK_FRAME_MAX_MS,
    };
  }
})();
