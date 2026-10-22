'use strict';
/* extract-items.js — список товаров/объявлений со страницы одним вызовом (инструмент extract_items).
 *
 * Общий для любых сайтов, без правил под конкретные площадки. Источники по надёжности:
 *   1) JSON-LD (schema.org Product / Offer / ItemList) — разметка для поисковиков;
 *   2) microdata (itemscope + itemprop="price" / "name" / "url") — так размечены, например, объявления Авито;
 *   3) повторяющиеся карточки с ценой: ищем текст цены и поднимаемся к предку, у которого есть
 *      ≥3 «братьев» той же формы (тег + класс).
 * Работает с живым document вкладки и с документом, разобранным из fetch (DOMParser): разметка не нужна.
 * Загружается в страницу перед content.js (тот же изолированный мир) и в тестах Node — через fake DOM.
 */

// Внутри функции: файл внедряется в страницу повторно, а const на верхнем уровне при этом упал бы с «already declared».
(() => {
  // Число: группы по 3 цифры через пробел/точку/запятую (12 490, 1.299, 1,299) или подряд, плюс копейки.
  const CRAWLER_NUM = String.raw`(?:\d{1,3}(?:[\s\u00a0\u202f.,]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
  const CRAWLER_PRICE_RE = new RegExp(String.raw`(?:(\$|€|£)\s?(${CRAWLER_NUM}))|(?:(${CRAWLER_NUM})\s?(₽|руб\.?|р\.|rub\b|\$|€|£|usd\b|eur\b|₸|₴))`, 'i');
  const CRAWLER_CURRENCY = { '₽': 'RUB', 'руб': 'RUB', 'руб.': 'RUB', 'р.': 'RUB', rub: 'RUB', $: 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', '₸': 'KZT', '₴': 'UAH' };

  // «12 490 ₽» → { price: 12490, currency: 'RUB', text: '12 490 ₽' }
  const CRAWLER_DETAILS = 200;   // описание/детали в строке выдачи: хватает, чтобы понять, что это за товар

  function crawlerParsePrice(text) {
    const t = String(text || '');
    const m = CRAWLER_PRICE_RE.exec(t);
    if (!m) return null;
    const sym = (m[1] || m[4] || '').toLowerCase();
    let num = (m[2] || m[3] || '').replace(/[\s\u00a0\u202f]/g, '');
    // «1,299.99» → 1299.99; «1.299» и «1,299» (тысячи) → 1299; «12,5» → 12.5
    const dec = /[.,](\d{1,2})$/.exec(num);
    num = dec ? num.slice(0, -dec[0].length).replace(/[.,]/g, '') + '.' + dec[1] : num.replace(/[.,]/g, '');
    const price = Number(num);
    if (!isFinite(price)) return null;
    return { price, currency: CRAWLER_CURRENCY[sym] || CRAWLER_CURRENCY[sym.replace(/\.$/, '')] || sym.toUpperCase(), text: m[0].trim() };
  }

  // Число из атрибута content="12490" или «12490.00».
  function crawlerNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[\s  ]/g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  // Картинка из JSON-LD: строка, массив или ImageObject { url | contentUrl }.

  function crawlerImageOf(v) {

    const x = Array.isArray(v) ? v[0] : v;

    return typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.url || x.contentUrl || '') : '';

  }


  // Картинка карточки: <img> с src / data-src / srcset (ленивые картинки), без data:-заглушек.

  function crawlerImgSrc(el) {

    if (!el) return '';

    const set = (el.getAttribute('srcset') || el.getAttribute('data-srcset') || '').split(',')[0].trim().split(/\s+/)[0];

    for (const v of [el.getAttribute('src'), el.getAttribute('data-src'), el.getAttribute('data-original'), set, el.getAttribute('content'), el.getAttribute('href')]) {

      if (v && !/^data:/.test(v)) return v;

    }

    return '';

  }


  // Товары из JSON-LD: Product (с offers), ItemList (itemListElement), @graph, массивы.
  function crawlerFromJsonLd(data, base) {
    const out = [];
    const abs = (h) => { try { return h ? new URL(h, base).href : ''; } catch (e) { return ''; } };
    const isType = (o, re) => o && (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).some((t) => re.test(String(t || '')));
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (o['@graph']) walk(o['@graph'], depth + 1);
      if (isType(o, /ItemList/)) walk(o.itemListElement, depth + 1);
      if (isType(o, /ListItem/) && o.item) walk(o.item, depth + 1);
      if (isType(o, /Product|Offer|Vehicle|Car|Accommodation|Residence|Book|Event/) && (o.name || o.offers)) {
        const offers = Array.isArray(o.offers) ? o.offers : o.offers ? [o.offers] : [];
        const offer = offers.find((x) => x && (x.price !== undefined || x.lowPrice !== undefined)) || (o.price !== undefined ? o : null);
        const rating = o.aggregateRating || {};
        // описание продавца и категория — чтобы модель отличала сам товар от запчасти или аксессуара к нему
        const cat = typeof o.category === 'string' ? o.category : '';
        const desc = String(o.description || '').replace(/\s+/g, ' ').trim();
        out.push({
          title: String(o.name || '').trim().slice(0, 160),
          price: offer ? crawlerNum(offer.price !== undefined ? offer.price : offer.lowPrice) : null,
          currency: offer ? String(offer.priceCurrency || '') : '',
          url: abs(o.url || (offer && offer.url) || ''),
          rating: crawlerNum(rating.ratingValue), reviews: crawlerNum(rating.reviewCount || rating.ratingCount),
          details: [cat, desc].filter(Boolean).join(' · ').slice(0, CRAWLER_DETAILS),
          image: abs(crawlerImageOf(o.image))
        });
      }
    };
    walk(data, 0);
    return out;
  }

  // Все способы запускаются всегда (разбор идёт на странице: модели это токенов не стоит, по времени — миллисекунды),
  // берётся тот, что нашёл больше всего. Раньше карточки искались, только если разметка дала меньше 3 товаров:
  // сайт с 10 товарами в JSON-LD и 50 карточками на экране отдавал 10.
  function crawlerExtractItems(doc, base, limit) {
    const max = Math.max(1, Math.min(100, Number(limit) || 100));
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const abs = (h) => { try { return h ? new URL(h, base).href : ''; } catch (e) { return ''; } };
    const found = {};                                           // способ → список
    let items = [], seen = new Set();
    const start = (name) => { items = found[name] = []; seen = new Set(); };
    const push = (it, src) => {
      if (!it.title || (it.price === null && !it.url)) return;
      const key = it.url || `${it.title}|${it.price}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ ...it, src });
    };

    // 1) JSON-LD
    start('json-ld');
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch (e) { continue; }
      for (const p of crawlerFromJsonLd(data, base)) push(p, 'json-ld');
    }

    // 2) microdata: itemscope с ценой внутри
    start('microdata');
    const prop = (scope, name) => scope.querySelector(`[itemprop="${name}"]`);
    const val = (el) => (el ? clean(el.getAttribute('content') || el.getAttribute('href') || el.textContent) : '');
    for (const scope of doc.querySelectorAll('[itemscope]')) {
      const priceEl = prop(scope, 'price') || prop(scope, 'lowPrice');
      const nameEl = prop(scope, 'name');
      if (!priceEl || !nameEl) continue;
      const priceAttr = priceEl.getAttribute('content');
      const parsed = priceAttr ? null : crawlerParsePrice(priceEl.textContent);
      const urlEl = prop(scope, 'url') || scope.querySelector('a[href]');
      const title = val(nameEl).slice(0, 160);
      const text = clean(scope.textContent);
      push({
        title,
        price: priceAttr ? crawlerNum(priceAttr) : parsed ? parsed.price : null,
        currency: val(prop(scope, 'priceCurrency')) || (parsed ? parsed.currency : ''),
        url: abs(urlEl ? (urlEl.getAttribute('href') || urlEl.getAttribute('content')) : ''),
        rating: crawlerNum(val(prop(scope, 'ratingValue'))), reviews: crawlerNum(val(prop(scope, 'reviewCount') || prop(scope, 'ratingCount'))),
        details: (val(prop(scope, 'description')) || clean(text.replace(title, ''))).slice(0, CRAWLER_DETAILS),
        image: abs(crawlerImgSrc(prop(scope, 'image') || scope.querySelector('img')))
      }, 'microdata');
    }

    // 3) повторяющиеся карточки с ценой
    start('cards');
    {
      const sig = (el) => `${el.tagName}.${String(el.getAttribute('class') || '').trim().split(/\s+/)[0] || ''}`;
      const cards = new Set();
      // родитель → число детей по подписи: считается один раз, а не для каждой цены на каждом из 9 предков
      const sigCount = new Map();
      const twinsOf = (parent, node) => {
        let m = sigCount.get(parent);
        if (!m) { m = new Map(); for (const c of parent.children) { const k = sig(c); m.set(k, (m.get(k) || 0) + 1); } sigCount.set(parent, m); }
        return m.get(sig(node)) || 0;
      };
      let scanned = 0;
      for (const el of doc.querySelectorAll('body *')) {
        if (++scanned > 8000) break;
        if (el.children.length || !CRAWLER_PRICE_RE.test(el.textContent || '')) continue;
        let node = el;
        for (let up = 0; up < 9 && node && node.parentElement; up++, node = node.parentElement) {
          const parent = node.parentElement;
          if (twinsOf(parent, node) >= 3 && node.querySelector('a[href]')) { cards.add(node); break; }
        }
      }
      for (const card of cards) {
        const links = [...card.querySelectorAll('a[href]')];
        const heads = [...card.querySelectorAll('h1,h2,h3,h4,[title]')];
        const title = [...links, ...heads].map((e) => clean(e.getAttribute('title') || e.textContent)).filter((t) => t && !CRAWLER_PRICE_RE.test(t))
          .sort((a, b) => b.length - a.length)[0] || '';
        const text = clean(card.textContent);
        const parsed = crawlerParsePrice(text);
        const best = links.find((a) => clean(a.textContent) === title || a.getAttribute('title') === title) || links[0];
        push({
          title: title.slice(0, 160), price: parsed ? parsed.price : null, currency: parsed ? parsed.currency : '',
          url: abs(best ? best.getAttribute('href') : ''), rating: null, reviews: null,
          details: clean(text.replace(title, '').replace(parsed ? parsed.text : '', '')).slice(0, CRAWLER_DETAILS),
          image: abs(crawlerImgSrc(card.querySelector('img')))
        }, 'cards');
      }
    }

    // лучший — где больше товаров; при равенстве — разметка (порядок выше): у неё точнее цены и названия
    let best = 'none', list = [];
    for (const name of ['json-ld', 'microdata', 'cards']) if (found[name].length > list.length) { best = name; list = found[name]; }
    return { method: best, total: list.length, items: list.slice(0, max) };
  }

  // Компактные строки для модели: 50 объявлений ≈ 2–3 тыс. токенов вместо скриншотов.
  // Цена сильно ниже медианы выдачи — частый признак запчасти или аксессуара («рама» среди велосипедов).
  // Общий признак без знаний о товаре: помечаем, модель сама читает описание и решает.
  const CRAWLER_CHEAP = 0.35, CRAWLER_MIN_PRICED = 5;
  function crawlerMedian(items) {
    const p = items.map((it) => it.price).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
    return p.length >= CRAWLER_MIN_PRICED ? p[Math.floor(p.length / 2)] : null;
  }

  // Компактные строки для модели: 50 объявлений ≈ 2–3 тыс. токенов вместо скриншотов.
  // budget — предел длины текста. Не влезает — сначала короче описания (120 → 60 → без), и только потом
  // меньше объявлений, с честным «showing N of M» (раньше хвост молча обрезался посреди строки).
  function crawlerFormatItems(r, sort, budget = 9000) {
    let list = r.items.slice();
    const median = crawlerMedian(r.items);
    if (sort === 'price_asc' || sort === 'price_desc') {
      const k = sort === 'price_asc' ? 1 : -1;
      list.sort((a, b) => (a.price === null) - (b.price === null) || k * ((a.price || 0) - (b.price || 0)));
    }
    const fmt = (n) => (n === null || n === undefined ? '?' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
    const cheap = (it) => median && it.price > 0 && it.price < median * CRAWLER_CHEAP;
    const line = (it, i, dl) => [
      `${i + 1}. ${fmt(it.price)}${it.currency ? ' ' + it.currency : ''}`,
      it.title,
      it.rating !== null && it.rating !== undefined ? `★${it.rating}${it.reviews ? ` (${it.reviews})` : ''}` : '',
      dl && it.details ? (it.details.length > dl ? it.details.slice(0, dl - 1) + '…' : it.details) : '',
      it.url,
      cheap(it) ? '⚠ much cheaper than most: check the details — a part/accessory or just a bargain' : ''
    ].filter(Boolean).join(' | ');
    const render = (n, dl) => {
      const shown = list.slice(0, n);
      const flagged = shown.filter(cheap).length;
      return `Found ${r.total} item(s) via ${r.method}${r.total > n ? `, showing ${n}` : ''}` +
        (median ? `, median price ${fmt(median)}` : '') + ':\n' + shown.map((it, i) => line(it, i, dl)).join('\n') +
        (flagged ? `\n${flagged} item(s) marked ⚠: read their details before deciding — keep real items (a cheap one may be the best deal), drop parts and accessories.` : '') +
        hiddenNote(n) + sortNote;
    };
    // Не всё влезло: честно — сколько скрыто и по каким ценам (раньше модель не знала, что за бортом есть дешевле).
    // сортировка здесь — только среди объявлений этой страницы: у сайта может быть больше результатов (живой прогон:
    // найдено 204, на странице ~50 — «самые дешёвые» были не самыми дешёвыми)
    const sortNote = sort === 'price_asc' || sort === 'price_desc'
      ? `\nSorted within this page only. If the site found more results than this page shows, turn on the site's own price sorting (its sort control or URL parameter) so the ${sort === 'price_asc' ? 'cheapest' : 'most expensive'} come first, then read again.`
      : '';
    const hiddenNote = (n) => {
      const rest = list.slice(n), prices = rest.map((it) => it.price).filter((v) => typeof v === 'number' && v > 0);
      if (!rest.length) return '';
      const range = prices.length ? ` (prices ${fmt(Math.min(...prices))}–${fmt(Math.max(...prices))})` : '';
      return `\n${rest.length} more item(s) not shown${range}. ` + (sort === 'price_asc' || sort === 'price_desc'
        ? 'They come after these in the same order.'
        : 'This is page order: call extract_items again with sort=price_asc (or price_desc) to see the cheapest (or most expensive) first.');
    };
    for (const dl of [CRAWLER_DETAILS, 120, 60, 0]) {
      const text = render(list.length, dl);
      if (text.length <= budget) return text;
    }
    let n = list.length;
    while (n > 1 && render(n, 0).length > budget) n--;
    return render(n, 0);
  }

  (typeof window !== 'undefined' ? window : globalThis).__crawlerExtract = {
    items: crawlerExtractItems, format: crawlerFormatItems, parsePrice: crawlerParsePrice, fromJsonLd: crawlerFromJsonLd, median: crawlerMedian
  };
})();
