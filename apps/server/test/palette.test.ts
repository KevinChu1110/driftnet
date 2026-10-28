import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// fuzzyRank lives in the single-file UI; pull it out between its markers and run it on its own.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const src = html.slice(html.indexOf("// <fuzzy>"), html.indexOf("// </fuzzy>"));
const fuzzyRank = new Function(`${src}\nreturn fuzzyRank;`)() as (q: string, entries: unknown[], fields: (e: any) => unknown[]) => any[];

const folders = [
  { id: "news", name: "AI news", desc: "Headlines and launches" },
  { id: "coding", name: "Coding agents", desc: "Agents that write code" },
  { id: "design", name: "Design tools", desc: "Figma, image models" },
  { id: "learn", name: "Learning", desc: "Courses and tutorials for coding" },
];
const rank = (q: string) => fuzzyRank(q, folders, (f) => [f.name, f.desc, f.id]).map((f) => f.id);

test("an empty query keeps every entry in order", () => {
  assert.deepEqual(rank(""), ["news", "coding", "design", "learn"]);
  assert.deepEqual(rank("   "), ["news", "coding", "design", "learn"]);
});

test("name matches come before description matches", () => {
  // "coding" is the name of one folder and only in the description of another
  assert.deepEqual(rank("coding"), ["coding", "learn"]);
});

test("prefix beats word start beats substring", () => {
  assert.equal(rank("agents")[0], "coding");
  assert.equal(rank("tools")[0], "design");
  assert.equal(rank("ding")[0], "coding");
});

test("an exact name wins over a longer name that starts with it", () => {
  const list = [{ id: "a", name: "Learning more" }, { id: "b", name: "Learning" }];
  assert.deepEqual(fuzzyRank("learning", list, (f) => [f.name]).map((f) => f.id), ["b", "a"]);
});

test("letters in order only count from three characters on, in the first field", () => {
  assert.deepEqual(rank("cda"), ["coding"]);   // c-o-d-i-n-g a-gents
  assert.deepEqual(rank("cd"), []);
  assert.deepEqual(rank("zzz"), []);
});

test("matching ignores case and the hidden id is the last resort", () => {
  assert.deepEqual(rank("NEWS"), ["news"]);
  const list = [{ id: "other", name: "Misc" }];
  assert.deepEqual(fuzzyRank("other", list, (f) => [f.name, "", f.id]).map((f) => f.id), ["other"]);
});
