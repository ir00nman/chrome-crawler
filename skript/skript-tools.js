'use strict';
/* skript-tools.js — инструменты жизненного цикла скрипта и черновики (этап 5).
 *
 * Чистые данные и логика без DOM и CDP: определения инструментов для модели
 * (набор собирается по именам, не по индексам) и хранилище черновиков текущей
 * задачи с проверкой кода профилем run, версиями и лимитом доработок.
 * Исполнение (run_script/stop_script/get_telemetry) подключает раннер на этапе 6.
 */

const SKRIPT_MAX_PATCHES = 5;
const SKRIPT_MAX_PARAMS = 6;

function skriptToolDef(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required && required.length ? { required } : {}) } } };
}

const SKRIPT_TOOL_DEFS = [
  skriptToolDef('write_script',
    'Save a controller script as a draft. `code` is the body of `async (args, __crawler) => result` (see SCRIPT CONTRACT). ' +
    'The code is checked statically; if it is rejected you get the reason, fix it and call again. Nothing runs until the user presses Run.', {
      title: { type: 'string', description: 'short name, e.g. "Play the game until it ends"' },
      description: { type: 'string', description: 'when to use this script, 1-2 sentences' },
      code: { type: 'string', description: 'self-contained function body' },
      params: { type: 'object', description: 'optional input parameters: { name: { type: "string|number|integer|boolean", description } }, at most 6' },
      goal: { type: 'object', description: 'what success means, so every run is scored: { metric: "score", target: 10000, better: "higher"|"lower", read: "short read-only JS expression returning the number from the page" }. Without read the value comes from __crawler.report. Strongly recommended for games and anything measurable.' }
    }, ['title', 'code']),
  skriptToolDef('patch_script',
    `Replace the code of a draft with a fixed version after a failed run, a rejection or a user remark. At most ${SKRIPT_MAX_PATCHES} patches per script; the old version is kept.`, {
      id: { type: 'string', description: 'draft id (optional: the latest draft)' },
      code: { type: 'string', description: 'full fixed function body' },
      reason: { type: 'string', description: 'what failed and why the fix helps' },
      goal: { type: 'object', description: 'optional: replace the goal of the draft (same shape as in write_script)' }
    }, ['code']),
  skriptToolDef('run_script',
    'Run a saved draft in the page. The FIRST run happens only after the user presses the Run button; call this to ask for a re-run of an already approved script.', {
      id: { type: 'string', description: 'draft id (optional: the latest draft)' },
      args: { type: 'object', description: 'values for the script params (optional)' }
    }),
  skriptToolDef('screenshot_region',
    'Look at part of the screen WITHOUT writing or running a script: average colours (RGB numbers, no image) of a cols×rows grid ' +
    'over an element (CSS selector) or a viewport rectangle, plus its exact viewport coordinates. Use it before writing pixel-reading code ' +
    '(canvas, WebGL, any visual state) to learn the real layout and colours instead of guessing; then read the same rectangle with __crawler.grid.', {
      selector: { type: 'string', description: 'CSS selector of the element to look at (e.g. "canvas")' },
      x: { type: 'number', description: 'viewport x (CSS px), if no selector' },
      y: { type: 'number', description: 'viewport y' },
      w: { type: 'number', description: 'width' },
      h: { type: 'number', description: 'height' },
      cols: { type: 'integer', description: 'grid columns, 1-16 (default 4)' },
      rows: { type: 'integer', description: 'grid rows, 1-16 (default 4)' },
      inset: { type: 'number', description: 'skip this share of each cell border, 0-0.45 (default 0.15)' }
    }),
  skriptToolDef('stop_script', 'Stop the running script and return its telemetry summary.', {}),
  skriptToolDef('get_telemetry', 'Summary of the last run: actions, fps, min/max/last of reported metrics, errors, result.', {})
];

const SKRIPT_TOOL_NAMES = SKRIPT_TOOL_DEFS.map((t) => t.function.name);
const skriptToolByName = (name) => SKRIPT_TOOL_DEFS.find((t) => t.function.name === name) || null;

// Набор по именам; names — какие инструменты отдать (по умолчанию все).
function skriptBuildTools(names) {
  const want = names || SKRIPT_TOOL_NAMES;
  return want.map((n) => {
    const t = skriptToolByName(n);
    if (!t) throw new Error(`SkriptTools: неизвестный инструмент «${n}»`);
    return t;
  });
}

// Плоская схема параметров: максимум 6 полей простых типов.
function skriptCleanParams(params) {
  if (params === undefined || params === null) return { ok: true, params: { type: 'object', properties: {}, required: [] } };
  if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'params must be an object { name: { type, description } }' };
  const names = Object.keys(params);
  if (names.length > SKRIPT_MAX_PARAMS) return { ok: false, error: `params: at most ${SKRIPT_MAX_PARAMS} fields (got ${names.length})` };
  const properties = {};
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(n)) return { ok: false, error: `params.${n}: bad name` };
    const p = params[n] && typeof params[n] === 'object' ? params[n] : { type: String(params[n] || 'string') };
    const type = p.type || 'string';
    if (!['string', 'number', 'integer', 'boolean'].includes(type)) return { ok: false, error: `params.${n}: type must be string|number|integer|boolean` };
    properties[n] = { type, ...(p.description ? { description: String(p.description).slice(0, 120) } : {}) };
  }
  return { ok: true, params: { type: 'object', properties, required: [] } };
}

// Черновики одной задачи. policy/contract берутся из глобальных SkriptPolicy/SkriptContract.
function skriptCreateDrafts() {
  const drafts = new Map();
  let seq = 0;
  let last = null;

  const check = (code) => {
    if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'code is empty' };
    const r = SkriptPolicy.lint(code, 'run');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };
  const pick = (id) => drafts.get(id || last);

  return {
    write({ title, description, code, params, goal } = {}) {
      if (!title || !String(title).trim()) return { ok: false, error: 'title is required' };
      const c = check(code);
      if (!c.ok) return c;
      const p = skriptCleanParams(params);
      if (!p.ok) return p;
      const g = SkriptEval.cleanGoal(goal);
      if (!g.ok) return g;
      const id = `d${++seq}`;
      const d = {
        id, title: String(title).slice(0, 120), description: String(description || '').slice(0, 400),
        code, params: p.params, goal: g.goal, permissions: SkriptContract.declaredPermissions(code),
        version: 1, patches: 0, history: [], approved: false
      };
      drafts.set(id, d);
      last = id;
      return { ok: true, id, version: 1, permissions: d.permissions };
    },
    patch({ id, code, reason, goal } = {}) {
      const d = pick(id);
      if (!d) return { ok: false, error: 'no such draft: call write_script first' };
      if (d.patches >= SKRIPT_MAX_PATCHES) return { ok: false, error: `patch limit reached (${SKRIPT_MAX_PATCHES}): finish with the done tool and an honest report` };
      const c = check(code);
      if (!c.ok) return c;
      const g = goal === undefined ? { ok: true, goal: d.goal } : SkriptEval.cleanGoal(goal);
      if (!g.ok) return g;
      d.goal = g.goal;
      d.history.unshift({ version: d.version, code: d.code, note: String(reason || '').slice(0, 200) });
      d.history = d.history.slice(0, 10);
      d.code = code;
      d.version++;
      d.patches++;
      const before = d.permissions.join(',');
      d.permissions = SkriptContract.declaredPermissions(code);
      // Новые права или новая версия кода снова требуют одобрения пользователя.
      d.approved = false;
      return { ok: true, id: d.id, version: d.version, permissions: d.permissions, permissionsChanged: before !== d.permissions.join(','), patchesLeft: SKRIPT_MAX_PATCHES - d.patches };
    },
    rollback(id, version) {
      const d = pick(id);
      const h = d && d.history.find((x) => x.version === version);
      if (!h) return { ok: false, error: 'version not found' };
      d.history.unshift({ version: d.version, code: d.code, note: 'rollback' });
      d.code = h.code;
      d.version++;
      d.permissions = SkriptContract.declaredPermissions(d.code);
      d.approved = false;
      return { ok: true, id: d.id, version: d.version };
    },
    approve(id) { const d = pick(id); if (!d) return false; d.approved = true; return true; },
    // «Сохранить для сайта»: черновик запоминает запись в библиотеке и сохранённый код — следующий запуск
    // покажет «Сохранено» и обновит ту же запись, а не создаст дубль
    markSaved(id, savedId, code) { const d = pick(id); if (!d) return false; d.savedId = savedId; d.adoptedCode = code; return true; },
    // «Починить»: скрипт из прошлой задачи или библиотеки становится черновиком этой задачи (правки — patch_script).
    adopt({ title, description, code, goal, savedId, version } = {}) {
      const c = check(code);
      if (!c.ok) return c;
      const id = `d${++seq}`;
      const d = {
        id, title: String(title || 'Скрипт').slice(0, 120), description: String(description || '').slice(0, 400),
        code, params: { type: 'object', properties: {}, required: [] }, goal: goal || null,
        permissions: SkriptContract.declaredPermissions(code), version: Number(version) || 1, patches: 0, history: [],
        approved: false, savedId: savedId || null, adoptedCode: code
      };
      drafts.set(id, d);
      last = id;
      return { ok: true, id, version: d.version };
    },
    // Человек поправил цель в карточке: меняются только target и better, не версия кода.
    setGoal(id, { target, better } = {}) {
      const d = pick(id);
      if (!d || !d.goal) return null;
      const before = { target: d.goal.target, better: d.goal.better };
      d.goal = { ...d.goal, target: target === null || (typeof target === 'number' && isFinite(target)) ? target : d.goal.target, better: better === 'lower' ? 'lower' : 'higher' };
      return before.target !== d.goal.target || before.better !== d.goal.better ? { before, after: { target: d.goal.target, better: d.goal.better } } : null;
    },
    get: (id) => { const d = pick(id); return d ? { ...d, history: d.history.slice() } : null; },
    list: () => [...drafts.values()].map((d) => ({ id: d.id, title: d.title, version: d.version, approved: d.approved })),
    get lastId() { return last; }
  };
}

const SkriptTools = {
  DEFS: SKRIPT_TOOL_DEFS,
  NAMES: SKRIPT_TOOL_NAMES,
  MAX_PATCHES: SKRIPT_MAX_PATCHES,
  byName: skriptToolByName,
  build: skriptBuildTools,
  createDrafts: skriptCreateDrafts,
  cleanParams: skriptCleanParams
};
