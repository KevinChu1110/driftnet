// A small QR code encoder: byte mode, error correction M, versions 1-10 (up to 213 bytes).
// Enough for a link with a one-time code; no dependencies, nothing leaves the page.
// qrMatrix(text) -> array of rows of booleans (true = dark), without the quiet zone.
// qrSvg(text, { scale, margin }) -> an <svg> string.

// Per version 1-10: [ecc codewords per block, [blocks, data codewords per block], ...]
const BLOCKS = [
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
  [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
];
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const dataWords = (v) => BLOCKS[v - 1].slice(1).reduce((n, [b, d]) => n + b * d, 0);
export const capacity = (v) => dataWords(v) - (v < 10 ? 2 : 3);

// GF(256) with the polynomial 0x11D.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function eccOf(data, n) {
  let gen = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    gen = next;
  }
  const rem = new Array(n).fill(0);
  for (const d of data) {
    const f = d ^ rem.shift();
    rem.push(0);
    if (f) gen.slice(1).forEach((g, j) => { rem[j] ^= mul(g, f); });
  }
  return rem;
}

function codewords(bytes, v) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const total = dataWords(v) * 8;
  put(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < total; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  // Split into blocks, add ECC to each, interleave.
  const [eccLen, ...groups] = BLOCKS[v - 1];
  const blocks = [];
  let at = 0;
  for (const [count, len] of groups) for (let i = 0; i < count; i++) { const d = data.slice(at, at + len); at += len; blocks.push({ d, e: eccOf(d, eccLen) }); }
  const out = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.d.length)); i++) blocks.forEach((b) => { if (i < b.d.length) out.push(b.d[i]); });
  for (let i = 0; i < eccLen; i++) blocks.forEach((b) => out.push(b.e[i]));
  return out;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function bch(value, poly, bitsLen) {
  let r = value << bitsLen;
  for (let i = 31 - Math.clz32(r); i >= bitsLen; i--) if ((r >>> i) & 1) r ^= poly << (i - bitsLen);
  return (value << bitsLen) | r;
}

function build(words, v, mask) {
  const n = 17 + 4 * v;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false)); // function modules
  const set = (r, c, dark) => { if (r >= 0 && c >= 0 && r < n && c < n) { m[r][c] = dark; fn[r][c] = true; } };
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      set(r0 + dr, c0 + dc, d !== 2 && d !== 4);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const a = ALIGN[v - 1];
  for (const r of a) for (const c of a) {
    if ((r === 6 && c === 6) || (r === 6 && c === a[a.length - 1]) || (r === a[a.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // Format (ECC M = 00) and version information, then the always-dark module.
  const fmt = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412;
  const f = (i) => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(i, 8, f(i));
  set(7, 8, f(6)); set(8, 8, f(7)); set(8, 7, f(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, f(i));
  for (let i = 0; i < 8; i++) set(8, n - 1 - i, f(i));
  for (let i = 8; i < 15; i++) set(n - 15 + i, 8, f(i));
  set(n - 8, 8, true);
  if (v >= 7) {
    const ver = bch(v, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const bit = ((ver >>> i) & 1) === 1, x = n - 11 + (i % 3), y = Math.floor(i / 3);
      set(y, x, bit); set(x, y, bit);
    }
  }
  // Data, zigzag from the bottom right, skipping the vertical timing column.
  const bits = [];
  words.forEach((w) => { for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1); });
  let k = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let j = 0; j < n; j++) for (let x = 0; x < 2; x++) {
      const c = right - x, up = ((right + 1) & 2) === 0, r = up ? n - 1 - j : j;
      if (fn[r][c]) continue;
      const bit = k < bits.length && bits[k++] === 1;
      m[r][c] = bit !== MASKS[mask](r, c);
    }
  }
  return m;
}

function penalty(m) {
  const n = m.length;
  let p = 0;
  const line = (get) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        if (get(i, j) === get(i, j - 1)) { run++; if (j === n - 1 && run >= 5) p += run - 2; }
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      // Finder-like 1:1:3:1:1 pattern with four light modules on a side.
      const s = Array.from({ length: n }, (_, j) => (get(i, j) ? 1 : 0)).join("");
      for (const pat of ["10111010000", "00001011101"]) for (let at = s.indexOf(pat); at >= 0; at = s.indexOf(pat, at + 1)) p += 40;
    }
  };
  line((r, c) => m[r][c]);
  line((r, c) => m[c][r]);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
  const dark = m.flat().filter(Boolean).length;
  p += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return p;
}

/** Smallest version that holds the text; throws when it does not fit in version 10. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((x) => bytes.length <= capacity(x));
  if (!v) throw new Error("text too long for the QR encoder");
  const words = codewords(bytes, v);
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(words, v, mask), s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}

export function qrSvg(text, { scale = 6, margin = 4 } = {}) {
  const m = qrMatrix(text), n = m.length + margin * 2;
  let d = "";
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + margin} ${r + margin}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges" role="img"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
