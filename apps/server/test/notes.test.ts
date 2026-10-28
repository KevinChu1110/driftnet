import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftnet } from "@driftnet/core";
import { collect, toMarkdown, toVault, zip } from "../src/export.ts";

const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-notes-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
const judgement = { isAiTool: 1, category: "coding-agent", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const summary = { name: "Tool: A/B", oneLiner: "Does a thing.", demo: "Shows a thing on screen.", why: "Asked for in chat", highlights: ["fast"], useCases: [], tags: ["cli tool"], primaryUrl: "https://notes.test/a" };
const a = dn.store.upsert({ url: "https://notes.test/a", aliases: [], title: "a", judgement, summary, flags: [], source: "s" });
const b = dn.store.upsert({ url: "https://notes.test/b", aliases: [], title: "b", judgement, summary: null, flags: ["injection"], source: "s" });
dn.store.recordShare(a.id, { platform: "line", chatId: "c", note: "could power our LINE bot" });
dn.store.recordShare(a.id, { platform: "line", chatId: "c", note: "could power our LINE bot" });
dn.store.recordShare(a.id, { platform: "line", chatId: "c", note: "Mentioned in https://x.test" });

test("an item note is stored, cleared, and searchable along with the chat text", () => {
  assert.ok(dn.store.setNote(a.id, "  tried it, needs Docker  "));
  assert.equal(dn.store.get(a.id)!.note, "tried it, needs Docker");
  assert.deepEqual(dn.store.list({ q: "Docker" }).map((i) => i.id), [a.id]);
  assert.deepEqual(dn.store.list({ q: "LINE bot" }).map((i) => i.id), [a.id], "what people said in chat is searchable");
  assert.deepEqual(dn.store.chatNotes([a.id]).get(a.id), ["could power our LINE bot"], "deduplicated, bookkeeping hidden");
  assert.equal(dn.store.setNote(999, "x"), false);
});

test("free-standing notes: create, update, search, delete", () => {
  const n = dn.store.saveNote({ title: "Ideas", body: "Try #1 with #99" })!;
  assert.equal(dn.store.saveNote({ id: n.id, title: "Ideas", body: `Try #${a.id} with #99` })!.body, `Try #${a.id} with #99`);
  assert.equal(dn.store.saveNote({ id: 999, title: "x", body: "" }), null);
  assert.deepEqual(dn.store.listNotes("Try").map((x) => x.id), [n.id]);
});

test("export: Markdown and an Obsidian/Notion vault, without flagged items", () => {
  const data = collect(dn, "en");
  assert.ok(!data.items.some((i) => i.id === b.id), "injection-flagged items stay out");
  const md = toMarkdown(data);
  assert.match(md, /## Coding agents/);
  assert.match(md, /### \[Tool: A\/B\]\(https:\/\/notes\.test\/a\)/);
  assert.match(md, /\*\*Demo:\*\* Shows a thing on screen\./);
  assert.match(md, /\*\*Why:\*\* Asked for in chat/);
  assert.match(md, /> could power our LINE bot/);
  assert.match(md, /\*\*Note:\*\* tried it, needs Docker/);
  const files = toVault(data);
  const item = files.find((f) => f.path === "driftnet/Coding agents/Tool A B.md")!;
  assert.ok(item, files.map((f) => f.path).join(", "));
  assert.match(item.data, /^---\nurl: "https:\/\/notes\.test\/a"\n/);
  assert.match(item.data, /tags:\n  - "cli-tool"/);
  const note = files.find((f) => f.path.startsWith("driftnet/Notes/Ideas"))!;
  assert.match(note.data, /Try \[\[Tool A B\]\] with #99/, "#id becomes a wiki link only for items that exist");
  // A real unzip reads it back.
  const dir = mkdtempSync(join(tmpdir(), "driftnet-zip-"));
  writeFileSync(join(dir, "v.zip"), zip(files));
  execFileSync("unzip", ["-q", "v.zip"], { cwd: dir });
  assert.equal(readFileSync(join(dir, "driftnet/Coding agents/Tool A B.md"), "utf8"), item.data);
});
