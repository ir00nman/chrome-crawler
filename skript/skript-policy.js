'use strict';
/* skript-policy.js — статическая проверка кода режима /skript (R8, R10).
 *
 * Три профиля:
 *   readonly — для eval_readonly/sample_state: никаких побочных эффектов;
 *   study    — для eval_free: побочные эффекты разрешены, но сеть, хранилища,
 *              chrome- API и эксфильтрация данных страницы запрещены;
 *   run      — для запуска приёмов: всё из study плюс запрет eval/Function,
 *              планировщиков и самостоятельной навигации (раннер управляет циклом).
 *
 * Разбор — мини-сканер: сначала вырезаются строки, шаблоны и комментарии,
 * составные операторы нормализуются, и только потом применяются правила.
 * Это лечит ложные срабатывания старого линтера: `a == b` (присваивание?),
 * `rect.top + 1` и `el.style.top` (навигация?).
 */

// Вырезаем строковые литералы, регулярки и комментарии, оставляя код. Выражения ${…} в шаблонах — это код:
// они остаются (иначе `${fetch(…)}` прятался в «строке»). Регулярка отличается от деления по предыдущему
// токену: кавычка внутри /["']/ раньше открывала «строку» и вырезала весь остальной код.
function skriptStrip(src) {
  let i = 0;
  // после этого кода «/» начинает регулярку, а не деление
  const regexAllowed = (out) => {
    const t = out.replace(/\s+$/, '');
    if (!t) return true;
    const ch = t[t.length - 1];
    if (/[\w$]/.test(ch)) return /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(t);
    if (ch === ')' || ch === ']' || ch === '"') return false;          // (a) / 2, x[1] / 2, "" / 2
    if ((ch === '+' || ch === '-') && t[t.length - 2] === ch) return false;   // a++ / 2
    return true;
  };
  // code: до конца или до непарной «}» (тело ${…}); возвращает вырезанный код
  const code = (inTemplate) => {
    let out = '', depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        out += '""';
        i++;
        while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (c === '`') { i++; out += template(); continue; }
      if (c === '/' && regexAllowed(out)) {
        i++;
        let cls = false;
        while (i < src.length && src[i] !== '\n') {
          if (src[i] === '\\') { i += 2; continue; }
          if (cls) { if (src[i] === ']') cls = false; }
          else if (src[i] === '[') cls = true;
          else if (src[i] === '/') break;
          i++;
        }
        i++;
        while (i < src.length && /[a-z]/i.test(src[i])) i++;      // флаги
        out += '""';
        continue;
      }
      if (inTemplate) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) { i++; return out; } depth--; }
      }
      out += c;
      i++;
    }
    return out;
  };
  // шаблон после открывающей «`»: текст выкидываем, ${выражения} оставляем как код
  const template = () => {
    let out = '""';
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { i++; return out; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; out += '+(' + code(true) + ')+""'; continue; }
      i++;
    }
    return out;
  };
  return code(false);
}

// Заменяем составные операторы на пробелы, чтобы одиночный `=` в `a = 1`
// не путался с `==`, `=>`, `+=` и т.п. Головы объявлений (var/let/const,
// включая деструктуризацию) вырезаем: инициализатор — не побочный эффект,
// а локальная переменная нужна даже в readonly-пробнике.
function skriptNormalize(code) {
  return code
 .replace(/>>>=|\*\*=|===|!==|>>=|<<=|\*\*|<=|>=|==|!=|=>/g, ' ')
 .replace(/[+\-*%&|^]=|\/=|<<=|>>=/g, '=') // составное присваивание = обычное
    .replace(/\b(?:var|let|const)\s+(?:\{[^{}]*\}|\[[^\[\]]*\]|[\w$]+)\s*=/g, 'DECL ')
    .replace(/\s+/g, ' ');
}

// Присваивание: одиночное `=` после идентификатора, скобки или литерала.
const SKRIPT_ASSIGN_RE = /[\w$\)\]'"`]\s*=(?!=)/;


// ---- Правила ----

// location в любом виде, кроме чтения безопасных полей: location.reload(), document.location.replace(…), const l = location.
const SKRIPT_LOCATION_RE = /\blocation\b(?!\s*\.\s*(?:href|pathname|search|hash|host|hostname|origin|protocol|port)\b(?!\s*=))/;

// Записи в хранилище, куки, сеть — запрещены везде, кроме инструментов агента.
const R_NET = [
  { re: /\bfetch\s*\(/, why: 'fetch' },
  { re: /\bXMLHttpRequest\b/, why: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/, why: 'WebSocket' },
  { re: /\bEventSource\b/, why: 'EventSource' },
  { re: /\bsendBeacon\b/, why: 'sendBeacon' },
  { re: /\bnavigator\s*\.\s*(?:sendBeacon|credentials|serviceWorker|cookieEnabled)\b/, why: 'navigator-доступ к сетевым/учётным данным' },
  { re: /\blocalStorage\b/, why: 'localStorage' },
  { re: /\bsessionStorage\b/, why: 'sessionStorage' },
  { re: /\bindexedDB\b/, why: 'indexedDB' },
  { re: /\bcaches\b/, why: 'caches API' },
  { re: /\bcookieStore\b/, why: 'cookieStore' },
  { re: /\bdocument\s*\.\s*cookie\b/, why: 'document.cookie' },
  { re: /\b(?:chrome|browser|extension|chromeRuntime)\s*\./, why: 'chrome-/browser- API расширения' },
  // Обходы по имени: строки вырезаются заранее, поэтому window["fetch"]() иначе проходит.
  { re: /\b(?:window|globalThis|self|top|parent|frames)\s*\[/, why: 'доступ к глобальному объекту по ключу' },
  { re: /\.\s*constructor\b|\[\s*""\s*\]\s*\(/, why: 'constructor/вызов по строковому ключу (обход запретов)' },
  { re: /\]\s*\(/, why: 'вызов элемента по ключу или индексу' },
  // Обходы через ссылку на глобальный объект или сетевую функцию: const f = fetch; this["fe"+"tch"]; Reflect.get(…)
  { re: /(?:^|[^\w$.])fetch\b/, why: 'ссылка на fetch' },
  { re: /\bthis\b(?!\s*\.)/, why: 'this вне обращения к свойству (может быть глобальным объектом)' },
  { re: /(?:^|[^\w$.])(?:window|globalThis|self|frames)\b(?!\s*\.)/, why: 'ссылка на глобальный объект целиком' },
  { re: /\bReflect\s*\./, why: 'Reflect' },
  { re: /\bimport\s*\(/, why: 'динамический import' },
  { re: /\bnew\s+(?:Image|Audio|Video|Worker|SharedWorker|Request|WebSocket|EventSource)\b/, why: 'объект, загружающий внешний ресурс' },
  // Без сетевых функций данные уходят через DOM: картинка/фрейм с адресом, разметка с адресом, открытие окна.
  { re: /\.\s*(?:src|srcset|poster|formAction)\s*=(?!=)/, why: 'присваивание адреса ресурса (src/srcset/…)' },
  { re: /[{,]\s*(?:src|srcset|poster|formAction)\s*:/, why: 'адрес ресурса в объекте (Object.assign(img, { src }))' },
  { re: /\.\s*(?:innerHTML|outerHTML)\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\s*\.\s*write/, why: 'вставка HTML-разметки (выводите через textContent)' },
  { re: /\bwindow\s*\.\s*open\s*\(|(?:^|[^\w$.])open\s*\(/, why: 'window.open' }
];

// Правила по исходнику (строки ещё на месте): адрес в атрибуте или в CSS url(…) — тоже загрузка ресурса.
const R_RAW = [
  { re: /\bsetAttribute\s*\(\s*[`'"]\s*(?:src|srcset|href|poster|data|action|formaction|background|style)\s*[`'"]/i, why: 'setAttribute с адресом ресурса' },
  { re: /url\s*\(\s*[`'"]?\s*(?:https?:)?\/\/|@import/i, why: 'CSS url() с внешним адресом' }
];

// Побочные эффекты и потенциально опасные конструкции — для readonly.
const R_SIDE = [
  { re: SKRIPT_ASSIGN_RE, why: 'оператор присваивания' },
 { re: /\b(?:eval|Function)\s*\(/, why: 'eval/Function' },
  { re: /\+\+|--/, why: 'инкремент/декремент' },
  { re: /\bdelete\b/, why: 'delete' },
  { re: /\bawait\b/, why: 'await' },
  { re: /\bnew\s+/, why: 'конструктор' },
  { re: /\bimport\b|\brequire\s*\(/, why: 'импорт модуля' },
  { re: /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\s*\(/, why: 'планировщик' },
  { re: /\bdocument\s*\.\s*(?:write|execCommand|createElement|writeln)\b/, why: 'запись в document' },
  { re: /\bwindow\s*\.\s*open\s*\(/, why: 'window.open' },
  { re: /(?:^|[^\w$.])(?:location|top|parent|opener)\s*=(?!=)/, why: 'присваивание навигационного объекта' },
  // Навигация — только через location (и присваивание href). Раньше ловили любой .replace(/.assign(:
  // живой прогон 2048 — str.replace() и Object.assign() отклонялись как «метод навигации», модель ушла кликать.
  { re: SKRIPT_LOCATION_RE, why: 'обращение к location (можно только читать location.href/pathname/search/hash/host/origin)' },
  { re: /\.\s*href\s*=(?!=)/, why: 'присваивание href' },
  { re: /\bhistory\s*\.\s*(?:pushState|replaceState|go|back|forward)\s*\(/, why: 'history-навигация' },
  { re: /Element\s*\.\s*prototype|HTMLElement\s*\.\s*prototype|EventTarget\s*\.\s*prototype|Window\s*\.\s*prototype|Document\s*\.\s*prototype|Object\s*\.\s*defineProperty/, why: 'патч прототипов' },
  { re: /\.(?:setItem|removeItem|appendChild|removeChild|insertBefore|replaceChild|append|prepend|after|before|replaceWith|setAttribute|removeAttribute|scrollTo|scrollIntoView|focus|blur|click|submit|reset|select|setRangeText|writeText|captureEvents|releaseEvents|stopPropagation)\s*\(/, why: 'мутирующий вызов' }
];

// Для run: код приёма — это контроллер. Локальные переменные (включая ++/--
// и свойства собственных объектов) разрешены; запрещено трогать глобальные
// объекты страницы, прототипы встроенных типов, а также сеть/eval/навигацию.
const R_RUN = [
 { re: /\b(?:window|globalThis|self|top|parent|document|location|history|navigator|localStorage|sessionStorage|screen|crypto|caches)\s*(?:\.\s*[\w$]+|\[[^\][]*\])+\s*=[^=]/, why: 'присваивание свойству глобального объекта' },
 { re: /\bdelete\s+(?:window|globalThis|self|top|parent|document|location|history|navigator|localStorage|sessionStorage|screen|crypto|caches)\b/, why: 'delete глобального объекта' },
 { re: /\b[\w$]+\s*\.\s*prototype(?:\s*(?:\.\s*[\w$]+|\[[^\][]*\]))*\s*=[^=]/, why: 'патч прототипа' },
 { re: /\bdelete\s+[\w$]+\s*\.\s*prototype\b/, why: 'delete прототипа' },
 { re: /__proto__/, why: '__proto__' },
 { re: /Object\s*\.\s*(?:defineProperty|defineProperties|setPrototypeOf)\s*\(/, why: 'переопределение свойств объекта' },
  { re: /\b(?:eval|Function)\s*\(/, why: 'eval/Function' },
  { re: /\bsetTimeout\s*\(|\bsetInterval\s*\(|\brequestAnimationFrame\s*\(|\bqueueMicrotask\s*\(/, why: 'свой планировщик (раннер управляет циклом)' },
  { re: /\bwindow\s*\.\s*open\s*\(/, why: 'window.open' },
  { re: /\bdocument\s*\.\s*write\b/, why: 'document.write' },
  { re: /(?:^|[^\w$.])(?:location|top|parent|opener)\s*=(?!=)/, why: 'самостоятельная навигация' },
  // Навигация — только через location (и присваивание href). Раньше ловили любой .replace(/.assign(:
  // живой прогон 2048 — str.replace() и Object.assign() отклонялись как «метод навигации», модель ушла кликать.
  { re: SKRIPT_LOCATION_RE, why: 'обращение к location (можно только читать location.href/pathname/search/hash/host/origin)' },
  { re: /\.\s*href\s*=(?!=)/, why: 'присваивание href' }
];

const SKRIPT_PROFILES = {
  // readonly: ничего, кроме чтения состояния
  readonly: [...R_NET, ...R_SIDE],
  // study: побочные эффекты ок, но сеть/хранилища/chrome под запретом
  study: [...R_NET],
  // run: study + запрет eval, планировщиков и навигации
  run: [...R_NET, ...R_RUN]
};

// where — фрагмент, на котором сработало правило: без него модель не знает, что исправить (живой прогон 2048:
// видела начало скрипта, решила, что запрещён querySelector, и переписала не то).
function skriptLintIssue(why, src, where) {
  const at = where ? ` — фрагмент: «${where}»` : `: ${String(src).trim().slice(0, 140)}`;
  return { ok: false, why, where: where || '', error: `Код отклонён (${why})${at}` };
}

// Основная точка: profile — 'readonly' | 'study' | 'run'.
function skriptLint(code, profile = 'readonly') {
  const src = Array.isArray(code) ? code.map(String).join('.') : String(code);
  if (!src.trim()) return skriptLintIssue('пустой код', src);
  if (src.length > 8000) return skriptLintIssue('слишком длинный код', src);
  const norm = skriptNormalize(skriptStrip(src));
  const rules = SKRIPT_PROFILES[profile] || SKRIPT_PROFILES.readonly;
  for (const r of R_RAW) {
    const m = r.re.exec(src);
    if (m) return skriptLintIssue(r.why, src, src.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim());
  }
  for (const r of rules) {
    const m = r.re.exec(norm);
    if (m) return skriptLintIssue(r.why, src, norm.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim());
  }
  return { ok: true, expr: src };
}

const SkriptPolicy = {
  lint: skriptLint,
  profiles: SKRIPT_PROFILES,
  strip: skriptStrip,
  normalize: skriptNormalize
};
