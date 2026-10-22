'use strict';
/* Тесты skript-mode.js (этап 4): разбор команд, гранты на запуск и «запомнить»,
 * набор инструментов по грантам (по реальному списку TOOLS из sidepanel.js),
 * гейт R2/R3 и навигации. Запуск: node skript-mode.test.js */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const deq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
function makeCtx() {
  const store = {};
  const ctx = {
    console, URL,
    chrome: { storage: { local: {
      async get(def) { const o = { ...def }; for (const k of Object.keys(def)) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); return o; },
      async set(v) { for (const k of Object.keys(v)) store[k] = JSON.parse(JSON.stringify(v[k])); }
    } } }
  };
  vm.createContext(ctx);
  for (const f of ['skript-policy.js', 'skript-access.js', 'skript-contract.js', 'skript-path.js', 'skript-mode.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
  }
  ctx.__store = store;
  return ctx;
}

(async () => {
  const ctx = makeCtx();
  const M = vm.runInContext('SkriptMode', ctx);
  const A = vm.runInContext('SkriptAccess', ctx);

  // ---- 1. Разбор команд ----
  deq({ ...M.resolve('обычная задача', null) }, { cmd: null, task: 'обычная задача' });
  deq({ ...M.resolve('/skript сыграй в 2048', null) }, { cmd: 'skript', task: 'сыграй в 2048' });
  assert.equal(M.resolve('/script x', null).cmd, 'skript', '/script — алиас');
  assert.equal(M.resolve('/SKRIPT', null).cmd, 'skript', 'регистр не важен');
  assert.equal(M.resolve('/skript', null).task, '', 'команда без задачи → пустая задача');
  deq({ ...M.resolve('сделай х', 'skript') }, { cmd: 'skript', task: 'сделай х' }, 'чип + текст');
  assert.equal(M.resolve('/lib', null).cmd, 'lib');
  assert.equal(M.resolve('/library', null).cmd, 'lib');
  assert.equal(M.resolve('/foo bar', null).cmd, null, 'неизвестная команда — обычная задача');
  assert.equal(M.resolve('открой /skript в тексте', null).cmd, null, '«/skript» не в начале — не команда');
  assert.equal(M.resolve('/skripter x', null).cmd, null, 'префикс-двойник не команда');

  // ---- 2. Меню ----
  deq(M.matchCommands('/').map((c) => c.id), ['skript', 'study', 'lib']);
  deq(M.matchCommands('/s').map((c) => c.id), ['skript', 'study']);
  deq(M.matchCommands('/st').map((c) => c.id), ['study']);
  deq(M.resolve('/study делать модели'), { cmd: 'study', task: 'делать модели' }, '/study <цель>');
  deq(M.resolve('делать модели', 'study'), { cmd: 'study', task: 'делать модели' }, 'чип /study');
  deq(M.matchCommands('/l').map((c) => c.id), ['lib']);
  deq(M.matchCommands('/zzz'), []);
  deq(M.matchCommands('/skript задача'), [], 'после пробела меню закрыто');
  deq(M.matchCommands('привет'), []);

  // ---- 3. Гранты и «запомнить» ----
  assert.equal(M.armed, false);
  const snap = await M.arm();
  assert.equal(snap.preset, 'explorer');
  assert.equal(snap.grants.act, true);
  await M.setGrant('act', false, false);
  assert.equal(M.grants.act, false, 'на этот запуск');
  assert.equal(ctx.__store.skriptAccess, undefined, 'без «запомнить» ничего не записано');
  await M.setGrant('web', false, true);
  assert.equal(ctx.__store.skriptAccess.overrides.web, false, '«запомнить» пишет отклонение');
  assert.equal(ctx.__store.skriptAccess.preset, 'explorer');
  await M.setGrant('see', false, true);
  assert.equal(M.grants.see, true, 'see выключить нельзя');
  await M.setGrant('нет-такого', true, true);
  assert.ok(!('нет-такого' in M.grants), 'неизвестный грант игнорируется');
  await M.setPreset('cautious', false);
  assert.equal(M.preset, 'cautious');
  assert.equal(M.grants.act, false);
  await M.setPreset('нет', false);
  assert.equal(M.preset, 'cautious', 'неизвестный пресет игнорируется');
  M.disarm();
  const again = await M.arm();
  assert.equal(again.preset, 'explorer', 'без «запомнить» пресет не сохранился');
  assert.equal(again.grants.web, false, 'запомненное отклонение вернулось');
  assert.equal(again.grants.act, true, 'временное отключение не запомнилось');

  // ---- 4. Набор инструментов по реальному TOOLS ----
  const panel = fs.readFileSync(path.join(__dirname, '..', 'panel', 'sidepanel.js'), 'utf8');
  const names = [...panel.slice(panel.indexOf('const TOOLS = ['), panel.indexOf('const DENIED')).matchAll(/fn\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 18, 'нашли список TOOLS: ' + names.length);
  const base = names.map((n) => ({ function: { name: n } }));
  await M.setPreset('cautious', false);
  let got = M.tools(base).map((t) => t.function.name);
  for (const n of ['click', 'click_at', 'type_text', 'fill_form', 'press_keys', 'scroll', 'swipe', 'drag', 'select_option', 'navigate', 'go_back', 'fetch_page']) {
    assert.ok(!got.includes(n), `«Осторожный»: ${n} скрыт`);
  }
  for (const n of ['query_dom', 'dom_hints', 'vision', 'wait', 'done']) assert.ok(got.includes(n), `«Осторожный»: ${n} остался`);
  await M.setPreset('explorer', false);
  got = M.tools(base).map((t) => t.function.name);
  assert.equal(got.length, names.length, '«Исследователь» видит все инструменты агента');
  await M.setGrant('nav', 'none', false);
  got = M.tools(base).map((t) => t.function.name);
  assert.ok(!got.includes('navigate') && !got.includes('go_back') && got.includes('click'), 'nav=none скрывает только навигацию');

  // ---- 5. Гейт ----
  deq({ ...M.gate({ name: 'click', args: {}, info: { label: 'Купить' }, host: 'shop.com' }) }, { ok: true, cls: 'R0' }, 'вне активного запуска гейт пропускает');
  await M.setPreset('explorer', false);
  await M.begin({ host: 'shop.com' });
  assert.equal(M.active, true);
  const g = (name, args, info, host) => M.gate({ name, args, info, host: host || 'shop.com', pageUrl: 'https://shop.com/a' });
  assert.ok(g('click', {}, { label: 'Купить' }).confirm, 'покупка → R2 подтверждение');
  assert.ok(g('click', { risky: true }, { label: 'Далее' }).confirm, 'risky=true → R2');
  assert.ok(g('click', { risk: 'R0' }, { label: 'Оплатить' }).confirm, 'занизить риск нельзя');
  assert.equal(g('click', {}, { label: 'Подробнее' }).ok, true);
  assert.ok(g('type_text', {}, { label: 'Пароль', isPassword: true }).denied, 'пароль → R3');
  assert.ok(g('type_text', {}, { label: 'Номер карты' }).denied, 'карта → R3');
  assert.ok(g('click', {}, { label: 'Войти' }, 'sberbank.ru').denied, 'банк → R3');
  assert.ok(g('navigate', { url: 'https://evil.com/x' }).denied, 'same-origin: чужой сайт запрещён');
  {
    const r = g('write_script', { title: 't', code: 'const x = 1;\nlocation.reload();' });
    assert.ok(r.denied && /static check/.test(r.text) && /location\.reload/.test(r.text) && !/different approach/i.test(r.text),
      'код не прошёл проверку: модель просят поправить фрагмент, а не менять путь');
  }
  assert.equal(g('navigate', { url: '/cart' }).ok, true, 'same-origin: относительный путь можно');
  assert.equal(g('navigate', { url: 'https://shop.com/cart' }).ok, true, 'same-origin: свой хост можно');
  assert.ok(g('navigate', { url: 'http://shop.com/cart' }).denied, 'same-origin: другая схема — чужой origin');
  assert.ok(g('navigate', { url: 'https://shop.com:8443/cart' }).denied, 'same-origin: другой порт — чужой origin');
  assert.equal(g('navigate', { url: 'https://shop.com:443/cart' }).ok, true, 'same-origin: порт по умолчанию — свой');
  assert.equal(g('navigate', { url: '//shop.com/cart' }).ok, true, 'same-origin: ссылка без схемы — свой');
  await M.setGrant('nav', 'any', false);
  assert.equal(g('navigate', { url: 'https://evil.com/x' }).ok, true, 'nav=any: можно');
  assert.ok(g('navigate', { url: 'https://paypal.com/x' }).denied, 'nav=any не снимает запрет чувствительных доменов');
  M.end();
  assert.equal(M.active, false);
  assert.ok(M.promptAddon().includes('SKRIPT MODE'));
  assert.ok(M.promptAddon().includes('SCRIPT CONTRACT') && M.promptAddon().includes('write_script'), 'в промпте контракт и инструкция про скрипты');
  {
    const pr = M.promptAddon();
    assert.ok(pr.includes('CHOOSE THE PATH FIRST') && pr.includes('PATH: <level>'), 'в промпте лестница путей и формат выбора');
    assert.ok(pr.indexOf('CHOOSE THE PATH FIRST') < pr.indexOf('SCRIPTS.'), 'выбор пути идёт раньше раздела про скрипты');
    const P = vm.runInContext('SkriptPath', ctx);
    assert.equal(P.LEVELS.length, 5);
    const got = P.parse('Думаю…\nPATH: 1 FeatureScript — модель кодом быстрее; rejected: нет');
    assert.equal(got.level, 1); assert.equal(got.id, 'native'); assert.match(got.line, /^PATH: 1 FeatureScript/);
    assert.equal(P.parse('путь не назван'), null);
    assert.equal(P.parse('PATH: 9 что-то'), null, 'уровни только 1–5');
  }

  console.log('skript-mode.test.js: OK');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
