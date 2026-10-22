'use strict';
/* skript-run.js — склейка режима /skript со скриптами в панели (этап 6).
 *
 * Поток для модели: write_script/patch_script → проверка кода, синтаксис через CDP,
 * пробный прогон (без ввода) → карточка в логе → ждём «Запустить» человека → запуск →
 * инструмент возвращает сводку запуска. Модель сама запустить первую версию не может.
 * Зависимости панели передаются в init(): cdp, parseKey, pressKey, mouseClick, mouseDrag,
 * sleep, tabUrl, fail, container, signal; для запуска человеком — busy, activeTabId, onSaved, reveal, release.
 */

const SkriptRun = (() => {
  let deps = null, drafts = null, runner = null, card = null, lastSummary = null, lastUi = 0, ledger = null, pendingRepair = null, repairNote = '';
  const TOOL_NAMES = ['write_script', 'patch_script', 'screenshot_region', 'run_script', 'stop_script', 'get_telemetry'];

  const fmtTime = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function fmtTele(r) {
    const s = r.summary();
    const parts = [];
    for (const [k, v] of Object.entries(s.lastReport || {}).slice(0, 4)) parts.push(`${k} ${v}`);
    if (s.fps) parts.push(`${s.fps} fps`);
    parts.push(`действий ${s.actions}`);
    if (s.dropped) parts.push(`отброшено ${s.dropped}`);
    parts.push(fmtTime(s.elapsedMs));
    return parts.join(' · ');
  }

  // Сводка для модели: коротко и без лишнего.
  function summaryText(s, d) {
    const out = {
      reason: s.reason, ok: s.ok, seconds: Math.round(s.elapsedMs / 100) / 10, actions: s.actions,
      ...(s.dropped ? { dropped: s.dropped } : {}), ...(s.fps ? { fps: s.fps } : {}),
      ...(Object.keys(s.metrics).length ? { metrics: s.metrics } : {}), ...(s.lastReport ? { lastReport: s.lastReport } : {}),
      ...(s.errors.length ? { errors: s.errors } : {}), ...(s.logs.length ? { logs: s.logs } : {}),
      ...(s.result !== null && s.result !== undefined ? { result: s.result } : {}),
      ...(s.pageBusyPercent ? { pageBusyPercent: s.pageBusyPercent } : {}), ...(s.longestFreezeMs ? { longestFreezeMs: s.longestFreezeMs } : {}),
      ...(s.secondsSinceLastAction !== null && s.secondsSinceLastAction !== undefined ? { secondsSinceLastAction: s.secondsSinceLastAction } : {}),
      ...(s.pixelCaptures ? { pixelCaptures: s.pixelCaptures, capturesPerAction: s.actions ? Math.round(s.pixelCaptures / s.actions * 10) / 10 : s.pixelCaptures } : {})
    };
    const head = `Script ${d.id} v${d.version} ended: ${SkriptRunner.REASONS[s.reason] || s.reason}.`;
    const why = REASON_HINTS[s.reason] ? ' ' + REASON_HINTS[s.reason](s) : '';
    // Живой прогон 2048: ~6 снимков на ход, игра шла медленно, а модель этого не видела.
    const shots = s.pixelCaptures && s.actions >= 5 && s.pixelCaptures / s.actions > 3
      ? ` The script took ${Math.round(s.pixelCaptures / s.actions)} screenshots per action: each costs 30-100 ms and slows play. After an action wait until the page has finished animating, then capture once.` : '';
    const tail = s.ok ? '' : ' If the goal is not reached, fix it with patch_script, or finish with done and say honestly what did not work.';
    return `${head} ${JSON.stringify(out)}${why}${shots}${tail}`;
  }

  // Что именно не так — словами для модели: без этого она видит только «остановлено» и повторяет тот же код.
  const REASON_HINTS = {
    slow: (s) => `The runner stopped it: your code kept the page's main thread busy ${s.pageBusyPercent}% of the time (longest freeze ${s.longestFreezeMs} ms). ` +
      'While your code computes, the page cannot render or receive key presses, so the game barely moves. Make every loop tick cheap: ' +
      'time-box any search with performance.now() (about 20-30 ms per decision, then use the best move found so far), lower the search depth, avoid re-reading the whole DOM many times per tick.',
    stalled: (s) => `The runner stopped it: the script pressed ${s.actions} times, then nothing for ${s.secondsSinceLastAction} s while it kept running. ` +
      'Likely the state you read stopped matching the page (animations, leftover or duplicate elements, a win/game-over message), or your move does not change the state and you wait forever. ' +
      'Log what you read with __crawler.log, re-read the state after each move, and if a move does not change the state try another move; detect win/game over and finish with __crawler.done.',
    heartbeat: (s) => `The page stopped answering for more than 8 s${s.longestFreezeMs ? ` (longest freeze ${s.longestFreezeMs} ms)` : ''}: a single tick of your code ran too long or never returned. Time-box heavy computations.`,
    manual: (s) => (s.pageBusyPercent >= 50 ? `The user stopped it while your code kept the page busy ${s.pageBusyPercent}% of the time: it was probably too slow. Time-box computations per tick.` : 'The user stopped it: ask what was wrong if it is not clear from the telemetry.')
  };

  async function holdKey(tab, spec, ms) {
    const k = deps.parseKey(spec);
    const base = { modifiers: k.mod, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await deps.cdp(tab, 'Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', ...(k.text ? { text: k.text } : {}) });
    await deps.sleep(ms);
    await deps.cdp(tab, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  // __crawler.pixels: снимок области через CDP (captureVisibleTab ограничен ~2 снимками в секунду), уменьшение
  // до size по длинной стороне, RGBA в base64. rect — в координатах страницы (CSS px с учётом прокрутки).
  async function capturePixels(tabId, rect, size, smooth) {
    const k = Math.min(1, size / Math.max(rect.w, rect.h));
    if (deps.hideFx) await deps.hideFx(tabId);                     // декоративные щупальца — не в пиксели
    const shot = await deps.cdp(tabId, 'Page.captureScreenshot', {
      format: 'png', fromSurface: true,
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: Math.max(0.05, k) }
    });
    if (!shot || !shot.data) throw new Error('пустой снимок');
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + shot.data)).blob());
    const w = Math.max(1, Math.round(rect.w * k)), h = Math.max(1, Math.round(rect.h * k));
    const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);   // снимок может быть в физических пикселях (Retina) — приводим к w×h
    if (bmp.close) bmp.close();
    const px = ctx.getImageData(0, 0, w, h).data;
    let bin = '';
    for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
    return { w, h, b64: btoa(bin) };
  }

  function ensureRunner(tabId) {
    if (runner && runner.tabId === tabId) return runner;
    if (runner && runner.running) runner.stop('manual');
    runner = SkriptRunner.create({
      cdp: (m, p) => deps.cdp(tabId, m, p),
      input: {
        key: (name, hold) => (hold ? holdKey(tabId, name, hold) : deps.pressKey(tabId, name)),
        click: (x, y) => deps.mouseClick(tabId, x, y),
        move: (x, y) => deps.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
        drag: (x1, y1, x2, y2) => deps.mouseDrag(tabId, x1, y1, x2, y2)
      },
      capture: deps.capture || ((rect, size, smooth) => capturePixels(tabId, rect, size, smooth)),
      // живая строка телеметрии, не чаще 4 раз в секунду
      ui: (r) => {
        const t = Date.now();
        if (card && !r.dryRun && r.running && t - lastUi > 250) { lastUi = t; card.tele(fmtTele(r)); }
      }
    });
    runner.tabId = tabId;
    return runner;
  }

  // Прокрутка страницы за время запуска. Живой прогон (динозаврик): Space и стрелки, не принятые игрой,
  // прокручивали страницу вниз, игра уезжала за экран и вставала, а модель 10 шагов искала ошибку в своей логике.
  async function pageScrollY(tabId) {
    try {
      const r = await deps.cdp(tabId, 'Runtime.evaluate', { expression: 'Math.round(globalThis.scrollY || 0)', returnByValue: true });
      const v = r && r.result && r.result.value;
      return typeof v === 'number' ? v : null;
    } catch (e) { return null; }
  }

  function scrollHint(y0, y1, s) {
    if (y0 === null || y1 === null || !s.actions || Math.abs(y1 - y0) < 100) return '';
    return ` Note: while the script ran, the page scrolled from y=${y0} to y=${y1}. Key presses (Space, arrows, PageDown) scroll the page ` +
      'when the focused element does not consume them: the game most likely did not receive your keys and may now be off-screen ' +
      '(many games pause when not visible). Click the game element first so it gets focus, keep it in view, and watch scrollY in your loop.';
  }

  // goal.read: расширение само читает метрику со страницы раз в секунду и в конце, не доверяя отчёту скрипта.
  // Выражение прошло проверку «только чтение» (SkriptEval.cleanGoal); ошибки чтения — просто нет значения.
  function startGoalReader(tabId, goal) {
    if (!goal || !goal.read) return { stop: async () => [] };
    const samples = [];
    let busy = false;
    const expression = `(() => { try { const v = (${goal.read}); return typeof v === 'number' ? v : Number(v); } catch (e) { return null; } })() /*crawler-goal*/`;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await deps.cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
        const v = r && r.result && r.result.value;
        if (typeof v === 'number' && isFinite(v)) { samples.push(v); if (samples.length > 600) samples.shift(); }
      } catch (e) { /* вкладка недоступна — пропуск */ }
      busy = false;
    };
    read();
    const h = globalThis.setInterval(read, 1000);
    return { async stop() { globalThis.clearInterval(h); busy = false; await read(); return samples; } };
  }

  // screenshot_region: модель смотрит на область экрана до написания кода — те же числа, что вернёт __crawler.grid.
  async function lookAt(args, st) {
    const clampInt = (v, d) => Math.min(16, Math.max(1, Math.floor(Number(v)) || d));
    const cols = clampInt(args.cols, 4), rows = clampInt(args.rows, 4);
    const inset = Math.min(0.45, Math.max(0, args.inset !== undefined ? Number(args.inset) || 0 : 0.15));
    const sel = args.selector ? String(args.selector).slice(0, 200) : '';
    const expression = `(() => { const v = { sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight }; ` +
      (sel ? `const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return { missing: true }; const r = e.getBoundingClientRect(); return { ...v, x: r.left, y: r.top, w: r.width, h: r.height };`
        : `return v;`) + ` })() /*crawler-rect*/`;
    let g;
    try {
      const r = await deps.cdp(st.tabId, 'Runtime.evaluate', { expression, returnByValue: true });
      if (r && r.exceptionDetails) return deps.fail(`screenshot_region: ${String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).split('\n')[0]}`);
      g = r && r.result && r.result.value;
    } catch (e) { return deps.fail(`screenshot_region: cannot reach the page (${e.message}).`); }
    if (!g || g.missing) return deps.fail(`screenshot_region: no element matches ${JSON.stringify(sel)}.`);
    const rect = sel ? { x: g.x, y: g.y, w: g.w, h: g.h } : { x: Number(args.x), y: Number(args.y), w: Number(args.w), h: Number(args.h) };
    if (![rect.x, rect.y, rect.w, rect.h].every((v) => isFinite(v)) || rect.w <= 0 || rect.h <= 0) return deps.fail('screenshot_region: give a selector or x, y, w, h (w, h > 0).');
    if (rect.x + rect.w <= 0 || rect.y + rect.h <= 0 || rect.x >= g.vw || rect.y >= g.vh) {
      return deps.fail(`screenshot_region: the region (x=${Math.round(rect.x)}, y=${Math.round(rect.y)}) is outside the visible viewport ${g.vw}×${g.vh}. Scroll it into view first.`);
    }
    let shot;
    try {
      shot = await (deps.capture || ((rc, size, smooth) => capturePixels(st.tabId, rc, size, smooth)))(
        { x: rect.x + (Number(g.sx) || 0), y: rect.y + (Number(g.sy) || 0), w: rect.w, h: rect.h }, Math.min(256, Math.max(cols, rows) * 12), true);
    } catch (e) { return deps.fail(`screenshot_region: capture failed (${e.message}).`); }
    if (!shot || !shot.b64) return deps.fail('screenshot_region: capture failed (empty image).');
    const bin = atob(shot.b64), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const cells = SkriptRunner.gridColors(data, shot.w, shot.h, cols, rows, inset);
    const R = (v) => Math.round(v);
    const counts = new Map();
    for (const line of cells) for (const c of line) { const k = c.join(','); counts.set(k, (counts.get(k) || 0) + 1); }
    const lines = [
      `Region in viewport coordinates: x=${R(rect.x)}, y=${R(rect.y)}, w=${R(rect.w)}, h=${R(rect.h)} (page scrolled to ${R(g.sx)},${R(g.sy)}; viewport ${g.vw}×${g.vh}).`,
      `Average RGB of a ${cols}×${rows} grid (inner ${Math.round((1 - 2 * inset) * 100)}% of each cell), row by row:`,
      ...cells.map((line, r) => `row ${r}: ${line.map((c) => c.join(',')).join(' | ')}`),
      `Distinct colours: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ×${n}`).join('; ')}.`,
      `In a script: const r = <element>.getBoundingClientRect(); const g = await __crawler.grid(r.left, r.top, r.width, r.height, ${cols}, ${rows}); g.at(col, row) → [r, g, b]. ` +
      'Colours can differ slightly between captures: match them by nearest colour, not by exact equality.'
    ];
    return { text: lines.join('\n') };
  }

  // ключи localStorage с состоянием, найденные пробой страницы (панель): __crawler.saved читает только их
  const savedKeys = () => (deps.savedKeys ? deps.savedKeys() || [] : []);

  // «Работает» / «Не работает»: кнопки в карточке, когда скрипт уже показал себя (проработал VERDICT_MS и сделал ход).
  // «Работает» — задача заканчивается без модели, скрипт играет дальше сам (detached), отладчик на вкладке держится,
  // пока он не закончится; «Не работает» — скрипт останавливается, модель получает «не работает — улучши».
  const VERDICT_MS = 4000;
  let detached = null;                                             // { tabId } — скрипт, отпущенный после «Да»

  async function execute(d, args, st) {
    const grants = SkriptMode.grants || {};
    const perms = d.permissions.filter((p) => p !== 'input' || grants.act);
    let origin = '';
    try { origin = new URL(await deps.tabUrl(st.tabId)).origin; } catch (e) { /* служебная страница */ }
    // своя ссылка на карточку: по «Стоп» задача завершается сразу и обнуляет общую card (end), а раннер
    // дозакрывает карточку позже — через общую переменную карточка оставалась «работающей» навсегда
    const c = card, run = runner;
    c.running(() => run.stop('manual'));
    const signal = deps.signal();
    const onAbort = () => run.stop('aborted');
    if (signal) signal.addEventListener('abort', onAbort);
    const y0 = await pageScrollY(st.tabId);
    const reader = startGoalReader(st.tabId, d.goal);
    const item = { title: d.title, description: d.description, code: d.code, permissions: d.permissions.slice(), origin, goal: d.goal,
      markSaved: ((list) => (sid, code) => list && list.markSaved(d.id, sid, code))(drafts),   // свои черновики: к сохранению задача могла смениться
      savedId: d.savedId || null, version: d.version, changed: !!d.savedId && d.code !== d.adoptedCode };
    deps.onScript?.(true);                                           // скрипт работает — панель убирает щупальца со страницы
    const runP = run.run({ code: d.code, args: args || {}, approved: true, permissions: perms, expectedOrigin: origin, savedKeys: savedKeys() });
    // кнопки «Работает» / «Не работает» — когда показал себя; ответ человека или конец скрипта — что раньше
    const t0 = Date.now();
    let removeAsk = () => {}, timer = 0;
    const answer = new Promise((resolve) => {
      timer = setInterval(() => {
        if (!run.running) { clearInterval(timer); return; }
        if (Date.now() - t0 >= VERDICT_MS && run.actions > 0) { clearInterval(timer); removeAsk = c.verdict(() => resolve('yes'), () => resolve('no')); }
      }, 250);
    });
    const release = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    let first;
    try { first = await Promise.race([runP.then((s) => ({ s })), answer.then((a) => ({ a }))]); }
    catch (e) {
      // раннер отказал в запуске («Скрипт уже запущен» и т. п.): без этого оставались интервал,
      // кнопки ответа, чтение цели и флаг «скрипт работает» (щупальца не возвращались)
      clearInterval(timer); removeAsk(); release();
      reader.stop().catch(() => {});
      deps.onScript?.(false);
      c.finish('Не запущен: ' + String(e && e.message || e).slice(0, 160), false);
      return { text: `The script did not start: ${String(e && e.message || e).slice(0, 200)}` };
    }
    clearInterval(timer);
    removeAsk();

    if (first.a === 'yes') {
      // задача заканчивается, скрипт — нет: доигрывает сам, карточка у поля ввода управляет им
      release();
      detached = { tabId: st.tabId };
      const mine = detached;
      runP.then((s) => {
        reader.stop().catch(() => {});
        lastSummary = s;
        c.finish(`${SkriptRunner.REASONS[s.reason] || s.reason} · ${fmtTele(run)}`, finishState(s));
        offerAfter(item, c, st.tabId, s);
      }).catch(() => {}).finally(async () => {
        deps.onScript?.(false);
        if (detached === mine) detached = null;
        if (deps.release && !(deps.busy && deps.busy())) await deps.release();   // вне задачи отладчик не держим
      });
      return { text: 'The user confirmed the script works; it keeps running on its own. Task finished.', finished: true, success: true,
        summary: `Скрипт «${d.title}» работает и играет дальше сам — остановить можно в карточке у поля ввода.` };
    }
    if (first.a === 'no') run.stop('manual');
    let s;
    try { s = first.s || await runP; }
    finally { release(); deps.onScript?.(false); }
    const userNo = first.a === 'no'
      ? '\nThe user pressed "Не работает" (does not work): the script does not do what is needed. Improve it with patch_script (or ask the user what exactly is wrong); do not finish yet.' : '';
    if (s.reason === 'aborted' || (signal && signal.aborted)) {
      // задача остановлена: панель уже завершает её и отключает отладчик — замеры страницы не делаем,
      // карточку закрываем сразу («■ остановлен»), кнопки «Запустить снова»/«Сохранить» — на месте
      reader.stop().catch(() => {});
      lastSummary = s;
      c.finish(`${SkriptRunner.REASONS[s.reason] || s.reason} · ${fmtTele(run)}`, 'stopped');
      offerAfter(item, c, st.tabId, s);
      return { text: summaryText(s, d) };
    }
    const samples = await reader.stop();
    const y1 = await pageScrollY(st.tabId);
    lastSummary = s;
    const book = ledger || (ledger = SkriptEval.createLedger());
    const ev = book.record(d, s, samples, { scrolled: y0 !== null && y1 !== null && s.actions > 0 && Math.abs(y1 - y0) >= 100 });
    c.finish(`${first.a === 'no' ? 'Не работает (по вашему ответу)' : SkriptRunner.REASONS[s.reason] || s.reason} · ${fmtTele(run)} · ${SkriptEval.line(ev, book)}`,
      first.a === 'no' ? false : finishState(s, ev.reached));
    // Копия кода на момент запуска: последующие патчи модели её не меняют.
    offerAfter(item, c, st.tabId, s);
    return { text: summaryText(s, d) + scrollHint(y0, y1, s) + SkriptEval.text(ev, book) + userNo };
  }

  // Запуск по кнопке человека («Запустить снова», сохранённый скрипт): без модели, нажатие — одобрение.
  // item: { title, description, code, permissions, origin, savedId }. Не зависит от черновиков задачи.
  async function runByUser(item, c, tabId) {
    if (deps.busy && deps.busy()) { c.note('Сейчас выполняется задача: дождитесь её конца или остановите.'); return null; }
    let origin = '';
    try { origin = new URL(await deps.tabUrl(tabId)).origin; } catch (e) { /* служебная страница или вкладка закрыта */ }
    if (!origin || origin !== item.origin) { c.note(`Вкладка открыта не на ${item.origin || 'сайте скрипта'}: скрипт не запущен.`); return null; }
    const run = ensureRunner(tabId);
    if (run.running) await run.stop('manual');
    card = c; // живая телеметрия идёт в эту карточку
    c.running(() => run.stop('manual'));
    deps.onScript?.(true);
    let s;
    try { s = await run.run({ code: item.code, args: {}, approved: true, permissions: item.permissions, expectedOrigin: origin, savedKeys: savedKeys() }); }
    finally { deps.onScript?.(false); }
    lastSummary = s;
    c.finish(`${SkriptRunner.REASONS[s.reason] || s.reason} · ${fmtTele(run)}`, finishState(s));
    if (item.savedId && typeof SkriptStore !== 'undefined') SkriptStore.recordRun(item.savedId, s.ok).catch(() => {});
    if (deps.release && !(deps.busy && deps.busy())) await deps.release(); // вне задачи отладчик не держим
    offerAfter(item, c, tabId, s);
    return s;
  }

  async function saveItem(item, c, tabId) {
    if (!item.origin) { c.note('Скрипт запускался не на обычном сайте: сохранить его не для чего.'); return; }
    let r;
    try {
      r = await SkriptStore.save({
        ...(item.savedId ? { id: item.savedId } : {}),
        title: item.title, description: item.description || '',
        kind: /__crawler\s*\.\s*loop\b/.test(item.code) ? 'loop' : 'action',
        code: item.code, permissions: item.permissions, scope: { origin: item.origin }, author: 'model'
      });
    } catch (e) { c.note('Не сохранено: ' + e.message); return; }
    item.savedId = r.skill.id;
    if (item.markSaved) item.markSaved(r.skill.id, item.code);
    cards.set('saved:' + r.skill.id, c);   // запуск из библиотеки потом найдёт эту же карточку
    item.changed = false;   // библиотека теперь хранит этот код
    if (r.warning) c.note(r.warning);
    offerAfter(item, c, tabId);
    if (deps.onSaved) deps.onSaved();
  }

  function offerAfter(item, c, tabId, s) {
    c.offer({
      saved: !!item.savedId,
      update: !!(item.savedId && item.changed),
      onRerun: () => { runByUser(item, c, tabId).catch((e) => c.note('Не удалось запустить: ' + e.message)); },
      onSave: () => { saveItem(item, c, tabId); },
      // «Починить» — только после неудачи и когда есть кому чинить (панель передала repair).
      onRepair: s && !s.ok && deps.repair ? () => {
        if (deps.busy && deps.busy()) { c.note('Сейчас выполняется задача: дождитесь её конца или остановите.'); return; }
        deps.repair(prepareRepair(item, s));
      } : null
    });
  }

  // Готовит починку: скрипт станет черновиком d1 следующей задачи /skript. Возвращает текст для поля ввода.
  function prepareRepair(item, s) {
    const errs = (s.errors || []).map((e) => String(e).split('\n')[0]).slice(-3);
    pendingRepair = {
      item: { title: item.title, description: item.description, code: item.code, goal: item.goal || null, savedId: item.savedId || null, version: item.version || 1 },
      summary: { reason: s.reason, errors: errs, actions: s.actions, result: s.result }
    };
    const why = errs.length ? `: ${errs[0].slice(0, 160)}` : '';
    return `Почини скрипт «${item.title}» — последний запуск: ${SkriptRunner.REASONS[s.reason] || s.reason}${why}. `;
  }

  // Сохранённый скрипт из библиотеки: карточка в логе и сразу запуск на активной вкладке.
  // Возвращает null или текст, почему не запущено (для подсказки рядом с кнопкой).
  async function runSaved(id) {
    if (deps.busy && deps.busy()) return 'Сейчас выполняется задача: дождитесь её конца или остановите.';
    const rec = await SkriptStore.get(id);
    if (!rec) return 'Скрипт не найден.';
    if (rec.status === 'stale' || rec.status === 'untrusted') return 'Код скрипта изменён вне расширения: запуск запрещён.';
    const tabId = await deps.activeTabId();
    if (tabId === undefined || tabId === null) return 'Нет активной вкладки.';
    const c = showCard({ title: rec.title, version: rec.version || 1, permissions: rec.permissions, code: rec.code }, 'saved:' + rec.id);
    if (deps.reveal) deps.reveal();
    runByUser({ title: rec.title, description: rec.description, code: rec.code, permissions: rec.permissions.slice(), origin: rec.scope.origin, savedId: rec.id, version: rec.version || 1 }, c, tabId)
      .catch((e) => c.note('Не удалось запустить: ' + e.message));
    return null;
  }

  // Итог карточки: успех, остановка (человеком или задачей) или ошибка.
  const finishState = (s, reached) => (s.ok || reached ? true : s.reason === 'manual' || s.reason === 'aborted' ? 'stopped' : false);

  // Одна карточка на один скрипт за сеанс. Корень дубля «Запустить → Стоп → Запустить» (проверено):
  // runSaved (запуск из «Для этой страницы есть скрипты» и библиотеки) и rerun (run_script модели) каждый раз
  // создавали новую карточку, старая оставалась в логе. Теперь ключ — id сохранённого скрипта, для черновика —
  // хэш кода; повторный запуск переиспользует карточку (счётчик «×N»). Новый код — новая карточка,
  // прежняя версия того же черновика сворачивается в строку «vN → заменён vM».
  const cards = new Map();                                      // ключ → карточка
  const draftCards = new Map();                                 // id черновика → { card, version }
  const codeKey = (code) => { let h = 5381; for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0; return 'code:' + (h >>> 0).toString(36) + ':' + code.length; };
  function showCard(d, key) {
    const k = key || codeKey(d.code || '');
    const old = cards.get(k);
    if (old && old.root.isConnected !== false && !old.collapsed) { card = old; return card; }   // ещё в логе/доке — переиспользуем
    card = SkriptCard.create({ container: deps.container, title: d.title, version: d.version, permissions: d.permissions, code: d.code, goal: d.goal });
    cards.set(k, card);
    if (d.id) {
      const prev = draftCards.get(d.id);
      if (prev && prev.card !== card) prev.card.collapse(`${d.title} v${prev.version} → заменён v${d.version}`);
      draftCards.set(d.id, { card, version: d.version });
    }
    return card;
  }

  // «X is not defined» в пробном прогоне: модель обычно угадала глобальную переменную по похожему сайту.
  // Подсказка экономит ходы: как проверить, где искать состояние и чего скрипт не видит.
  function undefinedHint(errors) {
    const m = /\b([A-Za-z_$][\w$]*) is not defined\b/.exec(errors.join('\n'));
    if (!m) return '';
    return ` "${m[1]}" is not a global of this page (the script runs in the top frame's main world, so real page globals ARE visible). ` +
      `Do not assume globals from similar sites: check with typeof ${m[1]} !== 'undefined' (comparing an undeclared name throws), ` +
      `or list names via Object.keys(window) (names only: reading window[name] is blocked by the policy, so use a found name directly in the next script). If the state is hidden in the page's own closures, read the DOM or the canvas pixels instead. ` +
      `Content inside iframes is not reachable from the script.`;
  }

  // Холст, который страница сама не может прочитать (OffscreenCanvas в worker, «грязный» canvas с чужого домена,
  // WebGL без сохранения буфера). Живой прогон: 2048 на OffscreenCanvas — модель обходила это пробами через throw.
  function canvasHint(errors) {
    if (!/transferred its control to offscreen|tainted by cross-origin|getImageData|getContext/i.test(errors.join('\n'))) return '';
    return ' The page cannot read this canvas from inside (offscreen/cross-origin/WebGL). Read what is on screen instead: ' +
      'const img = await __crawler.pixels(r.left, r.top, r.width, r.height, { size: 64 }) with r = canvas.getBoundingClientRect(), ' +
      'then img.at(x, y) → [r, g, b] at viewport coordinates. Keep the canvas visible on screen.';
  }

  // write_script / patch_script: проверить → показать карточку → дождаться решения → запустить.
  async function propose(r, st) {
    if (!r.ok) return deps.fail(r.error);
    const d = drafts.get(r.id);
    const grants = SkriptMode.grants || {};
    if (d.permissions.includes('input') && !grants.act) {
      return deps.fail('This script presses keys or clicks, but the user switched the "Действовать" grant off. Write a read-only script or tell the user.');
    }
    const run = ensureRunner(st.tabId);
    if (run.running) await run.stop('manual');
    const syntax = await run.check(d.code);
    if (syntax.infra) return deps.fail(`Could not check the script in the page (${syntax.error}). This is a tool problem, not a problem with your code: retry once, then tell the user instead of abandoning scripts silently.`);
    if (!syntax.ok) return deps.fail(`Syntax error: ${syntax.error}. Fix it with patch_script.`);
    // Пробный прогон выполняет код на странице: делаем его только для кода без записи в DOM.
    if (!d.permissions.includes('dom-write')) {
      const dry = await run.run({ code: d.code, args: {}, dryRun: true, maxMs: 1200, permissions: ['read'], savedKeys: savedKeys() });
      if (dry.reason === 'bridge-unavailable') return deps.fail('Cannot reach the page to test the script (restricted page?). Tell the user.');
      if (!dry.ok || dry.errors.length) {
        const errs = dry.errors.length ? [...new Set(dry.errors)].slice(0, 3) : [dry.reason];   // одна ошибка в цикле — один раз, не четыре
        // пробный прогон без ввода: проверки «после хода что-то изменилось» в нём всегда падают — объяснить и не сдаваться
        const inputHint = /измен|change|move|ход|after|после/i.test(errs.join(' ')) ? ' The dry run sends NO input and the page does not change: skip checks like "the board changed after my move" while __crawler.dry is true.' : '';
        return deps.fail(`Dry run failed: ${errs.join('; ')}.${undefinedHint(errs)}${canvasHint(errs)}${inputHint} Fix it with patch_script and continue — one failed dry run is normal, do not finish the task.`);
      }
    }
    showCard(d);
    const asked = card;                                              // своя ссылка: по «Стоп» общая card обнуляется (end)
    // карточка ждёт «Запустить»: модель не думает — панель показывает ожидание человека (deps.onAsk)
    deps.onAsk?.(true);
    let decision;
    try { decision = await asked.ask(deps.signal()); } finally { deps.onAsk?.(false, decision); }
    if (decision === 'abort') { asked.finish('Остановлено', 'stopped'); return { text: 'Task stopped by the user.' }; }
    if (decision === 'reject') {
      asked.finish('Отклонено вами', false);
      return { text: 'The user rejected this script; nothing was run. Ask what to change, patch it, or finish with done.' };
    }
    drafts.approve(d.id);
    // Цель, поправленная человеком в карточке, — для этого и следующих запусков; модель об этом узнаёт.
    const changed = card.goal ? drafts.setGoal(d.id, card.goal() || {}) : null;
    const res = await execute(drafts.get(d.id), {}, st);
    if (!changed) return res;
    const f = (g) => `${g.better === 'lower' ? '≤' : '≥'} ${g.target === null ? 'none' : g.target}`;
    return { ...res, text: `The user changed the goal before running: ${d.goal.metric} ${f(changed.before)} → ${f(changed.after)}. Use the user's goal from now on. ` + res.text };
  }

  async function rerun(args, st) {
    const d = drafts.get(args.id);
    if (!d) return deps.fail('No such script: call write_script first.');
    if (!d.approved) return propose({ ok: true, id: d.id }, st);
    const grants = SkriptMode.grants || {};
    if (d.permissions.includes('input') && !grants.act) return deps.fail('The "Действовать" grant is off: this script cannot press keys.');
    const run = ensureRunner(st.tabId);
    if (run.running) await run.stop('manual');
    showCard(d);
    return execute(d, args.args, st);
  }

  async function handle(name, args, st) {
    if (!drafts) return deps.fail('Scripts are not available.');
    switch (name) {
      case 'write_script': return propose(drafts.write(args), st);
      case 'patch_script': return propose(drafts.patch({ id: args.id, code: args.code, reason: args.reason }), st);
      case 'run_script': return rerun(args || {}, st);
      case 'screenshot_region': return lookAt(args || {}, st);
      case 'stop_script': {
        if (runner && runner.running) await runner.stop('manual');
        return { text: lastSummary ? JSON.stringify(lastSummary) : 'No script is running.' };
      }
      case 'get_telemetry': return { text: runner && runner.running ? JSON.stringify(runner.summary()) : (lastSummary ? JSON.stringify(lastSummary) : 'No run yet.') };
      default: return deps.fail('Unknown script tool.');
    }
  }

  function init(d) {
    deps = d;
    chrome.debugger.onEvent.addListener((src, method, params) => {
      if (method === 'Runtime.bindingCalled' && params && params.name === SkriptRunner.BINDING && runner && runner.tabId === src.tabId) {
        runner._onBinding(params.payload).catch(() => {});
      }
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.url && runner && runner.running && runner.tabId === tabId) runner.checkOrigin(info.url);
    });
    chrome.tabs.onRemoved.addListener((tabId) => { if (runner && runner.running && runner.tabId === tabId) runner.stop('tab-closed'); });
    window.addEventListener('beforeunload', () => { if (runner && runner.running) runner.stop('panel-closed'); });
  }

  return {
    init,
    TOOL_NAMES,
    tools: () => SkriptTools.build(TOOL_NAMES),
    begin() {
      // новая задача /skript: отпущенный после «Работает» скрипт останавливается — иначе два скрипта на одной вкладке
      if (detached && runner && runner.running) runner.stop('manual');
      drafts = SkriptTools.createDrafts(); ledger = SkriptEval.createLedger(); lastSummary = null; card = null; repairNote = '';
      // Нажали «Починить»: скрипт сразу черновик d1, модель видит его код и последнюю ошибку (promptAddon).
      if (pendingRepair) {
        const { item, summary } = pendingRepair;
        pendingRepair = null;
        const r = drafts.adopt(item);
        if (r.ok) {
          repairNote = `\n\nREPAIR: the user asks to fix the script "${item.title}"${item.savedId ? ' saved in the site library' : ''}. ` +
            `It is already loaded as draft ${r.id} (v${r.version}): change it with patch_script id "${r.id}" (full fixed code), do not write a new script. ` +
            `Last run: ${JSON.stringify(summary)}. Current code:\n${item.code.slice(0, 6000)}` +
            (item.savedId ? '\nAfter a successful run the user can update the library copy with one button.' : '');
        }
      }
    },
    promptAddon: () => repairNote,
    prepareRepair,
    async end() {
      if (runner && runner.running && !detached) await runner.stop('aborted');   // отпущенный после «Да» — играет дальше
      // на всякий случай: карточка, оставшаяся «работающей» (таймер, кнопка стопа, анимация мозга), — закрыть
      if (!detached && card && card.root && card.root.dataset.state === 'running') card.finish('Остановлено вместе с задачей', 'stopped');   // отпущенный — не трогаем
      drafts = null; ledger = null; card = null; repairNote = '';
    },
    // «Новый запуск»: лог очищен — карточек больше нет, реестр пуст.
    resetCards() { cards.clear(); draftCards.clear(); card = null; },
    // за эту задачу хоть один запуск скрипта делал ходы (не пробный прогон и не «только чтение»)
    acted() { return !!(lastSummary && lastSummary.actions > 0); },
    // вкладка, где играет отпущенный скрипт: панель не отключает на ней отладчик в конце задачи
    keepTab() { return detached && runner && runner.running ? detached.tabId : null; },
    handle,
    runSaved
  };
})();
