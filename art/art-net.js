// Центральный рисунок «звёздная сеть»: 3D-граф из точек на экранной сетке (кружки), медленно вращается.
// Узлы-сгустки на концах лучей, пунктирные связи, плотное ядро; узлы «дышат», по связям бегут импульсы,
// при появлении сеть прорисовывается: от крайнего правого узла линии растут точка за точкой к соседним вершинам;
// Вершины «набираются» по пикселю, когда до них доходит линия. Пока сеть рисуется — она неподвижна и чуть ближе;
// дорисовалась — камера мягко отъезжает, сеть начинает вращаться и вместе с этим зажигается звёздное небо. Цвет — акцент панели (--acc), ближнее светлее, дальнее гаснет.
// Тот же интерфейс, что у прежнего art.js (window.CrawlerArt: init, play, redraw, flow) — вернуть старый рисунок
// можно заменой одного <script> в sidepanel.html.
// Реакции на панель (сама смотрит на body[data-state] и карточку скрипта, код панели не нужен):
// думает — по сети бегут искры от синапса к синапсу (вершины вспыхивают цепочкой), ядро «дышит»; действует — импульсы наружу, быстрее; скрипт — ровный ритм,
// вершины мигают по кругу; ждёт подтверждения — почти замирает, жёлтый оттенок; ошибка — красный отлив;
// переключатели главного экрана — короткий «тик».
// Отправили сообщение — сеть «подключается» к его пузырю линиями из ближайших вершин и «выкачивает» данные
// пакетами по линиям в сеть, затем отключается — и из принявших вершин разбегаются искры «думает».
// Пока модель работает, к новым строкам лога (действия, ошибки, карточки скриптов) сеть на миг цепляется одним щупальцем.
// Взаимодействие с пользователем: печатаете — от поля ввода к сети бегут искры («слушает»), «/» — настроение скрипта;
// клик по пустому экрану — пульс: волна по сети от ядра; зажать ЛКМ — сеть хватает курсор нитями; минуту без
// действий — засыпает (тускнеет, медленно дышит), просыпается от курсора/клавиш; ждёт подтверждения — тянется к
// кнопкам; прогресс задачи — доля подсвеченных вершин; react(kind) — реакции панели: approve (зелёная вспышка),
// deny/bad/error (вздрагивает), good (тёплая волна), stop (сжимается и замирает), tab (осматривается),
// accept/accepted («Действовать»: тик; фраза втянулась — подрастает, оранжевый пульс); say(text) — фраза точками
// под мозгом: вылетает из ядра и втягивается обратно; send/take(x, y) — сгусток из мозга к точке и обратно;
// suck(n, hold)/unsuck() — пучок щупалец к краю (к странице): разово или пока модель работает.
(() => {
  let CELL = 2.5;                   // шаг экранной сетки, CSS px (меньше — выше разрешение); setCell — для видео/демо
  let demo = false;                 // демо (видео): «работает» — быстрее вращение и искры, без приглушения
  const ASSEMBLE_MS = 1700;       // прорисовка сети при появлении
  const SPIN = 0.16;              // рад/с вокруг вертикали
  const FPS_IDLE = 60, FPS_BEHIND = 60;   // WebGL дешёвый — 60 и за логом (2D-запас сам по себе медленнее)

  let canvas = null, ctx = null, raf = 0, last = 0, startAt = 0, angle = 0.6, colorAt = 0, accent = '#7c8cff', ink = '#e8e9ee';
  let stars = [];
  const NODE_GROW_MS = 450;       // вершина набирается по пикселю за это время
  const ALIVE_S = 1.1;            // фаза «оживания»: отъезд камеры, разгон и небо — вместе
  const ALIVE_LEAD_MS = 300;      // оживание начинается за столько мс до конца прорисовки (заступает на последние линии)
  const KICK = 10, KICK_TAU = 0.28, KICK_DELAY = -0.04;  // подкрутка: резкий толчок (пик через KICK_TAU с), ~1,2 рад сверху;
                                                         // KICK_DELAY < 0 — стартует чуть раньше начала уменьшения
  const ZOOM_IN = 0.3;            // насколько ближе камера во время прорисовки

  const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  // 0 во время прорисовки → 1 после разгона: «чертёж» оживает
  // секунды с начала оживания (<0 — ещё только рисуется)
  const aliveT = (now) => (now - startAt - (ASSEMBLE_MS - ALIVE_LEAD_MS)) / 1000;
  const liveAt = (now) => (reduce() ? 1 : smooth(aliveT(now) / ALIVE_S));
  let model = null;

  // Настроение: цель по состоянию панели, текущее значение плавно догоняет цель.
  //   spin — множитель вращения; pulse — скорость импульсов; heads — импульсов на связи; dir — 1 наружу, −1 к ядру;
  //   core — свечение и яркость ядра; blink — вершины мигают по кругу; tint/tintColor — оттенок (предупреждение, ошибка).
  const MOODS = {
    idle:     { spin: 1,   pulse: 0.35, heads: 1, dir: 1,  core: 1,   blink: 0, tint: 0, walk: 0 },
    thinking: { spin: 0.5, pulse: 0.25, heads: 1, dir: -1, core: 1.9, blink: 0, tint: 0, walk: 1 },
    working:  { spin: 1.8, pulse: 0.5,  heads: 1, dir: 1,  core: 1.2, blink: 0, tint: 0, walk: 1 },
    script:   { spin: 1.3, pulse: 0.6,  heads: 1, dir: 1,  core: 1.3, blink: 0, tint: 0, walk: 1 },
    awaiting: { spin: 0.15, pulse: 0.15, heads: 1, dir: 1, core: 1.4, blink: 0, tint: 0.55, tintVar: '--warn', walk: 0 },
    error:    { spin: 0.6, pulse: 0.2,  heads: 1, dir: 1,  core: 0.8, blink: 0, tint: 0.6, tintVar: '--critical', walk: 0 },
    absorbing: { spin: 0.7, pulse: 0.2, heads: 1, dir: -1, core: 1.6, blink: 0, tint: 0, walk: 0 },
    listening: { spin: 0.55, pulse: 0.3, heads: 1, dir: -1, core: 1.45, blink: 0, tint: 0, walk: 0 },   // печатаете — внимательно затихает
    commanding: { spin: 1.1, pulse: 0.5, heads: 1, dir: 1, core: 1.3, blink: 0.8, tint: 0, walk: 0 }    // «/» в поле — настрой скрипта
  };
  const mood = { spin: 1, pulse: 0.35, heads: 1, dir: 1, core: 1, blink: 0, tint: 0, walk: 0, tintColor: '#f5a524' };

  // Искры: бегут по графу от вершины к вершине; пришла — вершина вспыхивает, искра идёт к случайному соседу (не назад).
  // Пока модель работает (задача идёт): думает — 28 быстрых искр, действует — 22; работает скрипт — 30 коротких искр-цепочек; без задачи (только «думает») — 4 спокойных.
  const SPARKS = { thinking: [28, 3.4], working: [22, 3.0], script: [24, 3.8], calm: [4, 1.9] };   // [сколько, скорость — длин связи в секунду]
  let WALKERS = 4, WALK_SPEED = 1.9;
  let walkers = [];
  const edgeWalk = new Map();                                    // связь → [позиции искр 0..1 от e.a к e.b]
  // Скрипт: искры — короткие цепочки пикселей; голова выбирает путь, остальные пиксели идут точно по её следу.
  // Искра = один объект (не один пиксель).
  const SCRIPT_SPARKS = 30, SPARK_PIXELS = 3, PIXEL_GAP = 0.07, SPARK_SPEED = 3.8;   // шаг и скорость — в длинах связей
  let sparks = [];
  function stepSparks(dt) {
    while (sparks.length < SCRIPT_SPARKS) {
      const n = Math.floor(Math.random() * model.nodes.length);
      if (!model.adj[n].length) continue;
      const o = model.adj[n][Math.floor(Math.random() * model.adj[n].length)];
      sparks.push({ s: Math.random() * 0.3, path: [{ e: o.e, from: n, to: o.to, start: 0, len: o.len }] });
    }
    for (const tr of sparks) {
      tr.s += dt * SPARK_SPEED;
      let last = tr.path[tr.path.length - 1];
      while (tr.s > last.start + last.len) {                         // голова дошла до вершины — следующий отрезок пути
        const opts = model.adj[last.to].filter((o) => o.to !== last.from);
        const pool = opts.length ? opts : model.adj[last.to];
        const o = pool[Math.floor(Math.random() * pool.length)];
        last = { e: o.e, from: last.to, to: o.to, start: last.start + last.len, len: o.len };
        tr.path.push(last);
      }
      const tail = tr.s - SPARK_PIXELS * PIXEL_GAP;
      while (tr.path.length > 1 && tr.path[0].start + tr.path[0].len < tail) tr.path.shift();   // след позади хвоста не нужен
      for (let k = 0; k < SPARK_PIXELS; k++) {
        const ps = tr.s - k * PIXEL_GAP;
        if (ps < 0) break;
        const seg = tr.path.find((g) => ps >= g.start && ps <= g.start + g.len);
        if (!seg) continue;
        const t = (ps - seg.start) / seg.len;
        const pos = seg.e.a === seg.from ? t : 1 - t;
        if (!edgeWalk.has(seg.e)) edgeWalk.set(seg.e, []);
        edgeWalk.get(seg.e).push({ pos, dir: seg.e.a === seg.from ? 1 : -1, short: true });
      }
    }
  }

  function stepWalkers(dt, now) {
    edgeWalk.clear();
    if (mood.walk < 0.3 || !model) { walkers = []; sparks = []; return; }
    if (scriptOn) { walkers = []; stepSparks(dt); return; }        // скрипт — короткие искры-цепочки, без вспышек вершин
    sparks = [];
    const running = demo || (document.body && document.body.classList.contains('running'));
    const st = demo ? 'working' : document.body ? document.body.dataset.state : '';
    [WALKERS, WALK_SPEED] = scriptOn ? SPARKS.script : running ? (st === 'working' ? SPARKS.working : SPARKS.thinking) : SPARKS.calm;
    if (walkers.length > WALKERS) walkers.length = WALKERS;
    while (walkers.length < WALKERS) {
      const n = spawnFrom.length ? spawnFrom[walkers.length % spawnFrom.length] : Math.floor(Math.random() * model.nodes.length);
      const opts = model.adj[n];
      if (!opts.length) continue;
      const o = opts[Math.floor(Math.random() * opts.length)];
      walkers.push({ from: n, to: o.to, e: o.e, len: o.len, t: spawnFrom.length ? 0 : Math.random() * 0.5 });
      if (spawnFrom.length) model.nodes[n].fireAt = now;            // принявшая вершина «выстреливает» искру
    }
    spawnFrom = [];
    for (const w of walkers) {
      w.t += dt * WALK_SPEED / Math.max(0.15, w.len);
      if (w.t >= 1) {
        model.nodes[w.to].fireAt = now;                          // синапс сработал
        const opts = model.adj[w.to].filter((o) => o.to !== w.from);
        const o = (opts.length ? opts : model.adj[w.to])[Math.floor(Math.random() * (opts.length || model.adj[w.to].length))];
        w.from = w.to; w.to = o.to; w.e = o.e; w.len = o.len; w.t = 0;
      }
      const pos = w.e.a === w.from ? w.t : 1 - w.t;            // позиция вдоль связи от e.a к e.b
      if (!edgeWalk.has(w.e)) edgeWalk.set(w.e, []);
      edgeWalk.get(w.e).push({ pos, dir: w.e.a === w.from ? 1 : -1 });
    }
  }
  let pulseClock = 0, blinkClock = 0, moodName = 'idle', moodAt = 0, errorAt = -1e9, scriptCheckAt = 0, scriptOn = false;
  let pokeAt = -1e9, pokeSeed = 0;

  // ---- Реакции на пользователя ----
  // волны: фронт идёт от ядра наружу, вершины и точки на фронте вспыхивают
  const WAVE_MS = 1100;
  let waves = [];
  // цветная вспышка всей сети (одобрил — зелёная, хорошо — тёплая, ошибка — красная); перекрывает оттенок настроения
  let flash = null;                                              // { start, dur, color }
  // вздрог/сжатие: сеть на миг уменьшается (amt), вращение замирает (freeze)
  let squeeze = null;                                            // { start, dur, amt, freeze }
  // «слушает»: искры от поля ввода к нижним вершинам
  const LISTEN_MS = 420;
  let listens = [], typedAt = -1e9, lastListenAt = 0;
  // сон: минута без действий и без задачи
  const SLEEP_AFTER = 60000;
  let activeAt = performance.now(), sleep = 0;
  // ждёт подтверждения: щупальца к кнопкам вопроса
  let askLinks = null;
  // Хватает курсор: зажали ЛКМ на пустом поле дольше GRAB_DELAY — от трёх ближайших вершин к курсору тянутся нити,
  // сеть чуть тянется следом; отпустили — нити втягиваются, короткая волна. Короткий клик — по-прежнему пульс.
  const GRAB_DELAY = 180, GRAB_GROW = 220, GRAB_RELEASE = 320;
  let grab = null, lean = { x: 0, y: 0 }, grabbedClick = false;
  // щупальца на страницу (tentacles.js): пучок из ядра к левому краю холста — за ним вкладка, там щупальца продолжаются.
  // Фазы как на странице: выход → выкачивание (сгустки бегут с края в ядро) → втягивание.
  const OUT_REACH = 320, OUT_SUCK = 1700, OUT_RETRACT = 420, OUT_STAGGER = 130;
  let outs = null;                                               // { start, n, hold, releaseAt } — hold: держится, пока не unsuck()
  // Фраза из точек («Действовать»): по символу — точки символа вылетают из ядра и встают на место (как печать),
  // фраза стоит, все точки разом втягиваются обратно; когда вернулись — оранжевый пульс.
  const SAY_OUT = 480, SAY_CHAR = 45, SAY_HOLD = 2000, SAY_IN = 460, SAY_JITTER = 90;
  const SAY_IN_MAX = SAY_IN + SAY_JITTER;
  let say = null;                                                // { start, dots: [{ x, y, d0, d1, arc }] } — x, y в CSS px холста
  function wave(strength = 1) { waves.push({ start: performance.now(), str: strength }); if (waves.length > 4) waves.shift(); }
  function flashColor(color, dur = 900) { flash = { start: performance.now(), dur, color }; }
  function shrink(amt, dur, freeze = 0) { squeeze = { start: performance.now(), dur, amt, freeze }; }
  const cssColor = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;

  // Подключение к отправленному сообщению: фазы по доле времени — прорастание линий, выкачивание пакетов, отключение.
  const ABSORB_MS = 2200, GROW_F = 0.22, PULL_F = 0.82;
  let absorb = null, lastAbsorbText = '', lastAbsorbAt = -1e9;

  // Щупальца: короткая прицепка к новой строке лога — линия от ближайшей вершины, один пакет, втягивание.
  const TAP_MS = 900, TAPS_MAX = 4;
  const TAP_KINDS = ['action', 'done', 'err', 'skript-card'];   // к размышлениям и ответу не цепляемся
  let taps = [];
  let thinkUntil = -1e9, spawnFrom = [];
  let dim = 1;                                                   // приглушение фона рисунка (1 — без приглушения)
  let halos = [];                                                // ореолы искр и сработавших синапсов: [x, y, размер, сила]                         // после отключения: «думает» минимум столько, искры — из принявших вершин
  // Видимый пузырь вашего сообщения с этим текстом (лог «Действия» или чат — что сейчас на экране).
  function visibleMsg(kind, text) {
    const all = document.querySelectorAll(`#log .msg.${kind}, #chatLog .msg.${kind}`);
    for (let i = all.length - 1; i >= 0; i--) if (all[i].offsetParent && all[i].textContent === text) return all[i];
    return null;
  }
  function onMessages(muts) {
    // Панель за один такт добавляет сообщение в лог и перерисовывает историю чата (скрытую) — берём видимое.
    let found = null, any = null;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || !n.classList.contains('msg') || !n.classList.contains('user')) continue;
      any = n;
      if (n.offsetParent) found = n;
    }
    if (reduce()) return;
    // щупальца — только к строкам, добавленным прямо в лог (перенос в свёрнутые группы — не новая строка)
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || !n.parentElement || (n.parentElement.id !== 'log' && n.parentElement.id !== 'chatLog')) continue;
      if (!TAP_KINDS.some((k) => n.classList.contains(k)) || !n.offsetParent) continue;
      taps.push({ el: n, start: performance.now(), node: -1 });
      if (taps.length > TAPS_MAX) taps.shift();
    }
    found = found || any;
    if (!found) return;
    const now = performance.now(), text = found.textContent;
    // тот же текст ещё раз (перерисовка истории) — подключаемся один раз
    if (text === lastAbsorbText && now - lastAbsorbAt < 3000) { if (found.offsetParent && absorb && !absorb.el.offsetParent) absorb.el = found; return; }
    lastAbsorbText = text; lastAbsorbAt = now;
    absorb = { el: found, kind: 'user', text, start: now, links: null };
  }

  function currentMood(now) {
    if (now - scriptCheckAt > 400) { scriptOn = !!document.querySelector('.skript-card[data-state="running"]'); scriptCheckAt = now; }
    const st = document.body ? document.body.dataset.state : 'idle';
    const running = document.body && document.body.classList.contains('running');
    if (demo) return MOODS.working;                                  // демо: бодрое вращение и искры
    if (absorb) return MOODS.absorbing;                              // выкачивание — без искр, чтобы эффекты не смешивались
    if (now < thinkUntil && running && st !== 'awaiting_confirmation' && st !== 'error') return MOODS.thinking;
    if (st === 'error' && moodName !== 'error') { errorAt = now; react('error'); }
    moodName = st || 'idle';
    if (st === 'awaiting_confirmation') return MOODS.awaiting;
    if (st === 'error') return now - errorAt < 1500 ? MOODS.error : MOODS.idle;   // красный отлив гаснет
    if (scriptOn) return MOODS.script;
    if (st === 'thinking') return MOODS.thinking;
    if (st === 'working') return MOODS.working;
    if (!running) {
      const ta = document.getElementById('task');
      if (ta && /^\s*\//.test(ta.value)) return MOODS.commanding;
      if (now - typedAt < 1400) return MOODS.listening;
    }
    return MOODS.idle;
  }

  function updateMood(now, dt) {
    const t = currentMood(now);
    const k = Math.min(1, dt * 3);                                 // ~0,3 с на переход, без рывков
    for (const key of ['spin', 'pulse', 'core', 'blink', 'tint', 'walk']) mood[key] += (t[key] - mood[key]) * k;
    mood.heads = t.heads; mood.dir = t.dir;
    if (t.tintVar) mood.tintColor = getComputedStyle(document.documentElement).getPropertyValue(t.tintVar).trim() || mood.tintColor;
    pulseClock += dt * mood.pulse;
    if (!reduce()) stepWalkers(dt, now);
    blinkClock += dt * 0.9;
  }

  // Переключатели главного экрана — короткий «тик»: подкрут и вспышка нескольких вершин.
  const POKE = '#observeSeg button, .seg.effort button, #riskSeg button, .view-tabs button';
  function onPoke(e) { if (e.target.closest && e.target.closest(POKE)) { pokeAt = performance.now(); pokeSeed++; } }
  // меньше движения: системная настройка или «Анимации: Выкл» в панели (data-motion="off")
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';

  // Детерминированный генератор: форма сети одна и та же при каждом открытии.
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function build() {
    const rand = rng(20261016);
    const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
    const nodes = [];
    // внешние узлы — на «рваной» сфере, внутренние — ближе к центру
    const OUTER = 26, INNER = 10;
    for (let i = 0; i < OUTER; i++) {
      const u = rand() * 2 - 1, phi = rand() * Math.PI * 2, r = 0.72 + rand() * 0.34, s = Math.sqrt(1 - u * u);
      nodes.push({ x: s * Math.cos(phi) * r, y: u * r * 0.86, z: s * Math.sin(phi) * r, size: 1 + rand() * 0.9, beat: rand() * 6.28 });
    }
    for (let i = 0; i < INNER; i++) {
      nodes.push({ x: gauss() * 0.36, y: gauss() * 0.32, z: gauss() * 0.36, size: 0.8 + rand() * 0.7, beat: rand() * 6.28 });
    }
    nodes.push({ x: 0, y: 0, z: 0, size: 1.8, beat: 0 });   // центр
    const hub = nodes.length - 1;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const edges = new Map();
    const link = (a, b, dotted) => { if (a !== b) edges.set(a < b ? `${a}-${b}` : `${b}-${a}`, { a: Math.min(a, b), b: Math.max(a, b), dotted, phase: rand() }); };
    nodes.forEach((n, i) => {
      if (i === hub) return;
      const near = nodes.map((m, j) => ({ j, d: dist(n, m) })).filter((x) => x.j !== i).sort((p, q) => p.d - q.d);
      link(i, near[0].j, false);
      link(i, near[1].j, rand() < 0.5);
      if (i < OUTER && rand() < 0.75) link(i, rand() < 0.45 ? hub : OUTER + Math.floor(rand() * INNER), rand() < 0.35);   // лучи к ядру
    });
    for (let k = 0; k < 10; k++) link(Math.floor(rand() * OUTER), Math.floor(rand() * OUTER), true);  // длинные «хорды» паутины

    // точки: вдоль связей (со случайным разбросом), облако ядра, «пыль»
    const pts = [];
    for (const e of edges.values()) {
      const A = nodes[e.a], B = nodes[e.b], len = dist(A, B), steps = Math.max(14, Math.round(len * 130));
      for (let s = 0; s <= steps; s++) {
        if (e.dotted && s % 3 === 1) continue;           // пунктир — реже пропуски, линия читается
        if (rand() < 0.03) continue;
        const t = s / steps;
        pts.push({ edge: e, t, x: A.x + (B.x - A.x) * t + gauss() * 0.006, y: A.y + (B.y - A.y) * t + gauss() * 0.006, z: A.z + (B.z - A.z) * t + gauss() * 0.006, w: e.dotted ? 0.95 : 1.1 });
      }
    }
    for (let k = 0; k < 1200; k++) {
      const r = Math.pow(rand(), 1.7) * 0.32;   // ядро компактнее — не забивает центр
      const u = rand() * 2 - 1, phi = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pts.push({ core: true, x: s * Math.cos(phi) * r, y: u * r, z: s * Math.sin(phi) * r, w: 0.8, j: rand() * 6.28 });
    }
    for (let k = 0; k < 160; k++) pts.push({ dust: true, x: gauss() * 0.9, y: gauss() * 0.75, z: gauss() * 0.9, w: 0.35 });
    for (const p of pts) p.r = Math.hypot(p.x, p.y, p.z);           // расстояние от ядра — для волн
    // откуда точки «прилетают» при сборке
    // Прорисовка: кратчайшие пути по графу от крайнего правого узла. Узел загорается, когда до него дошла линия;
    // точка связи появляется, когда «перо» проходит её место (от узла, до которого линия дошла раньше).
    const E = [...edges.values()].map((e) => ({ e, len: dist(nodes[e.a], nodes[e.b]) }));
    const T = nodes.map(() => Infinity);
    const start = nodes.reduce((best, n, i) => (n.x > nodes[best].x ? i : best), 0);
    T[start] = 0;
    const done = new Set();
    for (let it = 0; it < nodes.length; it++) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!done.has(i) && T[i] < Infinity && (u < 0 || T[i] < T[u])) u = i;
      if (u < 0) break;
      done.add(u);
      for (const { e, len } of E) {
        const v = e.a === u ? e.b : e.b === u ? e.a : -1;
        if (v >= 0 && T[u] + len < T[v]) T[v] = T[u] + len;
      }
    }
    let maxT = 0;
    for (const t of T) if (t < Infinity && t > maxT) maxT = t;
    T.forEach((t, i) => { if (t === Infinity) T[i] = maxT; });
    const lenOf = new Map(E.map(({ e, len }) => [e, len]));
    for (const p of pts) {
      if (p.edge) {
        const e = p.edge, len = lenOf.get(e);
        p.at = T[e.a] <= T[e.b] ? T[e.a] + p.t * len : T[e.b] + (1 - p.t) * len;
      } else if (p.core) {
        p.at = T[hub] + Math.hypot(p.x, p.y, p.z) * 1.4;
      } else {
        p.at = maxT * (0.75 + rand() * 0.35);
      }
    }
    let end = 0;
    for (const p of pts) if (p.at > end) end = p.at;
    for (const p of pts) p.appear = p.at / end * 0.94;
    nodes.forEach((n, i) => { n.appear = T[i] / end * 0.94; });

    // Ориентация связей «от ядра наружу» (по кратчайшим путям от центра) — для направления импульсов.
    const H = nodes.map(() => Infinity);
    H[hub] = 0;
    const doneH = new Set();
    for (let it = 0; it < nodes.length; it++) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!doneH.has(i) && H[i] < Infinity && (u < 0 || H[i] < H[u])) u = i;
      if (u < 0) break;
      doneH.add(u);
      for (const { e, len } of E) {
        const v = e.a === u ? e.b : e.b === u ? e.a : -1;
        if (v >= 0 && H[u] + len < H[v]) H[v] = H[u] + len;
      }
    }
    for (const { e } of E) e.out = (H[e.a] === Infinity ? 0 : H[e.a]) <= (H[e.b] === Infinity ? 0 : H[e.b]);   // true — от a к b наружу
    // смежность — для искр «думает»
    const adj = nodes.map(() => []);
    for (const { e, len } of E) { adj[e.a].push({ to: e.b, e, len }); adj[e.b].push({ to: e.a, e, len }); }
    // порядок вершин по углу вокруг центра — для «мигания по кругу»
    nodes.forEach((n, i) => { n.order = (Math.atan2(n.z, n.x) / (Math.PI * 2) + 1) % 1; n.idx = i; n.r = Math.hypot(n.x, n.y, n.z); });
    // порядок «прогресса»: по кругу от верха — доля задачи = доля подсвеченных вершин
    nodes.map((n, i) => i).sort((a, b) => nodes[a].order - nodes[b].order).forEach((i, k) => { nodes[i].prog = k / nodes.length; });

    return { nodes, edges: [...edges.values()], pts, adj };
  }

  function readColor() {
    const cs = getComputedStyle(document.documentElement);
    accent = cs.getPropertyValue('--acc').trim() || accent;
    ink = cs.getPropertyValue('--txt').trim() || ink;        // звёзды — цветом текста: видны и в светлой теме
  }

  // Звёзды фона: доли ширины/высоты, мерцание у каждой своё; крупные — с четырёхлучевым бликом.
  function buildStars() {
    const rand = rng(777);
    stars = Array.from({ length: 160 }, () => ({
      x: rand(), y: rand(), r: 0.5 + Math.pow(rand(), 2.4) * 1.5, tw: 0.6 + rand() * 1.8, ph: rand() * 6.28,
      base: 0.25 + rand() * 0.5, tint: rand() < 0.18, appear: rand() * 0.9
    }));
    for (const st of stars.filter((x) => x.r > 1.3).slice(0, 11)) st.spark = true;
  }

  function drawStars(w, h, dpr, time, now, cx, cy) {
    const since = reduce() ? 99 : aliveT(now);                            // с начала оживания
    if (since <= 0) return;

    const [ir, ig, ib] = rgbOf(ink), [ar, ag, ab] = rgbOf(accent);
    const drift = angle * 0.012;                                   // чуть смещаются вслед за вращением — глубина
    const IR = ir / 255, IG = ig / 255, IB = ib / 255, AR = ar / 255, AG = ag / 255, AB = ab / 255;
    for (const st of stars) {
      const vis = smooth((since - st.appear * 0.2) / (ALIVE_S * 0.8));         // вместе с оживанием, с лёгким разбросом
      if (vis <= 0) continue;
      const a = vis * st.base * (0.55 + 0.45 * Math.sin(time * st.tw + st.ph)) * dim * (1 - fadeK);
      if (a <= 0.02) continue;
      const x = ((st.x - drift) % 1 + 1) % 1 * w, y = st.y * h, r = st.r * dpr;
      if (st.tint) emit(x, y, r * 2, AR, AG, AB, a, 0); else emit(x, y, r * 2, IR, IG, IB, a, 0);
      if (st.spark) { if (st.tint) emit(x, y, r * 11, AR, AG, AB, a * 0.55, 1); else emit(x, y, r * 11, IR, IG, IB, a * 0.55, 1); }   // блик-крестик
    }
  }

  // «#rrggbb» / «rgb(...)» → [r, g, b] (с кешем: цвет переспрашивается каждый кадр)
  const rgbCache = new Map();
  function rgbOf(c) {
    const hit = rgbCache.get(c);
    if (hit) return hit;
    const v = rgbParse(c);
    if (rgbCache.size > 64) rgbCache.clear();
    rgbCache.set(c, v);
    return v;
  }
  function rgbParse(c) {
    const ctx2 = rgbOf.ctx || (rgbOf.ctx = new OffscreenCanvas(1, 1).getContext('2d'));
    ctx2.fillStyle = '#000'; ctx2.fillStyle = c;
    const v = ctx2.fillStyle;
    if (v[0] === '#') return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
    const m = v.match(/[\d.]+/g) || [124, 140, 255];
    return [+m[0], +m[1], +m[2]];
  }

  let cssW = 0, cssH = 0;                                       // размер холста — из ResizeObserver, не перемеряем каждый кадр
  function layout() {
    if (!cssW) { const b = canvas.getBoundingClientRect(); cssW = b.width; cssH = b.height; }
    const r = { width: cssW, height: cssH };
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { w, h, dpr };
  }

  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const G = { v: null, d: null, used: null, n: 0, gw: 0 };

  // ---- Вывод. Каждая точка/звезда — экземпляр (x, y, размер, r, g, b, a, форма) в общем буфере;
  // кадр уходит на видеокарту одним вызовом (WebGL2: круг и крестик-блик рисует шейдер).
  // Без WebGL2 тот же буфер выводится через 2D (штампы). Свечение за ядром — CSS-фон холста.
  const STRIDE = 8;
  let inst = new Float32Array(STRIDE * 8192), instN = 0;
  function emit(x, y, size, r, g, b, a, shape) {
    if ((instN + 1) * STRIDE > inst.length) { const n = new Float32Array(inst.length * 2); n.set(inst); inst = n; }
    const o = instN++ * STRIDE;
    inst[o] = x; inst[o + 1] = y; inst[o + 2] = size; inst[o + 3] = r; inst[o + 4] = g; inst[o + 5] = b; inst[o + 6] = a; inst[o + 7] = shape;
  }

  let gl = null, glU = null, glBuf = null;
  function initGL(cv) {
    const g = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!g) return null;
    const sh = (type, src) => { const x = g.createShader(type); g.shaderSource(x, src); g.compileShader(x); return g.getShaderParameter(x, g.COMPILE_STATUS) ? x : null; };
    const vs = sh(g.VERTEX_SHADER, `#version 300 es
      in vec2 aPos; in float aSize; in vec4 aCol; in float aShape;
      uniform vec2 uRes;
      out vec4 vCol; out float vShape; out float vSize;
      void main() {
        vec2 p = aPos / uRes * 2.0 - 1.0;
        gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
        gl_PointSize = aSize;
        vCol = aCol; vShape = aShape; vSize = aSize;
      }`);
    const fs = sh(g.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      in vec4 vCol; in float vShape; in float vSize; out vec4 o;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a;
        if (vShape < 0.5) {                                                             // кружок
          // мелкий (до 4 px): углы полупрозрачные, а не срезаны — иначе 3×3 и 4×4 выходят плюсиком, а не кружком
          a = vSize < 4.5 ? 1.0 - 0.5 * step(0.45, length(c)) : 1.0 - smoothstep(0.40, 0.5, length(c));
        }
        else if (vShape > 1.5) { float d = length(c) * 2.0; a = (1.0 - d) * (1.0 - d); }  // мягкий ореол
        else {                                                                         // крестик-блик, тает к концам
          float t = 0.05;
          float lx = step(abs(c.y), t) * (1.0 - abs(c.x) * 2.0);
          float ly = step(abs(c.x), t) * (1.0 - abs(c.y) * 2.0);
          a = max(lx, ly);
        }
        if (a <= 0.0) discard;
        o = vec4(vCol.rgb * vCol.a * a, vCol.a * a);
      }`);
    if (!vs || !fs) return null;
    const pr = g.createProgram();
    g.attachShader(pr, vs); g.attachShader(pr, fs); g.linkProgram(pr);
    if (!g.getProgramParameter(pr, g.LINK_STATUS)) return null;
    g.useProgram(pr);
    glBuf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, glBuf);
    const attr = (name, size, off) => { const l = g.getAttribLocation(pr, name); g.enableVertexAttribArray(l); g.vertexAttribPointer(l, size, g.FLOAT, false, STRIDE * 4, off * 4); };
    attr('aPos', 2, 0); attr('aSize', 1, 2); attr('aCol', 4, 3); attr('aShape', 1, 7);
    glU = g.getUniformLocation(pr, 'uRes');
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.clearColor(0, 0, 0, 0);
    return g;
  }

  function flush(w, h) {
    if (gl) {
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(glU, w, h);
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
      gl.bufferData(gl.ARRAY_BUFFER, inst.subarray(0, instN * STRIDE), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, instN);
      return;
    }
    // запасной путь: 2D со штампами (цвет и прозрачность квантуются, чтобы штампов было немного)
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < instN; i++) {
      const o = i * STRIDE, size = inst[o + 2], a = inst[o + 6];
      const r = Math.round(inst[o + 3] * 20) * 12.75, g = Math.round(inst[o + 4] * 20) * 12.75, b = Math.round(inst[o + 5] * 20) * 12.75;
      ctx.globalAlpha = Math.round(a * 10) / 10;
      if (inst[o + 7] < 0.5 || inst[o + 7] > 1.5) {
        const img = stamp(`rgb(${r | 0},${g | 0},${b | 0})`, Math.max(0.6, Math.round(size) / 2));
        ctx.drawImage(img, Math.round(inst[o] - img.width / 2), Math.round(inst[o + 1] - img.height / 2));
      } else {
        const L = size / 2, t = Math.max(0.5, size * 0.05);
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        ctx.fillRect(inst[o] - L, inst[o + 1] - t / 2, L * 2, t); ctx.fillRect(inst[o] - t / 2, inst[o + 1] - L, t, L * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Свечение за ядром — CSS-фон холста (бесплатно для кадра); стиль меняем, только когда он заметно изменился.
  let glowCss = '', lastGlow = null;
  function setGlow(cx, cy, rad, r, g, b, a, dpr) {
    lastGlow = { x: cx / dpr, y: cy / dpr, rad: rad / dpr, r, g, b, a };   // для записи видео: свечение не на холсте
    const css = a < 0.005 ? 'none' : `radial-gradient(circle at ${Math.round(cx / dpr)}px ${Math.round(cy / dpr)}px, rgba(${r},${g},${b},${a.toFixed(3)}) 0, rgba(${r},${g},${b},0) ${Math.round(rad / dpr)}px)`;
    if (css !== glowCss) { glowCss = css; canvas.style.background = css; }
  }

  // Штамп кружка: рисуется один раз на цвет и размер, дальше копируется drawImage — в разы дешевле,
  // чем каждый кадр строить тысячи круглых фигур.
  const stamps = new Map();
  function stamp(color, rad) {
    const key = color + '|' + rad;
    let c = stamps.get(key);
    if (c) return c;
    const size = Math.ceil(rad * 2) + 2;
    c = new OffscreenCanvas(size, size);
    const g = c.getContext('2d');
    g.fillStyle = color; g.beginPath(); g.arc(size / 2, size / 2, rad, 0, 6.2832); g.fill();
    if (stamps.size > 80) stamps.clear();
    stamps.set(key, c);
    return c;
  }

  function render(now) {
    const { w, h, dpr } = layout();
    // шаг сетки — целое число пикселей экрана: при масштабе Windows 125/150/175% дробный шаг (3,125 / 3,75 px)
    // давал дробные кружки, видеокарта рисовала их то на 2, то на 3 пикселя — узлы выходили «дырявыми»
    const cell = Math.max(2, Math.round(CELL * dpr));
    // отъезд камеры — ease-out: быстрый старт и плавная посадка на место
    const zt = Math.min(1, Math.max(0, aliveT(now) / ALIVE_S));
    // исчезание (vanish): камера чуть наезжает, перо стирает сеть в обратном порядке, звёзды и свечение гаснут
    const vk = vanishAt ? Math.min(1, Math.max(0, (now - vanishAt) / vanishMs)) : 0;
    // схлопывание в точку (implode): воронка — сеть всё быстрее крутится и стягивается к ядру
    const ki = implodeAt ? Math.min(1, Math.max(0, (now - implodeAt) / implodeMs)) : 0;
    fadeK = Math.max(vk, ki);
    const zoom = (reduce() ? 1 : 1 + ZOOM_IN * Math.pow(1 - zt, 3)) * (1 + 0.18 * ease(vk));
    const live = liveAt(now);
    const sq = squeeze ? Math.max(0, (now - squeeze.start) / squeeze.dur) : 1;
    if (squeeze && sq >= 1) squeeze = null;
    // сжатие: быстро внутрь (первые 18%), долго обратно
    const shrinkK = squeeze ? squeeze.amt * (sq < 0.18 ? smooth(sq / 0.18) : 1 - smooth((sq - 0.18) / 0.82)) : 0;
    // схватил курсор — сеть чуть тянется к нему (плавно; отпустили — возвращается)
    let gpx = 0, gpy = 0;
    if (grab) { const gr = canvas.getBoundingClientRect(); gpx = (grab.x - gr.left) * dpr; gpy = (grab.y - gr.top) * dpr; }
    const leanOn = grab && grab.active && !grab.releasedAt;
    lean.x += ((leanOn ? (gpx - w / 2) * 0.06 : 0) - lean.x) * 0.12;
    lean.y += ((leanOn ? (gpy - h * 0.46) * 0.06 : 0) - lean.y) * 0.12;
    const cx = w / 2 + lean.x, cy = h * 0.46 + lean.y, R = Math.min(w, h * 0.92) * 0.36 * zoom * (1 - shrinkK) * (1 - ki * ki * ki);
    // волны от ядра: фронт в единицах модели (0 — ядро, ~1.1 — край)
    waves = waves.filter((wv) => now - wv.start < WAVE_MS);
    const fronts = waves.map((wv) => [Math.max(0, now - wv.start) / WAVE_MS * 1.35, wv.str]);
    // прогресс задачи — доля полоски прогресса
    const running = document.body && document.body.classList.contains('running');
    const bar = running && document.getElementById('progressBar');
    const progress = bar ? Math.min(1, (parseFloat(bar.style.width) || 0) / 100) : 0;
    const time = now / 1000;
    const assemble = vanishAt ? 1 - vk : reduce() ? 1 : Math.min(1, (now - startAt) / ASSEMBLE_MS);
    const ca = Math.cos(angle), sa = Math.sin(angle), tilt = 0.32 + Math.sin(time * 0.21) * 0.08 * live, ct = Math.cos(tilt), stt = Math.sin(tilt);
    // Сетка клеток в типизированных массивах (без тысяч объектов на кадр): яркость, глубина и список занятых клеток.
    const GW = Math.ceil(w / cell) + 2, GH = Math.ceil(h / cell) + 2, size = GW * GH;
    if (!G.v || G.v.length < size) { G.v = new Float32Array(size); G.d = new Float32Array(size); G.used = new Int32Array(size); }
    for (let i = 0; i < G.n; i++) G.v[G.used[i]] = 0;
    G.n = 0; G.gw = GW;
    const put = (gx, gy, v, depth) => {
      if (gx < -1 || gy < -1 || gx >= GW - 1 || gy >= GH - 1) return;
      const k = (gy + 1) * GW + gx + 1;
      const o = G.v[k];
      if (o === 0) G.used[G.n++] = k;
      if (o < v) { G.v[k] = v; G.d[k] = depth; }
    };
    const project = (x, y, z) => {
      const x1 = x * ca - z * sa, z1 = x * sa + z * ca;          // вокруг вертикали
      const y2 = y * ct - z1 * stt, z2 = y * stt + z1 * ct;      // наклон
      const k = 2.6 / (2.6 + z2);                                 // перспектива
      return { px: cx + x1 * R * k, py: cy + y2 * R * k, depth: z2, k };
    };

    // точки сети
    for (const p of model.pts) {
      const age = assemble - p.appear;
      if (age < 0) continue;                                      // перо ещё не дошло
      let x = p.x, y = p.y, z = p.z;
      if (p.core) { x += Math.sin(time * 1.3 + p.j) * 0.012 * live; y += Math.cos(time * 1.1 + p.j) * 0.012 * live; }
      const q = project(x, y, z);
      let v = p.w * Math.min(1, 0.35 + age * 22);                 // быстро «проявляется» на месте
      if (age < 0.018) v = 1.6;                                   // головка пера — яркая
      if (p.edge && assemble >= 1) {
        // импульсы по связи: скорость, число и направление (к ядру / наружу) — по настроению
        const along0 = p.edge.out ? p.t : 1 - p.t;                // 0 у ядра → 1 наружу
        const along = mood.dir > 0 ? along0 : 1 - along0;
        const u = (pulseClock + p.edge.phase) % 1;
        const m = (((along - u) * mood.heads) % 1 + 1) % 1;
        if (Math.min(m, 1 - m) / mood.heads < 0.045) v = 1.6;
        // искра «думает»: яркая головка и короткий хвост позади
        const ws = edgeWalk.get(p.edge);
        if (ws) for (const w of ws) {
          const d = (w.pos - p.t) * w.dir;                        // >0 — точка позади головки
          if (d >= -0.03 && d < 0.04) { v = 1.75; if (!w.short && d > -0.005 && d < 0.012) halos.push([q.px, q.py, cell * 4.2, 1]); }
          else if (!w.short && d >= 0.04 && d < 0.22) v = Math.max(v, 1.0 + 0.3 * (1 - (d - 0.04) / 0.18));
        }
      }
      if (p.core && absorb) { const f = (now - absorb.start) / ABSORB_MS; if (f > GROW_F && f < PULL_F) v *= 1.25; }
      if (p.core) v *= 0.75 + 0.25 * mood.core * (1 + 0.25 * Math.sin(time * 3.2) * Math.max(0, mood.core - 1.2));   // ядро «дышит», когда думает
      if (p.core && sleep > 0) v *= 1 - 0.35 * sleep * (0.5 + 0.5 * Math.sin(time * 0.9));     // спит — медленное глубокое дыхание
      for (const [f, a] of fronts) if (Math.abs(p.r - f) < 0.045) v = Math.max(v, 1.45 + 0.3 * a);
      put(Math.floor(q.px / cell), Math.floor(q.py / cell), v, q.depth);
    }
    // узлы-сгустки: диск из клеток, «дышит»
    model.nodes.forEach((n) => {
      // Набор по пикселю: каждая клетка сгустка загорается в свой момент (вразнобой, ближе к центру — раньше),
      // свежая клетка на миг ярче — узел «проявляется», а не выпрыгивает.
      const grow = vanishAt ? (assemble - n.appear) * ASSEMBLE_MS / NODE_GROW_MS : reduce() ? 1 : (now - startAt - n.appear * ASSEMBLE_MS) / NODE_GROW_MS;
      if (grow <= 0) return;
      const q = project(n.x, n.y, n.z);
      const fr = n.fireAt ? (now - n.fireAt) / 320 : 9;
      const r = (n.size * 1.15 + Math.sin(time * 1.6 + n.beat) * 0.35 + (fr >= 0 && fr < 1 ? 0.9 * (1 - fr) : 0)) * q.k;   // радиус в клетках; сработавший синапс на миг крупнее
      const g0x = Math.floor(q.px / cell), g0y = Math.floor(q.py / cell), ri = Math.ceil(r);
      // скрипт: вершины мигают по кругу; «тик»: несколько случайных вершин на миг вспыхивают
      let nodeV = 1.05;
      if (mood.blink > 0.05) { const b = (blinkClock - n.order) % 1; if ((b + 1) % 1 < 0.07) nodeV = 1.05 + 0.6 * mood.blink; }
      const fired = n.fireAt ? (now - n.fireAt) / 320 : 9;          // синапс сработал — вспышка тает за 0,32 с
      if (fired >= 0 && fired < 1) {
        nodeV = Math.max(nodeV, fired < 0.45 ? 1.75 : 1.75 - 0.6 * (fired - 0.45) / 0.55);   // первую половину — в полную яркость
        halos.push([q.px, q.py, cell * (7 + n.size * 3) * q.k, 1.2 * (1 - fired)]);
      }
      const pk = (now - pokeAt) / 350;
      if (pk >= 0 && pk < 1 && cellHash(n.idx * 3.1, pokeSeed) < 0.3) nodeV = Math.max(nodeV, 1.65 - 0.5 * pk);
      for (const [f, a] of fronts) if (Math.abs(n.r - f) < 0.09) { nodeV = Math.max(nodeV, 1.75); halos.push([q.px, q.py, cell * (6 + n.size * 3) * q.k, a]); }
      const passed = progress > 0 && n.prog < progress;                           // пройденная доля задачи — яркая точка в центре вершины
      for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
        const dd = dx * dx + dy * dy;
        if (dd > r * r) continue;
        const at = 0.25 * Math.sqrt(dd) / Math.max(1, r) + 0.75 * cellHash(dx + n.beat * 13, dy);   // 0..1 — когда загорится
        const age = grow - at;
        if (age < 0) continue;
        put(g0x + dx, g0y + dy, age < 0.12 && grow < 1.1 ? 1.4 : nodeV, q.depth - 0.05);
      }
      if (passed && grow >= 1) put(g0x, g0y, 1.75, q.depth - 0.1);
  });

    // подключение к сообщению
    if (absorb) {
      const f = (now - absorb.start) / ABSORB_MS;
      // пузырь скрыт (другая вкладка, перерисовка) — ищем видимый с тем же текстом
      if (!(absorb.el.isConnected && absorb.el.offsetParent)) { const v = visibleMsg(absorb.kind, absorb.text); if (v) absorb.el = v; }
      const box = absorb.el.isConnected && absorb.el.offsetParent ? absorb.el.getBoundingClientRect() : null;
      const cr = canvas.getBoundingClientRect();
      if (f >= 1) {
        // отпустили сообщение — полученное разбегается по сети: искры стартуют из принявших вершин
        if (absorb.links) spawnFrom = absorb.links.slice();
        mood.walk = 1;
        thinkUntil = now + 2500;
        absorb = null;
      } else if (!box || box.bottom < cr.top || box.top > cr.bottom) {
        // пузыря на экране пока нет (вкладка «Чат» скрыта, прокрутка) — ждём, не отменяя
      } else {
        // точка подключения — край пузыря, ближайший к ядру, в пикселях холста
        const bx = (Math.min(Math.max(cx / dpr + cr.left, box.left + 6), box.right - 6) - cr.left) * dpr;
        const by = (Math.min(Math.max(cy / dpr + cr.top, box.top), box.bottom) - cr.top) * dpr;
        if (!absorb.links) {                                       // 3 ближайшие к сообщению вершины
          absorb.links = model.nodes.map((n, i) => { const q = project(n.x, n.y, n.z); return { i, d: Math.hypot(q.px - bx, q.py - by) }; })
            .sort((a, b) => a.d - b.d).slice(0, 3).map((x) => x.i);
        }
        for (const i of absorb.links) {
          const n = model.nodes[i], q = project(n.x, n.y, n.z);
          const len = Math.hypot(bx - q.px, by - q.py), steps = Math.max(4, Math.round(len / cell));
          // доля линии от вершины к сообщению: растёт, держится, втягивается
          const reach = f < GROW_F ? f / GROW_F : f < PULL_F ? 1 : 1 - (f - PULL_F) / (1 - PULL_F);
          for (let k = 0; k <= steps * reach; k++) {
            const t = k / steps, x = q.px + (bx - q.px) * t, y = q.py + (by - q.py) * t;
            if (k % 2 && t < reach - 0.05) continue;                 // пунктир, головка сплошная
            put(Math.floor(x / cell), Math.floor(y / cell), t > reach - 0.05 ? 1.6 : 1.0, -0.6);
          }
          // пакеты данных бегут от сообщения в вершину
          if (f >= GROW_F && f < PULL_F) {
            const pf = (f - GROW_F) / (PULL_F - GROW_F);
            for (let j = 0; j < 4; j++) {
              const u = 1 - ((pf * 3.2 + j / 4 + i * 0.13) % 1);    // 1 у сообщения → 0 у вершины
              const x = q.px + (bx - q.px) * u, y = q.py + (by - q.py) * u;
              put(Math.floor(x / cell), Math.floor(y / cell), 1.75, -0.8);
              put(Math.floor(x / cell) + 1, Math.floor(y / cell), 1.4, -0.8);
            }
            n.fireAt = now - 120 * Math.random();                      // принимающая вершина светится
          }
        }
        // «порт» у сообщения: сгусток пикселей
        if (f < PULL_F + 0.08) {
          const pr = 2 + Math.sin(time * 9) * 0.6, gx0 = Math.floor(bx / cell), gy0 = Math.floor(by / cell);
          for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= pr * pr) put(gx0 + dx, gy0 + dy, 1.5, -0.8);
        }
      }
    }

    // щупальца к новым строкам лога
    if (taps.length) {
      const cr = canvas.getBoundingClientRect();
      taps = taps.filter((tp) => now - tp.start < TAP_MS && tp.el.isConnected);
      for (const tp of taps) {
        const f = Math.max(0, (now - tp.start) / TAP_MS);
        if (!tp.el.offsetParent) continue;
        const box = tp.el.getBoundingClientRect();
        if (box.bottom < cr.top || box.top > cr.bottom) continue;
        const bx = (Math.min(Math.max(cx / dpr + cr.left, box.left + 4), box.right - 4) - cr.left) * dpr;
        const by = (Math.min(Math.max(cy / dpr + cr.top, box.top), box.bottom) - cr.top) * dpr;
        if (tp.node < 0) {                                          // ближайшая к строке вершина — один раз
          let best = 0, bd = Infinity;
          model.nodes.forEach((n, i) => { const q = project(n.x, n.y, n.z); const d = Math.hypot(q.px - bx, q.py - by); if (d < bd) { bd = d; best = i; } });
          tp.node = best;
          model.nodes[best].fireAt = now;
        }
        const n = model.nodes[tp.node], q = project(n.x, n.y, n.z);
        const len = Math.hypot(bx - q.px, by - q.py), steps = Math.max(4, Math.round(len / cell));
        const reach = f < 0.3 ? f / 0.3 : f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3;
        for (let k = 0; k <= steps * reach; k++) {
          if (k % 2) continue;                                       // тонкий пунктир — легче большой прицепки
          const t = k / steps;
          put(Math.floor((q.px + (bx - q.px) * t) / cell), Math.floor((q.py + (by - q.py) * t) / cell), t > reach - 0.06 ? 1.5 : 0.95, -0.4);
        }
        if (f >= 0.3 && f < 0.7) {                                  // один пакет бежит от вершины к строке
          const u = (f - 0.3) / 0.4;
          put(Math.floor((q.px + (bx - q.px) * u) / cell), Math.floor((q.py + (by - q.py) * u) / cell), 1.75, -0.8);
        }
      }
    }

    // «слушает»: искра от поля ввода (снизу) к одной из нижних вершин, вершина вспыхивает
    if (listens.length) {
      const cr = canvas.getBoundingClientRect();
      for (const ls of listens) {
        const f = Math.max(0, (now - ls.start) / LISTEN_MS);
        if (f >= 1) { if (ls.node >= 0 && !ls.out) model.nodes[ls.node].fireAt = now; ls.done = true; continue; }
        const bx = Math.min(w - cell, Math.max(cell, ((ls.x !== null ? ls.x : cr.left + cr.width / 2) - cr.left) * dpr));   // над курсором
        const by = ls.y != null ? Math.min(h - cell, Math.max(cell, (ls.y - cr.top) * dpr)) : h - cell;   // y — к точке на холсте (фраза), иначе низ (поле ввода)
        if (ls.node < 0) {                                         // одна из 5 ближайших к низу вершин
          const near = model.nodes.map((n, i) => { const q = project(n.x, n.y, n.z); return { i, d: Math.hypot(q.px - bx, q.py - by) }; })
            .sort((a, b) => a.d - b.d).slice(0, 5);
          ls.node = near[Math.floor(Math.random() * near.length)].i;
          if (ls.out) model.nodes[ls.node].fireAt = now;            // «закачивание»: вершина выстреливает сгусток в поле
        }
        const q = project(model.nodes[ls.node].x, model.nodes[ls.node].y, model.nodes[ls.node].z);
        const u = ls.out ? 1 - smooth(f) : smooth(f);               // out — от вершины вниз к полю
        for (let k = 0; k < 4; k++) {                                // головка и короткий хвост
          const t = Math.min(1, Math.max(0, ls.out ? u + k * 0.04 : u - k * 0.04));
          put(Math.floor((bx + (q.px - bx) * t) / cell), Math.floor((by + (q.py - by) * t) / cell), k ? 1.35 - k * 0.1 : 1.75, -0.8);
        }
      }
      listens = listens.filter((ls) => !ls.done);
    }

    // схваченный курсор: нити от трёх ближайших вершин, сгустки бегут к курсору, у курсора — пульсирующий сгусток
    if (grab && !grab.active && !grab.releasedAt && now - grab.down > GRAB_DELAY) {
      grab.active = true;
      document.body.style.cursor = 'grabbing';
    }
    if (grab && grab.active) {
      let reach = grab.releasedAt ? 1 - Math.min(1, Math.max(0, (now - grab.releasedAt) / GRAB_RELEASE))
        : ease(Math.min(1, Math.max(0, (now - grab.down - GRAB_DELAY) / GRAB_GROW)));
      if (grab.releasedAt && reach <= 0) grab = null;
      else {
        if (!grab.nodes) {
          grab.nodes = model.nodes.map((n, i) => { const q = project(n.x, n.y, n.z); return { i, d: Math.hypot(q.px - gpx, q.py - gpy) }; })
            .sort((a, b) => a.d - b.d).slice(0, 3).map((x) => x.i);
          grab.nodes.forEach((i) => { model.nodes[i].fireAt = now; });
        }
        grab.nodes.forEach((ni, gi) => {
          const n = model.nodes[ni], q = project(n.x, n.y, n.z);
          const len = Math.hypot(gpx - q.px, gpy - q.py), steps = Math.max(4, Math.round(len / cell));
          const nx = -(gpy - q.py) / (len || 1), ny = (gpx - q.px) / (len || 1);
          const sag = Math.sin(time * 3 + gi * 2.1) * 0.06 * len;    // нить чуть провисает и «дышит»
          const pt = (t) => [q.px + (gpx - q.px) * t + nx * sag * Math.sin(Math.PI * t), q.py + (gpy - q.py) * t + ny * sag * Math.sin(Math.PI * t)];
          for (let k = 0; k <= steps * reach; k++) {
            const t = k / steps;
            if (k % 2 && t < reach - 0.05) continue;
            const [x, y] = pt(t);
            put(Math.floor(x / cell), Math.floor(y / cell), t > reach - 0.05 ? 1.6 : 1.05, -0.7);
          }
          if (reach >= 1) for (let j = 0; j < 2; j++) {           // сгустки бегут от вершины к курсору
            const [x, y] = pt((time * 1.4 + j / 2 + gi * 0.23) % 1);
            put(Math.floor(x / cell), Math.floor(y / cell), 1.75, -0.8);
          }
          if (reach >= 1 && Math.random() < 0.02) n.fireAt = now;
        });
        // у курсора — сгусток пикселей
        const pr = (1.6 + Math.sin(time * 9) * 0.5) * reach, g0x = Math.floor(gpx / cell), g0y = Math.floor(gpy / cell);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= pr * pr) put(g0x + dx, g0y + dy, 1.55, -0.8);
      }
    }

    // ждёт подтверждения: от двух ближайших вершин — пульсирующие линии к кнопкам вопроса
    const askEl = document.getElementById('ask');
    if (moodName === 'awaiting_confirmation' && askEl && !askEl.hidden) {
      const cr = canvas.getBoundingClientRect();
      if (!askLinks) askLinks = { start: now, nodes: null };
      const btns = ['askOk', 'askNo'].map((id) => document.getElementById(id)).filter((b) => b && b.offsetParent);
      const f = Math.min(1, Math.max(0, (now - askLinks.start) / 420));
      btns.forEach((b, bi) => {
        const box = b.getBoundingClientRect();
        const bx = (Math.min(Math.max(box.left + box.width / 2, cr.left + 4), cr.right - 4) - cr.left) * dpr;
        const by = (Math.min(Math.max(box.top, cr.top + 4), cr.bottom - 4) - cr.top) * dpr;
        if (!askLinks.nodes) askLinks.nodes = [];
        if (askLinks.nodes[bi] === undefined) {
          let best = 0, bd = Infinity;
          model.nodes.forEach((n, i) => { if (askLinks.nodes.includes(i)) return; const q = project(n.x, n.y, n.z); const d = Math.hypot(q.px - bx, q.py - by); if (d < bd) { bd = d; best = i; } });
          askLinks.nodes[bi] = best;
        }
        const n = model.nodes[askLinks.nodes[bi]], q = project(n.x, n.y, n.z);
        const len = Math.hypot(bx - q.px, by - q.py), steps = Math.max(4, Math.round(len / cell));
        for (let k = 0; k <= steps * ease(f); k++) {
          if (k % 2) continue;
          const t = k / steps;
          put(Math.floor((q.px + (bx - q.px) * t) / cell), Math.floor((q.py + (by - q.py) * t) / cell), 1.0, -0.5);
        }
        if (f >= 1) {                                                // «зовёт»: пакет бежит к кнопке и обратно
          const u = 0.5 - 0.5 * Math.cos(time * 3 + bi * 1.4);
          put(Math.floor((q.px + (bx - q.px) * u) / cell), Math.floor((q.py + (by - q.py) * u) / cell), 1.75, -0.8);
        }
      });
    } else askLinks = null;

    // щупальца из ядра к краю (продолжаются на странице)
    if (outs) {
      let alive = false;
      const ex = 0, ey = cy;                                       // точка выхода — на высоте ядра (по ней же считает страница)
      for (let i = 0; i < outs.n; i++) {
        let k = now - outs.start - i * OUT_STAGGER;
        if (k < 0) { alive = true; continue; }
        // постоянный режим: выкачивание по кругу; отпустили — сразу втягивание
        if (outs.hold && k >= OUT_REACH) k = outs.releaseAt ? OUT_REACH + OUT_SUCK + (now - outs.releaseAt) : OUT_REACH + ((k - OUT_REACH) % OUT_SUCK);
        else if (outs.releaseAt) k = OUT_REACH + OUT_SUCK + (now - outs.releaseAt);
        if (k >= OUT_REACH + OUT_SUCK + OUT_RETRACT) continue;
        alive = true;
        let g = 1;
        if (k < OUT_REACH) g = ease(k / OUT_REACH);
        else if (k > OUT_REACH + OUT_SUCK) g = 1 - smooth((k - OUT_REACH - OUT_SUCK) / OUT_RETRACT);
        // из ядра веером, к краю сходятся в одну точку
        const spread = (i - (outs.n - 1) / 2) * 16 * dpr;
        const x0 = cx, y0 = cy, x1 = cx * 0.45, y1 = cy + spread;
        const len = Math.hypot(cx - ex, spread) + cx * 0.1, steps = Math.max(8, Math.round(len / cell));
        const bez = (t) => [(1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * x1 + t * t * ex, (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * y1 + t * t * ey];
        for (let s2 = 0; s2 <= steps * g; s2++) {
          const t = s2 / steps;
          if (s2 % 2 && t < 0.5 && t < g - 0.05) continue;          // у ядра пунктир, к краю — сплошное и толще (как щупальце на странице)
          const [x, y] = bez(t);
          const gx = Math.floor(x / cell), gy = Math.floor(y / cell), v = t > g - 0.05 ? 1.6 : 1.05;
          put(gx, gy, v, -0.6);
          if (t > 0.45) put(gx, gy + 1, v, -0.6);
          if (t > 0.75) { put(gx, gy - 1, v * 0.95, -0.6); if (t > 0.88) put(gx, gy + 2, v * 0.95, -0.6); }
        }
        if (k >= OUT_REACH && k <= OUT_REACH + OUT_SUCK) {         // выкачивание: сгустки с края в ядро
          const f = (k - OUT_REACH) / OUT_SUCK;
          for (let j = 0; j < 3; j++) {
            const u = 1 - ((f * 2.4 + j / 3 + i * 0.17) % 1);
            const [x, y] = bez(u);
            put(Math.floor(x / cell), Math.floor(y / cell), 1.75, -0.8);
            put(Math.floor(x / cell) + 1, Math.floor(y / cell), 1.4, -0.8);
          }
        }
      }
      if (!alive) outs = null;
    }

    // отрисовка: плюсики, ближнее светлее (к белому), дальнее тусклее
    instN = 0;
    drawStars(w, h, dpr, time, now, cx, cy);
    // базовый цвет: акцент, при ожидании/ошибке — с оттенком предупреждения (пульсирует)
    const [a0, g0, b0] = rgbOf(accent), [tr, tg, tb] = rgbOf(mood.tintColor);
    const tint = mood.tint * (0.75 + 0.25 * Math.sin(time * 4));
    let ar = Math.round(a0 + (tr - a0) * tint), ag = Math.round(g0 + (tg - g0) * tint), ab = Math.round(b0 + (tb - b0) * tint);
    if (flash) {                                                   // вспышка цвета: быстро загорается, медленно гаснет
      const ff = Math.max(0, (now - flash.start) / flash.dur);   // метка кадра бывает чуть раньше события — не уходим в минус
      if (ff >= 1) flash = null;
      else {
        const k = Math.min(1, Math.max(0, ff < 0.2 ? ff / 0.2 : 1 - (ff - 0.2) / 0.8)) * 0.85, [fr2, fg2, fb2] = rgbOf(flash.color);
        ar = Math.round(ar + (fr2 - ar) * k); ag = Math.round(ag + (fg2 - ag) * k); ab = Math.round(ab + (fb2 - ab) * k);
      }
    }
    // мягкое свечение за ядром (CSS-фон)
    setGlow(cx, cy, R * 0.9 * (0.9 + 0.1 * mood.core), ar, ag, ab,
      0.16 * ease(assemble) * mood.core * (1 + 0.2 * Math.sin(time * 3.2) * Math.max(0, mood.core - 1.2)) * dim * (1 - ki), dpr);
    // клетки: ближнее светлее (к белому), дальнее тусклее; импульсы — почти белые
    // кружок клетки — тоже целый и стоит ровно на пиксельной сетке: каждый закрашивает одинаковый сплошной блок
    const dot = Math.max(1, Math.round(cell * 0.72)), dotHot = Math.max(dot + 1, Math.round(dot * 1.35));
    const off = Math.floor((cell - dot) / 2) + dot / 2, offHot = Math.floor((cell - dotHot) / 2) + dotHot / 2;
    const AR = ar / 255, AG = ag / 255, AB = ab / 255, GW2 = G.gw;
    // ореолы под искрами и сработавшими синапсами (рисуются первыми — головки остаются чёткими поверх)
    for (const hl of halos) emit(hl[0], hl[1], hl[2], AR + (1 - AR) * 0.6, AG + (1 - AG) * 0.6, AB + (1 - AB) * 0.6, 0.22 * hl[3], 2);
    halos = [];
    if (ki >= 1) G.n = 0;                                                 // стянулась в точку — дальше только точка и кольцо
    for (let i = 0; i < G.n; i++) {
      const k = G.used[i], v = G.v[k], depth = G.d[k];
      const near = Math.min(1, Math.max(0, 0.5 - depth * 0.55));         // 0 — далеко, 1 — близко
      const hot = v > 1.3;                                                // импульс
      const line = v >= 0.95 && !hot;                                     // связи и узлы — ярче фона
      const mix = hot ? 0.9 : near * (line ? 0.6 : 0.4);                  // доля белого
      const gx = (k % GW2) - 1, gy = ((k / GW2) | 0) - 1;
      const x = gx * cell + off, y = gy * cell + off;
      if (v >= 1.7) {                                                     // головка искры / сработавший синапс — поверх затемнения
        emit(gx * cell + offHot, gy * cell + offHot, dotHot, AR + (1 - AR) * 0.95, AG + (1 - AG) * 0.95, AB + (1 - AB) * 0.95, 1, 0);
        continue;
      }
      const alpha = Math.max(0.12, Math.min(1, (0.25 + near * 0.75) * Math.min(1, v) * (line ? 1.15 : 1)));
      const bright = hot ? 0.55 + 0.45 * dim : dim;                       // хвосты и импульсы — приглушаются слабее
      emit(x, y, dot, AR + (1 - AR) * mix, AG + (1 - AG) * mix, AB + (1 - AB) * mix, alpha * bright, 0);
    }

    // фраза из точек: ядро → буквы → ядро. Шаг и кружки — как у сети (CELL, dot), штрих в одну точку;
    // яркие; символы вылетают по очереди, втягивается всё разом.
    if (say && implodeAt && now - implodeAt >= implodeMs) say = null;     // засосало в точку — фразы больше нет
    if (say) {
      const k = now - say.start, back = say.outEnd + (say.hold ?? SAY_HOLD), size = dot;
      const AR2 = AR + (1 - AR) * 0.85, AG2 = AG + (1 - AG) * 0.85, AB2 = AB + (1 - AB) * 0.85;
      for (const d of say.dots) {
        let f;
        if (k < back) f = ease(Math.max(0, (k - d.d0) / SAY_OUT));
        else { const t = Math.min(1, Math.max(0, (k - back - d.d1) / SAY_IN)); f = 1 - t * t; }   // обратно — с разгоном, «засасывает»
        if (f <= 0) continue;
        const tx = d.x * dpr, ty = d.y * dpr;
        let x = cx + (tx - cx) * f, y = cy + (ty - cy) * f - Math.sin(Math.PI * f) * d.arc * dpr;
        if (implodeAt) {                                                  // воронка: буквы засасываются в ядро
          const g = Math.min(1, Math.max(0, (now - implodeAt - d.d1 * 0.5) / (implodeMs * 0.75)));
          const e = g * g;
          x = cx + (x - cx) * (1 - e); y = cy + (y - cy) * (1 - e);
        }
        const sz = f > 0.97 ? size : dotHot;                              // на пиксельной сетке, как клетки сети
        emit(Math.round(x - sz / 2) + sz / 2, Math.round(y - sz / 2) + sz / 2, sz, AR2, AG2, AB2, f > 0.97 ? 1 : 0.85, 0);
      }
      if (k > back + SAY_IN_MAX) { say = null; react('accepted'); }
    }

    // после схлопывания: одна яркая точка пульсирует и расходится кольцом из точек, затем пусто
    if (implodeAt) {
      const kp = now - implodeAt - implodeMs;
      if (kp >= 0 && kp < IMPLODE_END) {
        const f = kp / IMPLODE_END, W2 = (1 - AR) * 0.95;
        const pulse = 1 + 0.9 * Math.abs(Math.sin(f * Math.PI * 2.2)) * (1 - f);
        emit(cx, cy, cell * 2.6 * pulse, 1, 1, 1, 0.35 * (1 - f), 2);                       // ореол
        emit(Math.round(cx), Math.round(cy), dotHot * pulse, AR + W2, AG + (1 - AG) * 0.95, AB + (1 - AB) * 0.95, 1 - f * f, 0);
        const rr = (1 - Math.pow(1 - Math.min(1, f / 0.7), 3)) * Math.min(w, h) * 0.22, n = 56;
        if (f < 0.7) for (let j = 0; j < n; j++) {                                          // кольцо из точек
          const a = j / n * 6.2832;
          emit(Math.round(cx + Math.cos(a) * rr), Math.round(cy + Math.sin(a) * rr), dot, AR + W2 * 0.6, AG + (1 - AG) * 0.57, AB + (1 - AB) * 0.57, 1 - f / 0.7, 0);
        }
      }
    }

    flush(w, h);
  }


  const cellHash = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (document.hidden) { last = now; return; }
    const behind = canvas.parentElement && canvas.parentElement.classList.contains('has-content');
    // спит — реже кадры (медленное дыхание не требует 60)
    const minDt = sleep > 0.9 ? 1000 / 24 : 1000 / (behind && !absorb ? FPS_BEHIND : FPS_IDLE);
    if (now - last < minDt) return;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    // пока рисуется — стоит; при оживлении коротко «подкручивается» сильнее и выходит на обычную скорость
    // толчок сразу после начала уменьшения: быстрый подъём и долгий плавный выбег (t·e^(1−t))
    const kt = (aliveT(now) - KICK_DELAY) / KICK_TAU;
    const kick = reduce() || kt <= 0 || kt > 12 ? 0 : KICK * kt * Math.exp(1 - kt);
    updateMood(now, dt);
    // Затемнение — внутри рисунка, а не прозрачностью холста: фон сети, звёзды и свечение приглушаются
    // (за логом 32%, светлая тема 25%; пока модель работает — 65%; прицепка к сообщению — 90%),
    // а искры и сработавшие синапсы рисуются в полную яркость — их видно и за логом.
    if (canvas.style.opacity !== '1') canvas.style.opacity = '1';
    const running = document.body && document.body.classList.contains('running');
    const behindLog = canvas.parentElement && canvas.parentElement.classList.contains('has-content');
    const light = document.documentElement.dataset.theme === 'light' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches);
    // сон: минута без действий, без задачи и подключения — плавно засыпает (≈3 с), просыпается быстро
    const asleep = !running && !absorb && now - activeAt > SLEEP_AFTER;
    sleep += ((asleep ? 1 : 0) - sleep) * Math.min(1, dt * (asleep ? 0.35 : 4));
    const target = demo ? 1 : (absorb ? 0.9 : scriptOn ? 1 : running ? 0.65 : behindLog ? (light ? 0.25 : 0.32) : 1) * (1 - 0.5 * sleep);   // скрипт работает — сеть видна полностью
    dim += (target - dim) * Math.min(1, dt * 2.5);
    const pk = (now - pokeAt) / 500;                               // «тик» от переключателей: короткий подкрут
    const poke = reduce() || pk < 0 || pk > 1 ? 0 : 3 * Math.sin(Math.PI * pk);
    // вздрог/«Стоп»: вращение на время замирает
    const frozen = squeeze && squeeze.freeze && now - squeeze.start < squeeze.freeze ? 0 : 1;
    const kiSpin = implodeAt ? Math.min(1, Math.max(0, (now - implodeAt) / implodeMs)) : 0;
    angle += SPIN * dt * (liveAt(now) * mood.spin * (1 - 0.8 * sleep) * frozen + kick + poke + 60 * kiSpin * kiSpin);   // воронка разгоняется
    if (now - colorAt > 250) { readColor(); colorAt = now; }   // палитра перетекает (авто-акцент) — цвет следует за ней
    render(now);
  }

  function init(el) {
    canvas = el;
    gl = initGL(canvas);
    if (!gl) ctx = canvas.getContext('2d');           // без WebGL2 — тот же рисунок через 2D
    model = build();
    buildStars();
    document.addEventListener('click', onPoke, true);
    document.addEventListener('click', onBrainClick);
    document.addEventListener('pointerdown', onGrabDown);
    document.addEventListener('pointermove', onGrabMove, { passive: true });
    for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, onGrabUp);
    addEventListener('blur', onGrabUp);
    for (const ev of ['pointermove', 'keydown', 'pointerdown', 'wheel', 'focusin']) document.addEventListener(ev, wake, { passive: true, capture: true });
    document.addEventListener('input', onType, true);
    new MutationObserver(onMessages).observe(document.body, { childList: true, subtree: true });
    readColor();
    new ResizeObserver((es) => { const b = es[0].contentRect; cssW = b.width; cssH = b.height; if (reduce()) render(performance.now()); }).observe(canvas);
    play();
  }

  // Исчезание — зеркально появлению: перо стирает линии в обратном порядке, вершины тают, звёзды и свечение гаснут.
  let vanishAt = 0, vanishMs = 1700, fadeK = 0;
  function vanish(ms = 1700) { if (canvas) { vanishMs = ms; vanishAt = performance.now(); } }
  // Стянуться в одну точку: сеть закручивается воронкой и сжимается к ядру, точки фразы засасываются туда же,
  // потом точка коротко пульсирует и расходится кольцом из точек (IMPLODE_END мс после схлопывания).
  let implodeAt = 0, implodeMs = 1500;
  const IMPLODE_END = 900;
  function implode(ms = 1500) { if (canvas) { implodeMs = ms; implodeAt = performance.now(); } }

  function play() {
    if (!canvas) return;
    vanishAt = 0; fadeK = 0; implodeAt = 0;
    startAt = performance.now();
    cancelAnimationFrame(raf);
    if (reduce()) { readColor(); render(startAt + ASSEMBLE_MS); return; }   // меньше движения — один кадр
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  // Активность пользователя: будит спящую сеть (короткая волна и подкрут)
  function wake() {
    const now = performance.now();
    if (sleep > 0.5 && !reduce()) { wave(0.6); pokeAt = now; pokeSeed++; }
    activeAt = now;
  }
  // Печать в поле задачи: искры от поля к сети, не чаще раза в 70 мс
  function onType(e) {
    if (!e.target || e.target.id !== 'task' || reduce()) return;
    const now = performance.now();
    typedAt = now; activeAt = now;
    if (now - lastListenAt < 70 || listens.length > 10) return;
    lastListenAt = now;
    listens.push({ start: now, node: -1, x: caretX(e.target) });
  }
  // Где по горизонтали курсор в поле (с учётом переноса строк по ширине, а не только по Enter):
  // текст до курсора в невидимой копии поля с тем же шрифтом, отступами и шириной; x — в координатах окна.
  let mirror = null;
  function caretX(ta) {
    try {
      const cs = getComputedStyle(ta);
      if (!mirror) {
        mirror = document.createElement('div');
        mirror.setAttribute('aria-hidden', 'true');
        document.body.appendChild(mirror);
      }
      mirror.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;' +
        `box-sizing:border-box;width:${ta.clientWidth}px;padding:${cs.padding};border:0;font:${cs.font};letter-spacing:${cs.letterSpacing};` +
        `line-height:${cs.lineHeight};text-indent:${cs.textIndent};tab-size:${cs.tabSize}`;
      const pos = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : ta.value.length;
      mirror.textContent = ta.value.slice(0, pos);
      const mark = document.createElement('span');
      mark.textContent = '\u200b';
      mirror.appendChild(mark);
      const r = ta.getBoundingClientRect();
      return r.left + ta.clientLeft + mark.offsetLeft - ta.scrollLeft;
    } catch (err) { return null; }
  }
  // Клик по пустому экрану (сеть видна целиком, задача не идёт): пульс — волна от ядра и короткий подкрут.
  function onBrainField(e) {                                     // клик/нажатие по пустому полю мозга (задача не идёт)
    const stage = canvas && canvas.parentElement;
    if (!stage || stage.classList.contains('has-content') || document.body.classList.contains('running')) return false;
    return e.target === stage || e.target === canvas || e.target.id === 'log' || e.target.id === 'chatLog';
  }
  function onBrainClick(e) {
    if (grabbedClick) { grabbedClick = false; return; }              // это было «схватить и отпустить», а не клик
    if (onBrainField(e) && !reduce()) { wave(1); pokeAt = performance.now(); pokeSeed++; }
  }
  // Зажали ЛКМ на поле мозга: через GRAB_DELAY сеть «хватает» курсор (см. render), отпустили — отпускает.
  function onGrabDown(e) {
    if (e.button !== 0 || reduce() || !onBrainField(e)) return;
    e.preventDefault();                                              // без выделения текста при перетаскивании
    grab = { x: e.clientX, y: e.clientY, down: performance.now(), active: false, nodes: null, releasedAt: 0 };
  }
  function onGrabMove(e) { if (grab && !grab.releasedAt) { grab.x = e.clientX; grab.y = e.clientY; } }
  function onGrabUp() {
    if (!grab) return;
    if (!grab.active) { grab = null; return; }                       // короткий клик — пульс сделает onBrainClick
    if (!grab.releasedAt) {
      grab.releasedAt = performance.now();
      grabbedClick = true;
      setTimeout(() => { grabbedClick = false; }, 80);              // клик после отпускания может и не прийти
      document.body.style.cursor = '';
      wave(0.6); pokeAt = grab.releasedAt; pokeSeed++;
    }
  }
  // Реакции на события панели.
  function react(kind) {
    if (!canvas || reduce()) return;
    const now = performance.now();
    activeAt = now;
    switch (kind) {
      case 'approve': flashColor(cssColor('--ok', '#2fa56b'), 900); wave(0.8); break;          // разрешили — зелёная вспышка
      case 'good': flashColor('#ffcf7a', 1100); wave(1); break;                                   // «хорошо» — тёплая волна
      case 'deny': case 'bad': case 'error':                                                      // вздрагивает
        flashColor(cssColor('--critical', '#ef5350'), 650); shrink(0.07, 520); break;
      case 'stop': shrink(0.12, 1200, 800); break;                                                 // сжимается и замирает
      case 'tab': wave(0.7); pokeAt = now; pokeSeed++; break;                                      // осматривается
      case 'accept': pokeAt = now; pokeSeed++; break;                                               // «Действовать»: короткий тик (фраза — say)
      case 'accepted': shrink(-0.07, 1400); wave(1); flashColor(cssColor('--warn', '#f5a524'), 1200); break;   // фраза втянулась: подрастает, оранжевый пульс — цвет кнопки
      default: break;
    }
  }
  // Матричный шрифт 5×7 для фразы: штрих в одну точку, точка — клетка сетки мозга. Строчные пишутся
  // заглавными (как на табло); пустые столбцы по краям обрезаются — ширина у «.» и «Ш» разная.
  const DOT_FONT = (() => {
    const src = {
      'А': '01110 10001 10001 11111 10001 10001 10001', 'Б': '11111 10000 10000 11110 10001 10001 11110',
      'В': '11110 10001 10001 11110 10001 10001 11110', 'Г': '11111 10000 10000 10000 10000 10000 10000',
      'Д': '00110 01010 01010 01010 01010 11111 10001', 'Е': '11111 10000 10000 11110 10000 10000 11111',
      'Ё': '01010 00000 11111 10000 11110 10000 11111', 'Ж': '10101 10101 10101 01110 10101 10101 10101',
      'З': '01110 10001 00001 00110 00001 10001 01110', 'И': '10001 10001 10011 10101 11001 10001 10001',
      'Й': '01010 00100 10001 10011 10101 11001 10001', 'К': '10001 10010 10100 11000 10100 10010 10001',
      'Л': '00111 01001 01001 01001 01001 01001 10001', 'М': '10001 11011 10101 10101 10001 10001 10001',
      'Н': '10001 10001 10001 11111 10001 10001 10001', 'О': '01110 10001 10001 10001 10001 10001 01110',
      'П': '11111 10001 10001 10001 10001 10001 10001', 'Р': '11110 10001 10001 11110 10000 10000 10000',
      'С': '01110 10001 10000 10000 10000 10001 01110', 'Т': '11111 00100 00100 00100 00100 00100 00100',
      'У': '10001 10001 10001 01111 00001 10001 01110', 'Ф': '00100 01110 10101 10101 10101 01110 00100',
      'Х': '10001 10001 01010 00100 01010 10001 10001', 'Ц': '10010 10010 10010 10010 10010 11111 00001',
      'Ч': '10001 10001 10001 01111 00001 00001 00001', 'Ш': '10101 10101 10101 10101 10101 10101 11111',
      'Щ': '10101 10101 10101 10101 10101 11111 00001', 'Ъ': '11000 01000 01000 01110 01001 01001 01110',
      'Ы': '10001 10001 10001 11101 10011 10011 11101', 'Ь': '10000 10000 10000 11110 10001 10001 11110',
      'Э': '01110 10001 00001 00111 00001 10001 01110', 'Ю': '10010 10101 10101 11101 10101 10101 10010',
      'Я': '01111 10001 10001 01111 00101 01001 10001',
      'D': '11110 10001 10001 10001 10001 10001 11110', 'F': '11111 10000 10000 11110 10000 10000 10000',
      'G': '01110 10001 10000 10111 10001 10001 01111', 'I': '01110 00100 00100 00100 00100 00100 01110',
      'J': '00111 00010 00010 00010 00010 10010 01100', 'L': '10000 10000 10000 10000 10000 10000 11111',
      'N': '10001 10001 11001 10101 10011 10001 10001', 'Q': '01110 10001 10001 10001 10101 10010 01101',
      'R': '11110 10001 10001 11110 10100 10010 10001', 'S': '01111 10000 10000 01110 00001 00001 11110',
      'U': '10001 10001 10001 10001 10001 10001 01110', 'V': '10001 10001 10001 10001 10001 01010 00100',
      'W': '10001 10001 10001 10101 10101 10101 01010', 'Y': '10001 10001 01010 00100 00100 00100 00100',
      'Z': '11111 00001 00010 00100 01000 10000 11111',
      '0': '01110 10001 10011 10101 11001 10001 01110', '1': '00100 01100 00100 00100 00100 00100 01110',
      '2': '01110 10001 00001 00010 00100 01000 11111', '3': '11111 00010 00100 00010 00001 10001 01110',
      '4': '00010 00110 01010 10010 11111 00010 00010', '5': '11111 10000 11110 00001 00001 10001 01110',
      '6': '00110 01000 10000 11110 10001 10001 01110', '7': '11111 00001 00010 00100 01000 01000 01000',
      '8': '01110 10001 10001 01110 10001 10001 01110', '9': '01110 10001 10001 01111 00001 00010 01100',
      '.': '00000 00000 00000 00000 00000 00000 00100', ',': '00000 00000 00000 00000 00000 00100 01000',
      '!': '00100 00100 00100 00100 00100 00000 00100', '?': '01110 10001 00001 00010 00100 00000 00100',
      ':': '00000 00000 00100 00000 00000 00100 00000', ';': '00000 00000 00100 00000 00000 00100 01000',
      '-': '00000 00000 00000 01110 00000 00000 00000', '—': '00000 00000 00000 11111 00000 00000 00000',
      "'": '00100 00100 00000 00000 00000 00000 00000', '"': '01010 01010 00000 00000 00000 00000 00000',
      '«': '00000 00101 01010 10100 01010 00101 00000', '»': '00000 10100 01010 00101 01010 10100 00000',
      '(': '00010 00100 01000 01000 01000 00100 00010', ')': '01000 00100 00010 00010 00010 00100 01000',
      '/': '00001 00010 00010 00100 01000 01000 10000'
    };
    // латиница, совпадающая с кириллицей по начертанию
    for (const [l, c] of Object.entries({ A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' })) src[l] = src[c];
    src['’'] = src['‘'] = src["'"]; src['–'] = src['-']; src['„'] = src['“'] = src['”'] = src['"'];
    const out = {};
    for (const [ch, s] of Object.entries(src)) {
      const rows = s.split(' ');
      const used = [0, 1, 2, 3, 4].filter((x) => rows.some((r) => r[x] === '1'));
      const x0 = Math.min(...used), x1 = Math.max(...used), pts = [];
      rows.forEach((r, y) => { for (let x = x0; x <= x1; x++) if (r[x] === '1') pts.push([x - x0, y]); });
      out[ch] = { w: x1 - x0 + 1, pts };
    }
    return out;
  })();
  const DOT_GAP = 1, DOT_SPACE = 3, DOT_LINE = 11;               // в клетках: между буквами, пробел, шаг строк
  // Фраза точками под мозгом. false — не показать (нет холста / меньше движения): панель покажет текстом.
  function sayText(text, opts) {
    if (!canvas || reduce() || !model) return false;
    const { w, h, dpr } = layout();
    const cssW = w / dpr, cssH = h / dpr;
    const P = Math.max(2, Math.round(CELL * dpr)) / dpr;          // шаг — тот же целый шаг сетки, что у сети в render (CSS px)
    const LOOK = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' };   // латиница той же формы
    const glyph = (ch) => DOT_FONT[ch] || DOT_FONT[ch.toUpperCase()] || DOT_FONT[LOOK[ch.toUpperCase()]] || null;
    const width = (word) => [...word].reduce((n, ch, i) => n + (glyph(ch)?.w ?? DOT_SPACE) + (i ? DOT_GAP : 0), 0);
    // перенос по словам под ширину холста (в клетках)
    const maxW = Math.floor((cssW - 28) / P), lines = [];
    for (const word of String(text).replace(/…/g, '...').split(/\s+/).filter(Boolean)) {
      const cur = lines.length ? lines[lines.length - 1] : null;
      if (cur !== null && width(cur) + DOT_SPACE + 2 * DOT_GAP + width(word) <= maxW) lines[lines.length - 1] = cur + ' ' + word;
      else lines.push(word);
    }
    if (!lines.length) return false;
    // место: по центру, под ядром (как в render: cy = 0,46 высоты, R — радиус сети); сетка — шаг P
    const R = Math.min(cssW, cssH * 0.92) * 0.36, bh = (lines.length - 1) * DOT_LINE + 7;
    const oy = Math.min(cssH * 0.46 + R * 1.02 + 14, cssH - bh * P - 10);
    const dots = [];
    let order = 0;
    lines.forEach((line, li) => {
      let gx = Math.round((cssW / P - width(line)) / 2);
      for (const ch of line) {
        const g = glyph(ch);
        for (const [x, y] of g ? g.pts : [])
          dots.push({ x: (gx + x + 0.5) * P, y: oy + (li * DOT_LINE + y + 0.5) * P,
            d0: order * SAY_CHAR + Math.random() * 40, d1: Math.random() * SAY_JITTER, arc: (Math.random() - 0.5) * 22 });
        gx += (g ? g.w : DOT_SPACE) + DOT_GAP;
        order++;
      }
      order++;                                                   // перенос строки — как пробел
    });
    if (!dots.length) return false;
    say = { start: performance.now(), dots, outEnd: Math.max(...dots.map((d) => d.d0)) + SAY_OUT, hold: opts && opts.hold };
    activeAt = say.start;
    return true;
  }
  // Сгусток из мозга к точке (координаты окна): y не задан — вниз, к полю ввода. «Закачивание» текста.
  function send(x, y) { if (canvas && !reduce()) { listens.push({ start: performance.now(), node: -1, x, y, out: true }); if (listens.length > 24) listens.shift(); } }
  // Обратно: сгусток от точки (координаты окна) в мозг — стёртая буква «втягивается».
  function take(x, y) { if (canvas && !reduce()) { listens.push({ start: performance.now(), node: -1, x, y, out: false }); if (listens.length > 24) listens.shift(); } }
  // Щупальца на страницу: n линий из ядра к краю, синхронно с tentacles.js
  // hold — постоянный режим (щупальца на странице сменяют друг друга): пучок у края держится до unsuck().
  function suck(n, hold) {
    if (!canvas || reduce()) return;
    if (hold && outs && outs.hold && !outs.releaseAt) return;   // уже держит
    outs = { start: performance.now(), n: Math.max(1, Math.min(5, n | 0)), hold: !!hold, releaseAt: 0 };
  }
  function unsuck() { if (outs && outs.hold && !outs.releaseAt) outs.releaseAt = performance.now(); }
  // Щупальце к элементу панели (например, к полю «Что не так?» после «плохо»)
  function reach(el) { if (el && !reduce()) { taps.push({ el, start: performance.now(), node: -1 }); if (taps.length > TAPS_MAX) taps.shift(); } }

  function redraw() { if (canvas) { readColor(); if (reduce()) render(performance.now()); } }
  function flow() { colorAt = 0; }   // следующий кадр возьмёт новый цвет

  // Для видео/демо: шаг сетки (крупнее — точки как в панели при большом кадре) и бодрый режим без приглушения.
  function setCell(px) { CELL = Math.max(1, Number(px) || 2.5); }
  function setDemo(on) { demo = !!on; }

  window.CrawlerArt = { init, play, redraw, flow, react, reach, suck, unsuck, send, take, say: sayText, vanish, implode, glow: () => lastGlow, setCell, setDemo };
})();
