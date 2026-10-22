'use strict';
// Тесты skript-registry.js (этап D): node skript-registry.test.js
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert');

const src = fs.readFileSync(__dirname + '/skript-registry.js', 'utf8');
const ctx = vm.createContext({ console, URL });
vm.runInContext(src, ctx);
const R = () => vm.runInContext('SkriptRegistry', ctx);

const sk = (over = {}) => ({
 id:'sk1', title:'Добавить в корзину', description:'Кликает кнопку Buy',
 tags:['cart','shop'], kind:'action', code:'return1', permissions:['read'],
 scope:{ origin:'https://shop.example', pathPrefix:'' }, enabled:true, status:'ok',
 params:{ type:'object', properties:{ qty:{ type:'integer' } }, required:[] },
 ...over
});

async function main() {
 // ----1. match: origin, pathPrefix, enabled, untrusted/stale ----
 const skills = [
 sk(),
 sk({ id:'sk2', scope:{ origin:'https://shop.example', pathPrefix:'/item' } }),
 sk({ id:'sk3', enabled:false }),
 sk({ id:'sk4', status:'untrusted' }),
 sk({ id:'sk5', scope:{ origin:'https://other.example' } })
 ];
 const m = R().match('https://shop.example/item/42?x=1', skills);
 assert.deepEqual(m.map((s) => s.id).sort(), ['sk1','sk2'], 'match по origin+pathPrefix, отфильтрованы disabled/untrusted/чужой origin');
 assert.equal(R().match('https://shop.example/', skills).length,1, 'pathPrefix не подходит корню');
 assert.equal(R().match('not a url', skills).length,0, 'битый URL → пусто');
 assert.equal(R().match('https://shop.example/itemized', skills).length,1, 'pathPrefix по границе сегмента: /item не подходит /itemized');
 assert.equal(R().match('https://shop.example/item', skills).length,2, 'pathPrefix: сам путь подходит');

 // ----2. checkPreconditions: селекторы/глобалы через дешёвый eval ----
 const okDeps = { evalExpr: async (e) => JSON.stringify([true, true]) };
 const p1 = await R().checkPreconditions(sk({ preconditions:{ selectors:['#buy','.price'], globals:[] } }), okDeps);
 assert.deepEqual(p1, { ok:true }, 'все селекторы на месте → ok');
 const p2 = await R().checkPreconditions(sk({ preconditions:{ selectors:['#buy','.gone'], globals:[] } }),
 { evalExpr: async () => JSON.stringify([true, false]) });
 assert.equal(p2.degraded, true, 'нет селектора → degraded');
 assert.ok(/selector \.gone/.test(p2.why), 'починка называет селектор');
 const p3 = await R().checkPreconditions(sk({ preconditions:{ selectors:[], globals:['Shop'] } }),
 { evalExpr: async () => JSON.stringify([false]) });
 assert.equal(p3.degraded, true && /global Shop/.test(p3.why), 'нет глобала → degraded');
 // ошибка eval → degraded, не исключение
 const p4 = await R().checkPreconditions(sk({ preconditions:{ selectors:['#x'] } }), { evalExpr: async () => ({ __error:'detached' }) });
 assert.equal(p4.degraded, true, 'CDP-ошибка → degraded');

 // ----3. toTools: skill__<id>, ≤8, скоринг по задаче ----
 const many = [];
 for (let i =0; i <12; i++) many.push(sk({ id:'k'+i, title:'Приём '+i, tags:['filler'], description:'заполнитель' }));
 many.push(sk({ id:'best', title:'Добавить в корзину', tags:['cart'] }));
 const tools = R().toTools('добавить товар в корзину', many);
 assert.ok(tools.length <=8, 'не больше8 инструментов');
 assert.equal(tools[0].function.name, 'skill__best', 'самый релевантный первый');
 assert.ok(tools.every((t) => t.function.name.startsWith('skill__')), 'имена skill__<id>');
 assert.deepEqual(tools[0].function.parameters.properties, { qty:{ type:'integer' } }, 'схема параметров прокинута');

 console.log('skript-registry.test.js: OK');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });