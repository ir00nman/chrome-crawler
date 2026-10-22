'use strict';
/* Тест self-update.js: распаковка ZIP (store + deflate), снятие корневой папки GitHub, защита папки
 * (чужое расширение, другая версия, папка под git), запись файлов, манифест — последним. Запуск: node panel/self-update.test.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const ctx = vm.createContext({ console, Blob, Response, DecompressionStream, TextDecoder, TextEncoder, Uint8Array, Map, Promise });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'self-update.js'), 'utf8') + '\nglobalThis.S = SelfUpdate;', ctx, { filename: 'self-update.js' });
const S = vm.runInContext('S', ctx);
const enc = new TextEncoder(), dec = new TextDecoder();

// Сборка ZIP: локальные заголовки + центральный каталог + конец каталога (как у GitHub: папка «repo-main/»)
function makeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const nameB = Buffer.from(name), raw = Buffer.from(text || '');
    const data = name.endsWith('/') ? Buffer.alloc(0) : deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate && !name.endsWith('/') ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22);            // размеры в локальном заголовке — нули (как в потоковых ZIP)
    lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

// Папка в памяти с API File System Access (то, что использует self-update.js)
function memDir(files = {}, dirs = []) {
  const writes = [];
  const mk = (prefix) => ({
    async getDirectoryHandle(n, o = {}) {
      const p = prefix + n + '/';
      if (!o.create && !dirs.includes(p.slice(0, -1)) && !Object.keys(files).some((k) => k.startsWith(p))) throw new Error('NotFound');
      if (o.create && !dirs.includes(p.slice(0, -1))) dirs.push(p.slice(0, -1));
      return mk(p);
    },
    async getFileHandle(n, o = {}) {
      const p = prefix + n;
      if (!o.create && !(p in files)) throw new Error('NotFound');
      return {
        getFile: async () => ({ text: async () => (typeof files[p] === 'string' ? files[p] : dec.decode(files[p])) }),
        createWritable: async () => ({ write: async (d) => { files[p] = d; writes.push(p); }, close: async () => {} })
      };
    },
    async removeEntry(n) { const p = prefix + n; if (!(p in files)) throw new Error('NotFound'); delete files[p]; }
  });
  return { root: mk(''), files, writes };
}

const running = { name: 'Chrome crawler', version: '0.7.1', homepage_url: 'https://github.com/ir00nman/chrome-crawler' };
const manifest = (v) => JSON.stringify({ name: 'Chrome crawler', version: v, homepage_url: running.homepage_url });

(async () => {
  // ---- 1. Распаковка: store и deflate, папки пропускаются, корень GitHub снимается ----
  const zip = makeZip([
    ['chrome-crawler-main/', ''],
    ['chrome-crawler-main/manifest.json', manifest('0.7.2'), true],
    ['chrome-crawler-main/panel/', ''],
    ['chrome-crawler-main/panel/sidepanel.js', 'console.log("новая панель");'.repeat(50), true],
    ['chrome-crawler-main/README.md', '# Chrome crawler', false]
  ]);
  const raw = await S.unzip(zip);
  assert.deepEqual([...raw.keys()], ['chrome-crawler-main/manifest.json', 'chrome-crawler-main/panel/sidepanel.js', 'chrome-crawler-main/README.md']);
  assert.equal(dec.decode(raw.get('chrome-crawler-main/panel/sidepanel.js')), 'console.log("новая панель");'.repeat(50), 'deflate распакован');
  const files = S.stripRoot(raw);
  assert.deepEqual([...files.keys()], ['manifest.json', 'panel/sidepanel.js', 'README.md']);
  assert.deepEqual([...S.stripRoot(new Map([['x/../evil.js', enc.encode('1')], ['x/ok.js', enc.encode('1')]])).keys()], ['ok.js'], 'пути с «..» отбрасываются');
  await assert.rejects(S.unzip(new Uint8Array([1, 2, 3])), /архив повреждён/);

  // ---- 2. Защита папки ----
  await S.checkFolder(memDir({ 'manifest.json': manifest('0.7.1') }).root, running);
  await assert.rejects(S.checkFolder(memDir({ 'manifest.json': manifest('0.7.1') }, ['.git']).root, running), /папка под git/);
  await assert.rejects(S.checkFolder(memDir({ 'manifest.json': manifest('0.6') }).root, running), /версия 0\.6, а запущена 0\.7\.1/);
  await assert.rejects(S.checkFolder(memDir({ 'manifest.json': JSON.stringify({ name: 'Другое', version: '0.7.1' }) }).root, running), /другого расширения/);
  await assert.rejects(S.checkFolder(memDir({}).root, running), /нет manifest\.json/);

  // ---- 3. Обновление: запись всех файлов, манифест — последним ----
  {
    const d = memDir({ 'manifest.json': manifest('0.7.1'), 'panel/sidepanel.js': 'старое' });
    const steps = [];
    const fetch = async (url) => { assert.equal(url, 'https://codeload.github.com/ir00nman/chrome-crawler/zip/refs/heads/main'); return { ok: true, arrayBuffer: async () => zip.buffer }; };
    const n = await S.update({ zipUrl: 'https://codeload.github.com/ir00nman/chrome-crawler/zip/refs/heads/main', version: '0.7.2' }, running, { fetch, dir: d.root, onStep: (s) => steps.push(s) });
    assert.deepEqual({ ...n }, { files: 3, removed: 0 }, 'первое обновление: списка прошлого нет — ничего не удаляем');
    assert.equal(d.writes.filter((p) => p !== S.RECORD).pop(), 'manifest.json', 'манифест записан последним из файлов архива');
    assert.deepEqual(JSON.parse(d.files[S.RECORD]).files.sort(), ['README.md', 'manifest.json', 'panel/sidepanel.js'], 'список записанного сохранён в папке');
    assert.match(dec.decode(d.files['panel/sidepanel.js']), /новая панель/);
    assert.match(dec.decode(d.files['manifest.json']), /0\.7\.2/);
    assert.deepEqual(steps, ['Скачиваю…', 'Распаковываю…', 'Записываю 3 файлов…']);
  }
  // ---- 4. Следующее обновление удаляет файлы прошлой версии, которых нет в новой; чужие файлы не трогает ----
  {
    const d = memDir({ 'manifest.json': manifest('0.7.1'), 'panel/old.js': 'x', 'panel/sidepanel.js': 'x', 'my-notes.txt': 'моё',
      [S.RECORD]: JSON.stringify({ files: ['manifest.json', 'panel/old.js', 'panel/sidepanel.js', '../evil', 'README.md'] }) });
    const r = await S.update({ zipUrl: 'z', version: '0.7.2' }, running, { fetch: async () => ({ ok: true, arrayBuffer: async () => zip.buffer }), dir: d.root });
    assert.deepEqual({ ...r }, { files: 3, removed: 1 });
    assert.ok(!('panel/old.js' in d.files), 'старый модуль удалён');
    assert.equal(d.files['my-notes.txt'], 'моё', 'файл человека не тронут');
    assert.ok('panel/sidepanel.js' in d.files && 'README.md' in d.files, 'актуальные файлы на месте');
  }
  // в архиве не та версия (GitHub ещё не обновил архив) — ничего не пишем
  {
    const d = memDir({ 'manifest.json': manifest('0.7.1') });
    await assert.rejects(S.update({ zipUrl: 'z', version: '0.8' }, running, { fetch: async () => ({ ok: true, arrayBuffer: async () => zip.buffer }), dir: d.root }), /версия 0\.7\.2, ожидалась 0\.8/);
    assert.equal(d.writes.length, 0, 'при несовпадении версии файлы не тронуты');
  }
  await assert.rejects(S.update({ zipUrl: 'z' }, running, { fetch: async () => ({ ok: false, status: 404 }), dir: memDir().root }), /GitHub ответил 404/);

  console.log('self-update.test.js: ok');
})().catch((e) => { console.error(e); process.exit(1); });
