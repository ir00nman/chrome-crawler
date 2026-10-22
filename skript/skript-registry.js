'use strict';
/* skript-registry.js — реестр приёмов (R5, этап D).
 * Находит подходящие приёмы для текущей страницы (origin, pathPrefix, enabled,
 * фингерпринт), дешёво проверяет preconditions через CDP без модели
 * и превращает приёмы в инструменты skill__<id> для Исполнителя.
 */

const SkriptRegistry = {
 // Подходит ли приём под URL: origin, pathPrefix, enabled, не untrusted.
 match(url, skills) {
 let u;
 try { u = new URL(String(url)); } catch (e) { return []; }
 const origin = u.origin;
 return (skills || []).filter((s) =>
 s.scope.origin === origin &&
 SkriptRegistry.pathMatches(s.scope.pathPrefix, u.pathname) &&
 s.enabled !== false &&
 s.status !== 'untrusted' &&
 s.status !== 'stale'
 );
 },

 // pathPrefix — по границе сегмента: «/editor» подходит к /editor и /editor/1, но не к /editorial
 pathMatches(prefix, path) {
 if (!prefix) return true;
 return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
 },

 // Дешёвые проверки без модели: существуют ли селекторы и глобалы из fingerprint.
 // deps: { evalExpr(expr) -> значение|{__error} } (в панели — skriptEval через CDP).
 // Возвращает { ok: true } или { ok: false, degraded: true, why }.
 async checkPreconditions(skill, deps) {
 const pre = skill.preconditions || skill.fingerprint || {};
 const missing = [];
 if (Array.isArray(pre.selectors) && pre.selectors.length && deps && deps.evalExpr) {
 const r = await deps.evalExpr(
 `JSON.stringify(${JSON.stringify(pre.selectors)}.map(s=>!!document.querySelector(s)))`
 );
 let found = [];
 try { found = JSON.parse(r && r.__error ? '[]' : r); } catch (e) {}
 pre.selectors.forEach((s, i) => { if (!found[i]) missing.push(`selector ${s}`); });
 }
 if (Array.isArray(pre.globals) && pre.globals.length && deps && deps.evalExpr) {
 const r = await deps.evalExpr(
 `JSON.stringify(${JSON.stringify(pre.globals)}.map(g=>window[g]!==undefined))`
 );
 let found = [];
 try { found = JSON.parse(r && r.__error ? '[]' : r); } catch (e) {}
 pre.globals.forEach((g, i) => { if (!found[i]) missing.push(`global ${g}`); });
 }
 return missing.length
 ? { ok: false, degraded: true, why: `не найдено: ${missing.join(', ')}` }
 : { ok: true };
 },

 // Простой скоринг релевантности без модели: теги, заголовок, описание, ключевые слова задачи.
 score(skill, task) {
 const words = String(task || '').toLowerCase().split(/[^a-zа-яё0-9]+/i).filter((w) => w.length >2);
 if (!words.length) return 0;
 const hay = `${skill.title} ${skill.description} ${(skill.tags || []).join(' ')}`.toLowerCase();
 let sc =0;
 for (const w of words) if (hay.includes(w)) sc += w.length >4 ?2 :1;
 return sc;
 },

 // Превращает подходящие приёмы в function-инструменты skill__<id>, максимум limit (по умолчанию8),
 // отсортированные по релевантности к задаче.
 toTools(task, skills, limit =8) {
 const ranked = (skills || [])
 .map((s) => ({ s, sc: this.score(s, task) }))
 .sort((a, b) => b.sc - a.sc)
 .slice(0, Math.max(1, Math.min(8, Number(limit) ||8)))
 .map((x) => x.s);
 return ranked.map((s) => ({
 type: 'function',
 function: {
 name: `skill__${s.id}`,
 description: `${s.title}${s.description ? ` — ${String(s.description).slice(0,140)}` : ''} (kind: ${s.kind}${s.returns ? `, returns: ${s.returns}` : ''})`,
 parameters: s.params && s.params.properties && Object.keys(s.params.properties).length
 ? { type: 'object', properties: s.params.properties, required: s.params.required || [] }
 : { type: 'object', properties: {}, required: [] }
 }
 }));
 },

 // Индекс остальных приёмов (название, теги, описание) — для роутера.
 index(skills) {
 return (skills || []).map((s) => ({ id: s.id, title: s.title, tags: s.tags || [], description: s.description || '' }));
 }
};