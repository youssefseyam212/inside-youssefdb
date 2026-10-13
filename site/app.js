(function () {
  'use strict';
  const { DB, BSON, fs } = YDB;
  const { ObjectId } = BSON;
  const DIR = '/data';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  const base = (p) => p.slice(p.lastIndexOf('/') + 1);
  const isOid = (v) => v && typeof v === 'object' && v._bsontype === 'ObjectId';
  const decode = (bytes) => BSON.deserialize(bytes, { promoteBuffers: true });

  /* ---------------- recording every file system call ---------------- */
  let events = null; // array while an operation runs
  fs.__on((e) => { if (events) events.push(e); });

  /* ---------------- state ---------------- */
  let db;
  const state = { ops: [], selFile: `${DIR}/users.bson`, selDoc: 0, viewBytes: null, viewLabel: '', selStep: null, showAll: false, lastColl: 'users' };

  /* ---------------- wrapping collections so each call is traced ---------------- */
  const OPS = new Set(['insertOne', 'insertMany', 'find', 'findOne', 'countDocuments', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'createIndex', 'dropIndex', 'listIndexes', 'drop']);
  const wrapCache = new Map();
  function wrap(coll) {
    if (wrapCache.has(coll)) return wrapCache.get(coll);
    const proxy = new Proxy(coll, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function' || !OPS.has(prop)) return value;
        return (...args) => {
          const file = `${DIR}/${target.name}.bson`;
          const before = fs.__files.has(file) ? decode(fs.__files.get(file)).data : null;
          events = [];
          const op = { coll: target.name, method: prop, args, before, events, beforeBytes: fs.__files.get(file) || null, hadIndex: fs.__files.has(file.replace('.bson', '.index.bson')) };
          try {
            op.result = value.apply(target, args);
            return op.result;
          } catch (err) {
            op.error = err;
            throw err;
          } finally {
            events = null;
            op.after = fs.__files.has(file) ? decode(fs.__files.get(file)).data : null;
            op.afterBytes = fs.__files.get(file) || null;
            op.hasIndex = fs.__files.has(file.replace('.bson', '.index.bson'));
            state.ops.push(op);
          }
        };
      },
    });
    wrapCache.set(coll, proxy);
    return proxy;
  }
  function makeDb() {
    const real = new DB({ dir: DIR });
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'collection') return (name) => wrap(target.collection(name));
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  /* ---------------- values shown as code ---------------- */
  function show(v, ind = '') {
    if (isOid(v)) return `<span class="v-oid">ObjectId("${v.toHexString()}")</span>`;
    if (v instanceof Date) return `<span class="v-date">Date("${v.toISOString()}")</span>`;
    if (v === null || v === undefined) return `<span class="v-null">${v === null ? 'null' : 'undefined'}</span>`;
    if (typeof v === 'string') return `<span class="v-str">${esc(JSON.stringify(v))}</span>`;
    if (typeof v === 'number') return `<span class="v-num">${Number.isNaN(v) ? 'NaN' : v}</span>`;
    if (typeof v === 'boolean') return `<span class="v-bool">${v}</span>`;
    if (v instanceof Uint8Array) return `<span class="v-oid">Binary(${v.length} bytes)</span>`;
    if (Array.isArray(v)) return v.length ? `<span class="brace">[</span>${v.map((x) => show(x, ind)).join('<span class="brace">, </span>')}<span class="brace">]</span>` : '<span class="brace">[]</span>';
    if (typeof v === 'object') {
      const e = Object.entries(v);
      if (!e.length) return '<span class="brace">{}</span>';
      return `<span class="brace">{ </span>${e.map(([k, x]) => `<span class="k">${esc(k)}</span>: ${show(x, ind)}`).join('<span class="brace">, </span>')}<span class="brace"> }</span>`;
    }
    return esc(String(v));
  }
  function plain(v, ind = '') {
    if (isOid(v)) return `ObjectId("${v.toHexString()}")`;
    if (v instanceof Date) return `Date("${v.toISOString()}")`;
    if (v === undefined) return 'undefined';
    if (v === null || typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v) : String(v);
    if (v instanceof Uint8Array) return `Binary(${v.length} bytes)`;
    const n = `${ind}  `;
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => n + plain(x, n)).join(',\n')}\n${ind}]` : '[]';
    const e = Object.entries(v);
    return e.length ? `{\n${e.map(([k, x]) => `${n}${k}: ${plain(x, n)}`).join(',\n')}\n${ind}}` : '{}';
  }
  const sig = (v) => plain(v);
  const idKey = (d) => (d && d._id !== undefined ? sig(d._id) : null);

  /* ---------------- BSON byte map ---------------- */
  const TYPES = { 1: 'number (double)', 2: 'string', 3: 'embedded document', 4: 'array', 5: 'binary', 7: 'ObjectId', 8: 'boolean', 9: 'date', 10: 'null', 16: 'number (int32)', 18: 'number (int64)', 19: 'decimal128' };
  function mapBson(bytes) {
    const segs = [];
    const docs = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const td = new TextDecoder();
    const cstr = (o) => { let e = o; while (e < bytes.length && bytes[e] !== 0) e++; return [td.decode(bytes.subarray(o, e)), e + 1]; };
    function doc(o, label, depth, isArray) {
      const len = dv.getInt32(o, true);
      segs.push({ s: o, e: o + 4, role: 'len', text: `${label} starts: its total length is ${len} bytes (int32, little-endian)` });
      let p = o + 4;
      const end = o + len - 1;
      while (p < end) {
        const type = bytes[p];
        segs.push({ s: p, e: p + 1, role: 'type', text: `Type byte 0x${type.toString(16).padStart(2, '0')}: the next value is a ${TYPES[type] || 'unknown type'}` });
        const [key, after] = cstr(p + 1);
        const name = isArray ? `item [${key}]` : `field "${key}"`;
        segs.push({ s: p + 1, e: after, role: 'key', text: `${isArray ? 'Array index' : 'Field name'} "${key}", ending with a 00 byte` });
        p = after;
        switch (type) {
          case 1: segs.push({ s: p, e: p + 8, role: 'val', text: `Value of ${name}: ${dv.getFloat64(p, true)} (8-byte double)` }); p += 8; break;
          case 2: {
            const sl = dv.getInt32(p, true);
            segs.push({ s: p, e: p + 4, role: 'len', text: `String length: ${sl} bytes, including the closing 00` });
            const str = td.decode(bytes.subarray(p + 4, p + 4 + sl - 1));
            segs.push({ s: p + 4, e: p + 4 + sl, role: 'val', text: `Value of ${name}: "${str}" as UTF-8 text` });
            p += 4 + sl; break;
          }
          case 3: case 4: {
            const sub = dv.getInt32(p, true);
            const isDocList = depth === 0 && key === 'data' && type === 4;
            doc(p, type === 4 ? `Array ${name}` : `Embedded document ${name}`, depth + 1, type === 4);
            if (isDocList) collectDocs(p);
            p += sub; break;
          }
          case 5: {
            const bl = dv.getInt32(p, true);
            segs.push({ s: p, e: p + 5, role: 'len', text: `Binary length ${bl} and subtype ${bytes[p + 4]}` });
            segs.push({ s: p + 5, e: p + 5 + bl, role: 'val', text: `Binary data of ${name} (${bl} bytes)` });
            p += 5 + bl; break;
          }
          case 7: segs.push({ s: p, e: p + 12, role: 'oid', text: `ObjectId of ${name}: ${[...bytes.subarray(p, p + 12)].map((b) => b.toString(16).padStart(2, '0')).join('')} (12 bytes)` }); p += 12; break;
          case 8: segs.push({ s: p, e: p + 1, role: 'val', text: `Value of ${name}: ${bytes[p] ? 'true' : 'false'}` }); p += 1; break;
          case 9: segs.push({ s: p, e: p + 8, role: 'val', text: `Value of ${name}: ${new Date(Number(dv.getBigInt64(p, true))).toISOString()} (milliseconds since 1970, int64)` }); p += 8; break;
          case 10: break;
          case 16: segs.push({ s: p, e: p + 4, role: 'val', text: `Value of ${name}: ${dv.getInt32(p, true)} (4-byte integer)` }); p += 4; break;
          case 18: segs.push({ s: p, e: p + 8, role: 'val', text: `Value of ${name}: ${dv.getBigInt64(p, true)} (8-byte integer)` }); p += 8; break;
          case 19: segs.push({ s: p, e: p + 16, role: 'val', text: `Decimal128 value of ${name}` }); p += 16; break;
          default: return;
        }
      }
      segs.push({ s: end, e: end + 1, role: 'end', text: `00: end of ${label.charAt(0).toLowerCase()}${label.slice(1)}` });
    }
    function collectDocs(arrStart) {
      // walk the array's elements to find each document's byte range
      let p = arrStart + 4;
      const end = arrStart + dv.getInt32(arrStart, true) - 1;
      while (p < end) {
        const [, after] = cstr(p + 1);
        const len = dv.getInt32(after, true);
        docs.push({ s: p, e: after + len });
        p = after + len;
      }
    }
    try { doc(0, 'The file', 0, false); } catch (e) { /* show what we could map */ }
    const owner = new Int32Array(bytes.length).fill(-1);
    segs.forEach((g, i) => { for (let b = g.s; b < g.e; b++) owner[b] = i; });
    return { segs, owner, docs };
  }

  /* ---------------- step timeline ---------------- */
  function describeArgs(args) {
    try { return args.map((a) => plain(a).replace(/\s*\n\s*/g, ' ')).join(', '); } catch { return '…'; }
  }
  function middleStep(op) {
    const n = (x) => (Array.isArray(x) ? x.length : 0);
    switch (op.method) {
      case 'insertOne': return op.result ? { ic: 'mem', t: 'Give the new document an _id and add it to the end of the array', d: `_id ${plain(op.result.insertedId)}` } : null;
      case 'insertMany': return op.result ? { ic: 'mem', t: `Give ${op.result.insertedCount} documents an _id each and add them to the array`, d: Object.values(op.result.insertedIds).map(plain).join('\n') } : null;
      case 'find': case 'findOne': case 'countDocuments': {
        const k = op.method === 'find' ? n(op.result) : op.method === 'findOne' ? (op.result ? 1 : 0) : op.result;
        const usedIndex = op.events.some((e) => e.type === 'read' && e.path.endsWith('.index.bson'));
        return { ic: 'mem', t: usedIndex ? `Check the index first, then confirm each candidate: ${k} match` : `Compare every document in memory with the query: ${k} match`, d: `${n(op.before)} documents in the array` };
      }
      case 'updateOne': case 'updateMany': return op.result ? { ic: 'mem', t: `Apply $set in memory: ${op.result.matchedCount} matched, ${op.result.modifiedCount} changed`, d: op.result.modifiedCount ? 'changed documents are rewritten with the rest' : 'nothing changed, so nothing is written' } : null;
      case 'deleteOne': case 'deleteMany': return op.result ? { ic: 'mem', t: `Remove ${op.result.deletedCount} document${op.result.deletedCount === 1 ? '' : 's'} from the array`, d: op.result.deletedCount ? '' : 'nothing removed, so nothing is written' } : null;
      case 'createIndex': return { ic: 'mem', t: `Build the index: for each value of "${typeof op.args[0] === 'string' ? op.args[0] : Object.keys(op.args[0] || {})[0]}", list the positions of the documents that have it`, d: '' };
      default: return null;
    }
  }
  function stepsFor(op) {
    const out = [{ ic: 'call', cls: 'call', t: `${op.coll}.${op.method}(${esc(describeArgs(op.args))})`, d: '', fx: { kind: 'call' } }];
    const collFile = `${DIR}/${op.coll}.bson`;
    const writes = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'createIndex']);
    let middleDone = false;
    const mid = middleStep(op);
    const pushMid = () => { if (!middleDone && mid) out.push({ ...mid, fx: { kind: 'mid' } }); middleDone = true; };
    const readColl = op.events.some((e) => e.type === 'read' && e.path === collFile);
    if (!readColl && !op.error && op.method !== 'drop' && op.method !== 'listIndexes' && op.method !== 'dropIndex') {
      out.push({ ic: 'disk', t: `No ${base(collFile)} yet, so start with an empty array`, d: '', fx: { kind: 'empty' } });
    }
    for (const e of op.events) {
      if (e.type === 'read') {
        const isIdx = e.path.endsWith('.index.bson');
        if (isIdx) { out.push({ ic: 'disk', t: `Read the index file ${base(e.path)}`, d: fmt(e.bytes.length), bytes: e.bytes, path: e.path, fx: { kind: 'readIndex', bytes: e.bytes } }); continue; }
        let count = '?';
        try { count = decode(e.bytes).data.length; } catch { /* corrupt */ }
        out.push({ ic: 'disk', t: `Read the whole file ${base(e.path)} from disk`, d: fmt(e.bytes.length), bytes: e.bytes, path: e.path, fx: { kind: 'read', bytes: e.bytes } });
        out.push({ ic: 'mem', t: `Decode the BSON bytes into a JavaScript array of ${count} document${count === 1 ? '' : 's'}`, d: 'now the data is in memory', fx: { kind: 'decode', bytes: e.bytes } });
      } else if (e.type === 'write') {
        if (e.path.startsWith(collFile) && !e.path.includes('.index.')) pushMid();
        const target = e.path.replace(/\.\d+\.[0-9a-f]+\.tmp$/, '');
        out.push({ ic: 'disk', t: `Encode ${target.endsWith('.index.bson') ? 'the index' : 'the whole array'} as BSON and write it to a temporary file`, d: `${base(e.path)} · ${fmt(e.bytes.length)}`, bytes: e.bytes, path: target, fx: { kind: 'write', bytes: e.bytes, tmp: base(e.path), index: target.endsWith('.index.bson') } });
      } else if (e.type === 'rename') {
        out.push({ ic: 'disk', t: `Rename the temporary file to ${base(e.to)}: the old version is replaced in one step, so a crash can’t leave half a file`, d: '', fx: { kind: 'rename', index: e.to.endsWith('.index.bson'), bytes: e.bytes } });
      } else if (e.type === 'unlink') {
        out.push({ ic: 'disk', t: `Delete ${base(e.path)}`, d: '', fx: { kind: 'unlink' } });
      }
    }
    if (!writes.has(op.method) || !middleDone) pushMid();
    if (op.error) out.push({ ic: '!', t: `Stopped with ${op.error.name}`, d: op.error.message, fx: { kind: 'error' } });
    else out.push({ ic: '↩', t: 'Return the result to your code', d: '', fx: { kind: 'return' } });
    out.forEach((st) => { st.op = op; });
    return out;
  }
  function renderSteps() {
    const list = $('steps');
    if (!state.ops.length) { list.innerHTML = '<li class="empty">Run some code to see each step here.</li>'; return; }
    const all = [];
    state.ops.forEach((op) => stepsFor(op).forEach((s) => all.push(s)));
    state.stepList = all;
    list.innerHTML = all.map((s, i) => `<li class="step ${s.cls || ''}" data-i="${i}" tabindex="0" ${s.bytes ? 'data-has-bytes' : ''} aria-selected="${state.selStep === i}" aria-current="${flow.i === i}"><span class="ic ${s.ic === 'disk' ? 'disk' : s.ic === 'mem' ? 'mem' : s.ic === 'call' ? 'call' : ''}">${s.ic === 'disk' ? 'DISK' : s.ic === 'mem' ? 'RAM' : s.ic === 'call' ? 'JS' : esc(s.ic)}</span><span><span class="tt">${s.t}</span>${s.d ? `<div class="dd">${esc(s.d)}</div>` : ''}</span></li>`).join('');
  }
  function pickStep(i) {
    const s = state.stepList[i];
    if (!s || !s.bytes) return;
    state.selStep = i;
    state.viewBytes = s.bytes;
    state.viewLabel = `${base(s.path)} at this step`;
    state.selFile = s.path;
    renderAll(false);
  }
  const stepClick = (li) => { if (!li) return; pause(); goTo(+li.dataset.i); if (li.hasAttribute('data-has-bytes')) pickStep(+li.dataset.i); };
  $('steps').addEventListener('click', (e) => stepClick(e.target.closest('.step[data-i]')));
  $('steps').addEventListener('keydown', (e) => { if (e.key === 'Enter') stepClick(e.target.closest('.step[data-i]')); });

  /* ---------------- disk ---------------- */
  function renderDisk(flash) {
    const files = [...fs.__files.keys()].filter((f) => f.startsWith(`${DIR}/`) && !f.endsWith('.tmp')).sort();
    if (!files.includes(state.selFile) && files.length) state.selFile = files.find((f) => f.endsWith('.bson') && !f.includes('.index.')) || files[0];
    $('tree').innerHTML = `<div class="dir">data/</div>${files.length ? files.map((f) => `<button type="button" class="file ${flash.has(f) ? 'flash' : ''}" aria-pressed="${f === state.selFile}" data-f="${f}"><span>${esc(base(f))}</span><span class="sz">${fmt(fs.__files.get(f).length)}</span></button>`).join('') : '<p class="empty">The folder is empty. Insert a document to create a file.</p>'}`;
    const sel = fs.__files.get(state.selFile);
    let info = '';
    if (sel) {
      try {
        const v = decode(sel);
        info = state.selFile.includes('.index.') ? `Index on ${v.fields.map((f) => `"${f}"`).join(', ')}, built from a file with SHA-1 ${String(v.sourceHash).slice(0, 10)}…` : `Holds { data: [ ${v.data.length} document${v.data.length === 1 ? '' : 's'} ] }`;
      } catch { info = 'This file cannot be decoded.'; }
    }
    $('diskinfo').textContent = info;
  }
  $('tree').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    state.selFile = b.dataset.f;
    state.viewBytes = null;
    state.selStep = null;
    state.selDoc = 0;
    renderAll(false);
  });

  /* ---------------- memory ---------------- */
  function lastOpFor(coll) { for (let i = state.ops.length - 1; i >= 0; i--) if (state.ops[i].coll === coll) return state.ops[i]; return null; }
  function renderMemory() {
    const file = state.selFile;
    const bytes = state.viewBytes || fs.__files.get(file);
    $('oid').innerHTML = '';
    if (!bytes) { $('memwhere').textContent = ''; $('docs').innerHTML = '<p class="empty">Nothing in memory yet.</p>'; return; }
    let value;
    try { value = decode(bytes); } catch { $('docs').innerHTML = '<p class="empty">These bytes are not valid BSON.</p>'; return; }

    if (file.includes('.index.')) {
      $('memwhere').textContent = `index of ${base(file).replace('.index.bson', '')}`;
      $('memsub').textContent = 'The index maps each value to the positions of the documents that have it, so a lookup can skip the other documents.';
      $('docs').innerHTML = `<div class="idxview">${value.entries.map((en) => `<div><b>${esc(en.field)}</b>${en.keys.map(([k, pos]) => `<div class="row"><span>${esc(prettyKey(k))}</span><span class="brace">→</span>${pos.map((p) => `<span class="pos">#${p}</span>`).join('')}</div>`).join('')}</div>`).join('')}</div>`;
      return;
    }

    const coll = base(file).replace('.bson', '');
    $('memwhere').textContent = `${coll} = [ … ]`;
    $('memsub').textContent = 'When youssefdb opens a file, it turns the bytes back into a JavaScript array. Click a document.';
    const docs = value.data;
    const op = state.viewBytes ? null : lastOpFor(coll);
    const before = op && op.before ? op.before : null;
    const beforeMap = new Map((before || []).map((d) => [idKey(d), d]));
    const afterKeys = new Set(docs.map(idKey));
    const hits = new Set();
    if (op && !op.error) {
      if (op.method === 'find') (op.result || []).forEach((d) => hits.add(idKey(d)));
      if (op.method === 'findOne' && op.result) hits.add(idKey(op.result));
    }
    const fresh = op && !op.error && /insert/.test(op.method);
    const items = docs.map((d, i) => {
      const k = idKey(d);
      const old = beforeMap.get(k);
      let cls = '';
      let tag = '';
      const changed = new Set();
      if (op && !op.error) {
        if (fresh && !old) { cls = 'new'; tag = 'new'; }
        else if (old) {
          for (const f of new Set([...Object.keys(d), ...Object.keys(old)])) if (sig(d[f]) !== sig(old[f])) changed.add(f);
          if (changed.size) { cls = 'chg'; tag = 'changed'; }
        }
        if (hits.has(k)) { cls = 'hit'; tag = 'returned'; }
      }
      return { d, i, cls, tag, changed };
    });
    const deleted = op && !op.error && before ? before.filter((d) => !afterKeys.has(idKey(d))) : [];
    if (state.selDoc >= docs.length) state.selDoc = Math.max(0, docs.length - 1);
    const html = items.map(({ d, i, cls, tag, changed }) => `<div class="doc ${cls}" data-i="${i}" tabindex="0" aria-selected="${i === state.selDoc}"><span class="idx">#${i}</span><span class="brace">{</span>${tag ? `<span class="tag">${tag}</span>` : ''}${Object.entries(d).map(([k, v]) => `<span class="kv ${changed.has(k) ? 'changed' : ''}"><span class="k">${esc(k)}</span>: ${show(v)}</span>`).join('')}<span class="brace">}</span></div>`);
    deleted.forEach((d) => html.push(`<div class="doc del"><span class="brace">{</span><span class="tag">deleted</span>${Object.entries(d).map(([k, v]) => `<span class="kv"><span class="k">${esc(k)}</span>: ${show(v)}</span>`).join('')}<span class="brace">}</span></div>`));
    $('docs').innerHTML = html.length ? html.join('') : '<p class="empty">The array is empty: [ ]</p>';
    const sel = docs[state.selDoc];
    if (sel && isOid(sel._id)) renderOid(sel._id);
    const selEl = $('docs').querySelector('.doc[aria-selected="true"]');
    if (selEl) {
      const box = $('docs');
      const top = selEl.offsetTop - box.offsetTop;
      if (top < box.scrollTop || top + selEl.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 8);
    }
  }
  function prettyKey(k) {
    const t = k[0];
    const rest = k.slice(1);
    if (t === 's') return rest;
    if (t === 'n' || t === 'b') return rest;
    if (t === 'o') return `ObjectId("${rest}")`;
    if (t === 'd') return `Date(${new Date(+rest).toISOString()})`;
    return 'null / missing';
  }
  function renderOid(id) {
    const hex = id.toHexString();
    const bytes = hex.match(/../g);
    const ts = parseInt(hex.slice(0, 8), 16);
    const counter = parseInt(hex.slice(18), 16);
    $('oid').innerHTML = `<div class="oid"><div class="sub">This document’s <code>_id</code> is an ObjectId: 12 bytes youssefdb creates on insert, unique without asking any server.</div>
      <div class="bytes">${bytes.map((b, i) => `<span class="b ${i < 4 ? 'ts' : i < 9 ? 'rnd' : 'cnt'}">${b}</span>`).join('')}</div>
      <div class="legend"><div class="ts">Bytes 1–4 · time<b>${new Date(ts * 1000).toISOString().replace('.000Z', 'Z')}</b>seconds since 1970, so ids sort by creation time</div>
      <div class="rnd">Bytes 5–9 · random<b>${hex.slice(8, 18)}</b>picked once per process, so two machines don’t clash</div>
      <div class="cnt">Bytes 10–12 · counter<b>${counter}</b>goes up by one for each new id</div></div></div>`;
  }
  $('docs').addEventListener('click', (e) => { const d = e.target.closest('.doc[data-i]'); if (d) { state.selDoc = +d.dataset.i; renderMemory(); renderBytes(true); } });
  $('docs').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const d = e.target.closest('.doc[data-i]'); if (d) { state.selDoc = +d.dataset.i; renderMemory(); renderBytes(true); } } });

  /* ---------------- bytes ---------------- */
  let currentMap = null;
  const LIMIT = 1536;
  function renderBytes(scrollToDoc) {
    const bytes = state.viewBytes || fs.__files.get(state.selFile);
    $('byteswhere').textContent = bytes ? (state.viewBytes ? state.viewLabel : base(state.selFile)) : '';
    if (!bytes) { $('hex').innerHTML = '<p class="empty">No file selected.</p>'; $('more').hidden = true; currentMap = null; return; }
    currentMap = mapBson(bytes);
    const docRange = currentMap.docs[state.selDoc];
    const shown = state.showAll ? bytes.length : Math.min(bytes.length, Math.max(LIMIT, docRange ? docRange.e + 64 : 0));
    let out = '';
    for (let o = 0; o < shown; o += 16) {
      let cells = '';
      let ascii = '';
      for (let i = o; i < o + 16; i++) {
        if (i >= shown) { cells += '<span class="c"> </span>'; continue; }
        const g = segByOwner(currentMap.owner[i]);
        const inDoc = docRange && i >= docRange.s && i < docRange.e ? ' indoc' : '';
        cells += `<span class="c ${g ? `s-${g.role}` : ''}${inDoc}" data-b="${i}">${bytes[i].toString(16).padStart(2, '0')}</span>`;
        const ch = bytes[i] > 31 && bytes[i] < 127 ? String.fromCharCode(bytes[i]) : '·';
        ascii += `<span class="a">${esc(ch)}</span>`;
      }
      out += `<div class="row"><span class="off">${o.toString(16).padStart(4, '0')}</span><span class="cells">${cells}</span><span class="ascii">${ascii}</span></div>`;
    }
    $('hex').innerHTML = out;
    $('more').hidden = shown >= bytes.length;
    $('more').textContent = `Show all ${fmt(bytes.length)}`;
    if (scrollToDoc && docRange) {
      const el = $('hex').querySelector(`[data-b="${docRange.s}"]`);
      if (el) $('hexwrap').scrollTop = el.offsetTop - 40;
      $('caption').innerHTML = `Document #${state.selDoc} is bytes ${docRange.s}–${docRange.e - 1} of the file (${docRange.e - docRange.s} bytes), underlined below.<div class="r">Inside the file, the documents sit one after another in an array called “data”.</div>`;
    }
  }
  const segByOwner = (i) => (i >= 0 && currentMap ? currentMap.segs[i] : null);
  $('hex').addEventListener('mouseover', (e) => {
    const c = e.target.closest('[data-b]');
    if (!c || !currentMap) return;
    const i = +c.dataset.b;
    const g = segByOwner(currentMap.owner[i]);
    $('hex').querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
    if (!g) return;
    for (let b = g.s; b < g.e; b++) { const el = $('hex').querySelector(`[data-b="${b}"]`); if (el) el.classList.add('on'); }
    $('caption').innerHTML = `${esc(g.text)}<div class="r">byte${g.e - g.s > 1 ? 's' : ''} ${g.s}${g.e - g.s > 1 ? `–${g.e - 1}` : ''} · ${g.e - g.s} byte${g.e - g.s > 1 ? 's' : ''}</div>`;
  });
  $('more').addEventListener('click', () => { state.showAll = true; renderBytes(false); });

  /* ---------------- animated flow: code → memory → encoder → disk ---------------- */
  const flow = { i: -1, playing: false, timer: null };
  const SPEED = 1500;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function summary(d) {
    const parts = Object.entries(d).filter(([k]) => k !== '_id').slice(0, 2).map(([, v]) => (typeof v === 'string' ? v : plain(v).replace(/\s*\n\s*/g, ' ')));
    return parts.join(' · ') || '{ }';
  }
  function fieldBlocks(doc) {
    // one block group per top-level field: [type + name] then [value], widths follow byte counts
    let bytes;
    try { bytes = BSON.serialize(doc); } catch { return ''; }
    const groups = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 4;
    const end = bytes.length - 1;
    while (p < end) {
      const type = bytes[p];
      let q = p + 1;
      while (bytes[q] !== 0) q++;
      const key = new TextDecoder().decode(bytes.subarray(p + 1, q));
      const vs = q + 1;
      let ve = vs;
      if (type === 1 || type === 9 || type === 18) ve = vs + 8;
      else if (type === 2) ve = vs + 4 + dv.getInt32(vs, true);
      else if (type === 3 || type === 4) ve = vs + dv.getInt32(vs, true);
      else if (type === 5) ve = vs + 5 + dv.getInt32(vs, true);
      else if (type === 7) ve = vs + 12;
      else if (type === 8) ve = vs + 1;
      else if (type === 10) ve = vs;
      else if (type === 16) ve = vs + 4;
      else if (type === 19) ve = vs + 16;
      else break;
      groups.push({ key, head: vs - p, val: ve - vs, type });
      p = ve;
    }
    const unit = (n) => `${Math.max(n, 1)}fr`;
    const cols = ['4fr'].concat(groups.flatMap((g) => [unit(g.head), ...(g.val ? [unit(g.val)] : [])])).concat(['1fr']).join(' ');
    const cells = ['<span class="blk s-len" title="document length, 4 bytes"></span>']
      .concat(groups.flatMap((g) => [`<span class="blk s-key" title="type byte + field name &quot;${esc(g.key)}&quot;: ${g.head} bytes"></span>`, ...(g.val ? [`<span class="blk ${g.type === 7 ? 's-oid' : 's-val'}" title="value of ${esc(g.key)}: ${g.val} bytes"></span>`] : [])]))
      .concat(['<span class="blk s-end" title="end marker"></span>']).join('');
    const labels = groups.map((g) => `<span><b>${esc(g.key)}</b> ${g.head + g.val} B</span>`).join('');
    return `<div class="strip" style="grid-template-columns:${cols}">${cells}</div><div class="striplabels">${labels}</div><div class="stripnote">${bytes.length} bytes for this document</div>`;
  }
  function fileBar(bytes, cls = '') {
    if (!bytes) return '<div class="fbar empty"></div>';
    let m;
    try { m = mapBson(bytes); } catch { return '<div class="fbar"></div>'; }
    const total = bytes.length;
    const parts = [];
    let p = 0;
    m.docs.forEach((r, i) => {
      if (r.s > p) parts.push(`<span class="seg hdr" style="flex:${r.s - p}"></span>`);
      parts.push(`<span class="seg doc ${i % 2 ? 'alt' : ''}" style="flex:${r.e - r.s}" title="document #${i}: ${r.e - r.s} bytes"></span>`);
      p = r.e;
    });
    if (p < total) parts.push(`<span class="seg hdr" style="flex:${total - p}"></span>`);
    return `<div class="fbar ${cls}">${parts.join('')}</div>`;
  }

  function flowState(i) {
    const all = state.stepList || [];
    const step = all[i];
    const op = step.op;
    const mine = all.filter((s) => s.op === op);
    const k = mine.indexOf(step);
    const upto = mine.slice(0, k + 1);
    const has = (fn) => upto.some(fn);
    const readOnly = !/insert|update|delete|createIndex/.test(op.method);
    return {
      step, op, k, n: mine.length,
      loaded: has((s) => s.fx.kind === 'decode' || s.fx.kind === 'empty'),
      midPassed: has((s) => s.fx.kind === 'mid') || (readOnly && has((s) => s.fx.kind === 'return')),
      renamedMain: has((s) => s.fx.kind === 'rename' && !s.fx.index),
      writingMain: has((s) => s.fx.kind === 'write' && !s.fx.index) && !has((s) => s.fx.kind === 'rename' && !s.fx.index),
      writingIndex: has((s) => s.fx.kind === 'write' && s.fx.index) && !has((s) => s.fx.kind === 'rename' && s.fx.index),
      indexShown: op.hadIndex || has((s) => s.fx.index),
      tmp: (upto.filter((s) => s.fx.kind === 'write').pop() || { fx: {} }).fx.tmp,
    };
  }

  const STATIONS = { call: 'code', empty: 'disk', read: 'disk', decode: 'mem', readIndex: 'disk', mid: 'mem', write: 'enc', rename: 'disk', unlink: 'disk', return: 'code', error: 'code' };
  const PIPES = { call: { p1: 'fwd' }, read: { p3: 'back' }, readIndex: { p3: 'back' }, decode: { p2: 'back' }, write: { p2: 'fwd', p3: 'fwd' }, return: { p1: 'back' }, error: { p1: 'back' } };

  function renderFlow() {
    const all = state.stepList || [];
    if (flow.i < 0 || !all.length) {
      $('flowcap').innerHTML = 'Run some code to watch your data move.';
      $('flowcount').textContent = '';
      ['code', 'mem', 'enc', 'disk'].forEach((s) => { $(`st-${s}`).classList.remove('active'); });
      return;
    }
    const st = flowState(flow.i);
    const { step, op } = st;
    const kind = step.fx.kind;

    // stations and pipes
    ['code', 'mem', 'enc', 'disk'].forEach((s) => $(`st-${s}`).classList.toggle('active', STATIONS[kind] === s));
    $('st-code').classList.toggle('bad', kind === 'error');
    ['p1', 'p2', 'p3'].forEach((p) => {
      const dir = (PIPES[kind] || {})[p];
      const el = $(p);
      el.className = `pipe ${dir || ''}`;
      let label = '';
      if (dir) {
        if (kind === 'call') label = `${op.method}()`;
        else if (kind === 'read' || kind === 'readIndex' || (kind === 'write' && p === 'p3')) label = fmt(step.fx.bytes.length);
        else if (kind === 'decode') label = `${(op.before || []).length} docs`;
        else if (kind === 'write' && p === 'p2') label = step.fx.index ? 'index' : `${(op.after || []).length} docs`;
        else if (kind === 'return') label = 'result';
        else if (kind === 'error') label = 'error';
      }
      el.querySelector('.pkt').textContent = label;
    });

    // code
    let codeBody = `<code class="call">${esc(op.coll)}.${esc(op.method)}(${esc(describeArgs(op.args))})</code>`;
    if (kind === 'return') {
      const r = op.result;
      const txt = Array.isArray(r) ? `${r.length} document${r.length === 1 ? '' : 's'} returned` : r && typeof r === 'object' ? plain(r).replace(/\s*\n\s*/g, ' ') : String(r);
      codeBody += `<div class="ret">← ${esc(txt)}</div>`;
    }
    if (kind === 'error') codeBody += `<div class="ret bad">✕ ${esc(op.error.name)}</div>`;
    $('sb-code').innerHTML = codeBody;

    // memory
    let memBody;
    if (!st.loaded) memBody = '<p class="idle">Empty. Nothing is in memory until a file is read.</p>';
    else {
      const showAfter = st.midPassed;
      const docs = (showAfter ? op.after : op.before) || [];
      const before = op.before || [];
      const bmap = new Map(before.map((d) => [idKey(d), d]));
      const hits = new Set();
      if (showAfter && op.method === 'find') (op.result || []).forEach((d) => hits.add(idKey(d)));
      if (showAfter && op.method === 'findOne' && op.result) hits.add(idKey(op.result));
      const animNow = kind === 'mid' && !reduceMotion;
      const scanning = animNow && /find|count/.test(op.method);
      const tiles = docs.map((d, i) => {
        const key = idKey(d);
        const old = bmap.get(key);
        let cls = '';
        if (showAfter && /insert/.test(op.method) && !old) cls = 'new';
        else if (showAfter && old && sig(old) !== sig(d)) cls = 'chg';
        if (hits.has(key)) cls = 'hit';
        return `<div class="tile ${cls} ${animNow ? 'anim' : ''} ${scanning ? 'scan' : ''}" style="--d:${i * 90}ms" title="${esc(plain(d).replace(/\s*\n\s*/g, ' '))}"><span class="ti">#${i}</span><span class="tt">${esc(summary(d))}</span></div>`;
      });
      if (showAfter && op.after) {
        const ak = new Set(op.after.map(idKey));
        before.filter((d) => !ak.has(idKey(d))).forEach((d) => tiles.push(`<div class="tile del ${animNow ? 'anim' : ''}"><span class="ti">✕</span><span class="tt">${esc(summary(d))}</span></div>`));
      }
      memBody = `<div class="arrlabel">${esc(op.coll)} = [ ${docs.length} document${docs.length === 1 ? '' : 's'} ]</div><div class="tiles">${tiles.join('') || '<span class="idle">[ ] empty array</span>'}</div>`;
    }
    $('sb-mem').innerHTML = memBody;

    // encoder
    let enc = '<p class="idle">Waiting. It turns objects into bytes on the way to disk, and bytes back into objects on the way in.</p>';
    if (kind === 'read' || kind === 'decode') {
      enc = `<div class="encmode">${kind === 'read' ? 'Bytes arriving from disk' : 'Decoding bytes → objects'}</div>${fileBar(step.fx.bytes, kind === 'decode' ? 'dim' : '')}<div class="stripnote">each block is one document inside the file</div>`;
    } else if (kind === 'readIndex') {
      enc = `<div class="encmode">Decoding the index</div><div class="stripnote">${fmt(step.fx.bytes.length)} of value → positions</div>`;
    } else if (kind === 'write' && step.fx.index) {
      enc = `<div class="encmode">Encoding the index → ${fmt(step.fx.bytes.length)}</div><div class="stripnote">each value is stored with the positions of its documents</div>`;
    } else if (kind === 'write') {
      const after = op.after || [];
      const bmap = new Map((op.before || []).map((d) => [idKey(d), d]));
      const focus = after.find((d) => !bmap.has(idKey(d))) || after.find((d) => sig(d) !== sig(bmap.get(idKey(d)))) || after[0];
      enc = `<div class="encmode">Encoding objects → BSON bytes</div>${focus ? `<div class="focus">${esc(summary(focus))}</div>${fieldBlocks(focus)}` : ''}<div class="stripnote">then the whole array of ${after.length} document${after.length === 1 ? '' : 's'}: ${fmt(step.fx.bytes.length)}</div>`;
    }
    $('sb-enc').innerHTML = enc;

    // disk
    const mainBytes = st.renamedMain ? op.afterBytes : op.beforeBytes;
    const rows = [];
    rows.push(`<div class="frow ${kind === 'read' ? 'reading' : ''} ${kind === 'rename' && !step.fx.index ? 'swap' : ''}"><span class="fname">${esc(op.coll)}.bson</span><span class="fsz">${mainBytes ? fmt(mainBytes.length) : 'no file yet'}</span>${fileBar(mainBytes)}</div>`);
    if (st.writingMain) rows.push(`<div class="frow tmp"><span class="fname">${esc(st.tmp || 'temporary file')}</span><span class="fsz">writing…</span><div class="fbar fill"><span class="seg doc" style="flex:1"></span></div></div>`);
    if (st.indexShown) rows.push(`<div class="frow idxrow ${kind === 'readIndex' ? 'reading' : ''} ${kind === 'rename' && step.fx.index ? 'swap' : ''} ${st.writingIndex ? 'pending' : ''}"><span class="fname">${esc(op.coll)}.index.bson</span><span class="fsz">${st.writingIndex ? 'writing…' : 'index'}</span></div>`);
    $('sb-disk').innerHTML = `<div class="folder">data/</div>${rows.join('')}`;

    // caption + controls
    const extra = { call: 'Your code asks youssefdb to do something.', empty: 'There is no file to read yet, so youssefdb starts with an empty list.', read: 'The whole file is read, even if you only need one document.', decode: 'The bytes become JavaScript objects you can work with.', readIndex: 'The index tells youssefdb which documents could match, so it checks fewer of them.', mid: 'All changes happen in memory first. The disk has not changed yet.', write: 'Objects are turned back into bytes and written to a temporary file first.', rename: 'Swapping the files in one step means a crash leaves either the old file or the new one, never half of each.', unlink: '', return: 'The answer goes back to your code.', error: 'youssefdb stopped before changing anything on disk.' }[kind] || '';
    $('flowcap').innerHTML = `<b>${step.t}</b>${extra ? `<span>${esc(extra)}</span>` : ''}`;
    $('flowcount').textContent = `Step ${flow.i + 1} of ${all.length}`;
    $('flowbar').style.width = `${((flow.i + 1) / all.length) * 100}%`;
    $('play').textContent = flow.playing ? 'Pause' : flow.i >= all.length - 1 ? 'Replay' : 'Play';
    $('prev').disabled = flow.i <= 0;
    $('next').disabled = flow.i >= all.length - 1;
    document.querySelectorAll('#steps .step').forEach((li) => li.setAttribute('aria-current', String(+li.dataset.i === flow.i)));
  }
  function goTo(i) {
    const n = (state.stepList || []).length;
    flow.i = Math.max(0, Math.min(n - 1, i));
    renderFlow();
  }
  function pause() { flow.playing = false; clearTimeout(flow.timer); renderFlow(); }
  function play() {
    const n = (state.stepList || []).length;
    if (!n) return;
    if (flow.i >= n - 1) flow.i = -1;
    flow.playing = true;
    const tick = () => {
      if (!flow.playing) return;
      if (flow.i >= n - 1) { flow.playing = false; renderFlow(); return; }
      goTo(flow.i + 1);
      flow.timer = setTimeout(tick, SPEED);
    };
    tick();
  }
  $('play').addEventListener('click', () => (flow.playing ? pause() : play()));
  $('prev').addEventListener('click', () => { pause(); goTo(flow.i - 1); });
  $('next').addEventListener('click', () => { pause(); goTo(flow.i + 1); });

  /* ---------------- run ---------------- */
  function renderAll(scroll, flash = new Set()) {
    renderSteps();
    renderDisk(flash);
    renderMemory();
    renderBytes(scroll);
  }
  function run() {
    const code = $('code').value;
    const sizes = new Map([...fs.__files].map(([k, v]) => [k, v]));
    state.ops = [];
    state.selStep = null;
    state.viewBytes = null;
    state.showAll = false;
    let res;
    const users = db.collection('users');
    try {
      let fn;
      try { fn = new Function('db', 'users', 'ObjectId', `"use strict"; return (${code.trim().replace(/;\s*$/, '')});`); } catch { fn = new Function('db', 'users', 'ObjectId', `"use strict"; ${code}`); }
      res = fn(db, users, ObjectId);
      $('result').classList.remove('err');
      $('result').textContent = res === undefined ? 'Done.' : plain(res);
    } catch (err) {
      $('result').classList.add('err');
      $('result').textContent = `${err.name}: ${err.message}`;
    }
    const flash = new Set([...fs.__files.keys()].filter((k) => sizes.get(k) !== fs.__files.get(k)));
    const last = state.ops[state.ops.length - 1];
    if (last) {
      state.lastColl = last.coll;
      const f = `${DIR}/${last.coll}.bson`;
      if (fs.__files.has(f)) state.selFile = f;
      if (/insert/.test(last.method) && fs.__files.has(f)) state.selDoc = decode(fs.__files.get(f)).data.length - 1;
      else if ((last.method === 'find' || last.method === 'findOne') && last.result && fs.__files.has(f)) {
        const first = Array.isArray(last.result) ? last.result[0] : last.result;
        const idx = first ? decode(fs.__files.get(f)).data.findIndex((d) => idKey(d) === idKey(first)) : -1;
        if (idx >= 0) state.selDoc = idx;
      }
    }
    renderAll(true, flash);
    clearTimeout(flow.timer);
    flow.i = -1;
    play();
  }

  function seed() {
    for (const k of [...fs.__files.keys()]) fs.__files.delete(k);
    db = makeDb();
    db.collection('users').insertMany([
      { name: 'Alice', age: 30, city: 'Cairo' },
      { name: 'Bob', age: 25, city: 'Giza', tags: ['dev'] },
      { name: 'Cara', age: 30, city: 'Giza' },
    ]);
    state.ops = [];
    state.selFile = `${DIR}/users.bson`;
    state.selDoc = 0;
    state.viewBytes = null;
    state.selStep = null;
  }

  /* ---------------- lessons ---------------- */
  const LESSONS = [
    { t: 'A document', code: "users.insertOne({ name: 'Dina', age: 28, city: 'Alexandria' })",
      x: ['A <b>document</b> is a JavaScript object: field names and values. NoSQL databases store it as it is, with no table to fit into.', 'Run it, then follow the steps: youssefdb reads <code>users.bson</code>, decodes it into an array in memory, adds Dina, and writes the whole file back.'] },
    { t: 'The _id key', code: "users.insertOne({ name: 'Omar' })",
      x: ['Every document needs a unique key called <code>_id</code>. If you don’t give one, youssefdb creates an <b>ObjectId</b>.', 'Click Omar in Memory: you’ll see his 12-byte id split into a timestamp, a random part and a counter. In the Bytes panel it’s the orange block.'] },
    { t: 'No fixed shape', code: "users.insertMany([\n  { name: 'Mona', skills: ['sql', 'node'] },\n  { name: 'Tarek', address: { city: 'Giza', zip: '12511' } }\n])",
      x: ['Documents in one collection don’t need the same fields. Mona has an array, Tarek has a document inside a document.', 'In Bytes, find the type byte <code>04</code> (array) and <code>03</code> (embedded document): BSON stores nested data as documents inside documents.'] },
    { t: 'How a value is saved', code: "users.insertOne({ n: 1, pi: 3.14, ok: true, nothing: null, when: new Date(0) })",
      x: ['Each field becomes: a <b>type byte</b>, the <b>field name</b> ending in <code>00</code>, then the <b>value</b>.', 'Point at the bytes of this new document: a whole number takes 4 bytes, a decimal 8, true/false 1, and null takes none at all.'] },
    { t: 'Reading', code: "users.find({ city: 'Giza' })",
      x: ['To read, youssefdb loads the <b>whole file</b> into memory and checks every document against your query.', 'Matching documents are marked “returned” in Memory. Notice that reading never writes to disk.'] },
    { t: 'Updating', code: "users.updateOne({ name: 'Alice' }, { $set: { age: 31 } })",
      x: ['<code>$set</code> changes one field in memory. Then the <b>entire file</b> is encoded and saved again, even for one number.', 'The changed field is highlighted. Click the Read step and the Write step to compare the old and new bytes.'] },
    { t: 'Deleting', code: "users.deleteMany({ city: 'Giza' })",
      x: ['Deleting removes documents from the array in memory, then saves what is left.', 'Removed documents are shown crossed out. The file gets smaller.'] },
    { t: 'Indexes', code: "users.createIndex('city')",
      x: ['An <b>index</b> is a second file that maps each value to the positions of the documents that have it.', 'Click <code>users.index.bson</code> in Disk to see it. Then run <code>users.find({ city: \'Cairo\' })</code>: the steps show the index being read first.'] },
    { t: 'Collections', code: "db.collection('orders').insertOne({ item: 'Laptop', price: 950 })",
      x: ['A <b>collection</b> is a group of documents, and each one is its own file in the folder.', 'A new file, <code>orders.bson</code>, appears in Disk. Click between the files to switch what Memory and Bytes show.'] },
  ];
  let cur = 0;
  function renderLessons() {
    $('lessons').innerHTML = LESSONS.map((l, i) => `<li><button type="button" class="lesson" aria-current="${i === cur}" data-i="${i}"><span class="n">${i + 1}</span><span class="t">${l.t}</span></button></li>`).join('');
    $('ltitle').textContent = `${cur + 1} · ${LESSONS[cur].t}`;
    $('explain').innerHTML = LESSONS[cur].x.map((p) => `<p>${p}</p>`).join('');
    $('code').value = LESSONS[cur].code;
  }
  $('lessons').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) { cur = +b.dataset.i; renderLessons(); $('code').focus(); } });
  $('run').addEventListener('click', run);
  $('code').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  $('reset').addEventListener('click', () => { seed(); $('result').textContent = 'Data reset to three example users.'; renderAll(false); });

  seed();
  renderLessons();
  run();
})();
