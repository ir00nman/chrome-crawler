'use strict';
// Тесты skript-store.js (этап D): node --test не используем — node skript-store.test.js
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert');
const { webcrypto } = require('node:crypto');

const src = fs.readFileSync(__dirname + '/skript-store.js', 'utf8');

function makeCtx() {
 const data = {};
 const storage = {
 local: {
 async get(defs) {
 const out = {};
 for (const k of Object.keys(defs)) out[k] = data[k] !== undefined ? data[k] : defs[k];
 return out;
 },
 async set(obj) { Object.assign(data, obj); }
 }
 };
 const ctx = vm.createContext({ console, storage, TextEncoder, crypto: { subtle: webcrypto.subtle } });
 vm.runInContext(src, ctx);
 vm.runInContext('SkriptStore.storage = storage.local', ctx);
 ctx.__data = data;
 return ctx;
}

async function main() {
 const S = () => vm.runInContext('SkriptStore', ctx);
 let ctx = makeCtx();

 const base = (over = {}) => ({
 title: 'Проверить бейдж корзины', kind: 'probe', code: 'return1 +1',
 permissions: ['read'], scope: { origin: 'https://shop.example' }, ...over
 });

 // ----1. save→list→get: полная схема R4, SHA-256-хеш, version1 ----
 const { skill } = await S().save(base());
 assert.ok(skill.id && skill.hash && skill.hash.length ===64, 'id и SHA-256-хеш созданы');
 assert.equal(skill.version,1, 'версия1 при создании');
 assert.equal((await S().list()).length,1, 'запись в списке');
 const got = await S().get(skill.id);
 assert.equal(got.hash, skill.hash, 'get без изменений не даёт warning');
 assert.ok(!got.warning, 'нет предупреждения при целостном коде');

 // ----2. Изменение кода → новая версия, старая в history ----
 const { skill: v2 } = await S().save({ ...base(), id: skill.id, code: 'return42' });
 assert.equal(v2.version,2, 'версия2 после изменения кода');
 assert.equal(v2.history.length,1, 'история хранит версию1');
 // метаданные без изменения кода не поднимают версию
 const { skill: v2b } = await S().save({ ...base({ title:'Новое имя' }), id: skill.id, code: v2.code });
 assert.equal(v2b.version,2, 'версия не растёт при смене заголовка');
 assert.equal(v2b.title,'Новое имя', 'заголовок обновился');
 const { skill: v2c } = await S().save({ ...base(), id: skill.id, code: v2.code, risk: 'R2', returns: 'счёт', params: { type:'object', properties:{ n:{ type:'integer' } }, required:[] } });
 assert.ok(v2c.version === 2 && v2c.risk === 'R2' && v2c.returns === 'счёт' && v2c.params.properties.n, 'тот же код: risk/returns/params обновились');
 const { skill: v2d } = await S().save({ title: v2c.title, kind: v2c.kind, code: v2.code, permissions: v2c.permissions, scope: { origin: v2c.scope.origin }, id: skill.id });
 assert.ok(v2d.risk === 'R2' && v2d.params.properties.n, 'не переданные метаданные не затираются');

 // ----3. Подмена кода в хранилище → get возвращает stale + warning ----
 const all = ctx.__data.skriptLibrary;
 all[0].code = 'return "tampered"';
 const tampered = await S().get(skill.id);
 assert.equal(tampered.status,'stale', 'подмена обнаружена: status=stale');
 assert.ok(/изменён вне ревью/.test(tampered.warning), 'предупреждение о подмене');

 // ----4. remove ----
 ctx = makeCtx();
 const { skill: s2 } = await S().save(base());
 assert.equal(await S().remove(s2.id), true, 'remove=true');
 assert.equal(await S().remove(s2.id), false, 'повторный remove=false');

 // ----5. setEnabled / rollback ----
 await S().save({ ...base(), id: 'x1' });
 await S().save({ ...base({ code:'v2 code' }), id:'x1' });
 assert.equal((await S().setEnabled('x1', false)).enabled, false, 'setEnabled');
 const rb = await S().rollback('x1',1);
 assert.equal(rb.skill.version,3, 'откат создаёт новую версию');
 assert.equal(rb.skill.code, base().code, 'код вернулся к версии1');

 // ----6. Импорт: author=import, status=untrusted ----
 const exported = await S().exportJSON();
 const imported = await S().importJSON(exported);
 assert.equal(imported.length,1, 'запись импортирована');
 assert.ok(imported.every((s) => s.author ==='import' && s.status ==='untrusted'), 'импорт → untrusted');
 // непрошедший валидацию JSON отклоняется
 await assert.rejects(() => S().importJSON(JSON.stringify([{ title:'x', kind:'probe', code:'1', scope:{origin:'https://a'} , permissions:['hack'] }])), /permissions/, 'плохие права отклонены');

 // ----7. Валидация: kind, params≤6, типы, required, risk ----
 assert.equal(S().validate(base()).ok, true, 'валидная запись ок');
 assert.equal(S().validate(base({ kind:'magic' })).ok, false, 'неизвестный kind отклонён');
 const manyProps = {}; for (let i =0; i <7; i++) manyProps['f'+i] = { type:'string' };
 assert.equal(S().validate(base({ params:{ type:'object', properties:manyProps } })).ok, false, 'больше6 полей отклонено');
 assert.equal(S().validate(base({ params:{ type:'object', properties:{ q:{type:'array'} } } })).ok, false, 'вложенные типы отклонены');
 assert.equal(S().validate(base({ params:{ type:'object', properties:{}, required:['nope'] } })).ok, false, 'required без поля отклонён');
 assert.equal(S().validate(base({ risk:'R9' })).ok, false, 'risk вне R0–R2 отклонён');

 // ----8. Лимит20 на origin + предупреждение с17 ----
 ctx = makeCtx();
 for (let i =0; i <17; i++) await S().save(base({ title:'s'+i }));
 const w = await S().save(base({ title:'w' }));
 assert.ok(w.warning && /из\s*20/.test(w.warning), 'предупреждение при приближении к лимиту: ' + w.warning);
 for (let i =0; i <2; i++) await S().save(base({ title:'more'+i }));
 await assert.rejects(() => S().save(base({ title:'over' })), /Лимит\s*20/, '21-я запись отклонена');
 // другой origin — можно
 const other = await S().save(base({ scope:{ origin:'https://other.example' } }));
 assert.ok(other.skill.id, 'другой origin не под лимитом');

 // ----9. Миграция старых скилов → kind:'note' ----
 ctx = makeCtx();
 // старый формат: skills = { host: [{id,title,path,text,source,enabled}] }
 ctx.__data.skills = {
 'example.com': [
 { id:'a1', title:'Подсказка1', path:'/editor', text:'текст подсказки', source:'manual', enabled:true },
 { id:'a2', title:'Черновик', path:'', text:'от агента', source:'learned', enabled:false }
 ],
 'other.org': [ { id:'b1', title:'O', path:'', text:'ok', source:'manual', enabled:true } ]
 };
 let m = await S().migrateLegacySkills();
 assert.equal(m.migrated,3, 'все старые скилы перенесены');
 const notes = await S().list({ kind:'note' });
 assert.equal(notes.length,3, 'заметки в хранилище');
 const n1 = notes.find((n) => n.title === 'Подсказка1');
 assert.ok(n1 && n1.kind === 'note' && n1.description === 'текст подсказки' && n1.author === 'human'
 && n1.scope.origin === 'example.com' && n1.scope.pathPrefix === '/editor' && n1.enabled === true, 'поля перенесены верно');
 assert.ok(notes.find((n) => n.author === 'model'), 'source learned → author model');
 // старый ключ не тронут
 assert.equal(ctx.__data.skills['example.com'].length,2, 'старый ключ skills нетронут');
 assert.equal(ctx.__data.skills['other.org'][0].id,'b1', 'старые данные целы');
 // идемпотентность
 m = await S().migrateLegacySkills();
 assert.equal(m.migrated,0, 'повторная миграция ничего не добавляет');
 assert.equal((await S().list({ kind:'note' })).length,3, 'дубликатов нет');
 // флаг стоит
 assert.equal(ctx.__data.skriptNotesMigrated, true, 'флаг миграции установлен');

 // ----10. Лимиты20/20 раздельно: notes считаются по домену отдельно от исполняемых ----
 const noteBase = () => ({ title:'заметка', description:'текст', kind:'note', code:'', scope:{ origin:'lim.com' }, permissions:['read'] });
 for (let i =0; i <20; i++) await S().save(noteBase());
 await assert.rejects(() => S().save(noteBase()), /заметок/, '21-я заметка отклонена');
 // исполняемые на том же домене (origin) — лимит свой
 for (let i =0; i <20; i++) await S().save(base({ scope:{ origin:'lim.com' } }));
 await assert.rejects(() => S().save(base({ scope:{ origin:'lim.com' } })), /исполняемых/, '21-й исполняемый отклонён');

 // ----11. Этап 3 v3: заметки, параллельные записи, миграция ----
 ctx = makeCtx();
 const nz1 = (await S().save({ title:'з', description:'текст', kind:'note', scope:{ origin:'a.com' } })).skill;
 assert.strictEqual(nz1.code, '', 'заметка без code сохраняется с пустым code, не "undefined"');
 const gz1 = await S().get(nz1.id);
 assert.strictEqual(gz1.status, 'ok', 'чтение заметки не помечает её stale');
 assert.ok(!gz1.warning, 'у заметки нет предупреждения о хеше');
 await Promise.all([1, 2, 3, 4, 5].map((i) => S().save(base({ title:'p' + i, code:'return ' + i, scope:{ origin:'https://par.example' } }))));
 assert.strictEqual((await S().list({ origin:'https://par.example' })).length, 5, 'параллельные save не теряют записи');
 ctx.__data.skills = { 'old.com': [{ id:'x1', title:'Т', text:'подсказка', path:'/p', source:'learned', enabled:false }] };
 const mz1 = await S().migrateLegacySkills();
 assert.strictEqual(mz1.migrated, 1, 'мигрирована одна подсказка');
 const mz2 = await S().migrateLegacySkills();
 assert.ok(mz2.skipped, 'повторная миграция пропускается');
 const mig = (await S().list({ kind:'note', origin:'old.com' }))[0];
 assert.ok(mig && mig.enabled === false && mig.scope.pathPrefix === '/p' && mig.author === 'model', 'поля подсказки сохранены');
 assert.ok(ctx.__data.skills && ctx.__data.skills['old.com'].length === 1, 'старый ключ skills не тронут');

 console.log('skript-store.test.js: OK');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });