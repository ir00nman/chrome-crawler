// Внедряется в страницу через chrome.scripting.executeScript.
// snapshot() — нумерованные интерактивные элементы; действия по номерам;
// плюс «быстрые» инструменты: query_dom, hints, fetchSame, fillMany, waitIdle.
(() => {
  if (window.__agent?.blockerAt) return;   // самая новая функция: старая версия в той же вкладке будет заменена

  const registry = new Map();
  let counter = 0;

  const SEMANTIC = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const SEL = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const CLICKABLE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[onclick]';

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  // Подпись иконки по классу — только в крайнем случае: у кнопки нет ни текста, ни aria/title/alt нигде внутри.
  const ICON_RE = /(?:^|[-_\s])(close|search|cart|basket|heart|favou?rites?|like|menu|burger|share|delete|remove|trash|edit|plus|minus|add|next|prev|back|arrow-?(?:left|right|up|down)|play|pause|settings|gear|filter|sort|user|profile|account|bell|notifications?|download|upload|copy|more|dots|kebab|expand|collapse|refresh|home|star|bookmark|chat|message|mail|phone|camera|mic)(?=$|[-_\s])/i;
  function iconHint(el) {
    for (const n of [el, ...el.querySelectorAll('svg, i, span, use, img')].slice(0, 12)) {
      const c = (typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '') + ' ' + (n.getAttribute('href') || n.getAttribute('xlink:href') || '').replace(/^.*#/, '');
      const m = ICON_RE.exec(c);
      if (m) return `icon: ${m[1].toLowerCase()}`;
    }
    return '';
  }

  function labelOf(el) {
    let t = el.getAttribute('aria-label') || '';
    // aria-labelledby: подпись — текст других элементов по id
    if (!t && el.getAttribute('aria-labelledby')) {
      t = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText || n.textContent || '' : ''; }).join(' ');
    }
    if (!t && el.labels && el.labels.length) t = el.labels[0].innerText;
    if (!t && el.tagName !== 'SELECT' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      t = el.innerText || el.textContent || '';
    }
    if (!t && el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) t = el.value;
    if (!t) t = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
    if (!t && el.querySelector) {
      const img = el.querySelector('img[alt]');
      if (img) t = img.alt;
    }
    // кнопка-иконка: подпись у SVG (<title>, aria-label) или у вложенного элемента (aria-label, title)
    if (!clean(t) && el.querySelector) {
      const inner = el.querySelector('[aria-label], svg title, [title]');
      if (inner) t = inner.getAttribute('aria-label') || inner.getAttribute('title') || inner.textContent || '';
    }
    if (!clean(t) && el.querySelector) t = iconHint(el);
    return clean(t).slice(0, 80);
  }

  function collect(root, out, seen) {
    let list;
    try { list = root.querySelectorAll(SEL); } catch (e) { return; }
    for (const el of list) {
      if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    for (const n of root.querySelectorAll('*')) {
      if (n.shadowRoot) collect(n.shadowRoot, out, seen);
    }
  }

  function lineFor(id, el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let kind = tag;
    if (tag === 'input') kind += `:${el.type || 'text'}`;
    else if (role) kind += `[${role}]`;
    let line = `[${id}] ${kind} "${labelOf(el)}"`;
    if (tag === 'a' && el.getAttribute('href')) line += ` href=${el.getAttribute('href').slice(0, 60)}`;
    if (tag === 'input' || tag === 'textarea') {
      if (el.type === 'password') line += ' value=•••';
      else if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' [checked]' : ' [unchecked]';
      else if (el.value) line += ` value="${clean(el.value).slice(0, 60)}"`;
    }
    if (tag === 'select') {
      const opts = [...el.options].slice(0, 15).map((o) => clean(o.text));
      line += ` options=[${opts.join(' | ')}] selected="${clean(el.selectedOptions[0]?.text || '')}"`;
    }
    if (el.disabled) line += ' [disabled]';
    return line;
  }

  // Доля видимой области, занятая canvas/video (≥ 200×150 px): состояние нарисовано, а не написано —
  // текст страницы его не описывает (игры, редакторы, карты). Для решения «нужен ли скриншот».
  function visualArea() {
    let area = 0;
    for (const el of document.querySelectorAll('canvas, video')) {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (w >= 200 && h >= 150) area += w * h;
    }
    return Math.min(1, Math.round(area / Math.max(1, innerWidth * innerHeight) * 100) / 100);
  }

  function snapshot(maxEls = 150, maxText = 2500) {
    registry.clear();
    counter = 0;
    const els = [];
    collect(document, els, new Set());
    const lines = [];
    for (const el of els) {
      if (lines.length >= maxEls) break;
      if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
      if (!isVisible(el)) continue;
      if (!SEMANTIC.has(el.tagName) && !el.getAttribute('role') && !el.isContentEditable) {
        const txt = clean(el.innerText);
        if (!txt || txt.length > 100) continue;
      }
      const id = ++counter;
      registry.set(id, el);
      lines.push(lineFor(id, el));
    }
    const maxScroll = Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight));
    const text = clean(document.body ? document.body.innerText : '').slice(0, maxText);
    return {
      visual: visualArea(),
      w: innerWidth,
      h: innerHeight,
      count: lines.length,
      text: [
        `URL: ${location.href}`,
        `Title: ${document.title}`,
        `Viewport: ${innerWidth}x${innerHeight} CSS px. Scroll: ${Math.round(scrollY)} / ${maxScroll} px`,
        `Interactive elements in viewport (${lines.length}):`,
        lines.join('\n') || '(none)',
        '',
        'Page text excerpt:',
        text || '(empty)'
      ].join('\n')
    };
  }

  // Только открытые подсказки интерфейса. Не читаем значения форм и произвольный текст документа.
  function learnSnapshot() {
    const parts = [`URL: ${location.origin}${location.pathname}`, `Title: ${document.title.slice(0, 120)}`];
    const els = [];
    collect(document, els, new Set());
    for (const el of els) {
      if (parts.length >= 100 || !isVisible(el) || el.closest('form') || el.isContentEditable) continue;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) continue;
      const label = labelOf(el);
      if (!label || label.length > 70) continue;
      const link = el.tagName === 'A' ? el.getAttribute('href') : null;
      parts.push(`${el.tagName.toLowerCase()} "${label}"${link && /^\//.test(link) ? ` href=${link.slice(0, 100)}` : ''}`);
    }
    // Таблицы сочетаний клавиш обычно не интерактивны: читаем только строки с <kbd>.
    for (const key of document.querySelectorAll('kbd')) {
      if (parts.length >= 115 || !isVisible(key) || key.closest('form')) continue;
      const row = key.closest('tr, li, dt, dd') || key.parentElement;
      const hint = clean(row?.textContent).slice(0, 180);
      if (hint) parts.push(`shortcut: ${hint}`);
    }
    return parts.join('\n').slice(0, 6000);
  }

  // ---------- Описание элементов ----------
  const get = (id) => {
    const el = registry.get(id);
    return el && el.isConnected ? el : null;
  };
  const NOT_FOUND = { ok: false, error: 'Element not found (page changed?). Use ids from the latest observation.' };

  // Визуальная подсветка действий на странице отключена намеренно.
  const highlight = () => {};

  function infoOf(el) {
    const tag = el.tagName;
    const type = (el.type || '').toLowerCase();
    let formAction = '';
    if (el.form) {
      const sb = el.form.querySelector('button[type=submit],input[type=submit],button:not([type])');
      if (sb) formAction = labelOf(sb);
    }
    return {
      ok: true,
      tag: tag.toLowerCase(),
      type,
      label: labelOf(el),
      inForm: !!el.form,
      formAction,
      isPassword: type === 'password',
      isSubmit: (tag === 'BUTTON' && !!el.form && type === 'submit') ||
                (tag === 'INPUT' && (type === 'submit' || type === 'image'))
    };
  }

  function describe(id) {
    const el = get(id);
    return el ? infoOf(el) : NOT_FOUND;
  }

  function activeInfo() {
    const el = document.activeElement;
    if (!el || el === document.body) {
      return { ok: true, tag: 'body', type: '', label: '', inForm: false, formAction: '', isPassword: false, isSubmit: false };
    }
    return infoOf(el);
  }

  function describeAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, error: 'Nothing at these coordinates.' };
    const target = el.closest(CLICKABLE);
    highlight(target || el, 'нажимает');
    // clickable: ссылка/кнопка/обработчик — или курсор-«рука» (кнопки-div в SPA); иначе клик, скорее всего, в пустоту
    let pointer = false;
    try { pointer = getComputedStyle(el).cursor === 'pointer'; } catch (e) { /* без стилей */ }
    return { ...infoOf(target || el), clickable: !!target || pointer };
  }

  // Кто на самом деле в точке (x, y): null — сам элемент (или его часть, его <label>), иначе описание перекрывшего
  // (баннер cookies, модалка, липкая шапка). Как в agent-browser: настоящий клик по CDP попал бы в него.
  // Наши слои (щупальца, подсветка) — pointer-events: none, elementFromPoint их не видит.
  function blockerAt(el, x, y) {
    let d = document, lx = x, ly = y, hit = d.elementFromPoint(lx, ly);
    while (hit && /^I?FRAME$/.test(hit.tagName) && hit !== el) {   // точка над iframe того же сайта — ищем внутри
      let inner = null;
      try { inner = hit.contentDocument; } catch (e) { /* чужой сайт */ }
      if (!inner) break;
      const r = hit.getBoundingClientRect();
      lx -= r.x + hit.clientLeft; ly -= r.y + hit.clientTop; d = inner; hit = d.elementFromPoint(lx, ly);
    }
    if (!hit || hit === el) return null;
    const up = (n) => n.parentNode || n.host || null;
    for (let n = hit; n; n = up(n)) if (n === el) return null;    // внутри элемента (в том числе в его shadow root)
    for (let n = el; n; n = up(n)) if (n === hit) return null;    // элемент внутри попадания (обёртка, pointer-events)
    const lab = hit.closest && hit.closest('label');
    if (lab && (lab.control === el || lab.contains(el))) return null;
    const own = el.closest && el.closest('label');
    if (own && own.contains(hit)) return null;
    let desc = hit.tagName.toLowerCase();
    if (hit.id) desc += '#' + hit.id;
    else if (typeof hit.className === 'string' && hit.className.trim()) desc += '.' + hit.className.trim().split(/\s+/).slice(0, 2).join('.');
    const text = clean(hit.innerText || '').slice(0, 60);
    return text ? `${desc} "${text}"` : desc;
  }

  // Точка для настоящего клика: центр, а если он закрыт — другие точки элемента (липкая шапка часто закрывает только край).
  // Закрыт везде — blocked: модель узнаёт, что мешает, вместо клика в баннер.
  function rect(id) {
    const el = get(id);
    if (!el) return NOT_FOUND;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    highlight(el, 'нажимает');
    const r = el.getBoundingClientRect();
    const box = { w: Math.round(r.width), h: Math.round(r.height) };
    let blocker = null;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
      const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const b = blockerAt(el, x, y);
      if (!b) return { ok: true, x, y, ...box };
      blocker = blocker || b;
    }
    if (!blocker) return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ...box };   // вне экрана — как раньше
    return { ok: false, blocked: blocker, error: `Element [${id}] is covered by <${blocker}> at its click point, so a click would land on that instead. ` +
      'Dismiss or use the covering element first (often a cookie banner, dialog or sticky header), then re-observe and click again.' };
  }

  // ---------- Действия (синтетические; для «настоящих» есть CDP в панели) ----------
  function fire(el, type, Ctor = MouseEvent) {
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
  }

  function click(id) {
    const el = get(id);
    if (!el) return NOT_FOUND;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    highlight(el, 'нажимает');
    try { el.focus({ preventScroll: true }); } catch (e) {}
    fire(el, 'pointerdown', PointerEvent);
    fire(el, 'mousedown');
    fire(el, 'pointerup', PointerEvent);
    fire(el, 'mouseup');
    el.click();
    return { ok: true };
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notPrevented = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (notPrevented && el.form) {
      try { el.form.requestSubmit(); } catch (e) { el.form.submit(); }
    }
  }

  function type(id, text, clear = true, submit = false) {
    const el = get(id);
    if (!el) return NOT_FOUND;
    el.scrollIntoView({ block: 'center' });
    highlight(el, 'вводит текст');
    el.focus();
    if (el.isContentEditable) {
      if (clear) document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, clear ? text : el.value + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return { ok: false, error: 'This element is not a text field.' };
    }
    if (submit) pressEnter(el);
    return { ok: true };
  }

  function selectOption(id, value) {
    const el = get(id);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'Not a <select> element or not found.' };
    highlight(el, 'выбирает');
    const v = String(value).toLowerCase();
    const opt = [...el.options].find((o) => o.value.toLowerCase() === v || clean(o.text).toLowerCase() === v) ||
                [...el.options].find((o) => clean(o.text).toLowerCase().includes(v));
    if (!opt) return { ok: false, error: 'Option not found.' };
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  // Пакетное заполнение: [{id, text} | {id, value} | {id, checked}]
  function fillMany(fields) {
    const results = [];
    for (const f of fields || []) {
      const el = get(f.id);
      if (!el) { results.push(`#${f.id}: not found`); continue; }
      highlight(el, 'заполняет');
      let r;
      if (el.tagName === 'SELECT') r = selectOption(f.id, f.value ?? f.text ?? '');
      else if (el.type === 'checkbox' || el.type === 'radio') {
        if (typeof f.checked === 'boolean' && el.checked !== f.checked) el.click();
        r = { ok: true };
      } else r = type(f.id, String(f.text ?? f.value ?? ''), true, false);
      results.push(`#${f.id}: ${r.ok ? 'ok' : r.error}`);
    }
    return { ok: true, results };
  }

  function scroll(direction) {
    const dy = innerHeight * 0.8;
    const map = { down: dy, up: -dy, top: -1e9, bottom: 1e9 };
    window.scrollBy({ top: map[direction] ?? dy, behavior: 'instant' });
    return { ok: true, y: Math.round(scrollY) };
  }

  // ---------- Чтение данных без скриншотов ----------
  function extractFrom(root, selector, limit, attrs) {
    let nodes;
    try { nodes = [...root.querySelectorAll(selector)]; } catch (e) { return { ok: false, error: 'Bad selector: ' + e.message }; }
    const items = nodes.slice(0, Math.max(1, Math.min(100, Math.floor(Number(limit)) || 30))).map((n, i) => {
      const a = n.matches('a[href]') ? n : (n.querySelector('a[href]') || n.closest('a[href]'));
      const o = { i: i + 1, text: clean(n.innerText ?? n.textContent).slice(0, 300) };
      if (a) o.href = a.getAttribute('href');
      for (const at of attrs || []) {
        const v = n.getAttribute(at);
        if (v != null) o[at] = v.slice(0, 200);
      }
      return o;
    });
    return { ok: true, total: nodes.length, items };
  }

  function queryDom(selector, limit = 30, attrs = []) {
    return extractFrom(document, selector, limit, attrs);
  }

  // Подсказки для поиска стабильных селекторов (data-marker, data-testid и т.п.)
  function hints() {
    const attrs = ['data-marker', 'data-testid', 'data-test', 'data-qa', 'data-component', 'itemprop', 'role'];
    const counts = new Map();
    for (const el of document.querySelectorAll('*')) {
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (v) {
          const k = `[${a}="${v.slice(0, 60)}"]`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, c]) => `${k} x${c}`);
    return { ok: true, hints: top };
  }

  // GET-запрос к тому же сайту (с куками пользователя), без открытия страницы
  async function fetchSame(url, selector, limit = 30, attrs = [], format = 'text', maxLen = 6000) {
    let u;
    try { u = new URL(url, location.href); } catch (e) { return { ok: false, error: 'Bad URL' }; }
    if (u.origin !== location.origin) return { ok: false, error: 'Only same-origin URLs are allowed (relative URL or same site).' };
    const r = await fetch(u.href, { credentials: 'include', headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } });
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();
    const out = { ok: r.ok, status: r.status, finalUrl: r.url, contentType: ct.split(';')[0] };
    if (!r.ok) { out.text = body.slice(0, 300); return out; }
    if (ct.includes('html')) {
      const doc = new DOMParser().parseFromString(body, 'text/html');
      // extract_items по загруженной странице: тот же разбор, что и для открытой вкладки (extract-items.js)
      if (format === 'items' && window.__crawlerExtract) { Object.assign(out, window.__crawlerExtract.items(doc, r.url || u.href, limit)); return out; }
      if (selector) { Object.assign(out, extractFrom(doc, selector, limit, attrs)); return out; }
      doc.querySelectorAll('script,style,noscript,svg,template').forEach((e) => e.remove());
      if (format === 'links') {
        out.links = [...doc.querySelectorAll('a[href]')].slice(0, 80)
          .map((a) => `${clean(a.textContent).slice(0, 60)} -> ${a.getAttribute('href')}`);
        return out;
      }
      out.text = clean(doc.body ? doc.body.textContent : '').slice(0, maxLen);
      return out;
    }
    out.text = body.slice(0, maxLen);
    return out;
  }

  // Список товаров/объявлений открытой страницы (extract-items.js загружается перед этим файлом)
  function items(limit = 40) {
    if (!window.__crawlerExtract) return { method: 'none', total: 0, items: [], error: 'extractor not loaded' };
    return window.__crawlerExtract.items(document, location.href, limit);
  }

  // Ждём, пока DOM «затихнет» (вместо фиксированных пауз)
  function waitIdle(maxMs = 2500, quietMs = 250) {
    return new Promise((resolve) => {
      let last = Date.now();
      const t0 = last;
      const mo = new MutationObserver(() => { last = Date.now(); });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const iv = setInterval(() => {
        const now = Date.now();
        if (now - last >= quietMs || now - t0 >= maxMs) {
          clearInterval(iv);
          mo.disconnect();
          resolve({ ok: true, waited: now - t0 });
        }
      }, 50);
    });
  }

  window.__agent = {
    snapshot, learnSnapshot, describe, activeInfo, describeAt, rect,
    click, type, selectOption, fillMany, scroll,
    queryDom, hints, fetchSame, waitIdle, items, visualArea, blockerAt
  };
})();
