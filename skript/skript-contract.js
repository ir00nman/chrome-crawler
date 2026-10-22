'use strict';
/* skript-contract.js — контракт кода /skript (этап 5): единый источник правды.
 *
 * Контракт описан ОДИН раз (SKRIPT_CONTRACT_API) и используется:
 *   - промптом для модели (docs) — модель сама пишет код, примеров готовых игр здесь нет;
 *   - раннером (этап 6): тест раннера сверяет, что обёртка реализует все имена из списка;
 *   - определением прав (declaredPermissions).
 * Код приёма — тело функции `async (args, __crawler) => result`.
 */

const SKRIPT_CONTRACT_API = [
  { name: 'loop', sig: '__crawler.loop(fn, { fps })', doc: 'Run fn repeatedly (default 30 fps, max 120). Returns a cancel function. Stops by itself when the script is stopped. Do not use setTimeout/setInterval/requestAnimationFrame: they are blocked.' },
  { name: 'key', sig: '__crawler.key(name, { hold })', doc: 'Press a key as a trusted browser event (e.g. "ArrowUp", "Enter", "Space", "a"). hold = ms to keep it down (max 2000). Fire-and-forget, rate-limited to 60 actions/s.' },
  { name: 'click', sig: '__crawler.click(x, y)', doc: 'Trusted left click at viewport coordinates (CSS pixels, from getBoundingClientRect).' },
  { name: 'move', sig: '__crawler.move(x, y)', doc: 'Move the mouse to viewport coordinates.' },
  { name: 'drag', sig: '__crawler.drag(x1, y1, x2, y2)', doc: 'Press at (x1,y1), move, release at (x2,y2).' },
  { name: 'pixels', sig: 'await __crawler.pixels(x, y, w, h, { size, smooth })', doc: 'Screenshot of a viewport rectangle (CSS pixels, from getBoundingClientRect) as { width, height, data, at(x, y), px(i, j) }: data = RGBA bytes row by row; at(x, y) = [r, g, b] at VIEWPORT coordinates (the same units you passed to pixels); px(i, j) = [r, g, b] at coordinates of the returned image itself (0..width-1, 0..height-1) — use px when you loop over the image, at when you look up a point on the page; do not mix them. It sees what the user sees, so it works where the page itself cannot read pixels (OffscreenCanvas, WebGL, cross-origin canvas). size = longest side of the returned image (default: the rectangle size, max 256); smooth (default true) averages colours (good for reading a flat colour area that has text or icons on it), false samples exact pixels. Each call takes about 30-100 ms, at most 20 per second: read only the area you need. Do not capture every frame: after an action wait until the page has finished animating, then capture once (the run summary shows captures per action). The rectangle must be visible on screen. Returns null if the capture failed.' },
  { name: 'grid', sig: 'await __crawler.grid(x, y, w, h, cols, rows, { inset })', doc: 'Average colour of every cell of a cols×rows grid laid over a viewport rectangle: { cols, rows, cells, at(col, row) → [r, g, b] } (cells[row][col]). inset (default 0.15, 0-0.45) skips the border of each cell (gaps, outlines) so the average is the colour of the cell itself. Built on pixels (same limits). Before writing such code, look at the real layout and colours with the screenshot_region tool.' },
  { name: 'saved', sig: '__crawler.saved(key)', doc: 'Read-only saved game state from the page\'s localStorage, parsed from JSON — only for the keys named in STATE SOURCE (others return null). Direct localStorage is not allowed.' },
  { name: 'dry', sig: '__crawler.dry', doc: 'true during the dry run: input (key/click/drag) is NOT sent and the page does not change — never treat "nothing changed after my move" as an error while __crawler.dry is true.' },
  { name: 'wait', sig: 'await __crawler.wait(ms)', doc: 'Pause (max 60000). Returns early if the script is stopped.' },
  { name: 'report', sig: '__crawler.report({ ... })', doc: 'Telemetry for the user and for you: small flat object of numbers/strings (e.g. { score, fps }). Throttled; call it every second or so, not every frame.' },
  { name: 'log', sig: '__crawler.log(message)', doc: 'One line of text in the run log.' },
  { name: 'done', sig: '__crawler.done(result)', doc: 'Finish normally. result must be JSON-serializable and small.' },
  { name: 'stopped', sig: '__crawler.stopped', doc: 'true after the user pressed Stop or a limit was hit. Long loops must check it.' },
  { name: 'limits', sig: '__crawler.limits', doc: '{ actionsPerSecond, maxMs } currently in force.' }
];

// Какие конструкции отклоняет статическая проверка (профиль run) — модели нужно знать заранее.
const SKRIPT_CONTRACT_RULES = [
  'No network (fetch, XMLHttpRequest, WebSocket, sendBeacon), no cookies/localStorage/sessionStorage/indexedDB, no chrome.* APIs.',
  'No loading of external resources: no .src/.srcset assignments, new Image/Audio/Worker, innerHTML/insertAdjacentHTML, CSS url(…), window.open, import(). Show text with textContent. Do not reference window/globalThis/this as a whole value or via Reflect.',
  'No eval / new Function / .constructor, no setTimeout/setInterval/requestAnimationFrame (use __crawler.loop and __crawler.wait).',
  'No navigation (location=, window.open, history.*), no assignment to window/document/location properties.',
  'No computed access to globals (window["x"], globalThis[k]) and no calls through a key or index (handlers[name](), fns[0]()): call functions by plain name.',
  'Keep every loop tick cheap (well under 30 ms of computation): the page cannot render or receive keys while your code runs. Time-box any search with performance.now() and use the best result found so far. A runner stops scripts that keep the page busy (reason "slow").',
  'After an action the page may animate: re-read the state and act again only when it has changed; if an action does not change the state, try another one. A script that stops acting for 10 s is stopped (reason "stalled").',
  'The code is checked statically before it runs; a rejected script is returned to you with the reason.'
];

function skriptContractDocs() {
  return [
    'SCRIPT CONTRACT. You write the BODY of `async (args, __crawler) => result`. `args` is a plain object of parameters.',
    'The code runs inside the page (main world) at full speed with NO model calls between steps: read state directly from the DOM or page globals, decide, act with __crawler.key/click/drag.',
    'Prefer DOM/globals over pixels; when the state exists only on screen (canvas/WebGL games), read it with __crawler.pixels. Finish with `return value` or __crawler.done(value); long-running controllers use __crawler.loop and check __crawler.stopped.',
    'API:',
    ...SKRIPT_CONTRACT_API.map((a) => `- ${a.sig}: ${a.doc}`),
    'Rules:',
    ...SKRIPT_CONTRACT_RULES.map((r) => `- ${r}`)
  ].join('\n');
}

// Нейтральный каркас (не решение какой-либо игры): чтение → решение → действие → телеметрия.
const SKRIPT_CONTRACT_SKELETON = [
  'let steps = 0;',
  'const cancel = __crawler.loop(() => {',
  '  const state = readState();            // read from DOM / globals, never from the model',
  '  const move = decide(state);           // pure function of the state',
  '  if (move) __crawler.key(move);',
  '  steps++;',
  '  if (steps % 30 === 0) __crawler.report({ steps });',
  '  if (isFinished(state)) { cancel(); __crawler.done({ steps }); }',
  '}, { fps: 10 });',
  'function readState() { return {}; }',
  'function decide(state) { return null; }',
  'function isFinished(state) { return false; }'
].join('\n');

// Права по использованным возможностям. Эвристика: проверка при запуске всё равно строже
// (раннер блокирует ввод без гранта «Действовать»).
const SKRIPT_DOM_WRITE_RE = /\.(?:innerHTML|outerHTML|textContent|innerText|value|checked|className|selected)\s*=(?!=)|\.style\s*\.\s*[\w$]+\s*=(?!=)|\.(?:setAttribute|removeAttribute|appendChild|removeChild|insertBefore|replaceChild|replaceWith|append|prepend|remove|click|focus|submit|dispatchEvent)\s*\(/;

function skriptDeclaredPermissions(code) {
  const c = typeof SkriptPolicy !== 'undefined' ? SkriptPolicy.strip(String(code || '')) : String(code || '');
  const perms = ['read'];
  // __clodex — прежнее имя пульта: сохранённые до переименования скрипты должны получать те же права.
  if (/__(?:crawler|clodex)\s*\.\s*(?:key|click|move|drag)\b/.test(c)) perms.push('input');
  // вызовы самой обёртки (__crawler.click) — не запись в DOM страницы
  if (SKRIPT_DOM_WRITE_RE.test(c.replace(/__(?:crawler|clodex)\s*\.\s*[\w$]+/g, ''))) perms.push('dom-write');
  return perms;
}

const SkriptContract = {
  API: SKRIPT_CONTRACT_API,
  RULES: SKRIPT_CONTRACT_RULES,
  SKELETON: SKRIPT_CONTRACT_SKELETON,
  docs: skriptContractDocs,
  declaredPermissions: skriptDeclaredPermissions
};
