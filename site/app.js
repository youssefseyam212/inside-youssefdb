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
  // small line icons, 12px, 2px stroke, coloured by the surrounding text
  const icon = (d, label) => `<svg class="icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}><path d="${d}"/></svg>`;
  const ICON = { ok: (l = 'match') => icon('M2 6.5 4.8 9 10 3', l), no: (l = 'no match') => icon('M3 3l6 6M9 3 3 9', l) };

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
      case 'insertOne': return op.result ? { ic: 'mem', t: `Add the document to the end of the array, at position #${n(op.before)}`, d: `the array grows from ${n(op.before)} to ${n(op.before) + 1} documents` } : null;
      case 'insertMany': return op.result ? { ic: 'mem', t: `Add the ${op.result.insertedCount} documents to the end of the array, at positions #${n(op.before)}–#${n(op.before) + op.result.insertedCount - 1}`, d: `the array grows from ${n(op.before)} to ${n(op.before) + op.result.insertedCount} documents` } : null;
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
  /* ---------------- detailed memory steps: searching, the index, placing documents ---------------- */
  // These replay what youssefdb did, using the same rules (src/query/compileQuery.js, src/indexes/*).
  const MAX_EACH = 6; // the first documents get one step each; the rest share one step
  const OID_HEX = /^[0-9a-f]{24}$/i;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const flat = (v) => plain(v).replace(/\s*\n\s*/g, ' ');
  const hexOf = (v) => (isOid(v) ? v.toHexString() : typeof v === 'string' ? v.toLowerCase() : null);
  function same(a, b) {
    if (a === b) return true;
    if (isOid(a) || isOid(b)) { const h = hexOf(a); return h !== null && h === hexOf(b); }
    if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    return sig(a) === sig(b);
  }
  function checkField(doc, field, expected) {
    const present = own(doc, field) && doc[field] !== undefined;
    const actual = present ? doc[field] : null;
    let ok;
    if (expected === null || expected === undefined) ok = actual === null;
    else if (!present) ok = false;
    else ok = same(actual, expected) || (Array.isArray(actual) && !Array.isArray(expected) && actual.some((x) => same(x, expected)));
    return { field, actual: present ? actual : undefined, expected: expected === undefined ? null : expected, ok };
  }
  function checkDoc(doc, query) {
    const checks = Object.keys(query).map((f) => checkField(doc, f, query[f]));
    return { checks, ok: checks.every((c) => c.ok) };
  }
  const checkText = (c) => `${c.field}: ${c.actual === undefined ? 'missing' : flat(c.actual)} ${c.ok ? '=' : '≠'} ${flat(c.expected)}`;

  // index keys, same format as youssefdb's index file: s"Cairo", n30, btrue, null, o<hex>, d<ms>
  function storedKey(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return `s${JSON.stringify(v)}`;
    if (typeof v === 'number') return `n${Number.isNaN(v) ? 'NaN' : String(v === 0 ? 0 : v)}`;
    if (typeof v === 'boolean') return `b${v}`;
    if (isOid(v)) return `o${v.toHexString()}`;
    if (v instanceof Date) return `d${v.getTime()}`;
    return undefined;
  }
  function queryKey(v) {
    if (Array.isArray(v) || isOid(v) || (typeof v === 'string' && OID_HEX.test(v))) return undefined;
    if (v !== null && v !== undefined && typeof v === 'object' && !(v instanceof Date)) return undefined;
    return storedKey(v);
  }
  function keyLabel(k) {
    if (k === 'null') return 'null';
    const v = k.slice(1);
    if (k[0] === 'o') return `ObjectId("${v}")`;
    if (k[0] === 'd') return `Date("${new Date(+v).toISOString()}")`;
    return v;
  }
  // the index youssefdb used in this call: the one it wrote (if it rebuilt it), else the one it read
  function indexOf(op) {
    const ev = op.events.filter((e) => (e.type === 'read' || e.type === 'write') && e.path.includes('.index.bson')).pop();
    if (!ev) return null;
    try { const s = decode(ev.bytes); return s && Array.isArray(s.entries) ? s : null; } catch { return null; }
  }
  function eachStep(positions, make) {
    const out = positions.slice(0, MAX_EACH).map((p) => make([p]));
    if (positions.length > MAX_EACH) out.push(make(positions.slice(MAX_EACH)));
    return out;
  }
  const posList = (ps) => (ps.length ? ps.map((p) => `#${p}`).join(', ') : 'none');
  const docsWord = (n) => `${n} document${n === 1 ? '' : 's'}`;

  // find / findOne / countDocuments / update* / delete*: which documents were compared, and how
  function searchSteps(op) {
    if (op.error || !op.before) return null;
    const docs = op.before;
    const reads = /^(find|findOne|countDocuments)$/.test(op.method);
    const query = op.args[0] && typeof op.args[0] === 'object' ? op.args[0] : {};
    const fields = Object.keys(query);
    const steps = [];
    let pool = docs.map((_, i) => i);
    let via = 'scan';
    let why = '';
    const idx = reads ? indexOf(op) : null;
    if (idx) {
      for (const f of fields) {
        if (!idx.fields.includes(f)) continue;
        const key = queryKey(query[f]);
        if (key === undefined) { why = `a value like ${flat(query[f])} can’t be looked up in an index`; continue; }
        const entry = idx.entries.find((e) => e.field === f);
        if (!entry) continue;
        const hit = entry.keys.find(([k]) => k === key);
        pool = hit ? [...hit[1]] : [];
        via = 'index';
        steps.push({ ic: 'mem', t: `Look up ${esc(f)} = ${esc(flat(query[f]))} in the index`, d: pool.length ? `the index points to ${posList(pool)}, so only ${pool.length === 1 ? 'that document needs' : 'those need'} checking` : 'that value is not in the index, so nothing can match', fx: { kind: 'lookup', field: f, key, rows: entry.keys, positions: pool } });
        break;
      }
      if (via === 'scan' && !why) why = fields.length ? `the index is on ${idx.fields.map((f) => `"${f}"`).join(', ')}, and this query is on ${fields.map((f) => `"${f}"`).join(', ')}` : 'an empty query {} matches every document';
    }
    const firstOnly = op.method === 'updateOne' || op.method === 'deleteOne';
    const checked = [];
    const res = new Map();
    for (const p of pool) {
      if (!docs[p]) continue;
      const r = checkDoc(docs[p], query);
      res.set(p, r);
      checked.push(p);
      if (firstOnly && r.ok) break;
    }
    const matched = checked.filter((p) => res.get(p).ok).length;
    // safety: if this replay disagrees with what youssefdb returned, show the short version instead
    const r = op.result;
    const real = op.method === 'find' ? r.length : op.method === 'countDocuments' ? r : op.method === 'findOne' ? (r ? 1 : 0) : r.matchedCount ?? r.deletedCount;
    if (real !== (op.method === 'findOne' ? Math.min(matched, 1) : matched)) return null;

    const note = via === 'index' ? '' : why ? `The index can’t help here (${why}), so each document is checked in turn.` : !reads && op.hadIndex ? 'Updates and deletes don’t use the index in youssefdb, so each document is checked in turn.' : '';
    steps.push(...eachStep(checked, (ps) => {
      if (ps.length > 1) {
        const k = ps.filter((p) => res.get(p).ok).length;
        return { ic: 'mem', t: `Check the other ${ps.length} documents (${posList(ps)}) the same way: ${k} match`, d: '', fx: { kind: 'scan', positions: ps, via, note } };
      }
      const one = res.get(ps[0]);
      return { ic: 'mem', t: `${via === 'index' ? 'Go straight to' : 'Check'} document #${ps[0]}: ${one.ok ? 'it matches' : 'no match'}`, d: one.checks.map(checkText).join(' · ') || 'the query is empty, so every document matches', fx: { kind: 'scan', positions: ps, via, note } };
    }));

    const n = docs.length;
    const c = checked.length;
    let t;
    let d = '';
    if (via === 'index') {
      t = `The index meant checking only ${c} of ${docsWord(n)}: ${matched} matched`;
      d = `Without the index, all ${n} would be compared one by one.`;
    } else {
      t = firstOnly && c < n ? `Stopped at the first match: checked ${c} of ${docsWord(n)}` : `Full scan: compared all ${docsWord(n)}, ${matched} matched`;
      if (why) d = `There is an index, but it couldn’t help: ${why}.`;
      else if (!reads && op.hadIndex) d = 'youssefdb only uses indexes for find, findOne and countDocuments. Updates and deletes check documents in order.';
      else if (reads && fields.length) d = `Tip: ${op.coll}.createIndex('${fields[0]}') would let youssefdb jump straight to the matches.`;
    }
    return { steps, done: { ic: 'mem', t, d } };
  }

  // insertOne / insertMany: making the _id, checking it is unique, placing the document
  function insertSteps(op) {
    if (op.error || !op.result) return null;
    const ids = op.method === 'insertOne' ? [op.result.insertedId] : Object.values(op.result.insertedIds);
    const given = op.method === 'insertOne' ? [op.args[0]] : op.args[0];
    const n = (op.before || []).length;
    const steps = eachStep(ids.map((_, i) => i), (is) => {
      if (is.length > 1) return { ic: 'mem', t: `Give the other ${is.length} new documents an _id the same way`, d: '', fx: { kind: 'idgen', items: is } };
      const i = is[0];
      const mine = given[i] && given[i]._id !== undefined;
      const name = ids.length > 1 ? `new document ${i + 1}` : 'the new document';
      return { ic: 'mem', t: mine ? `Keep the _id you gave ${name}: ${esc(flat(ids[i]))}` : `Make an _id for ${name}: ${esc(flat(ids[i]))}`, d: !mine && isOid(ids[i]) ? `${ids[i].toHexString().slice(0, 8)} time · ${ids[i].toHexString().slice(8, 18)} random · ${ids[i].toHexString().slice(18)} counter` : '', fx: { kind: 'idgen', items: is } };
    });
    const its = ids.length > 1 ? 'each new _id' : 'the _id';
    steps.push({ ic: 'mem', t: n ? `Make sure ${its} is unique: compare with the ${n} _id${n === 1 ? '' : 's'} already in memory${ids.length > 1 ? ' and with each other' : ''}` : `Make sure ${its} is unique: the array is empty${ids.length > 1 ? ', so only compare the new ones with each other' : ', so there is nothing to clash with'}`, d: 'no duplicate. A duplicate would stop here with DuplicateKeyError, and nothing would be saved', fx: { kind: 'uniq' } });
    return { steps };
  }

  // createIndex: fill the index one document at a time
  function buildSteps(op) {
    if (op.error) return null;
    const field = typeof op.args[0] === 'string' ? op.args[0] : Object.keys(op.args[0] || {})[0];
    const idx = indexOf(op);
    const entry = idx && idx.entries.find((e) => e.field === field);
    if (!entry) return null;
    const docs = op.before || [];
    const steps = eachStep(docs.map((_, i) => i), (ps) => {
      const last = ps[ps.length - 1];
      if (ps.length > 1) return { ic: 'mem', t: `Do the same for documents ${posList(ps)}`, d: '', fx: { kind: 'build', field, rows: entry.keys, upto: last, positions: ps } };
      const doc = docs[last];
      const v = own(doc, field) ? doc[field] : undefined;
      let t;
      if (v === undefined) t = `Document #${last} has no ${esc(field)}, so list #${last} under null`;
      else if (Array.isArray(v)) t = `Document #${last}: ${esc(field)} is an array, so list #${last} under each of its values`;
      else if (storedKey(v) === undefined) t = `Document #${last}: ${esc(field)} is an embedded document, which can’t be indexed, so skip it`;
      else t = `Document #${last}: ${esc(field)} is ${esc(flat(v))}, so add #${last} to that value’s list`;
      return { ic: 'mem', t, d: '', fx: { kind: 'build', field, rows: entry.keys, upto: last, positions: ps } };
    });
    return { steps, done: { ic: 'mem', t: `The index on "${esc(field)}" is ready: ${entry.keys.length} value${entry.keys.length === 1 ? '' : 's'}, each with the positions of its documents`, d: `Now ${op.coll}.find({ ${field}: … }) can look up a value instead of checking every document.` } };
  }
  function detailFor(op) {
    try {
      if (/^insert/.test(op.method)) return insertSteps(op);
      if (op.method === 'createIndex') return buildSteps(op);
      if (/^(find|findOne|countDocuments|updateOne|updateMany|deleteOne|deleteMany)$/.test(op.method)) return searchSteps(op);
    } catch { /* fall back to the short version */ }
    return null;
  }

  function stepsFor(op) {
    const out = [{ ic: 'call', cls: 'call', t: `${op.coll}.${op.method}(${esc(describeArgs(op.args))})`, d: '', fx: { kind: 'call' } }];
    const collFile = `${DIR}/${op.coll}.bson`;
    const writes = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'createIndex']);
    let middleDone = false;
    const detail = detailFor(op);
    const reads = !writes.has(op.method) || op.method === 'createIndex';
    // reads end on the detailed summary; writes keep their own middle step and show the summary just before it
    const mid = detail && detail.done && reads ? detail.done : middleStep(op);
    const pushMid = () => {
      if (middleDone) return;
      middleDone = true;
      if (detail) detail.steps.forEach((st) => out.push(st));
      if (detail && detail.done && !reads) out.push({ ...detail.done, fx: { kind: 'scandone' } });
      if (mid) out.push({ ...mid, fx: { kind: 'mid' } });
    };
    const readColl = op.events.some((e) => e.type === 'read' && e.path === collFile);
    if (!readColl && !op.error && op.method !== 'drop' && op.method !== 'listIndexes' && op.method !== 'dropIndex') {
      out.push({ ic: 'disk', t: `No ${base(collFile)} yet, so start with an empty array`, d: '', fx: { kind: 'empty' } });
    }
    for (const e of op.events) {
      if (e.type === 'read') {
        const isIdx = e.path.endsWith('.index.bson');
        if (isIdx && op.method !== 'createIndex' && writes.has(op.method)) pushMid();
        if (isIdx) { out.push({ ic: 'disk', t: writes.has(op.method) && op.method !== 'createIndex' ? `Read the index file ${base(e.path)} so it can be rebuilt for the changed data` : `Read the index file ${base(e.path)}`, d: fmt(e.bytes.length), bytes: e.bytes, path: e.path, fx: { kind: 'readIndex', bytes: e.bytes } }); continue; }
        let count = '?';
        try { count = decode(e.bytes).data.length; } catch { /* corrupt */ }
        out.push({ ic: 'disk', t: `Read the whole file ${base(e.path)} from disk`, d: fmt(e.bytes.length), bytes: e.bytes, path: e.path, fx: { kind: 'read', bytes: e.bytes } });
        out.push({ ic: 'mem', t: `Decode the BSON bytes into a JavaScript array of ${count} document${count === 1 ? '' : 's'}`, d: 'now the data is in memory', fx: { kind: 'decode', bytes: e.bytes } });
      } else if (e.type === 'write') {
        if ((e.path.startsWith(collFile) && !e.path.includes('.index.')) || op.method === 'createIndex') pushMid();
        const target = e.path.replace(/\.\d+\.[0-9a-f]+\.tmp$/, '');
        out.push({ ic: 'disk', t: `Encode ${target.endsWith('.index.bson') ? 'the index' : 'the whole array'} as BSON and write it to a temporary file`, d: `${base(e.path)} · ${fmt(e.bytes.length)}`, bytes: e.bytes, path: target, fx: { kind: 'write', bytes: e.bytes, tmp: base(e.path), index: target.endsWith('.index.bson') } });
      } else if (e.type === 'rename') {
        out.push({ ic: 'disk', t: `Rename the temporary file to ${base(e.to)}: the old version is replaced in one step, so a crash can’t leave half a file`, d: '', fx: { kind: 'rename', index: e.to.endsWith('.index.bson'), bytes: e.bytes } });
      } else if (e.type === 'unlink') {
        out.push({ ic: 'disk', t: `Delete ${base(e.path)}`, d: '', fx: { kind: 'unlink' } });
      }
    }
    if (!writes.has(op.method) || !middleDone) pushMid();
    if (op.error) out.push({ ic: 'ERR', t: `Stopped with ${op.error.name}`, d: op.error.message, fx: { kind: 'error' } });
    else out.push({ ic: 'OUT', t: 'Return the result to your code', d: '', fx: { kind: 'return' } });
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
  const flow = { i: -1, playing: false, timer: null, speed: 1 };
  const STEP_MS = 1500;
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
      step, op, k, n: mine.length, upto,
      loaded: has((s) => s.fx.kind === 'decode' || s.fx.kind === 'empty'),
      midPassed: has((s) => s.fx.kind === 'mid') || (readOnly && has((s) => s.fx.kind === 'return')),
      renamedMain: has((s) => s.fx.kind === 'rename' && !s.fx.index),
      writingMain: has((s) => s.fx.kind === 'write' && !s.fx.index) && !has((s) => s.fx.kind === 'rename' && !s.fx.index),
      writingIndex: has((s) => s.fx.kind === 'write' && s.fx.index) && !has((s) => s.fx.kind === 'rename' && s.fx.index),
      indexShown: op.hadIndex || has((s) => s.fx.index),
      tmp: (upto.filter((s) => s.fx.kind === 'write').pop() || { fx: {} }).fx.tmp,
    };
  }

  const STATIONS = { call: 'code', empty: 'disk', read: 'disk', decode: 'mem', readIndex: 'disk', mid: 'mem', lookup: 'mem', scan: 'mem', scandone: 'mem', idgen: 'mem', uniq: 'mem', build: 'mem', write: 'enc', rename: 'disk', unlink: 'disk', return: 'code', error: 'code' };
  const PIPES = { call: { p1: 'fwd' }, read: { p3: 'back' }, readIndex: { p3: 'back' }, decode: { p2: 'back' }, write: { p2: 'fwd', p3: 'fwd' }, return: { p1: 'back' }, error: { p1: 'back' } };

  // Memory station for the detailed steps: which document is being looked at, the index table, the new _id
  const MAX_ROWS = 8;
  function memTile(d, i, cls, mark = '') {
    return `<div class="tile ${cls}" title="${esc(flat(d))}"><span class="ti">#${i}${mark ? ` <b class="mk">${mark}</b>` : ''}</span><span class="tt">${esc(summary(d))}</span></div>`;
  }
  function indexTable(field, rows, { hitKey = null, upto = Infinity, cur = -1 } = {}) {
    const shown = rows.map(([k, ps]) => [k, ps.filter((p) => p <= upto)]).filter(([, ps]) => ps.length);
    const list = shown.slice(0, MAX_ROWS).map(([k, ps]) => `<div class="irow ${k === hitKey ? 'hit' : ''} ${ps.includes(cur) ? 'cur' : ''}"><span class="ik">${esc(keyLabel(k))}</span><span class="ia">→</span><span class="ip">${ps.map((p) => `<span class="${p === cur ? 'now' : ''}">#${p}</span>`).join(' ')}</span></div>`).join('');
    const more = shown.length > MAX_ROWS ? `<div class="irow more">+ ${shown.length - MAX_ROWS} more values</div>` : '';
    return `<div class="arrlabel">index on "${esc(field)}": value → positions</div><div class="itable">${list || '<span class="idle">empty so far</span>'}${more}</div>`;
  }
  function memDetail(st) {
    const { step, op, upto } = st;
    const kind = step.fx.kind;
    if (!['lookup', 'scan', 'scandone', 'idgen', 'uniq', 'build'].includes(kind) && !(kind === 'mid' && /^(find|findOne|countDocuments|createIndex)$/.test(op.method) && upto.some((s) => s.fx.kind === 'scan' || s.fx.kind === 'build'))) return null;
    const docs = op.before || [];
    const label = `<div class="arrlabel">${esc(op.coll)} = [ ${docsWord(docs.length)} ]</div>`;
    const anim = reduceMotion ? '' : 'anim';

    if (kind === 'idgen' || kind === 'uniq') {
      const ids = op.method === 'insertOne' ? [op.result.insertedId] : Object.values(op.result.insertedIds);
      const shown = kind === 'idgen' ? step.fx.items : ids.map((_, i) => i);
      const cards = shown.slice(0, 3).map((i) => {
        const id = ids[i];
        const idHtml = isOid(id) ? `ObjectId("<span class="ts">${id.toHexString().slice(0, 8)}</span><span class="rnd">${id.toHexString().slice(8, 18)}</span><span class="cnt">${id.toHexString().slice(18)}</span>")` : esc(flat(id));
        return `<div class="newdoc ${anim}"><span class="nk">_id</span>: <span class="oidp">${idHtml}</span></div>`;
      }).join('') + (shown.length > 3 ? `<div class="stripnote">+ ${shown.length - 3} more</div>` : '');
      const legend = kind === 'idgen' && isOid(ids[shown[0]]) ? '<div class="oidlegend"><span class="ts">time</span><span class="rnd">random</span><span class="cnt">counter</span></div>' : '';
      const tiles = docs.map((d, i) => memTile(d, i, kind === 'uniq' ? `scan ${anim}` : '', kind === 'uniq' ? '≠' : '')).join('');
      return `<div class="arrlabel">new document${ids.length > 1 ? 's' : ''}, not saved yet</div>${cards}${legend}${label}<div class="tiles" style="--n:${docs.length}">${tiles || '<span class="idle">[ ] empty array, nothing to compare</span>'}</div>${kind === 'uniq' ? `<div class="verdict ok">${ICON.ok('')} no other document has this _id</div>` : ''}`;
    }

    if (kind === 'build') {
      const cur = step.fx.positions.length === 1 ? step.fx.upto : -1;
      const tiles = docs.map((d, i) => memTile(d, i, i === cur || step.fx.positions.includes(i) ? 'cur' : i < step.fx.positions[0] ? 'done' : '')).join('');
      return `${label}<div class="tiles">${tiles}</div>${indexTable(step.fx.field, step.fx.rows, { upto: step.fx.upto, cur })}`;
    }

    if (kind === 'mid' && op.method === 'createIndex') {
      const b = upto.filter((s) => s.fx.kind === 'build').pop();
      return `${label}<div class="tiles">${docs.map((d, i) => memTile(d, i, 'done')).join('')}</div>${indexTable(b.fx.field, b.fx.rows)}`;
    }

    // searching: lookup, scan, scandone, and the final summary of a read
    const lookup = upto.find((s) => s.fx.kind === 'lookup');
    const scans = upto.filter((s) => s.fx.kind === 'scan');
    const query = op.args[0] && typeof op.args[0] === 'object' ? op.args[0] : {};
    const seen = new Map();
    scans.forEach((s) => s.fx.positions.forEach((p) => seen.set(p, checkDoc(docs[p], query).ok)));
    const now = kind === 'scan' ? step.fx.positions : [];
    const pool = lookup ? new Set(lookup.fx.positions) : null;
    const finished = kind === 'scandone' || kind === 'mid';
    const tiles = docs.map((d, i) => {
      if (now.includes(i)) return memTile(d, i, `cur ${anim}`, now.length === 1 ? '?' : '');
      if (seen.has(i)) return memTile(d, i, seen.get(i) ? 'hit' : 'miss', seen.get(i) ? ICON.ok() : ICON.no());
      if (pool && !pool.has(i)) return memTile(d, i, 'skip', 'skipped');
      if (finished) return memTile(d, i, 'skip', 'not checked');
      return memTile(d, i, '');
    }).join('');
    let card = '';
    if (kind === 'scan' && now.length === 1) {
      const r = checkDoc(docs[now[0]], query);
      card = `<div class="cmp"><div class="arrlabel">compare #${now[0]} with the query ${esc(flat(query))}</div>${r.checks.map((c) => `<div class="cmprow ${c.ok ? 'ok' : 'bad'}">${esc(checkText(c))} ${c.ok ? ICON.ok() : ICON.no()}</div>`).join('') || `<div class="cmprow ok">empty query: matches ${ICON.ok()}</div>`}</div>`;
    }
    if (finished) {
      const checked = seen.size;
      card = `<div class="verdict ${lookup ? 'ok' : ''}">${lookup ? `checked ${checked} of ${docs.length}, thanks to the index` : `checked ${checked} of ${docs.length}`}</div>`;
    }
    const table = lookup && (kind === 'lookup' || kind === 'scan') ? indexTable(lookup.fx.field, lookup.fx.rows, { hitKey: lookup.fx.key }) : '';
    return `${table}${label}<div class="tiles">${tiles}</div>${card}`;
  }

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
    if (kind === 'error') codeBody += `<div class="ret bad">${ICON.no('')} ${esc(op.error.name)}</div>`;
    $('sb-code').innerHTML = codeBody;

    // memory
    let memBody = memDetail(st);
    if (memBody) { /* detailed view for this step */ } else if (!st.loaded) memBody = '<p class="idle">Empty. Nothing is in memory until a file is read.</p>';
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
        before.filter((d) => !ak.has(idKey(d))).forEach((d) => tiles.push(`<div class="tile del ${animNow ? 'anim' : ''}"><span class="ti">${ICON.no('deleted')} deleted</span><span class="tt">${esc(summary(d))}</span></div>`));
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
    const detailed = kind === 'scandone' || (kind === 'mid' && st.upto.some((s) => s.fx.kind === 'scan' || s.fx.kind === 'build') && /^(find|findOne|countDocuments|createIndex)$/.test(op.method));
    const extra = kind === 'readIndex' && /^(insert|update|delete)/.test(op.method) ? 'The data changed, so the positions in the index are out of date. youssefdb rebuilds the index and saves it again.' : kind === 'scan' ? (step.fx.via === 'index' ? 'Only the positions the index gave are checked. The other documents are skipped without being looked at.' : step.fx.note || 'Without an index, youssefdb can’t know where the matches are, so it looks at each document in turn.') : detailed ? step.d : { lookup: 'Like the index at the back of a book: find the value, read the positions next to it, go straight there.', idgen: 'An ObjectId is 12 bytes: 4 for the time, 5 random, 3 for a counter, so two ids are never the same.', uniq: 'Two documents can never share an _id.', build: 'The index lists each value once, with the positions of the documents that have it.', scandone: '', call: 'Your code asks youssefdb to do something.', empty: 'There is no file to read yet, so youssefdb starts with an empty list.', read: 'The whole file is read, even if you only need one document.', decode: 'The bytes become JavaScript objects you can work with.', readIndex: 'The index tells youssefdb which documents could match, so it checks fewer of them.', mid: 'All changes happen in memory first. The disk has not changed yet.', write: 'Objects are turned back into bytes and written to a temporary file first.', rename: 'Swapping the files in one step means a crash leaves either the old file or the new one, never half of each.', unlink: '', return: 'The answer goes back to your code.', error: 'youssefdb stopped before changing anything on disk.' }[kind] || '';
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
    flow.tick = () => {
      if (!flow.playing) return;
      if (flow.i >= n - 1) { flow.playing = false; renderFlow(); return; }
      goTo(flow.i + 1);
      flow.timer = setTimeout(flow.tick, STEP_MS / flow.speed);
    };
    flow.tick();
  }
  $('play').addEventListener('click', () => (flow.playing ? pause() : play()));
  $('prev').addEventListener('click', () => { pause(); goTo(flow.i - 1); });
  $('next').addEventListener('click', () => { pause(); goTo(flow.i + 1); });
  document.querySelectorAll('.speed button').forEach((b) => b.addEventListener('click', () => {
    flow.speed = +b.dataset.speed;
    document.querySelector('.flow').style.setProperty('--slow', 1 / flow.speed);
    document.querySelectorAll('.speed button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    // restart the wait for the next step so the new speed applies right away
    if (flow.playing) { clearTimeout(flow.timer); flow.timer = setTimeout(flow.tick, STEP_MS / flow.speed); }
  }));

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
    try {
      // eval returns the value of the last statement, so `const users = db.collection('users')` followed by `users.find({})` shows the find result.
      const fn = new Function('db', 'ObjectId', '__code', '"use strict"; return eval(__code);');
      res = fn(db, ObjectId, code);
      $('result').classList.remove('err');
      $('result').textContent = res === undefined ? 'Done.' : plain(res);
    } catch (err) {
      $('result').classList.add('err');
      const missing = err instanceof ReferenceError && /^(\w+) is not defined$/.exec(err.message);
      $('result').textContent = `${err.name}: ${err.message}` + (missing ? `\n\nCreate the collection first, on its own line:\nconst ${missing[1]} = db.collection('${missing[1]}')` : '');
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
    { t: 'A document', code: "const users = db.collection('users')\nusers.insertOne({ name: 'Dina', age: 28, city: 'Alexandria' })",
      x: ['A <b>document</b> is a JavaScript object: field names and values. NoSQL databases store it as it is, with no table to fit into.', 'Run it, then follow the steps: youssefdb reads <code>users.bson</code>, decodes it into an array in memory, adds Dina, and writes the whole file back.'] },
    { t: 'The _id key', code: "const users = db.collection('users')\nusers.insertOne({ name: 'Omar' })",
      x: ['Every document needs a unique key called <code>_id</code>. If you don’t give one, youssefdb creates an <b>ObjectId</b>.', 'Click Omar in Memory: you’ll see his 12-byte id split into a timestamp, a random part and a counter. In the Bytes panel it’s the orange block.'] },
    { t: 'No fixed shape', code: "const users = db.collection('users')\nusers.insertMany([\n  { name: 'Mona', skills: ['sql', 'node'] },\n  { name: 'Tarek', address: { city: 'Giza', zip: '12511' } }\n])",
      x: ['Documents in one collection don’t need the same fields. Mona has an array, Tarek has a document inside a document.', 'In Bytes, find the type byte <code>04</code> (array) and <code>03</code> (embedded document): BSON stores nested data as documents inside documents.'] },
    { t: 'How a value is saved', code: "const users = db.collection('users')\nusers.insertOne({ n: 1, pi: 3.14, ok: true, nothing: null, when: new Date(0) })",
      x: ['Each field becomes: a <b>type byte</b>, the <b>field name</b> ending in <code>00</code>, then the <b>value</b>.', 'Point at the bytes of this new document: a whole number takes 4 bytes, a decimal 8, true/false 1, and null takes none at all.'] },
    { t: 'Reading', code: "const users = db.collection('users')\nusers.find({ city: 'Giza' })",
      x: ['To read, youssefdb loads the <b>whole file</b> into memory and checks every document against your query.', 'Press Play and watch Memory: each document is compared with the query in turn and marked as a match or not. With no index this is a <b>full scan</b>. Notice that reading never writes to disk.'] },
    { t: 'Updating', code: "const users = db.collection('users')\nusers.updateOne({ name: 'Alice' }, { $set: { age: 31 } })",
      x: ['<code>$set</code> changes one field in memory. Then the <b>entire file</b> is encoded and saved again, even for one number.', 'The changed field is highlighted. Click the Read step and the Write step to compare the old and new bytes.'] },
    { t: 'Deleting', code: "const users = db.collection('users')\nusers.deleteMany({ city: 'Giza' })",
      x: ['Deleting removes documents from the array in memory, then saves what is left.', 'Removed documents are shown crossed out. The file gets smaller.'] },
    { t: 'Indexes', code: "const users = db.collection('users')\nusers.createIndex('city')",
      x: ['An <b>index</b> is a second file that lists each value once, with the positions of the documents that have it, like the index at the back of a book.', 'Press Play to watch it being built one document at a time. Then click <code>users.index.bson</code> in Disk to see it.'] },
    { t: 'Collections', code: "const orders = db.collection('orders')\norders.insertOne({ item: 'Laptop', price: 950 })",
      x: ['A <b>collection</b> is a group of documents, and each one is its own file in the folder. <code>db.collection(\'orders\')</code> gives you the collection; save it in a variable, then call its methods.', 'A new file, <code>orders.bson</code>, appears in Disk. Click between the files to switch what Memory and Bytes show.'] },
    { t: 'With vs without an index', code: "const shop = db.collection('shop')\nshop.drop()\nshop.insertMany([\n  { item: 'Pen', type: 'office' }, { item: 'Novel', type: 'book' },\n  { item: 'Mug', type: 'kitchen' }, { item: 'Atlas', type: 'book' },\n  { item: 'Lamp', type: 'home' }, { item: 'Stapler', type: 'office' }\n])\nshop.find({ type: 'book' })   // no index: checks all 6\nshop.createIndex('type')\nshop.find({ type: 'book' })   // with the index: checks only 2",
      x: ['The same search runs twice: first with no index, then after <code>createIndex(\'type\')</code>.', 'Press Play. The first find checks all 6 documents one by one. The second looks up "book" in the index, gets positions #1 and #3, and goes straight there. The other four are skipped.'] },
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
  // Every collection on the in-memory disk, saved as one JSON file. ObjectIds and Dates are kept as Extended JSON ({ "$oid": ... }).
  function download() {
    const data = {};
    for (const [f, bytes] of [...fs.__files].sort(([a], [b]) => a.localeCompare(b))) {
      const m = /^\/data\/([^/]+)\.bson$/.exec(f);
      if (m && !m[1].endsWith('.index')) data[m[1]] = decode(bytes).data;
    }
    const blob = new Blob([BSON.EJSON.stringify(data, null, 2, { relaxed: true })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'youssefdb-data.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('download').addEventListener('click', download);
  $('reset').addEventListener('click', () => { seed(); $('result').textContent = 'Data reset to three example users.'; renderAll(false); });

  seed();
  renderLessons();
  run();
})();
