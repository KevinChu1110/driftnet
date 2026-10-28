import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain browser module, no types
import { qrMatrix, qrSvg, capacity } from "../public/qr.js";

const grid = (t: string) => qrMatrix(t) as boolean[][];

test("the version follows the length and sets the size", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(capacity), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  assert.equal(grid("a".repeat(14)).length, 21, "version 1");
  assert.equal(grid("a".repeat(15)).length, 25, "version 2");
  assert.equal(grid("a".repeat(106)).length, 41, "version 6");
  assert.equal(grid("a".repeat(107)).length, 45, "version 7");
  assert.equal(grid("a".repeat(213)).length, 57, "version 10");
  assert.throws(() => qrMatrix("a".repeat(214)), /too long/);
});

test("finder patterns, timing and the dark module are where the spec puts them", () => {
  for (const text of ["hi", "https://driftnet.example/#pair=" + "x".repeat(32)]) {
    const m = grid(text), n = m.length;
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
        const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        assert.equal(m[r0 + i]![c0 + j], ring !== 2, `finder at ${r0},${c0}`);
      }
    }
    for (let i = 8; i < n - 8; i++) assert.equal(m[6]![i], i % 2 === 0, "timing row");
    assert.equal(m[n - 8]![8], true, "dark module");
  }
});

test("format information is a valid BCH codeword for level M, both copies agree", () => {
  const m = grid("https://driftnet.example/#pair=abc"), n = m.length;
  const one = (i: number): [number, number] => (i <= 5 ? [i, 8] : i === 6 ? [7, 8] : i === 7 ? [8, 8] : i === 8 ? [8, 7] : [8, 14 - i]);
  const two = (i: number): [number, number] => (i < 8 ? [8, n - 1 - i] : [n - 15 + i, 8]);
  let v = 0;
  for (let i = 14; i >= 0; i--) {
    const [r1, c1] = one(i), [r2, c2] = two(i);
    assert.equal(m[r1]![c1], m[r2]![c2], `bit ${i} matches in both copies`);
    v = (v << 1) | (m[r1]![c1] ? 1 : 0);
  }
  v ^= 0x5412;
  assert.equal(v >> 13, 0, "level M is 00");
  for (let i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
  assert.equal(v, 0, "BCH remainder is zero");
});

test("deterministic, and the SVG is self-contained", () => {
  assert.deepEqual(grid("same"), grid("same"));
  const svg = qrSvg("hello", { scale: 4 }) as string;
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29" width="116"/);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), "no external references");
});
