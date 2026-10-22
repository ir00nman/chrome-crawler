'use strict';
/* skript-runner.js — исполнение кода /skript во вкладке через CDP (этап 6).
 *
 * Две части:
 *   skriptPageSide — настоящая JS-функция, её текст внедряется в страницу одним
 *     Runtime.evaluate вместе с кодом модели (обёртка __crawler по контракту);
 *   skriptCreateRunner — сторона панели: мост Runtime.addBinding, ввод через CDP,
 *     лимиты, watchdog, heartbeat, телеметрия, стоп.
 * Все зависимости (cdp, ввод, таймеры, часы) передаются в create(opts): тесты
 * подставляют моки, а страничную часть исполняют в vm без изменений.
 * Не реализовано (этап 6.1): iframe/смещения фреймов, режим «синтетических» событий.
 */

const SKRIPT_BINDING = '__crawlerBridge';

const SKRIPT_RUNNER_LIMITS = {
  maxMs: 5 * 60 * 1000,      // watchdog: максимум 5 минут
  actionsPerSecond: 60,      // лимит действий ввода
  heartbeatMs: 2000,         // страница шлёт heartbeat
  heartbeatTimeoutMs: 8000,  // нет heartbeat — считаем зависшим
  resultLimit: 4000,         // лимит размера результата (символы JSON)
  telemetryBuffer: 600,      // кольцевой буфер
  queueMax: 120,             // очередь ввода
  reportEveryMs: 250,        // не чаще для report()
  maxHoldMs: 2000,
  lagProbeMs: 100,           // замер занятости главного потока страницы
  slowBusyRatio: 0.6,        // доля времени, когда код скрипта держит страницу
  slowWindows: 2,            // столько окон heartbeat подряд → «тормозит» (≈4 с)
  stallMs: 10000,            // после первых нажатий нет ни одного действия столько мс → «перестал действовать»
  pixelsPerSecond: 20,       // __crawler.pixels: снимков экрана в секунду
  pixelsMaxSide: 256,        // самая длинная сторона возвращаемой картинки
  pixelsTimeoutMs: 3000      // нет ответа панели — скрипт получает null
};

// Средний цвет клеток сетки cols×rows по RGBA-картинке w×h. inset — доля края клетки, которую пропускаем
// (зазоры, обводки). Чистая и самодостаточная: её текст передаётся и в страницу (grid), и используется панелью
// (инструмент screenshot_region), чтобы модель видела те же числа, что получит её скрипт.
function skriptGridColors(data, w, h, cols, rows, inset) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c + inset) * w / cols), x1 = Math.max(x0 + 1, Math.ceil((c + 1 - inset) * w / cols));
      const y0 = Math.floor((r + inset) * h / rows), y1 = Math.max(y0 + 1, Math.ceil((r + 1 - inset) * h / rows));
      let R = 0, G = 0, B = 0, n = 0;
      for (let y = y0; y < Math.min(y1, h); y++) for (let x = x0; x < Math.min(x1, w); x++) {
        const k = (y * w + x) * 4;
        R += data[k]; G += data[k + 1]; B += data[k + 2]; n++;
      }
      line.push(n ? [Math.round(R / n), Math.round(G / n), Math.round(B / n)] : [0, 0, 0]);
    }
    out.push(line);
  }
  return out;
}

// Код, который исполняется В СТРАНИЦЕ. nonce знает только эта функция (замыкание): страничные
// скрипты не могут подделать сообщения моста. Должна быть самодостаточной: её текст копируется.
function skriptPageSide(NONCE, L, DRY, ARGS, USER, GRID) {
  const bridge = globalThis.__crawlerBridge;
  // Chrome требует правильный this у setTimeout/clearInterval и т.п. (WindowOrWorkerGlobalScope):
  // оторванная ссылка (const f = window.setTimeout) бросает "Illegal invocation". Оборачиваем в вызов метода.
  const G = globalThis;
  const ST = (...a) => G.setTimeout(...a), CT = (...a) => G.clearTimeout(...a), SI = (...a) => G.setInterval(...a), CI = (...a) => G.clearInterval(...a);
  const NOW = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
  const S = { stopped: false, finished: false, bodyDone: false, result: undefined, loops: new Set(), timers: new Set(), waiters: new Set(), pending: null, lastRep: 0, errs: 0, pix: new Map(), pixSeq: 0 };

  const send = (m) => { try { m.n = NONCE; bridge(JSON.stringify(m)); } catch (e) { /* моста нет — панель увидит по heartbeat */ } };
  const safe = (v) => {
    try {
      const s = JSON.stringify(v);
      if (s === undefined) return null;
      return s.length > L.resultLimit ? { clipped: s.slice(0, L.resultLimit) } : JSON.parse(s);
    } catch (e) { return String(v).slice(0, L.resultLimit); }
  };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  const flush = () => { if (S.pending) { send({ t: 'report', data: S.pending }); S.pending = null; S.lastRep = NOW(); } };
  const stopAll = () => {
    S.stopped = true;
    for (const c of [...S.loops]) c();
    S.loops.clear();
    for (const t of S.timers) { CT(t); CI(t); }
    S.timers.clear();
    for (const w of [...S.waiters]) w();
    S.waiters.clear();
    for (const p of [...S.pix.values()]) p.end(null);
    S.pix.clear();
  };
  const finish = (result) => {
    if (S.finished) return;
    S.finished = true;
    flush();
    stopAll();
    send({ t: 'done', result: safe(result) });
  };
  const stackOf = (e) => (e && e.stack ? String(e.stack).slice(0, 500) : undefined);
  const fatal = (e) => {
    if (S.finished) return;
    S.finished = true;
    stopAll();
    send({ t: 'fatal', msg: String(e && e.message || e).slice(0, 300), stack: stackOf(e) });
  };
  const maybeFinish = () => { if (S.bodyDone && !S.loops.size && !S.finished) finish(S.result); };

  const api = {
    loop(fn, opt) {
      if (S.stopped || typeof fn !== 'function') return () => {};
      const fps = Math.min(120, Math.max(1, Number(opt && opt.fps) || 30));
      const iv = 1000 / fps;
      let on = true, handle = 0, frames = 0, t0 = NOW();
      const cancel = () => { on = false; CT(handle); S.timers.delete(handle); S.loops.delete(cancel); maybeFinish(); };
      const tick = async () => {
        S.timers.delete(handle);                    // сработавший таймер — не копим: при 60 fps за 5 минут это ~18 000 id
        if (!on || S.stopped) return;
        const t = NOW();
        try { await fn(); S.errs = 0; }
        catch (e) {
          send({ t: 'error', msg: String(e && e.message || e).slice(0, 200), stack: stackOf(e) });
          if (++S.errs >= 5) { fatal('loop: 5 errors in a row: ' + String(e && e.message || e)); return; }
        }
        frames++;
        const now = NOW();
        if (now - t0 >= 500) { send({ t: 'fps', fps: Math.round(frames * 1000 / (now - t0)) }); frames = 0; t0 = now; }
        if (!on || S.stopped) return;
        handle = ST(tick, Math.max(0, iv - (NOW() - t)));
        S.timers.add(handle);
      };
      S.loops.add(cancel);
      handle = ST(tick, 0);
      S.timers.add(handle);
      return cancel;
    },
    key(name, opt) {
      if (S.stopped) return;
      send({ t: 'key', name: String(name).slice(0, 24), hold: Math.min(L.maxHoldMs, Math.max(0, Number(opt && opt.hold) || 0)) });
    },
    click(x, y) { if (!S.stopped && num(x) !== null && num(y) !== null) send({ t: 'click', x, y }); },
    move(x, y) { if (!S.stopped && num(x) !== null && num(y) !== null) send({ t: 'move', x, y }); },
    drag(x1, y1, x2, y2) {
      if (!S.stopped && [x1, y1, x2, y2].every((v) => num(v) !== null)) send({ t: 'drag', x1, y1, x2, y2 });
    },
    // Снимок области экрана: запрос уходит в панель (CDP Page.captureScreenshot), ответ приходит через __crawlerPix.
    pixels(x, y, w, h, opt) {
      return new Promise((resolve) => {
        if (S.stopped || [x, y, w, h].some((v) => num(v) === null) || w <= 0 || h <= 0) { resolve(null); return; }
        const size = Math.min(L.pixelsMaxSide, Math.max(1, Math.round(Number(opt && opt.size) || Math.max(w, h))));
        const id = ++S.pixSeq;
        let th;
        const end = (v) => { CT(th); S.timers.delete(th); S.pix.delete(id); resolve(v); };
        th = ST(() => end(null), L.pixelsTimeoutMs);
        S.timers.add(th);
        S.pix.set(id, { end, x, y, w, h });
        send({ t: 'pixels', id, x, y, w, h, size, smooth: !(opt && opt.smooth === false), sx: Number(G.scrollX) || 0, sy: Number(G.scrollY) || 0 });
      });
    },
    // Сетка средних цветов поверх области экрана (на основе pixels).
    async grid(x, y, w, h, cols, rows, opt) {
      cols = Math.floor(Number(cols)); rows = Math.floor(Number(rows));
      if (!(cols >= 1 && cols <= 32 && rows >= 1 && rows <= 32)) return null;
      const inset = Math.min(0.45, Math.max(0, opt && opt.inset !== undefined ? Number(opt.inset) || 0 : 0.15));
      const img = await api.pixels(x, y, w, h, { size: Math.min(L.pixelsMaxSide, Math.max(cols, rows) * 8) });
      if (!img) return null;
      const cells = GRID(img.data, img.width, img.height, cols, rows, inset);
      return Object.freeze({ cols, rows, cells, at(c, r) { return (cells[r] && cells[r][c]) || null; } });
    },
    wait(ms) {
      return new Promise((resolve) => {
        if (S.stopped) { resolve(); return; }
        let h;
        const end = () => { CT(h); S.waiters.delete(end); S.timers.delete(h); resolve(); };
        h = ST(end, Math.min(60000, Math.max(0, Number(ms) || 0)));
        S.timers.add(h);
        S.waiters.add(end);
      });
    },
    report(obj) {
      if (!obj || typeof obj !== 'object') return;
      const flat = {};
      for (const k of Object.keys(obj).slice(0, 20)) {
        const v = obj[k];
        if (typeof v === 'number' && isFinite(v)) flat[k] = v;
        else if (typeof v === 'string') flat[k] = v.slice(0, 80);
        else if (typeof v === 'boolean') flat[k] = v;
      }
      S.pending = flat;
      if (NOW() - S.lastRep >= L.reportEveryMs) flush();
    },
    log(msg) { send({ t: 'log', msg: String(msg).slice(0, 200) }); },
    done(result) { finish(result); },
    get stopped() { return S.stopped; },
    // пробный прогон: ввод не отправляется, страница не меняется — скрипт не должен считать это ошибкой
    dry: !!DRY,
    // Сохранённое состояние игры из localStorage — только чтение и только ключи, которые проба страницы нашла как
    // состояние (L.savedKeys). Прямой localStorage в коде модели запрещён (там бывают токены и личные данные).
    saved(key) {
      const k = String(key);
      if (!Array.isArray(L.savedKeys) || !L.savedKeys.includes(k)) return null;
      let v = null;
      try { v = globalThis.localStorage.getItem(k); } catch (e) { return null; }
      if (v === null) return null;
      try { return JSON.parse(v); } catch (e) { return v; }
    },
    limits: Object.freeze({ actionsPerSecond: L.actionsPerSecond, maxMs: L.maxMs })
  };
  Object.freeze(api);

  globalThis.__crawlerStop = () => { S.finished = true; stopAll(); };
  // Ответ панели на pixels(): RGBA в base64. Без nonce запуска чужой код страницы подсунуть картинку не может.
  globalThis.__crawlerPix = (n, id, out) => {
    if (n !== NONCE) return;
    const req = S.pix.get(id);
    if (!req) return;
    if (!out || !out.b64) { req.end(null); return; }
    const bin = G.atob(out.b64), data = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const W = out.w, H = out.h;
    req.end(Object.freeze({
      width: W, height: H, data,
      at(px, py) {
        const ix = Math.min(W - 1, Math.max(0, Math.floor((px - req.x) / req.w * W)));
        const iy = Math.min(H - 1, Math.max(0, Math.floor((py - req.y) / req.h * H)));
        const k = (iy * W + ix) * 4;
        return [data[k], data[k + 1], data[k + 2]];
      },
      // По координатам самой картинки (0..width-1, 0..height-1) — для обхода всех её пикселей.
      px(ix, iy) {
        if (!(ix >= 0 && iy >= 0 && ix < W && iy < H)) return null;
        const k = ((iy | 0) * W + (ix | 0)) * 4;
        return [data[k], data[k + 1], data[k + 2]];
      }
    }));
  };
  // Занятость страницы: таймер с шагом lagProbeMs опаздывает ровно на то время, пока синхронный код
  // (в том числе код модели) держит главный поток. Пока поток занят, страница не рисует и не получает клавиши.
  let lagLast = NOW(), busy = 0, freeze = 0, winStart = NOW();
  S.timers.add(SI(() => {
    // В фоновой вкладке Chrome сам замедляет таймеры до ~1 раза в секунду — это не занятость.
    const hidden = !!(G.document && G.document.hidden);
    const t = NOW(), lag = hidden ? 0 : Math.max(0, t - lagLast - L.lagProbeMs);
    lagLast = t; busy += lag; if (lag > freeze) freeze = lag;
  }, L.lagProbeMs));
  S.timers.add(SI(() => {
    if (S.stopped) return;
    const t = NOW(), win = Math.max(1, t - winStart);
    send({ t: 'hb', busy: Math.min(1, busy / win), freeze: Math.round(freeze) });
    busy = 0; freeze = 0; winStart = t;
    flush();
  }, L.heartbeatMs));
  send({ t: 'hb' });

  Promise.resolve().then(() => USER(ARGS, api, api)).then(
    (r) => { S.bodyDone = true; S.result = r; maybeFinish(); },
    (e) => fatal(e)
  );
}

// Выражение для Runtime.evaluate: страничная часть + код модели как тело async-функции.
function skriptBuildExpression({ code, args, nonce, dryRun, limits }) {
  const lim = { ...SKRIPT_RUNNER_LIMITS, ...(limits || {}) };
  return `(${skriptPageSide.toString()})(${JSON.stringify(nonce)}, ${JSON.stringify(lim)}, ${dryRun ? 'true' : 'false'}, ${JSON.stringify(args || {})}, ` +
    `async function (args, __crawler, __clodex) {\n${code}\n}, ${skriptGridColors.toString()})`;   // __clodex — прежнее имя, для скриптов, сохранённых до переименования
}

// Только компиляция (синтаксис), без выполнения: Runtime.compileScript.
function skriptCompileExpression(code) {
  return `(async function (args, __crawler, __clodex) {\n${code}\n})`;
}

const SKRIPT_END_REASONS = {
  done: 'Готово', returned: 'Готово', 'dry-end': 'Пробный прогон завершён', manual: 'Остановлено вами',
  'max-time': 'Достигнут лимит времени', heartbeat: 'Скрипт завис', error: 'Ошибка в скрипте',
  slow: 'Скрипт тормозит страницу', stalled: 'Скрипт перестал действовать',
  'origin-changed': 'Вы ушли с сайта', 'tab-closed': 'Вкладка закрыта', 'panel-closed': 'Панель закрыта',
  aborted: 'Задача остановлена', 'bridge-unavailable': 'Не удалось связаться со страницей', syntax: 'Ошибка синтаксиса'
};
const SKRIPT_OK_REASONS = ['done', 'returned', 'dry-end'];

function skriptCreateRunner(opts = {}) {
  const cdp = opts.cdp || (async () => { throw new Error('cdp недоступен'); });
  const input = opts.input || {};
  const now = opts.now || (() => Date.now());
  // Только вызов через globalThis: timers.setTimeout(...) с this=timers в Chrome бросает "Illegal invocation".
  const timers = opts.timers || {
    setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
    setInterval: (f, ms) => globalThis.setInterval(f, ms),
    clearInterval: (h) => globalThis.clearInterval(h)
  };
  const random = opts.random || (() => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  const limits = { ...SKRIPT_RUNNER_LIMITS, ...(opts.limits || {}) };
  const ui = opts.ui || (() => {});
  const capture = opts.capture || null; // (rect, size, smooth) → { w, h, b64 } — снимок экрана для pixels()
  const logger = opts.logger || (() => {});

  const R = {
    running: false, dryRun: false, nonce: '', permissions: new Set(['read']),
    startedAt: 0, stoppedAt: 0, lastHeartbeat: 0, fps: null,
    telemetry: [], lastReport: null, logs: [], errors: [], actions: 0, dropped: 0, dryActions: 0,
    stopReason: null, result: null, busy: 0, longestFreezeMs: 0, lastActionAt: 0, _slowWins: 0, captures: 0, _pixStamps: [],
    _queue: [], _draining: false, _stamps: [], _end: null, _watchdog: null, _hb: null, _expectedOrigin: '',

    _push(entry) {
      this.telemetry.push({ ts: now(), ...entry });
      if (this.telemetry.length > limits.telemetryBuffer) this.telemetry.splice(0, this.telemetry.length - limits.telemetryBuffer);
    },

    summary() {
      const metrics = {};
      for (const e of this.telemetry) {
        if (e.t !== 'report' || !e.data) continue;
        for (const [k, v] of Object.entries(e.data)) {
          if (typeof v !== 'number') continue;
          const m = metrics[k] || (metrics[k] = { min: v, max: v, last: v });
          m.min = Math.min(m.min, v); m.max = Math.max(m.max, v); m.last = v;
        }
      }
      const t = now();
      return {
        running: this.running, reason: this.stopReason, ok: SKRIPT_OK_REASONS.includes(this.stopReason),
        // Занятость страницы кодом скрипта (последнее окно) и самая долгая заморозка — для модели.
        pageBusyPercent: Math.round(this.busy * 100), longestFreezeMs: this.longestFreezeMs,
        secondsSinceLastAction: this.lastActionAt ? Math.round(((this.stoppedAt || t) - this.lastActionAt) / 100) / 10 : null,
        elapsedMs: this.startedAt ? (this.stoppedAt || now()) - this.startedAt : 0,
        actions: this.actions, dropped: this.dropped, ...(this.captures ? { pixelCaptures: this.captures } : {}), dryActions: this.dryRun ? this.dryActions : undefined,
        fps: this.fps, metrics, lastReport: this.lastReport,
        errors: this.errors.slice(-5), logs: this.logs.slice(-5), result: this.result
      };
    },

    // Только синтаксис: код не выполняется.
    async check(code) {
      try {
        // compileScript работает только при включённом домене Runtime («Runtime agent is not enabled»).
        await cdp('Runtime.enable', {});
        const r = await cdp('Runtime.compileScript', { expression: skriptCompileExpression(code), sourceURL: 'crawler-script.js', persistScript: false });
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return { ok: false, error: String((d.exception && d.exception.description) || d.text || 'SyntaxError').split('\n')[0].slice(0, 300) };
        }
        return { ok: true };
      } catch (e) { return { ok: false, infra: true, error: String(e.message || e).slice(0, 300) }; }
    },

    // Запуск. Возвращает промис со сводкой после остановки по любой причине.
    // approved обязателен: модель не запускает первую версию сама.
    async run({ code, args = {}, dryRun = false, approved = false, permissions = ['read'], maxMs, expectedOrigin = '', savedKeys = [] } = {}) {
      if (this.running) throw new Error('Скрипт уже запущен: сначала остановите его.');
      if (!approved && !dryRun) return { ok: false, reason: 'not-approved', error: 'Первый запуск требует нажатия «Запустить» в панели.' };
      Object.assign(this, {
        running: true, dryRun: !!dryRun, nonce: random(), permissions: new Set(permissions), stopReason: null, result: null,
        startedAt: now(), stoppedAt: 0, lastHeartbeat: now(), fps: null, telemetry: [], lastReport: null, logs: [], errors: [],
        actions: 0, dropped: 0, dryActions: 0, _queue: [], _stamps: [], _expectedOrigin: expectedOrigin,
        busy: 0, longestFreezeMs: 0, lastActionAt: 0, _slowWins: 0, captures: 0, _pixStamps: []
      });
      const ended = new Promise((resolve) => { this._end = resolve; });
      try {
        await cdp('Runtime.enable', {});
        await cdp('Runtime.addBinding', { name: SKRIPT_BINDING });
        const probe = await cdp('Runtime.evaluate', { expression: `typeof globalThis.${SKRIPT_BINDING}`, returnByValue: true });
        if (!probe || !probe.result || probe.result.value !== 'function') { await this.stop('bridge-unavailable'); return ended; }
        const r = await cdp('Runtime.evaluate', {
          expression: skriptBuildExpression({ code, args, nonce: this.nonce, dryRun, limits: { ...limits, savedKeys: (savedKeys || []).map(String).slice(0, 8) } }), returnByValue: true, userGesture: false
        });
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          // Полное описание (с стеком), не только первая строка: синхронный сбой при внедрении
          // обёртки нужно видеть целиком, чтобы понять, откуда он — из обёртки или из кода модели.
          this.errors.push(String((d.exception && d.exception.description) || d.text || 'error').slice(0, 600));
          await this.stop(/SyntaxError/.test(this.errors[0]) ? 'syntax' : 'error');
          return ended;
        }
      } catch (e) {
        this.errors.push(String(e.message || e).slice(0, 300));
        await this.stop('error');
        return ended;
      }
      // Скрипт мог успеть закончиться (done) ещё до ответа на evaluate: тогда таймеры заводить нельзя —
      // stop() уже прошёл, и сторож с heartbeat остались бы висеть после остановки.
      if (!this.running) return ended;
      this._watchdog = timers.setTimeout(() => this.stop(dryRun ? 'dry-end' : 'max-time'), maxMs || limits.maxMs);
      this._hb = timers.setInterval(() => {
        if (!this.running || this.dryRun) return;
        const t = now();
        if (t - this.lastHeartbeat > limits.heartbeatTimeoutMs) { this.stop('heartbeat'); return; }
        // Нажимал и перестал: цикл крутится, а действий нет (неверно читает состояние, ход не меняет поле, конец игры).
        if (this.permissions.has('input') && this.lastActionAt && t - this.lastActionAt > limits.stallMs) this.stop('stalled');
      }, limits.heartbeatMs);
      ui(this);
      return ended;
    },

    // Сообщение страницы (Runtime.bindingCalled). Чужие сообщения без nonce игнорируются.
    async _onBinding(payload) {
      let m;
      try { m = JSON.parse(payload); } catch (e) { return; }
      if (!this.running || !m || m.n !== this.nonce) return;
      switch (m.t) {
        case 'hb':
          this.lastHeartbeat = now();
          if (typeof m.busy === 'number') {
            this.busy = m.busy;
            this.longestFreezeMs = Math.max(this.longestFreezeMs, Number(m.freeze) || 0);
            this._slowWins = m.busy >= limits.slowBusyRatio ? this._slowWins + 1 : 0;
            if (!this.dryRun && this._slowWins >= limits.slowWindows) await this.stop('slow');
          }
          return;
        case 'fps': this.lastHeartbeat = now(); this.fps = Number(m.fps) || 0; ui(this); return;
        case 'report': this.lastReport = m.data; this._push({ t: 'report', data: m.data }); ui(this); return;
        case 'log': this.logs.push(String(m.msg).slice(0, 200)); logger(String(m.msg)); ui(this); return;
        case 'error': this.errors.push(String(m.msg).slice(0, 200) + (m.stack ? '\n' + m.stack : '')); ui(this); return;
        case 'fatal': this.errors.push(String(m.msg).slice(0, 300) + (m.stack ? '\n' + m.stack : '')); await this.stop('error'); return;
        case 'done':
          this.result = m.result === undefined ? null : m.result;
          await this._idle(); // последние нажатия перед done() должны дойти до страницы
          await this.stop(this.dryRun ? 'dry-end' : 'done');
          return;
        case 'key': case 'click': case 'move': case 'drag': this._action(m); return;
        case 'pixels': this._pixels(m); return;
      }
    },

    // Снимок для pixels(): только чтение экрана своей вкладки, поэтому без гранта ввода. Ответ — всегда,
    // даже null: скрипт не должен ждать до таймаута. Координаты страницы = вьюпорт + прокрутка (clip CDP).
    async _pixels(m) {
      const nonce = this.nonce, t = now();
      this._pixStamps = this._pixStamps.filter((s) => t - s < 1000);
      let out = null;
      if (!capture) {
        if (!this.errors.some((e) => e.startsWith('pixels'))) this.errors.push('pixels: снимок экрана недоступен');
      } else if (this._pixStamps.length >= limits.pixelsPerSecond) {
        if (!this.errors.some((e) => e.startsWith('pixels: лимит'))) this.errors.push(`pixels: лимит ${limits.pixelsPerSecond} снимков в секунду, лишние вернули null`);
      } else {
        this._pixStamps.push(t);
        try {
          out = await capture({ x: m.x + (Number(m.sx) || 0), y: m.y + (Number(m.sy) || 0), w: m.w, h: m.h },
            Math.min(limits.pixelsMaxSide, Math.max(1, Number(m.size) || 64)), m.smooth !== false);
          this.captures++;
        } catch (e) { this.errors.push('pixels: ' + String(e.message || e).slice(0, 120)); }
      }
      if (!this.running || this.nonce !== nonce) return;
      cdp('Runtime.evaluate', {
        expression: `globalThis.__crawlerPix && globalThis.__crawlerPix(${JSON.stringify(nonce)}, ${Number(m.id) | 0}, ${out ? JSON.stringify(out) : 'null'})`,
        returnByValue: true
      }).catch(() => {});
    },

    _action(m) {
      if (this.dryRun) { this.dryActions++; return; }
      if (!this.permissions.has('input')) {
        if (!this.errors.some((e) => e.startsWith('Blocked'))) this.errors.push('Blocked: ввод (key/click/move/drag) не разрешён для этого скрипта');
        this.dropped++;
        return;
      }
      const t = now();
      this._stamps = this._stamps.filter((s) => t - s < 1000);
      if (this._stamps.length >= limits.actionsPerSecond || this._queue.length >= limits.queueMax) {
        if (!this.dropped) this.errors.push(`Лимит ввода: больше ${limits.actionsPerSecond} действий в секунду, лишние отброшены`);
        this.dropped++;
        return;
      }
      this._stamps.push(t);
      this._queue.push(m);
      this._drain();
    },

    // Ждём, пока очередь ввода опустеет (не дольше 1.5 с).
    async _idle() {
      const until = now() + 1500;
      while ((this._queue.length || this._draining) && this.running && now() < until) {
        await new Promise((r) => timers.setTimeout(r, 5));
      }
    },

    async _drain() {
      if (this._draining) return;
      this._draining = true;
      try {
        while (this._queue.length && this.running) {
          const m = this._queue.shift();
          try {
            if (m.t === 'key') await input.key(m.name, m.hold || 0);
            else if (m.t === 'click') await input.click(m.x, m.y);
            else if (m.t === 'move') await input.move(m.x, m.y);
            else if (m.t === 'drag') await input.drag(m.x1, m.y1, m.x2, m.y2);
            this.actions++;
            this.lastActionAt = now();
          } catch (e) { this.errors.push(String(e.message || e).slice(0, 120)); }
        }
      } finally { this._draining = false; }
      ui(this);
    },

    // Стоп не ждёт сетевых вызовов: страница гасится отдельной командой (цель < 200 мс).
    async stop(reason = 'manual') {
      if (!this.running) return { stopped: false };
      const t0 = now();
      this.running = false;
      this.stopReason = reason;
      this.stoppedAt = t0;
      this._queue = [];
      if (this._watchdog) timers.clearTimeout(this._watchdog);
      if (this._hb) timers.clearInterval(this._hb);
      this._watchdog = this._hb = null;
      cdp('Runtime.evaluate', { expression: 'globalThis.__crawlerStop && globalThis.__crawlerStop(); delete globalThis.__crawlerStop; delete globalThis.__crawlerPix;', returnByValue: true }).catch(() => {});
      cdp('Runtime.removeBinding', { name: SKRIPT_BINDING }).catch(() => {});
      this._push({ t: 'stop', reason });
      const end = this._end; this._end = null;
      ui(this);
      if (end) end(this.summary());
      return { stopped: true, ms: now() - t0, reason };
    },

    // Страница сменила адрес или закрыта: вызывает панель.
    checkOrigin(currentUrl) {
      if (!this.running || !this._expectedOrigin) return false;
      let o = '';
      try { o = new URL(currentUrl).origin; } catch (e) { this.stop('tab-closed'); return true; }
      if (o !== this._expectedOrigin) { this.stop('origin-changed'); return true; }
      return false;
    }
  };
  return R;
}

const SkriptRunner = {
  BINDING: SKRIPT_BINDING,
  LIMITS: SKRIPT_RUNNER_LIMITS,
  REASONS: SKRIPT_END_REASONS,
  OK_REASONS: SKRIPT_OK_REASONS,
  buildExpression: skriptBuildExpression,
  compileExpression: skriptCompileExpression,
  gridColors: skriptGridColors,
  create: skriptCreateRunner
};
