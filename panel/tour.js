'use strict';
/* tour.js — обучение при первом запуске панели: затемнение с вырезом вокруг кнопки, по контуру — рамка из точек
 * (как мозг); при смене шага точки сматываются со старой рамки, тянутся линией и наматываются на новую. Карточка — по центру. «Далее/Назад», «Пропустить» на любом шаге (стрелки, Enter, Esc).
 * Пройдено или пропущено — запоминается (chrome.storage: tourDone) и само больше не открывается;
 * заново — кнопкой в настройках (Tour.start()).
 * Подключение: Tour.init({ home }) — home закрывает открытые экраны (обучение идёт по главному); Tour.maybeStart().
 */

const Tour = (() => {
  const KEY = 'tourDone';
  // target — селектор или список (вырез охватывает все видимые); null — карточка по центру, без выреза.
  const STEPS = [
    { target: '#btnSettings', title: 'Как поставить модель', text: ['Шестерёнка → провайдер, API-ключ, модель.'] },
    { target: '#modelChip', title: 'Быстрая смена модели', text: [] },
    { target: '#riskSeg', title: 'Спрашивать / делать', text: ['Будьте осторожны )'] },
    { target: ['#btnNew', '#btnSettings'], title: 'Настройки / новый чат', text: [] },
    // rows: пункты-строки, от каждого к его кнопке тянется линия (word выделен)
    { target: ['#btnCopyLog', '#btnLearn', '#btnSkills', '.view-tabs'], title: 'Скопировать всё / изучить сайт / заметки', text: [],
      rows: [
        { word: 'Скопировать всё', rest: ' — весь лог', target: '#btnCopyLog' },
        { word: 'Изучить сайт', rest: '', target: '#btnLearn' },
        { word: 'Заметки', rest: ' — подсказки для модели, если тупит', target: '#btnSkills' },
        { word: 'Действия', rest: ' — всё, что делает модель', target: '#tabActions' },
        { word: 'Чат', rest: ' — только ответы', target: '#tabChat' }
      ] },
    { target: '.compose-row', title: 'Скрипты',
      text: ['/skript + задача: модель один раз пишет скрипт, дальше он работает без неё.', 'Например, «/skript научись играть в 2048». Скрипты могут видеть код страницы и даже скриншоты.'] },
    { target: '#btnSkills', title: 'Сохранённые скрипты', text: [] },
    { target: '#stage', title: 'Наслаждайтесь)', text: [] }
  ];

  let root = null, card = null, i = 0, home = null;

  // ---------- Рамка из точек и затемнение (холст) ----------
  // как у мозга (art-net.js): сетка CELL 2,5 px, кружок 0,72 клетки; линия — точка в каждой клетке
  const CELL = 2.5, DOT_R = CELL * 0.72 / 2, CORNER = 12;
  let fx = null, g = null, raf = 0;
  let frame = null;            // { rect, hole, from, start } — куда рамка, есть ли вырез, откуда летит и когда начала
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';
  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const css = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  // прямоугольник { x, y, w, h, c }: c — радиус скругления (у кнопок CORNER, вокруг карточки — как у неё)
  const rc = (r) => Math.min(r.c ?? CORNER, r.w / 2, r.h / 2);
  const lerpR = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t, c: (a.c ?? CORNER) + ((b.c ?? CORNER) - (a.c ?? CORNER)) * t });
  const dotOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0, c: r.c });   // прямоугольник, сжатый в точку
  // Точка на контуре скруглённого прямоугольника по доле обхода 0..1 (по часовой, от верхнего левого края прямой).
  function onPerimeter(r, f) {
    const c = rc(r), sw = r.w - 2 * c, sh = r.h - 2 * c, arc = Math.PI * c / 2;
    let d = (((f % 1) + 1) % 1) * (2 * sw + 2 * sh + 4 * arc);
    const corner = (cx, cy, a0) => (t) => ({ x: cx + c * Math.cos(a0 + t / (c || 1)), y: cy + c * Math.sin(a0 + t / (c || 1)) });
    const segs = [
      [sw, (t) => ({ x: r.x + c + t, y: r.y })], [arc, corner(r.x + r.w - c, r.y + c, -Math.PI / 2)],
      [sh, (t) => ({ x: r.x + r.w, y: r.y + c + t })], [arc, corner(r.x + r.w - c, r.y + r.h - c, 0)],
      [sw, (t) => ({ x: r.x + r.w - c - t, y: r.y + r.h })], [arc, corner(r.x + c, r.y + r.h - c, Math.PI / 2)],
      [sh, (t) => ({ x: r.x, y: r.y + r.h - c - t })], [arc, corner(r.x + c, r.y + c, Math.PI)]
    ];
    for (const [len, at] of segs) { if (d <= len) return at(d); d -= len; }
    return { x: r.x + c, y: r.y };
  }
  const perimeterOf = (r) => { const c = rc(r); return 2 * (r.w + r.h - 4 * c) + 2 * Math.PI * c; };
  function roundRect(ctx, r) {
    const c = rc(r);
    ctx.beginPath(); ctx.moveTo(r.x + c, r.y); ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, c); ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, c);
    ctx.arcTo(r.x, r.y + r.h, r.x, r.y, c); ctx.arcTo(r.x, r.y, r.x + r.w, r.y, c); ctx.closePath();
  }
  const FLOW_MS = 760;
  const easeIO = (t) => { t = Math.min(1, Math.max(0, t)); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  // Доля обхода контура, ближайшая к точке p (по 96 пробам).
  function nearestF(r, p) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < 96; j++) { const q = onPerimeter(r, j / 96), d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; best = j / 96; } }
    return best;
  }
  // Новая цель рамки. Путь перелёта общий для всех точек: старый контур (от точки выхода A) → прямая A→B →
  // новый контур (от точки входа B). Точка k едет по этому пути со своего места на старом контуре на своё место
  // на новом — точки сматываются со старой рамки, тянутся линией и наматываются на новую. В первый раз — из центра.
  function aim(rect, hole) {
    const now = performance.now();
    const old = frame ? (now - frame.start < FLOW_MS / 2 ? frame.from.rect : frame.rect) : dotOf(rect);
    const oldHole = frame ? frame.hole : false;
    const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const fA = old.w ? nearestF(old, c) : 0, A = old.w ? onPerimeter(old, fA) : { x: old.x, y: old.y };
    const fB = nearestF(rect, A), B = onPerimeter(rect, fB);
    frame = { rect, hole, start: reduce() ? now - FLOW_MS : now,
      from: { rect: old, hole: oldHole }, fA, fB, A, B,
      Lold: old.w ? perimeterOf(old) : 0, Lb: Math.hypot(B.x - A.x, B.y - A.y), Lnew: perimeterOf(rect) };
    if (!raf) raf = requestAnimationFrame(draw);
  }
  // Точка пути перелёта на расстоянии d от его начала.
  function pathAt(d) {
    const F = frame;
    if (d <= F.Lold && F.Lold > 0) return onPerimeter(F.from.rect, F.fA + d / F.Lold);
    d -= F.Lold;
    if (d <= F.Lb) { const t = F.Lb ? d / F.Lb : 1; return { x: F.A.x + (F.B.x - F.A.x) * t, y: F.A.y + (F.B.y - F.A.y) * t }; }
    return onPerimeter(F.rect, F.fB + (d - F.Lb) / F.Lnew);
  }
  function draw(now) {
    raf = 0;
    if (!fx || !frame) return;
    const dpr = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight;
    if (fx.width !== Math.round(W * dpr) || fx.height !== Math.round(H * dpr)) { fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const F = frame, k = easeIO((now - F.start) / FLOW_MS);
    // затемнение с вырезом: вырез переезжает вместе с рамкой; к шагу без кнопки — сжимается, от него — раскрывается
    g.fillStyle = css('--scrim', 'rgba(0,0,0,.6)');
    g.fillRect(0, 0, W, H);
    const h0 = F.from.hole ? F.from.rect : dotOf(F.rect), h1 = F.hole ? F.rect : dotOf(F.from.rect);
    const holeR = F.hole || F.from.hole ? lerpR(h0, h1, k) : null;
    if (holeR && holeR.w > 1 && holeR.h > 1) { g.globalCompositeOperation = 'destination-out'; roundRect(g, holeR); g.fill(); g.globalCompositeOperation = 'source-over'; }
    // точки: k-я — с места k/n старого контура на место k/n нового, по общему пути
    // точки встают в клетки сетки, как у мозга: одна клетка — одна точка (ярче из попавших)
    const n = Math.max(24, Math.round(F.Lnew / CELL)), moving = k < 1;
    const shimmer = reduce() || moving ? -1 : (now / 2600) % 1;
    const cells = new Map();
    for (let j = 0; j < n; j++) {
      const f = j / n, d0 = f * F.Lold, d1 = F.Lold + F.Lb + f * F.Lnew;
      const p = pathAt(d0 + (d1 - d0) * k);
      // блик: светлая волна бежит по готовой рамке; в полёте точки яркие
      const dist = shimmer < 0 ? 1 : Math.min(Math.abs(f - shimmer), 1 - Math.abs(f - shimmer));
      const glow = moving ? 1 : Math.max(0, 1 - dist * 14);
      const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL), key = gx * 100003 + gy;
      if ((cells.get(key)?.[2] ?? -1) < glow) cells.set(key, [gx, gy, glow]);
    }
    g.fillStyle = css('--acc', '#f5f5f5');
    for (const [gx, gy, glow] of cells.values()) {
      g.globalAlpha = 0.6 + 0.4 * glow;
      g.beginPath(); g.arc(gx * CELL + CELL / 2, gy * CELL + CELL / 2, DOT_R * (glow > 0.6 && !moving ? 1.35 : 1), 0, 6.2832); g.fill();
    }
    g.globalAlpha = 1;
    drawLinks(now, moving);
    if (moving || !reduce()) raf = requestAnimationFrame(draw);
  }

  // ---------- Линии от пунктов к кнопкам (шаг с rows) ----------
  // Точками на сетке, как связи мозга, повороты скруглены. Прорастают по очереди, когда рамка встала. Маршрут без пересечений:
  // от конца строки вправо за край карточки (на узкой панели — в её правый отступ) → вверх по своей дорожке → к кнопке → вверх в неё. Пункты идут
  // в порядке кнопок слева направо: левой кнопке — ближняя к карточке дорожка и самый низкий поворот.
  // Кнопка правее дорожек — напрямую: вправо до неё и вверх (тоже с дугой).
  const LINK_MS = 420, LINK_STAGGER = 110, LANE = CELL * 2;   // дорожки — через клетку, чтобы линии не сливались
  const PAD = 50;                                                 // правый отступ карточки с линиями (.tour-card.has-links)
  let lk = null, lg = null, links = [], routeMemo = null;
  // Геометрия линий — один раз на шаг (сброс в render: смена шага и размера панели), а не каждый кадр:
  // на шаге со строками это десятки замеров DOM за кадр. Длины отрезков — тут же.
  function cachedRoutes() {
    if (!routeMemo) routeMemo = routes().map((it) => {
      if (!it) return null;
      const segs = it.pts.slice(1).map((p, k) => Math.hypot(p.x - it.pts[k].x, p.y - it.pts[k].y));
      return { pts: it.pts, segs, total: segs.reduce((a, b) => a + b, 0) };
    });
    return routeMemo;
  }
  function routes() {
    const items = links.map((l) => {
      const b = document.querySelector(l.target)?.getBoundingClientRect();
      const rects = (() => { const rg = document.createRange(); rg.selectNodeContents(l.row); return [...rg.getClientRects()]; })();
      const last = rects[rects.length - 1] || l.row.getBoundingClientRect();
      return b && b.width ? { a: { x: last.right + 5, y: last.top + last.height / 2 }, bx: b.left + b.width / 2, by: b.bottom + 3 } : null;
    });
    const out = layoutLinks(items, { cr: card.offsetLeft + card.offsetWidth, ct: card.offsetTop, width: innerWidth });
    return out.map((pts) => (pts ? { pts: rounded(pts) } : null));
  }
  // Маршруты линий (без скруглений): items — [{ a: конец строки, bx, by: низ кнопки } | null] в порядке строк,
  // cr/ct — правый и верхний край карточки, width — ширина окна. Чистая функция (тесты: tour.test.js).
  function layoutLinks(items, { cr, ct, width }) {
    // кнопки правее карточки — напрямую: прямая вниз и одна дуга к строке (их строки самые нижние). Остальные — по
    // дорожкам; дорожки снаружи карточки, только если там есть место и они не встанут правее прямых линий
    // (иначе пересечение) — тогда внутри её правого отступа
    const all = items.filter(Boolean).sort((p, q) => p.bx - q.bx);
    const laned = all.filter((it) => it.bx < cr - 2), direct = all.filter((it) => it.bx >= cr - 2);
    const n = laned.length, lastBx = n ? laned[n - 1].bx : 0;
    // самая правая кнопка на дорожках висит над правым отступом карточки — дорожки строятся от неё: её линия прямая,
    // остальные левее, все в отступе (не через текст)
    const anchored = n && lastBx <= cr - 4 && lastBx - (n - 1) * LANE >= cr - PAD + 4;
    const outside = !anchored && width - cr >= 10 + n * LANE && direct.every((it) => it.bx > cr + 13 + n * LANE);
    const lanes = laned.map((it, j) => (anchored ? lastBx - (n - 1 - j) * LANE : outside ? cr + 7 + j * LANE : cr - 6 - (n - 1 - j) * LANE));
    // кнопка почти над своей дорожкой — дорожка встаёт прямо под неё (не через текст и не на соседние): прямая без ступеньки
    for (let j = laned.length - 1; j >= 0; j--) {
      const bx = laned[j].bx;
      if ((outside ? bx > cr + 2 : bx >= cr - 30) && Math.abs(bx - lanes[j]) < 2 * BEND && (j === 0 || bx >= lanes[j - 1] + LANE) && (j === laned.length - 1 || bx <= lanes[j + 1] - LANE)) lanes[j] = bx;
    }
    const pts = new Map();
    laned.forEach((it, j) => {
      const lane = lanes[j], level = ct - 12 - j * 6, jog = Math.abs(it.bx - lane);
      if (lane === it.bx) pts.set(it, [it.a, { x: lane, y: it.a.y }, { x: lane, y: it.by }]);
      else if (j === n - 1 && jog < 2 * BEND) {
        // верхняя линия, кнопка близко к дорожке: два коротких поворота дали бы ступеньку — вместо них один плавный
        // S-изгиб вверх к кнопке (выше верхней линии других нет — пересечений не будет)
        const V = Math.max(8, Math.min(Math.max(40, jog * 1.6), level - it.by - 10)), s = [];
        for (let q = 0; q <= 16; q++) { const t = q / 16, e = t * t * (3 - 2 * t); s.push({ x: lane + (it.bx - lane) * e, y: level - V * t }); }
        pts.set(it, [it.a, { x: lane, y: it.a.y }, ...s, { x: it.bx, y: it.by }]);
      } else pts.set(it, [it.a, { x: lane, y: it.a.y }, { x: lane, y: level }, { x: it.bx, y: level }, { x: it.bx, y: it.by }]);
    });
    for (const it of direct) pts.set(it, [it.a, { x: it.bx, y: it.a.y }, { x: it.bx, y: it.by }]);
    return items.map((it) => (it ? pts.get(it) : null));
  }
  // Повороты — дугами: угол заменяется кривой радиусом до BEND (не больше половины соседних отрезков).
  const BEND = 24;
  function rounded(pts) {
    const out = [pts[0]];
    for (let k = 1; k < pts.length - 1; k++) {
      const a = pts[k - 1], p = pts[k], b = pts[k + 1];
      const la = Math.hypot(a.x - p.x, a.y - p.y), lb = Math.hypot(b.x - p.x, b.y - p.y), r = Math.min(BEND, la / 2, lb / 2);
      if (r < 1) { out.push(p); continue; }
      const p1 = { x: p.x + (a.x - p.x) * r / la, y: p.y + (a.y - p.y) * r / la }, p2 = { x: p.x + (b.x - p.x) * r / lb, y: p.y + (b.y - p.y) * r / lb };
      for (let q = 0; q <= 8; q++) {                                  // квадратичная кривая p1 → p2 с вершиной угла как опорой
        const t = q / 8, u = 1 - t;
        out.push({ x: u * u * p1.x + 2 * u * t * p.x + t * t * p2.x, y: u * u * p1.y + 2 * u * t * p.y + t * t * p2.y });
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function drawLinks(now, moving) {
    if (!lk) return;
    const dpr = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight;
    if (lk.width !== Math.round(W * dpr) || lk.height !== Math.round(H * dpr)) { lk.width = Math.round(W * dpr); lk.height = Math.round(H * dpr); }
    lg.setTransform(dpr, 0, 0, dpr, 0, 0);
    lg.clearRect(0, 0, W, H);
    if (moving || !links.length) return;
    const t0 = frame.start + FLOW_MS, cells = new Map();
    cachedRoutes().forEach((it, j) => {
      if (!it) return;
      const grow = reduce() ? 1 : ease((now - t0 - j * LINK_STAGGER) / LINK_MS);
      if (grow <= 0) return;
      const { segs, total } = it;
      for (let d = 0; d <= total * grow; d += CELL / 2) {
        let rest = d, k = 0;
        while (k < segs.length - 1 && rest > segs[k]) { rest -= segs[k]; k++; }
        const a = it.pts[k], b = it.pts[k + 1], u = segs[k] ? rest / segs[k] : 0;
        const gx = Math.floor((a.x + (b.x - a.x) * u) / CELL), gy = Math.floor((a.y + (b.y - a.y) * u) / CELL);
        const head = grow < 1 && total * grow - d < CELL * 3 ? 1 : 0;   // растущий кончик — ярче
        const key = gx * 100003 + gy;
        if ((cells.get(key)?.[2] ?? -1) < head) cells.set(key, [gx, gy, head]);
      }
    });
    lg.fillStyle = css('--acc', '#f5f5f5');
    for (const [gx, gy, head] of cells.values()) {
      lg.globalAlpha = head ? 1 : 0.75;
      lg.beginPath(); lg.arc(gx * CELL + CELL / 2, gy * CELL + CELL / 2, DOT_R * (head ? 1.35 : 1), 0, 6.2832); lg.fill();
    }
    lg.globalAlpha = 1;
  }
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  // Прямоугольник вокруг всех видимых целей шага (с отступом), null — целей нет или они скрыты.
  function rectOf(step) {
    if (!step.target) return null;
    const rs = [].concat(step.target).flatMap((s) => [...document.querySelectorAll(s)])
      .map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (!rs.length) return null;
    const pad = 6, x0 = Math.min(...rs.map((r) => r.left)) - pad, y0 = Math.min(...rs.map((r) => r.top)) - pad;
    const x1 = Math.max(...rs.map((r) => r.right)) + pad, y1 = Math.max(...rs.map((r) => r.bottom)) + pad;
    return { x: Math.max(4, x0), y: Math.max(4, y0), w: Math.min(innerWidth - 4, x1) - Math.max(4, x0), h: Math.min(innerHeight - 4, y1) - Math.max(4, y0) };
  }

  function render() {
    if (!root) return;
    const step = STEPS[i], r = rectOf(step);

    card.textContent = '';
    card.append(el('div', 'tour-count', `${i + 1} / ${STEPS.length}`), el('h3', 'tour-title', step.title));
    for (const p of step.text) card.append(el('p', 'tour-text', p));
    links = []; routeMemo = null;
    card.classList.toggle('has-links', !!(step.rows && step.rows.length));   // шире правый отступ — место под дорожки
    for (const r of step.rows || []) {
      const p = el('p', 'tour-text tour-row'), w = el('span', 'tour-link', r.word);
      p.append(w, r.rest);
      card.append(p);
      links.push({ row: p, target: r.target });
    }
    const row = el('div', 'tour-actions');
    const skip = el('button', 'tour-skip', i === STEPS.length - 1 ? '' : 'Пропустить');
    skip.type = 'button'; skip.onclick = () => finish();
    const back = el('button', 'btn', 'Назад');
    back.type = 'button'; back.disabled = i === 0; back.onclick = () => go(-1);
    const next = el('button', 'btn primary', i === STEPS.length - 1 ? 'Начать' : 'Далее');
    next.type = 'button'; next.onclick = () => go(1);
    row.append(skip, el('span', 'tour-gap'), back, next);
    card.append(row);

    // карточка по центру, но выровнена по НИЖНЕМУ краю на постоянной высоте: «Назад/Далее» на одном месте
    // при любой длине текста — удобно щёлкать подряд
    const bottom = Math.min(innerHeight - 8, innerHeight / 2 + 130);
    Object.assign(card.style, { left: Math.max(8, (innerWidth - card.offsetWidth) / 2) + 'px', top: Math.max(8, bottom - card.offsetHeight) + 'px' });
    card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    next.focus({ preventScroll: true });
    // рамка: вокруг кнопки шага (с вырезом в затемнении); шаг без кнопки — вокруг карточки, без выреза
    if (r) aim(r, true);
    // без кнопки — вокруг карточки: место по разметке (offset*), а не getBoundingClientRect — тот сдвинут
    // анимацией появления; скругление — как у карточки плюс отступ
    else aim({ x: card.offsetLeft - 6, y: card.offsetTop - 6, w: card.offsetWidth + 12, h: card.offsetHeight + 12, c: (parseFloat(getComputedStyle(card).borderTopLeftRadius) || 14) + 6 }, false);
  }

  function go(d) {
    const n = i + d;
    if (n >= STEPS.length) return finish();
    if (n < 0) return;
    i = n;
    render();
  }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'Tab') {                                     // фокус не уходит из карточки
      const f = [...card.querySelectorAll('button:not(:disabled)')];
      const at = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(at + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    }
  }

  function start() {
    if (root) return;
    try { home && home(); } catch (e) { /* экраны закрыть не удалось — всё равно показываем */ }
    i = 0;
    root = el('div', 'tour');
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Обучение');
    fx = el('canvas', 'tour-fx');
    g = fx.getContext('2d');
    card = el('div', 'tour-card');
    lk = el('canvas', 'tour-fx');                                  // линии — над карточкой: начинаются у строк внутри неё
    lg = lk.getContext('2d');
    root.append(fx, card, lk);
    frame = null;
    document.body.appendChild(root);
    addEventListener('resize', render);
    document.addEventListener('keydown', onKey, true);
    render();
  }

  function finish() {
    if (!root) return;
    removeEventListener('resize', render);
    document.removeEventListener('keydown', onKey, true);
    const r = root;
    cancelAnimationFrame(raf); raf = 0;
    root = card = fx = g = lk = lg = null; frame = null; links = []; routeMemo = null;
    r.classList.add('out');
    setTimeout(() => r.remove(), 260);
    try { chrome.storage.local.set({ [KEY]: true }); } catch (e) { /* без памяти — покажется ещё раз */ }
    document.getElementById('task')?.focus();
  }

  // Первый запуск: ещё не проходили и не пропускали.
  async function maybeStart(delay = 700) {
    try { if ((await chrome.storage.local.get({ [KEY]: false }))[KEY]) return; } catch (e) { return; }
    setTimeout(start, delay);                                       // дать панели отрисоваться (мозг собирается)
  }

  return { init(d) { home = d && d.home; }, start, maybeStart, finish, STEPS, layoutLinks, BEND };
})();
