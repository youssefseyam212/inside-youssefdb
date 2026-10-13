// In-memory file system used in the browser. Records every call so the page can show it.
const files = new Map();
const dirs = new Set(['/']);
const listeners = [];
const emit = (e) => listeners.forEach((f) => f(e));
const fail = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
module.exports = {
  readFileSync(p) {
    if (dirs.has(p)) throw fail('EISDIR', p);
    if (!files.has(p)) throw fail('ENOENT', p);
    const bytes = files.get(p);
    emit({ type: 'read', path: p, bytes });
    return new Uint8Array(bytes);
  },
  writeFileSync(p, data) {
    const bytes = new Uint8Array(data);
    files.set(p, bytes);
    emit({ type: 'write', path: p, bytes });
  },
  renameSync(from, to) {
    if (!files.has(from)) throw fail('ENOENT', from);
    files.set(to, files.get(from));
    files.delete(from);
    emit({ type: 'rename', from, to, bytes: files.get(to) });
  },
  unlinkSync(p) {
    if (!files.has(p)) throw fail('ENOENT', p);
    files.delete(p);
    emit({ type: 'unlink', path: p });
  },
  mkdirSync(p) {
    let cur = p;
    while (cur && !dirs.has(cur)) { dirs.add(cur); cur = dirname(cur); }
  },
  readdirSync(p) {
    if (!dirs.has(p)) throw fail('ENOENT', p);
    return [...files.keys()].filter((f) => dirname(f) === p).map((f) => f.slice(p.length + 1));
  },
  existsSync: (p) => files.has(p) || dirs.has(p),
  __files: files,
  __on: (f) => listeners.push(f),
};
