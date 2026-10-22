// tentacles.js — декоративные «щупальца мозга» на странице. Выходят из правого края (за ним панель с мозгом),
// из точки на высоте мозга, впиваются в элементы и «выкачивают» их — сгустки бегут к краю.
// Виды (настройка «Щупальца» в панели):
//   jagged  — ломаные: бросок рывком, острые суставы, дрожь; когти к углам элемента и сеть из точек, сжимается толчками;
//   smooth  — «щупальца»: изогнутое волнистое тело с присосками, на кончике пульсирует кольцо;
//   roots   — корни: медленно прорастают, по дороге ветвятся отростками, на элементе расползаются корешками.
// Панель закрыли — щупальца сразу втягиваются (порт к панели рвётся).
// Два режима: run — один заход (несколько щупалец разом); start/stop — пока модель работает, щупальца на странице
// постоянно: каждое держит элемент случайное время и отпускает, на его место выходит новое к другому элементу.
// Держится за элемент: при прокрутке едет вместе с ним; элемент ушёл с экрана — отпускает.
// Только картинка: на действия агента не влияет, ничего не ждёт.
// Вёрстку не трогает: один фиксированный слой вне потока (closed shadow root, pointer-events: none, contain: strict),
// страница не прокручивается, стили сайта не меняются; когда всё втянулось, слой удаляется из документа.
// Внедряется панелью (sidepanel.js → suckPage) в изолированный мир; повторное внедрение той же версии ничего не делает.
(() => {
  const VERSION = 6;
  if (window.__crawlerSuck && window.__crawlerSuck.v === VERSION) return;
  try { window.__crawlerSuck && window.__crawlerSuck.hide(); } catch (e) { /* старая версия после обновления расширения */ }

  const GRID = 2.5, MAX = 3;
  const T_SUCK = 1700, T_RETRACT = 420, STAGGER = 130;           // T_SUCK — период выкачивания (сгустки, толчки)
  const HOLD_MIN = 1300, HOLD_MAX = 3000, SPAWN_GAP = 260;       // постоянный режим: сколько держит, пауза между сменами
  const T_CLAW = 170, CLAW_STAGGER = 28;                         // когти раскрываются после касания
  const GRAB_W = 420, GRAB_H = 260;                              // больше — хватает только часть элемента
  const easeOut = (t) => 1 - Math.pow(1 - t, 4);
  const easeInOut = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const hash = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  let host = null, cv = null, ctx = null, raf = 0, acc = [59, 130, 246], dark = false;
  let items = [], style = 'jagged', exitY = 0, looping = false, nextSpawn = 0, hiddenUntil = 0, side = 1;
  const recent = [];                                             // недавно отпущенные элементы — к ним не сразу
  let port = null;

  // Связь с панелью: панель закрыли (или расширение перезагрузили) — порт рвётся, и щупальца сразу втягиваются.
  function link() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: 'crawler-suck' });
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; stop(); });   // причина обрыва — прочитана, не в консоль
    } catch (e) { port = null; stop(); }                          // контекст расширения недействителен
  }
  function unlink() { if (port) { try { port.disconnect(); } catch (e) { /* уже закрыт */ } port = null; } }
  // Уходим со страницы (в том числе в кэш «назад/вперёд»): порт закрываем сами, до кэша. Иначе его закрывает Chrome
  // с ошибкой «page … moved into back/forward cache» в консоли панели. Щупальца убираем сразу.
  addEventListener('pagehide', () => { if (port || host) { looping = false; items = []; unmount(); } });

  function mount() {
    if (host && host.isConnected) return;
    host = document.createElement('crawler-suck-' + Math.random().toString(36).slice(2, 8));
    host.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;margin:0;padding:0;border:0;' +
      'pointer-events:none;z-index:2147483647;contain:strict;display:block;background:transparent';
    const root = host.attachShadow({ mode: 'closed' });
    cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
    root.appendChild(cv);
    ctx = cv.getContext('2d');
    document.documentElement.appendChild(host);
  }
  function unmount() {
    cancelAnimationFrame(raf); raf = 0;
    if (host) host.remove();
    host = cv = ctx = null;
    unlink();
  }

  // ---------- Цели ----------
  // Кандидаты: заметные элементы в видимой области. Крупные виды — картинки и карточки в приоритете,
  // «щупальца» (smooth) — любые «читаемые»: заголовки, цены, короткий текст.
  // Геометрия одного элемента: куда хвататься, или null — мелкий, огромный или за экраном.
  function measure(el, big) {
    const W = innerWidth, H = innerHeight;
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < (big ? 40 : 24) || r.height < (big ? 22 : 10) || r.width > W * (big ? 0.75 : 0.7) || r.height > H * (big ? 0.6 : 0.5)) return null;
    if (r.bottom < 8 || r.top > H - 8 || r.right < 8 || r.left > W - 40) return null;
    const x0 = Math.max(4, r.left), y0 = Math.max(4, r.top);
    const g = { x: x0, y: y0, w: Math.min(GRAB_W, Math.min(W - 4, r.right) - x0), h: Math.min(GRAB_H, Math.min(H - 4, r.bottom) - y0) };
    if (g.w < 24 || g.h < 10) return null;
    return { rect: g, at: { x: r.left, y: r.top } };
  }
  // Полный обход страницы дорогой (селектор + замер до 300 элементов), а цели меняются редко:
  // список держится CAND_TTL, свой для каждого вида; свежая геометрия — только у выбранных (pick).
  const CAND_TTL = 900;
  const candCache = { true: null, false: null };
  function candidates(big) {
    const hit = candCache[big];
    if (hit && performance.now() - hit.t < CAND_TTL) return hit.list;
    const out = [];
    const els = document.querySelectorAll('h1,h2,h3,h4,img,picture,video,figure,article,li,[class*="card" i],[class*="price" i],[class*="title" i],a,p,button,label');
    for (const el of els) {
      if (!/^(IMG|PICTURE|VIDEO|FIGURE)$/.test(el.tagName) && !(el.textContent || '').trim()) continue;
      if (el.children.length > (big ? 12 : 4)) continue;
      const m = measure(el, big);
      if (!m) continue;
      out.push({ el, ...m, w: big ? (0.4 + Math.random() * 0.6) * Math.sqrt(m.rect.w * m.rect.h) : Math.random() });
      if (out.length > 300) break;
    }
    out.sort((a, b) => b.w - a.w);
    candCache[big] = { t: performance.now(), list: out };
    return out;
  }
  const overlaps = (a, b, pad) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  // n целей, не налезающих на занятые
  function pick(n, busy) {
    const out = [];
    const big = STYLES[style].big;
    for (const cached of candidates(big)) {
      if (busy.some((b) => b.el === cached.el || overlaps(cached.rect, b.rect, 16)) || out.some((o) => overlaps(cached.rect, o.rect, 16))) continue;
      if (recent.includes(cached.el) && Math.random() < 0.85) continue;
      const m = measure(cached.el, big);                              // список мог устареть: прокрутка, перерисовка
      if (!m) continue;
      const c = { ...cached, ...m };
      if (busy.some((b) => overlaps(c.rect, b.rect, 16)) || out.some((o) => overlaps(c.rect, o.rect, 16))) continue;
      out.push(c);
      if (out.length >= n) break;
    }
    return out;
  }

  // ---------- Цвет ----------
  // Акцент панели при автопалитре — это цвет самого сайта: без поправки щупальце сливается со страницей.
  // Поэтому тело подгоняется по яркости до контраста ≥ 3:1 с фоном страницы, «сок» (сгустки, присоски) —
  // ещё контрастнее, а под каждой точкой — тонкий ободок противоположной яркости (читается и поверх картинок).
  let bg = [255, 255, 255];
  const mix = (c, m) => (dark ? c.map((v) => v + (255 - v) * m) : c.map((v) => v * (1 - m * 0.45))).map(Math.round);
  const light = (m) => (dark ? acc.map((c) => c + (255 - c) * m) : acc.map((c) => c * (1 - m * 0.6))).map(Math.round);   // «сок»: на тёмном — к белому, на светлом — глубже
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const parseBg = (el) => {
    const m = el && getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).map(Number);
    return a > 0.5 ? [r, g, b] : null;
  };
  // фон страницы там, где щупальца: элемент в центре экрана и его родители (у многих сайтов body прозрачный,
  // фон задан на обёртке), иначе body/html, иначе белый
  // busy — фон задан картинкой/градиентом (сплошного цвета нет): яркость фона заранее не известна
  function pageBg() {
    // картинка/градиент по дороге — отмечаем и ищем дальше сплошной фон страницы: по нему решаем, тёмная ли она
    // (живой случай: Яндекс Музыка — в центре жёлто-пурпурное пятно на чёрной странице, щупальца темнели в оливковый)
    let el = document.elementFromPoint(innerWidth * 0.5, innerHeight * 0.5), busy = false;
    for (let i = 0; el && i < 40; i++, el = el.parentElement) {
      const c = parseBg(el);
      if (c) return { c, busy };
      if (getComputedStyle(el).backgroundImage !== 'none') busy = true;
    }
    for (const e of [document.body, document.documentElement]) {
      const c = e && parseBg(e);
      if (c) return { c, busy };
      if (e && getComputedStyle(e).backgroundImage !== 'none') busy = true;
    }
    return { c: [255, 255, 255], busy };
  }
  // Цвет до нужного контраста с фоном — в HSL: оттенок сохраняется, вялому цвету поднимается насыщенность, двигается
  // только яркость (на светлом — темнее, на тёмном — светлее). Раньше цвет смешивался с чёрным/белым и серел
  // (живой прогон 2048: коричневый акцент сайта превращался в почти чёрный — щупальца «чёрно-белые»).
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s2 = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s2, l];
  }
  function fromHsl([h, s2, l]) {
    const c = (1 - Math.abs(2 * l - 1)) * s2, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map((v) => Math.round((v + m) * 255));
  }
  function withContrast(c, min) {
    let [h, s2, l] = toHsl(c);
    s2 = Math.max(s2, 0.35);                                      // совсем серому акценту — немного цвета (иначе чёрно-белое)
    for (let i = 0; i <= 25; i++) {
      const x = fromHsl([h, s2, l]);
      if (contrast(x, bg) >= min) return x;
      l = dark ? Math.min(0.95, l + 0.03) : Math.max(0.12, l - 0.03);
    }
    return fromHsl([h, s2, dark ? 0.85 : 0.22]);
  }

  // ---------- Геометрия ----------
  // Ломаная от края к цели: суставы поперёк прямой, знаки чередуются — зигзаг с острыми углами.
  function zigzag(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    const n = 4 + Math.floor(Math.random() * 3), amp = Math.min(46, L * 0.12);
    const pts = [from, { x: from.x + Math.min(40, L * 0.08) * Math.sign(dx || -1), y: from.y }];   // выход — горизонтально, из панели
    for (let i = 1; i < n; i++) {
      const t = i / n, off = amp * (0.55 + Math.random() * 0.45) * Math.sin(Math.PI * t) * (i % 2 ? side : -side);
      pts.push({ x: from.x + dx * t + nx * off, y: from.y + dy * t + ny * off });
    }
    pts.push({ x: to.x, y: to.y });
    return pts;
  }
  // Плавная: кубическая кривая (выход горизонтально), разложенная в мелкую ломаную.
  function curve(from, to, n = 28) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const p = [from, { x: from.x + dx * 0.42, y: from.y }, { x: to.x - dx * 0.2, y: to.y - dy * 0.25 }, to], out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push({ x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x,
        y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y });
    }
    return out;
  }
  // Извилистая (корни): кривая плюс медленная волна поперёк и мелкий разброс.
  function meander(from, to, amp, n = 24) {
    const base = curve(from, to, n), f1 = 1.5 + Math.random() * 1.5, f2 = 3 + Math.random() * 3, p1 = Math.random() * 6.28, p2 = Math.random() * 6.28;
    return base.map((p, i) => {
      if (i === 0 || i === n) return p;
      const q = base[Math.min(n, i + 1)], o = base[i - 1], l = Math.hypot(q.x - o.x, q.y - o.y) || 1, t = i / n;
      const off = amp * Math.sin(Math.PI * t) * (Math.sin(t * f1 * 6.28 + p1) * 0.7 + Math.sin(t * f2 * 6.28 + p2) * 0.3) + (Math.random() - 0.5) * 3;
      return { x: p.x - (q.y - o.y) / l * off, y: p.y + (q.x - o.x) / l * off };
    });
  }
  // Отростки вдоль тела (корни): с точек пути вбок, иногда с развилкой.
  function twigs(path) {
    const out = [], n = path.length - 1;
    for (let j = 3; j < n - 2; j += 2) {
      if (Math.random() < 0.3) continue;
      const a = path[j], b = path[j + 1], ang = Math.atan2(b.y - a.y, b.x - a.x) + (Math.random() < 0.5 ? 1 : -1) * (0.7 + Math.random() * 0.7);
      const len = 14 + Math.random() * 24, pts = [a];
      for (let s = 1; s <= 3; s++) {
        const bend = ang + (Math.random() - 0.5) * 0.6 * s;
        const p = pts[pts.length - 1];
        pts.push({ x: p.x + Math.cos(bend) * len / 3, y: p.y + Math.sin(bend) * len / 3 });
      }
      const w = easeInOut(j / n), t0 = j / n;
      out.push({ pts, w, t0 });
      if (Math.random() < 0.4) {
        const m = pts[2], a2 = ang + (Math.random() < 0.5 ? 0.9 : -0.9);
        out.push({ pts: [m, { x: m.x + Math.cos(a2) * len * 0.35, y: m.y + Math.sin(a2) * len * 0.35 }], w, t0: t0 + 0.04 });
      }
    }
    return out;
  }
  // Корешки по элементу: от кончика к случайным точкам внутри захвата, извилисто.
  function rootlets(tip, r) {
    const out = [], n = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const end = { x: r.x + r.w * (0.05 + Math.random() * 0.9), y: r.y + r.h * (0.05 + Math.random() * 0.9) }, pts = [tip];
      for (let s = 1; s <= 4; s++) { const q = lerp(tip, end, s / 4); pts.push(s === 4 ? q : { x: q.x + (Math.random() - 0.5) * 10, y: q.y + (Math.random() - 0.5) * 10 }); }
      out.push({ pts, w: 1, delay: i * 40 });
    }
    return out;
  }
  // Когти: от кончика к углам (у широких — и к серединам верха и низа); локоть выгнут наружу, на конце крюк внутрь.
  function claws(tip, r) {
    const grips = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    if (r.w > 200) grips.push([r.x + r.w / 2, r.y], [r.x + r.w / 2, r.y + r.h]);
    return grips.map(([gx, gy], i) => {
      const dx = gx - tip.x, dy = gy - tip.y, L = Math.hypot(dx, dy) || 1;
      const out = Math.min(26, L * 0.3) * (i % 2 ? 1 : -1);
      const elbow = { x: tip.x + dx * 0.55 - dy / L * out, y: tip.y + dy * 0.55 + dx / L * out };
      const hx = r.x + r.w / 2 - gx, hy = r.y + r.h / 2 - gy, hl = Math.hypot(hx, hy) || 1;
      const hook = { x: gx + hx / hl * 7, y: gy + hy / hl * 7 };   // крюк загнут к центру элемента
      return { pts: [tip, elbow, { x: gx, y: gy }, hook], w: 1, delay: i * CLAW_STAGGER };
    });
  }
  // ---------- Виды ----------
  // reach — мс на бросок; big — крупные цели; tip(rect) — куда кончик; build(it) — линии вида (it.g), draw(it, k, time).
  // Линия { pts, w }: w — насколько она едет вместе с элементом при прокрутке (1 — целиком, 'path' — по длине тела).
  const STYLES = {
    jagged: { reach: 380, big: true, tip: (r) => ({ x: Math.min(r.x + r.w - 6, r.x + r.w * 0.72), y: r.y + r.h / 2 }),
      build: (it) => ({ path: { pts: zigzag(it.from, it.tip), w: 'path' }, claws: claws(it.tip, it.rect) }), draw: drawJagged },
    smooth: { reach: 520, big: false, tip: (r) => ({ x: r.x + Math.min(r.w * 0.5, 60), y: r.y + r.h / 2 }),
      build: (it) => ({ path: { pts: curve(it.from, it.tip), w: 'path' } }), draw: drawSmooth },
    roots: { reach: 900, big: true, tip: (r) => ({ x: r.x + r.w * 0.66, y: r.y + r.h / 2 }),
      build: (it) => { const pts = meander(it.from, it.tip, 26); return { path: { pts, w: 'path' }, twigs: twigs(pts), roots: rootlets(it.tip, it.rect) }; }, draw: drawRoots },
  };

  // Щупальце к цели c; i из n — место в пучке (у края чуть разведены).
  function launch(c, i, n, now, hold) {
    const S = STYLES[style], from = { x: innerWidth + 12, y: exitY + (i - (n - 1) / 2) * 5 };
    const it = { ...c, from, tip: S.tip(c.rect), start: now, seed: Math.random() * 1000, ph: Math.random() * 6.28, style, reach: S.reach, hold, dx: 0, dy: 0 };
    it.g = S.build(it);
    it.base = { rect: it.rect, tip: it.tip, g: it.g };            // геометрия в момент захвата — от неё сдвиг
    return it;
  }

  // Держится за элемент: сдвиг элемента с момента захвата (прокрутка, перерисовка) переносит всё, что на элементе,
  // а суставы тела — тем сильнее, чем ближе к кончику (у края панели тело на месте, щупальце изгибается следом).
  // false — элемент ушёл с экрана или пропал.
  function shiftLine(l, dx, dy) {
    const n = l.pts.length - 1;
    return { ...l, pts: l.pts.map((p, i) => { const w = l.w === 'path' ? easeInOut(i / (n || 1)) : l.w; return { x: p.x + dx * w, y: p.y + dy * w }; }) };
  }
  function follow(it) {
    const r = it.el && it.el.isConnected ? it.el.getBoundingClientRect() : null;
    if (!r || (!r.width && !r.height)) return false;
    const dx = r.left - it.at.x, dy = r.top - it.at.y, b = it.base;
    if (dx !== it.dx || dy !== it.dy) {
      it.dx = dx; it.dy = dy;
      it.rect = { x: b.rect.x + dx, y: b.rect.y + dy, w: b.rect.w, h: b.rect.h };
      it.tip = { x: b.tip.x + dx, y: b.tip.y + dy };
      it.g = {};
      for (const [k, v] of Object.entries(b.g)) it.g[k] = Array.isArray(v) ? v.map((l) => shiftLine(l, dx, dy)) : shiftLine(v, dx, dy);
    }
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function prepare(color, fromBottom, st) {
    if (Array.isArray(color)) acc = color;
    if (STYLES[st]) style = st;
    exitY = Math.max(24, Math.min(innerHeight - 24, typeof fromBottom === 'number' ? innerHeight - fromBottom : innerHeight * 0.45));
    // цвет — акцентный цвет панели: на тёмной странице как есть; на светлой (и на пёстром фоне — картинка,
    // градиент) — тот же оттенок темнее, до контраста ~2.5:1 с фоном. Без обводки точек.
    // тёмная/светлая — по сплошному фону страницы (пятна и картинки поверх не в счёт); слабый акцент подтягивается:
    // на светлой — темнее до ~2.5:1, на тёмной — светлее до 3:1; яркий остаётся как есть
    const pb = pageBg();
    bg = pb.c;
    dark = lum(bg) < 0.25;
    acc = withContrast(acc, dark ? 3 : 2.5);
  }

  // Один заход: до MAX щупалец разом, каждое держит T_SUCK. fromBottom — расстояние от мозга до низа панели:
  // панель и вкладка в одном окне, низ у них общий, поэтому та же высота на странице — innerHeight − fromBottom.
  function run(color, fromBottom, st) {
    prepare(color, fromBottom, st);
    const targets = pick(MAX, []).sort((a, b) => a.rect.y - b.rect.y);   // по высоте: щупальца не перекрещиваются
    if (!targets.length) return 0;
    mount();
    const now = performance.now();
    side = Math.random() < 0.5 ? 1 : -1;                         // изгиб у всех в одну сторону — пучок не путается
    items = targets.map((c, i) => launch(c, i, targets.length, now + i * STAGGER, T_SUCK));
    if (!raf) raf = requestAnimationFrame(frame);
    return items.length;
  }
  // Постоянный режим: щупальца сменяют друг друга, пока не вызовут stop(). Повторный start обновляет цвет, высоту и вид.
  function start(color, fromBottom, st) {
    prepare(color, fromBottom, st);
    if (!looping) { looping = true; nextSpawn = 0; side = Math.random() < 0.5 ? 1 : -1; }
    link();
    if (!looping) return 0;                                       // связи с панелью нет — не начинаем
    mount();
    if (!raf) raf = requestAnimationFrame(frame);
    return MAX;
  }
  // Всё отпускает и втягивается; слой исчезнет сам.
  function stop() {
    looping = false;
    const now = performance.now();
    for (const it of items) { const k = now - it.start; if (k < it.reach + it.hold) it.hold = Math.max(0, k - it.reach); }
    return true;
  }

  function frame(now) {
    raf = 0;
    if (!ctx) return;
    // постоянный режим: держим MAX щупалец (не считая втягивающихся), новое — к другому элементу
    if (looping) {
      const holding = items.filter((it) => now - it.start < it.reach + it.hold);
      if (holding.length < MAX && now >= nextSpawn) {
        const [c] = pick(1, holding);
        if (c) items.push(launch(c, holding.length, MAX, now, HOLD_MIN + Math.random() * (HOLD_MAX - HOLD_MIN)));
        nextSpawn = now + SPAWN_GAP + Math.random() * 300;
      }
    }
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    cv.style.visibility = now < hiddenUntil ? 'hidden' : 'visible';
    const time = now / 1000;
    for (const it of items) if (now - it.start >= it.reach + it.hold + T_RETRACT && !recent.includes(it.el)) { recent.push(it.el); if (recent.length > 4) recent.shift(); }
    items = items.filter((it) => now - it.start < it.reach + it.hold + T_RETRACT);
    for (const it of items) {
      const k = now - it.start;
      if (k < 0) continue;
      // едет вместе с элементом; ушёл с экрана или пропал — отпускаем раньше
      if (!follow(it) && k < it.reach + it.hold) it.hold = Math.max(0, k - it.reach);
      STYLES[it.style].draw(it, k, time);
    }
    ctx.globalAlpha = 1;
    if (items.length || looping) raf = requestAnimationFrame(frame);
    else unmount();                                          // всё втянулось — слоя на странице больше нет
  }

  // ---------- Общие куски отрисовки ----------
  // Точка на ломаной по доле длины 0..1, нормаль её отрезка, номер отрезка и доля внутри него.
  function along(pts, t) {
    const lens = pts.lens || (pts.lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y)));
    const total = pts.total || (pts.total = lens.reduce((a, b) => a + b, 0) || 1);
    let d = t * total, i = 0;
    while (i < lens.length - 1 && d > lens[i]) { d -= lens[i]; i++; }
    const a = pts[i], b = pts[i + 1] || a, l = lens[i] || 1, u = Math.min(1, d / l);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, nx: -(b.y - a.y) / l, ny: (b.x - a.x) / l, seg: i, u };
  }
  const lengthOf = (pts) => { along(pts, 0); return pts.total; };
  // Дрожь суставов: ступеньками ~18 раз в секунду (рывки, а не волна); amp — px; pin — сколько точек с конца не трогать.
  function jitter(pts, seed, time, amp, pin) {
    const step = Math.floor(time * 18);
    return pts.map((p, i) => (i === 0 || i >= pts.length - pin) ? p :
      { x: p.x + (hash(seed + i, step) - 0.5) * 2 * amp, y: p.y + (hash(seed + i * 7.3, step + 0.5) - 0.5) * 2 * amp });
  }
  // фазы: sucking — держит; sk — 0..1 по кругу (сгустки); rk — 0..1 втягивания; pull — толчки хватки 0..1
  function phases(it, k) {
    const sucking = k >= it.reach && k <= it.reach + it.hold;
    const sk = sucking ? ((k - it.reach) / T_SUCK) % 1 : 0;
    const rk = k > it.reach + it.hold ? (k - it.reach - it.hold) / T_RETRACT : 0;
    const pull = sucking ? Math.pow(Math.max(0, Math.sin(((k - it.reach) / T_SUCK) * Math.PI * 2 * 3.3)), 3) : 0;
    const lumps = sucking ? [0, 1, 2].map((j) => 1 - ((sk * 2.2 + j / 3) % 1)) : [];
    return { sucking, sk, rk, pull, lumps };
  }
  const bulgeAt = (lumps, t) => { let b = 0; for (const u of lumps) b = Math.max(b, Math.max(0, 1 - Math.abs(t - u) * 14)); return b; };

  // Клетки сетки: тело рисуется кружками на сетке GRID (как точки мозга в панели).
  function cellsOf() {
    const cells = new Map();
    const put = (x, y, r, v, t) => {
      const g0x = Math.floor((x - r) / GRID), g1x = Math.ceil((x + r) / GRID), g0y = Math.floor((y - r) / GRID), g1y = Math.ceil((y + r) / GRID);
      for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) {
        const cx = gx * GRID, cy = gy * GRID, d = Math.hypot(cx - x, cy - y);
        if (d > Math.max(r, GRID * 0.5)) continue;
        const vv = Math.max(v * (1 - 0.4 * Math.min(1, d / Math.max(r, 0.01)) ** 2), v > 1.15 ? v : 0);
        const key = gx * 100003 + gy, old = cells.get(key);
        if (!old || old[0] < vv) cells.set(key, [vv, t, cx, cy]);
      }
    };
    // линия по доле 0..upto: радиус и яркость — функции доли
    const line = (pts, upto, rad, val, tOf = (t) => t) => {
      const steps = Math.max(4, Math.round(lengthOf(pts) / 2));
      for (let s = 0; s <= steps * upto; s++) { const t = s / steps, p = along(pts, t); put(p.x, p.y, rad(t, p), val(t, p), tOf(t)); }
    };
    const paint = (alphaMul = 1) => {
      const cr = GRID * 0.46;                                       // крупнее — щупальце читается, а не сеткой
      for (const [v, t, cx, cy] of cells.values()) {
        ctx.globalAlpha = Math.min(1, 0.75 + 0.25 * v) * alphaMul;   // плотнее: полупрозрачное терялось на тёмном
        // сгустки и кончики — «сок» (контрастнее тела), тело — акцент, поправленный под фон
        ctx.fillStyle = rgb(v > 1.15 ? light(0.55) : mix(acc, t * 0.5));
        ctx.beginPath(); ctx.arc(cx, cy, v > 1.15 ? cr * 1.25 : cr, 0, 6.2832); ctx.fill();
      }
    };
    return { put, line, paint };
  }
  const dot = (x, y, a, c, r = GRID * 0.4) => { ctx.globalAlpha = a; ctx.fillStyle = c; ctx.beginPath(); ctx.arc(Math.round(x / GRID) * GRID, Math.round(y / GRID) * GRID, r, 0, 6.2832); ctx.fill(); };
  const tint = (rc, a) => { ctx.globalAlpha = a; ctx.fillStyle = rgb(acc); ctx.fillRect(rc.x, rc.y, rc.w, rc.h); };
  // рост тела: при втягивании сначала уходит то, что на элементе (первые lead), потом тело
  const growth = (it, k, rk, lead, ease = easeOut) => (k < it.reach ? ease(k / it.reach) : rk ? 1 - easeInOut((rk - lead) / (1 - lead)) : 1);
  const onElement = (k, it, rk, lead) => (k >= it.reach ? (rk ? 1 - clamp01(rk / lead) : 1) : 0);

  // ---------- Ломаные ----------
  function drawJagged(it, k, time) {
    const { rk, pull, lumps } = phases(it, k);
    const g = growth(it, k, rk, 0.3);
    const impact = k >= it.reach ? Math.max(0, 1 - (k - it.reach) / 220) : 0;   // удар при касании
    const path = jitter(it.g.path.pts, it.seed, time, 1.2 + impact * 5 + pull * 2.2, 1);
    const { put, line, paint } = cellsOf();
    // тело: толще у края, сужается к кончику; суставы — узлы потолще
    line(path, g, (t, p) => 7 - 4 * Math.pow(t, 0.8) + bulgeAt(lumps, t) * 2 + ((p.u < 0.06 || p.u > 0.94) && p.seg > 0 ? 1.6 : 0),
      (t) => { const b = bulgeAt(lumps, t); return b > 0.3 ? 1.2 + b * 0.4 : 1; });
    // когти и сеть на элементе — только пока кончик на месте
    const open = g >= 0.999 ? onElement(k, it, rk, 0.3) : 0;
    if (open > 0) {
      const tipNow = path[path.length - 1], rc = it.rect, net = open * clamp01((k - it.reach - 90) / 260);
      if (net > 0) {
        // сеть по захвату: точки с шагом 3 клетки, стягиваются к кончику в толчок; контур — гуще
        const step = GRID * 3, sq = 0.05 * pull;
        for (let y = rc.y; y <= rc.y + rc.h + 0.1; y += step) for (let x = rc.x; x <= rc.x + rc.w + 0.1; x += step) {
          const edge = x < rc.x + step * 0.5 || y < rc.y + step * 0.5 || x > rc.x + rc.w - step * 0.5 || y > rc.y + rc.h - step * 0.5;
          dot(x + (tipNow.x - x) * sq, y + (tipNow.y - y) * sq, net * (edge ? 0.95 : 0.4 + 0.25 * pull + 0.1 * hash(x, y + Math.floor(time * 12))), rgb(edge ? mix(acc, 0.3) : acc));
        }
        tint(rc, net * (0.07 + 0.08 * pull));
      }
      for (const c of it.g.claws) {
        const ck = rk ? open : easeOut(clamp01((k - it.reach - c.delay) / T_CLAW));
        if (ck <= 0) continue;
        // в толчок когти подтягиваются к кончику
        const cp = jitter(c.pts.map((q, i) => (i === 0 ? tipNow : lerp(q, tipNow, pull * 0.06))), it.seed + 50, time, 0.6 + pull, 2);
        line(cp, ck, (t, p) => 2.6 - 1.4 * t + (p.seg === 1 && p.u < 0.1 ? 1 : 0), (t) => (t > 0.97 ? 1.5 : 1), () => 1);
      }
    }
    paint();
  }

  // ---------- Плавные ----------
  const wob = (t, time, ph) => Math.sin(t * 7.1 + time * 2.3 + ph) * 0.9 + Math.sin(t * 13.7 - time * 3.1 + ph * 1.7) * 0.6;
  function drawSmooth(it, k, time) {
    const { sucking, rk, lumps } = phases(it, k);
    const g = k < it.reach ? easeOut(k / it.reach) : rk ? 1 - easeInOut(rk) : 1;
    const pts = it.g.path.pts, steps = Math.max(12, Math.round(lengthOf(pts) / 2));
    const { put, paint } = cellsOf();
    for (let s = 0; s <= steps * g; s++) {
      const t = s / steps, p = along(pts, t), wv = 2.6 * wob(t, time, it.ph) * Math.sin(Math.PI * t);
      const x = p.x + p.nx * wv, y = p.y + p.ny * wv, b = bulgeAt(lumps, t), r = 6.5 - 4.2 * Math.pow(t, 0.8) + b * 1.8;
      put(x, y, r, b > 0.3 ? 1.2 + b * 0.4 : 1, t);
      if (s % 8 === 4 && t > 0.08 && t < 0.9) put(x + p.nx * r * 0.55, y + p.ny * r * 0.55, Math.max(1.3, r * 0.38), 1.6, t);   // присоски
    }
    paint();
    if (sucking || (k > it.reach * 0.9 && !rk)) {
      // присос: кольцо из кружков вокруг кончика пульсирует, элемент слегка подсвечен
      const a = sucking ? 1 : g, R = 7 + 2 * Math.sin(time * 14);
      for (let j = 0; j < 14; j++) dot(it.tip.x + Math.cos(j / 14 * 6.2832) * R, it.tip.y + Math.sin(j / 14 * 6.2832) * R, 0.8 * a, rgb(mix(acc, 0.3)));
      tint(it.rect, 0.08 * a * (0.7 + 0.3 * Math.sin(time * 9)));
    }
  }

  // ---------- Корни ----------
  function drawRoots(it, k, time) {
    const { rk, pull, lumps } = phases(it, k);
    const g = growth(it, k, rk, 0.4, easeInOut);                 // прорастает ровно, без рывка
    const { line, paint } = cellsOf();
    const sway = (pts, amp) => pts.map((p, i) => (i === 0 ? p : { x: p.x + Math.sin(time * 1.3 + i * 0.7 + it.ph) * amp, y: p.y + Math.cos(time * 1.1 + i * 0.9 + it.ph) * amp }));
    line(sway(it.g.path.pts, 0.6), g, (t) => 5 - 3 * Math.pow(t, 0.7) + bulgeAt(lumps, t) * 1.6,
      (t) => { const b = bulgeAt(lumps, t); return b > 0.3 ? 1.2 + b * 0.4 : 0.95; });
    // отростки растут, когда тело прошло их место; при втягивании засыхают первыми
    const wither = rk ? 1 - clamp01(rk / 0.4) : 1;
    for (const tw of it.g.twigs) {
      const tg = clamp01((g - tw.t0) / 0.18) * wither;
      if (tg > 0) line(sway(tw.pts, 0.8), tg, (t) => 1.7 - 0.9 * t, (t) => (t > 0.96 ? 1.3 : 0.9), (t) => tw.t0 + t * 0.2);
    }
    // корешки по элементу: расползаются от кончика, в толчок чуть стягиваются; на концах — узелки
    const spread = g >= 0.999 ? onElement(k, it, rk, 0.4) : 0;
    if (spread > 0) {
      for (const r of it.g.roots) {
        const rg = rk ? spread : easeOut(clamp01((k - it.reach - r.delay) / 520));
        if (rg <= 0) continue;
        const pts = sway(r.pts.map((q, i) => (i ? lerp(q, it.tip, pull * 0.05) : q)), 1);
        line(pts, rg, (t) => 1.9 - 0.8 * t, (t) => (t > 0.97 ? 1.45 : 0.95), () => 0.8);
      }
      tint(it.rect, spread * (0.05 + 0.05 * pull));
    }
    paint();
  }

  window.__crawlerSuck = {
    v: VERSION,
    styles: Object.keys(STYLES),
    run, start, stop,
    timing: { suck: T_SUCK, retract: T_RETRACT, stagger: STAGGER },
    // перед снимком экрана: щупальца не должны попасть в то, что видит модель. Разовый заход — убрать совсем;
    // постоянный режим — спрятать слой на ms (снимок успеет), потом щупальца снова видны.
    hide(ms) {
      if (looping && ms) { hiddenUntil = performance.now() + ms; if (cv) cv.style.visibility = 'hidden'; return true; }
      looping = false; items = []; unmount(); return true;
    }
  };
})();
