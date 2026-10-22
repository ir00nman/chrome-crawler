'use strict';
/* skript-store.js — библиотека приёмов режима /skript (R4, этап D).
 * Хранение: chrome.storage.local, отдельный ключ skriptLibrary.
 * Каждая запись проходит валидацию по схеме R4; код+права защищены
 * SHA-256-хешем, подмена обнаруживается при чтении (status:'stale').
 * Для тестов хранилище и crypto подменяемы: SkriptStore.storage, SkriptStore._crypto.
 */

const SKRIPT_STORE_KEY = 'skriptLibrary';
const SKRIPT_KINDS = ['probe', 'action', 'loop', 'note'];
const SKRIPT_PERMISSIONS = ['read', 'input', 'dom-write', 'nav-same-origin'];
const SKRIPT_STATUS = ['ok', 'degraded', 'stale', 'untrusted'];
const SKRIPT_STORE_ORIGIN_LIMIT =20;
const SKRIPT_STORE_WARN_AT =17;
const SKRIPT_HISTORY_LIMIT =10;

// SHA-256 через crypto.subtle (браузер и Node20+), hex.
async function skriptHash(code, permissions) {
 const c = (typeof SkriptStore !== 'undefined' && SkriptStore._crypto) || (typeof crypto !== 'undefined' && crypto);
 if (!c || !c.subtle) throw new Error('crypto.subtle недоступен');
 const data = new TextEncoder().encode(JSON.stringify([String(code), [...(permissions || [])].sort()]));
 const buf = await c.subtle.digest('SHA-256', data);
 return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function skriptStoreValidate(skill) {
 if (!skill || typeof skill !== 'object') return { ok: false, error: 'приём должен быть объектом' };
 // Заметки (kind 'note') — текстовые подсказки без кода: code не обязателен.
 const need = skill && skill.kind === 'note' ? ['title', 'scope'] : ['title', 'code', 'scope'];
 for (const f of need) if (!skill[f]) return { ok: false, error: `пустое обязательное поле ${f}` };
 if (!SKRIPT_KINDS.includes(skill.kind)) return { ok: false, error: `kind должен быть одним из ${SKRIPT_KINDS.join('|')}` };
 const perms = skill.kind === 'note' ? ['read'] : (skill.permissions || []);
 if (!Array.isArray(perms) || perms.some((p) => !SKRIPT_PERMISSIONS.includes(p))) {
 return { ok: false, error: `permissions: только ${SKRIPT_PERMISSIONS.join('|')}` };
 }
 if (skill.risk && !['R0', 'R1', 'R2'].includes(skill.risk)) return { ok: false, error: 'risk: R0–R2' };
 // params — плоская JSON Schema, максимум6 полей, простые типы.
 const props = skill.params && skill.params.properties ? Object.keys(skill.params.properties) : [];
 if (props.length >6) return { ok: false, error: `params: не более6 полей (сейчас ${props.length})` };
 for (const [k, v] of Object.entries((skill.params && skill.params.properties) || {})) {
 if (v && v.type && !['string', 'number', 'integer', 'boolean'].includes(v.type)) {
 return { ok: false, error: `params.${k}: плоская схема (string|number|integer|boolean)` };
 }
 }
 const req = (skill.params && skill.params.required) || [];
 if (req.some((r) => !props.includes(r))) return { ok: false, error: 'params.required ссылается на неизвестное поле' };
 if (!skill.scope || !skill.scope.origin) return { ok: false, error: 'scope.origin обязателен' };
 if (skill.tests && !Array.isArray(skill.tests)) return { ok: false, error: 'tests должен быть массивом {args, expect}' };
 return { ok: true };
}

// Миграция старых текстовых подсказок (текстовых подсказок) в записи kind:'note'.
// Идемпотентна по id; старый ключ `skills` остаётся нетронутым (резервная копия).
async function skriptMigrateLegacy(store) {
 const stor = store._stor();
 const flags = await stor.get({ skriptNotesMigrated: false });
 if (flags && flags.skriptNotesMigrated) return { migrated:0, skipped: true };
 const { skills = {} } = await stor.get({ skills: {} });
 const all = await store._readAll();
 let n =0;
 for (const [host, list] of Object.entries(skills || {})) {
 if (!Array.isArray(list)) continue;
 for (const s of list) {
 if (!s || typeof s.text !== 'string' || !s.text.trim()) continue;
 const safeHost = String(host).replace(/[^a-z0-9.\-]/gi, '_');
 const safeId = String(s.id || '').replace(/[^a-z0-9\-]/gi, '_') || 'x';
 const id = `note_${safeHost}_${safeId}`;
 if (all.some((x) => x.id === id)) continue; // идемпотентность
 all.push({
 id,
 title: String(s.title || 'Подсказка').slice(0,120),
 description: String(s.text).slice(0,3000),
 tags: ['migrated'],
 kind: 'note',
 params: { type:'object', properties:{}, required:[] },
 returns: '',
 code: '',
 permissions: ['read'],
 scope: { origin: String(host), pathPrefix: String(s.path || ''), frame: '' },
 fingerprint: { selectors:[], globals:[], canvas:false },
 preconditions: { selectors:[], globals:[] },
 tests: [],
 risk: 'R0',
 version:1, history: [],
 hash: '', // заметки не исполняются — хеш не нужен
 author: s.source === 'learned' ? 'model' : 'human',
 status: 'ok',
 stats: { runs:0, successes:0, lastRunAt:0 },
 enabled: s.enabled !== false,
 createdAt: Date.now()
 });
 n++;
 }
 }
 if (n) await store._writeAll(all);
 await stor.set({ skriptNotesMigrated: true });
 return { migrated: n, skipped: false };
}

const SkriptStore = {
 key: SKRIPT_STORE_KEY,
 // Подменяемое в тестах: { local: { get, set } }.
 storage: null,
 _crypto: null,

 _stor() {
 const s = this.storage || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
 if (!s) throw new Error('chrome.storage.local недоступен');
 return s;
 },

 // Все операции «прочитать → изменить → записать» идут по очереди: параллельные
 // save() иначе затирают друг друга (последняя запись выигрывает).
 _q: Promise.resolve(),
 _tx(fn) {
 const r = this._q.then(fn);
 this._q = r.catch(() => {});
 return r;
 },

 async _readAll() {
 const r = await this._stor().get({ [SKRIPT_STORE_KEY]: [] });
 return r[SKRIPT_STORE_KEY] || [];
 },
 async _writeAll(list) {
 await this._stor().set({ [SKRIPT_STORE_KEY]: list });
 },

 async list(filter = {}) {
 let all = await this._readAll();
 if (filter.origin) all = all.filter((s) => s.scope.origin === filter.origin);
 if (filter.kind) all = all.filter((s) => s.kind === filter.kind);
 if (filter.enabled !== undefined) all = all.filter((s) => s.enabled === filter.enabled);
 return all;
 },

 // Чтение с проверкой хеша: подмена кода в хранилище → status:'stale'.
 get(id) { return this._tx(() => this._get(id)); },
 async _get(id) {
 const all = await this._readAll();
 const s = all.find((x) => x.id === id);
 if (!s) return null;
 try {
 if (s.kind === 'note') return { ...s };
 const h = await skriptHash(s.code, s.permissions);
 if (h !== s.hash && s.status !== 'untrusted') {
 s.status = 'stale';
 await this._writeAll(all);
 return { ...s, warning: 'Код приёма изменён вне ревью (хеш не совпал). Требуется повторное ревью.' };
 }
 } catch (e) { /* crypto недоступен — отдаём как есть */ }
 return { ...s };
 },

 // Новая запись или новая версия при изменении кода/прав; старая уходит в history.
 save(skill) { return this._tx(() => this._save(skill)); },
 async _save(skill) {
 const v = skriptStoreValidate(skill);
 if (!v.ok) throw new Error(`Приём не прошёл валидацию: ${v.error}`);
 const all = await this._readAll();
 const now = Date.now();
 const prev = all.find((x) => x.id === skill.id);
 let warning = null;
 // Лимиты считаются раздельно: заметки —20 на домен, исполняемые —20 на origin.
 const isNote = skill.kind === 'note';
 const sameBucket = all.filter((x) =>
 (x.kind === 'note') === isNote && x.scope.origin === skill.scope.origin && x.id !== skill.id);
 if (sameBucket.length >= SKRIPT_STORE_ORIGIN_LIMIT && !prev) {
 throw new Error(`Лимит ${SKRIPT_STORE_ORIGIN_LIMIT} ${isNote ? 'заметок на домен' : 'исполняемых скриптов на origin'} ${skill.scope.origin}`);
 }
 if (sameBucket.length +1 >= SKRIPT_STORE_WARN_AT) warning = `${isNote ? 'Заметок' : 'Скриптов'} для ${skill.scope.origin}: ${sameBucket.length +1} из ${SKRIPT_STORE_ORIGIN_LIMIT}`;
 const hash = isNote ? '' : await skriptHash(skill.code, skill.permissions || []);
 let version =1;
 let history = [];
 if (prev) {
 if (prev.hash === hash || (isNote && prev.description === skill.description)) {
 // код не менялся — обновляем только метаданные
 Object.assign(prev, {
 title: skill.title, description: skill.description || prev.description,
 tags: skill.tags || prev.tags, enabled: skill.enabled !== false,
 stats: prev.stats
 });
 // остальные метаданные — только переданные: чего нет в запросе, то не затираем
 if (skill.params) prev.params = skill.params;
 if (skill.returns !== undefined) prev.returns = String(skill.returns || '').slice(0,200);
 if (skill.risk) prev.risk = skill.risk;
 if (skill.preconditions) prev.preconditions = skill.preconditions;
 if (skill.fingerprint) prev.fingerprint = skill.fingerprint;
 if (skill.tests) prev.tests = skill.tests.slice(0,5);
 if (skill.author) prev.author = skill.author;
 if (skill.status && SKRIPT_STATUS.includes(skill.status)) prev.status = skill.status;
 if (skill.scope && skill.scope.pathPrefix !== undefined) prev.scope = { ...prev.scope, pathPrefix: skill.scope.pathPrefix || '' };
 if (skill.scope && skill.scope.frame !== undefined) prev.scope = { ...prev.scope, frame: skill.scope.frame || '' };
 await this._writeAll(all);
 return { skill: prev, warning };
 }
 version = (prev.version ||1) +1;
 history = [{ version: prev.version ||1, code: prev.code, hash: prev.hash, note: prev.description, ts: now }, ...(prev.history || [])].slice(0, SKRIPT_HISTORY_LIMIT);
 }
 const rec = {
 id: skill.id || (prev ? prev.id : `sk_${now.toString(36)}_${Math.random().toString(36).slice(2,8)}`),
 title: String(skill.title).slice(0,120),
 description: String(skill.description || '').slice(0,400),
 tags: (skill.tags || []).slice(0,10).map(String),
 kind: skill.kind,
 params: skill.params || { type: 'object', properties: {}, required: [] },
 returns: String(skill.returns || '').slice(0,200),
 code: skill.kind === 'note' ? String(skill.code || '') : String(skill.code),
 permissions: (skill.permissions || []).slice(),
 scope: { origin: skill.scope.origin, pathPrefix: (skill.scope && skill.scope.pathPrefix) || '', frame: (skill.scope && skill.scope.frame) || '' },
 fingerprint: skill.fingerprint || { selectors: [], globals: [], canvas: false },
 preconditions: skill.preconditions || { selectors: [], globals: [] },
 tests: (skill.tests || []).slice(0,5),
 risk: skill.risk || 'R1',
 version, history, hash,
 author: skill.author || 'model',
 status: skill.status && SKRIPT_STATUS.includes(skill.status) ? skill.status : 'ok',
 stats: prev ? prev.stats : { runs:0, successes:0, lastRunAt:0 },
 enabled: skill.enabled !== false,
 createdAt: prev ? prev.createdAt : now
 };
 const idx = prev ? all.findIndex((x) => x.id === prev.id) : -1;
 if (idx >=0) all[idx] = rec; else all.push(rec);
 await this._writeAll(all);
 return { skill: { ...rec }, warning };
 },

 remove(id) { return this._tx(() => this._remove(id)); },
 async _remove(id) {
 const all = await this._readAll();
 const next = all.filter((x) => x.id !== id);
 if (next.length === all.length) return false;
 await this._writeAll(next);
 return true;
 },

 // Откат: версия из history становится текущей (новой версией, снова на ревью).
 async rollback(id, version) {
 const all = await this._readAll();
 const s = all.find((x) => x.id === id);
 if (!s) throw new Error('Приём не найден');
 const h = (s.history || []).find((x) => x.version === version);
 if (!h) throw new Error(`Версия ${version} отсутствует в истории`);
 return this.save({ ...s, code: h.code, description: h.note || s.description, status: 'ok' });
 },

 setEnabled(id, enabled) { return this._tx(() => this._setEnabled(id, enabled)); },
 async _setEnabled(id, enabled) {
 const all = await this._readAll();
 const s = all.find((x) => x.id === id);
 if (!s) return null;
 s.enabled = !!enabled;
 await this._writeAll(all);
 return { ...s };
 },

 setStatus(id, status) { return this._tx(() => this._setStatus(id, status)); },
 async _setStatus(id, status) {
 const all = await this._readAll();
 const s = all.find((x) => x.id === id);
 if (!s) return null;
 s.status = SKRIPT_STATUS.includes(status) ? status : s.status;
 await this._writeAll(all);
 return { ...s };
 },

 recordRun(id, success) { return this._tx(() => this._recordRun(id, success)); },
 async _recordRun(id, success) {
 const all = await this._readAll();
 const s = all.find((x) => x.id === id);
 if (!s) return null;
 s.stats = { runs: (s.stats.runs ||0) +1, successes: (s.stats.successes ||0) + (success ?1 :0), lastRunAt: Date.now() };
 await this._writeAll(all);
 return { ...s };
 },

 async exportJSON(filter) {
 return JSON.stringify(await this.list(filter || {}), null,2);
 },

 // Импорт: author:'import', status:'untrusted' до ревью (R4).
 async importJSON(text) {
 let arr;
 try { arr = JSON.parse(String(text)); } catch (e) { throw new Error('Некорректный JSON'); }
 if (!Array.isArray(arr)) arr = [arr];
 const imported = [];
 for (const raw of arr) {
 const v = skriptStoreValidate(raw);
 if (!v.ok) throw new Error(`Импорт отклонён: ${v.error}`);
 const { skill } = await this.save({ ...raw, id: undefined, author: 'import', status: 'untrusted', enabled: false });
 imported.push(skill);
 }
 return imported;
 },

 validate: skriptStoreValidate,
 hash: skriptHash,
 migrateLegacySkills: () => SkriptStore._tx(() => skriptMigrateLegacy(SkriptStore)),
 LIMITS: { perOrigin: SKRIPT_STORE_ORIGIN_LIMIT, warnAt: SKRIPT_STORE_WARN_AT }
};