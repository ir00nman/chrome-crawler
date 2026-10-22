'use strict';
/* self-update.js — «Обновиться»: расширение само скачивает себя с GitHub и перезаписывает свою папку.
 * Распакованное расширение не может писать в свою папку само; File System Access API даёт это с разрешения
 * человека: один раз выбирается папка расширения (handle хранится в IndexedDB), дальше обновление — одной кнопкой
 * (Chrome может раз за сеанс переспросить разрешение на запись).
 * Поток: архив main одним запросом (codeload.github.com) → распаковка (ZIP: store/deflate, DecompressionStream,
 * без библиотек) → в архиве manifest.json с ожидаемой версией → запись файлов → chrome.runtime.reload() (в панели).
 * Защита: папка должна быть именно этим расширением той же версии, что запущена; папку под git не трогаем
 * (там рабочая копия разработчика — обновляться через git pull).
 */
const SelfUpdate = (() => {
  // ---------- ZIP ----------
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  async function inflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Map «путь → байты» (без папок). Читается центральный каталог: размеры в локальных заголовках бывают нулями.
  async function unzip(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('архив повреждён (нет каталога ZIP)');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const out = new Map(), dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) throw new Error('архив повреждён (каталог)');
      const method = u16(b, p + 10), csize = u32(b, p + 20), nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
      const local = u32(b, p + 42), name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      if (u32(b, local) !== 0x04034b50) throw new Error('архив повреждён (заголовок файла)');
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28), raw = b.subarray(start, start + csize);
      if (method === 0) out.set(name, raw.slice());
      else if (method === 8) out.set(name, await inflate(raw));
      else throw new Error(`неизвестный способ сжатия в архиве: ${method}`);
    }
    return out;
  }
  // GitHub кладёт всё в папку «repo-main/» — снимаем её; пути с «..» или абсолютные отбрасываем
  function stripRoot(files) {
    const names = [...files.keys()];
    const root = names.length && names.every((n) => n.split('/')[0] === names[0].split('/')[0]) && names[0].includes('/') ? names[0].split('/')[0] + '/' : '';
    const out = new Map();
    for (const [n, data] of files) {
      const rel = n.slice(root.length);
      if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '')) continue;
      out.set(rel, data);
    }
    return out;
  }

  // ---------- Папка расширения ----------
  const DB = 'crawler-self-update', STORE = 'kv';
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const saveHandle = (h) => idb('readwrite', (s) => s.put(h, 'dir'));
  const loadHandle = () => idb('readonly', (s) => s.get('dir')).catch(() => null);

  async function readText(dir, name) {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { return null; }
  }
  async function hasDir(dir, name) { try { await dir.getDirectoryHandle(name); return true; } catch (e) { return false; } }

  // Папка — именно это расширение: тот же name и homepage_url, та же версия, что запущена; не под git.
  async function checkFolder(dir, running) {
    if (await hasDir(dir, '.git')) throw Object.assign(new Error('Это папка под git (рабочая копия): обновитесь командой git pull в ней.'), { code: 'git' });
    const text = await readText(dir, 'manifest.json');
    let m = null;
    try { m = JSON.parse(text); } catch (e) { /* нет или битый */ }
    if (!m) throw Object.assign(new Error('В этой папке нет manifest.json: выберите папку, которую загружали в chrome://extensions.'), { code: 'folder' });
    if (m.name !== running.name || (running.homepage_url && m.homepage_url !== running.homepage_url))
      throw Object.assign(new Error(`Это папка другого расширения («${m.name}»).`), { code: 'folder' });
    if (m.version !== running.version)
      throw Object.assign(new Error(`В этой папке версия ${m.version}, а запущена ${running.version}: выберите папку, из которой расширение загружено.`), { code: 'folder' });
  }

  async function writeFile(root, path, data) {
    const parts = path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }

  async function removeFile(root, path) {
    const parts = path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    await dir.removeEntry(parts[parts.length - 1]);
  }

  // Список того, что записало прошлое обновление, — в самой папке: так он всегда про эту папку.
  // Удаляется только из этого списка: файлы, которые человек положил сам, не трогаем.
  const RECORD = '.crawler-update.json';

  // Получить папку: сохранённую (с разрешением на запись) или выбрать заново. Вызывать по нажатию кнопки.
  async function folder(running) {
    let dir = await loadHandle();
    if (dir) {
      const ok = (await dir.queryPermission({ mode: 'readwrite' })) === 'granted' || (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
      if (!ok) dir = null;
      else { try { await checkFolder(dir, running); return dir; } catch (e) { if (e.code === 'git') throw e; dir = null; } }
    }
    if (typeof showDirectoryPicker !== 'function') throw new Error('Браузер не даёт выбрать папку: обновитесь вручную (ZIP).');
    dir = await showDirectoryPicker({ id: 'crawler-extension', mode: 'readwrite' });
    await checkFolder(dir, running);
    await saveHandle(dir);
    return dir;
  }

  // Обновление: { zipUrl, version } из Updates.check; running — chrome.runtime.getManifest(); fetch — для тестов.
  // Возвращает { files, removed }: сколько записано и сколько старых удалено. Перезапуск расширения — за вызывающим.
  async function update({ zipUrl, version }, running, { fetch: f = fetch, onStep = () => {}, dir = null } = {}) {
    const target = dir || await folder(running);               // папку — сразу, пока жест пользователя «свежий»
    onStep('Скачиваю…');
    const r = await f(zipUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
    onStep('Распаковываю…');
    const files = stripRoot(await unzip(await r.arrayBuffer()));
    let m = null;
    try { m = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))); } catch (e) { /* ниже */ }
    if (!m || m.name !== running.name) throw new Error('В архиве не это расширение.');
    if (version && m.version !== version) throw new Error(`В архиве версия ${m.version}, ожидалась ${version}: попробуйте позже.`);
    onStep(`Записываю ${files.size} файлов…`);
    // manifest.json — последним: если запись оборвётся, папка останется «старой версии» по манифесту
    const order = [...files.keys()].sort((a, b) => (a === 'manifest.json') - (b === 'manifest.json'));
    for (const path of order) await writeFile(target, path, files.get(path));
    // файлы прошлой версии, которых в новой нет (переименованные/удалённые модули), — убрать
    let prev = [];
    try { prev = JSON.parse(await readText(target, RECORD) || '{}').files || []; } catch (e) { /* нет списка — первое обновление */ }
    let removed = 0;
    for (const path of prev) {
      if (typeof path !== 'string' || files.has(path) || path === 'manifest.json' || path === RECORD ||
        path.startsWith('/') || path.split('/').some((x) => x === '..' || x === '' || x === '.git')) continue;
      try { await removeFile(target, path); removed++; } catch (e) { /* уже нет — и ладно */ }
    }
    await writeFile(target, RECORD, JSON.stringify({ version: m.version, files: [...files.keys()] }));
    return { files: files.size, removed };
  }

  return { update, unzip, stripRoot, checkFolder, writeFile, RECORD };
})();
if (typeof module !== 'undefined') module.exports = SelfUpdate;
