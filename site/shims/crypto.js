// Minimal crypto for the browser: SHA-1 hex digests and random bytes.
function sha1(bytes) {
  const ml = bytes.length * 8;
  const withOne = bytes.length + 1;
  const total = Math.ceil((withOne + 8) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes); m[bytes.length] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 4, ml >>> 0); dv.setUint32(total - 8, Math.floor(ml / 2 ** 32));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 80; j++) { const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]; w[j] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      const f = j < 20 ? (b & c) | (~b & d) : j < 40 ? b ^ c ^ d : j < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = j < 20 ? 0x5a827999 : j < 40 ? 0x6ed9eba1 : j < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
module.exports = {
  createHash() {
    let data = new Uint8Array();
    const api = {
      update(b) { const n = new Uint8Array(data.length + b.length); n.set(data); n.set(b, data.length); data = n; return api; },
      digest() { return sha1(data); },
    };
    return api;
  },
  randomBytes(n) {
    const u8 = crypto.getRandomValues(new Uint8Array(n));
    return { toString: () => hex(u8) };
  },
  __sha1: sha1,
};
