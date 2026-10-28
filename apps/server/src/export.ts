import { crc32 } from "node:zlib";
import type { Driftnet, Item, Locale, Note } from "@driftnet/core";

/**
 * Take everything out: one Markdown file, or a zip of Markdown files laid out
 * as folders — Obsidian opens it as a vault, Notion imports it (Import →
 * Markdown & CSV). Trash and items flagged for prompt injection stay behind.
 */
export interface ExportData {
  items: Item[];
  chat: Map<number, string[]>;
  notes: Note[];
  path: (folder: string) => string[];
}

export function collect(dn: Driftnet, locale: Locale): ExportData {
  const folders = new Map(dn.store.folders().map((f) => [f.id, f]));
  const path = (id: string): string[] => {
    const f = folders.get(id);
    const label = dn.folderLabel(id, locale);
    return f?.parent ? [...path(f.parent), label] : [label];
  };
  const items = dn.store.exportable();
  return { items, chat: dn.store.chatNotes(items.map((i) => i.id)), notes: dn.store.listNotes(), path };
}

const name = (i: Item) => i.summary?.name ?? i.title;
const url = (i: Item) => i.summary?.primaryUrl || i.url;

function itemBody(i: Item, chat: string[]): string {
  const s = i.summary;
  const out: string[] = [];
  if (s?.oneLiner) out.push(s.oneLiner, "");
  if (s?.highlights.length) out.push(...s.highlights.map((h) => `- ${h}`), "");
  if (s?.useCases.length) out.push("Use cases:", ...s.useCases.map((u) => `- ${u}`), "");
  for (const c of chat) out.push(...c.split("\n").map((l) => `> ${l}`), "");
  if (i.note) out.push("**Note:** " + i.note, "");
  return out.join("\n");
}

export function toMarkdown(d: ExportData, title = "driftnet"): string {
  const byFolder = new Map<string, Item[]>();
  for (const i of d.items) byFolder.set(i.category, [...(byFolder.get(i.category) ?? []), i]);
  const out = [`# ${title} — ${new Date().toISOString().slice(0, 10)}`, ""];
  for (const [folder, items] of [...byFolder].sort((a, b) => d.path(a[0]).join("/").localeCompare(d.path(b[0]).join("/")))) {
    out.push(`## ${d.path(folder).join(" › ")}`, "");
    for (const i of items) {
      out.push(`### [${name(i)}](${url(i)})`, "");
      out.push(itemBody(i, d.chat.get(i.id) ?? []));
      const tags = i.summary?.tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ");
      out.push([tags, i.shareCount ? `shared ${i.shareCount}×` : "", `added ${i.createdAt.slice(0, 10)}`, i.favorite ? "★" : ""]
        .filter(Boolean).join(" · "), "");
    }
  }
  if (d.notes.length) {
    out.push("## Notes", "");
    for (const n of d.notes) out.push(`### ${n.title || n.createdAt.slice(0, 10)}`, "", n.body, "");
  }
  return out.join("\n");
}

/** File names that work on macOS, Windows and Linux. */
const safe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";

function yaml(fields: Record<string, string | number | boolean | string[] | undefined>): string {
  const q = (v: string) => JSON.stringify(v); // a JSON string is a valid YAML scalar
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${q(x)}`).join("\n")}` : `${k}: ${typeof v === "string" ? q(v) : v}`));
  return `---\n${lines.join("\n")}\n---\n\n`;
}

export function toVault(d: ExportData, root = "driftnet"): { path: string; data: string }[] {
  const files: { path: string; data: string }[] = [];
  const taken = new Set<string>();
  const fileOf = new Map<number, string>();
  for (const i of d.items) {
    let base = safe(name(i));
    if (taken.has(base.toLowerCase())) base = `${base} (${i.id})`;
    taken.add(base.toLowerCase());
    fileOf.set(i.id, base);
    const dir = [root, ...d.path(i.category).map(safe)].join("/");
    files.push({
      path: `${dir}/${base}.md`,
      data: yaml({
        url: url(i), folder: d.path(i.category).join(" / "), kind: i.kind, worth: i.worth,
        tags: i.summary?.tags.map((t) => t.replace(/\s+/g, "-")), shared: i.shareCount || undefined,
        favorite: i.favorite || undefined, added: i.createdAt.slice(0, 10), driftnet_id: i.id,
      }) + `# ${name(i)}\n\n` + itemBody(i, d.chat.get(i.id) ?? []),
    });
  }
  for (const n of d.notes) {
    // "#12" in a note points at item 12: a wiki link inside the vault.
    const body = n.body.replace(/(^|[^\w&])#(\d+)\b/g, (m, pre, id) => (fileOf.has(Number(id)) ? `${pre}[[${fileOf.get(Number(id))}]]` : m));
    files.push({ path: `${root}/Notes/${safe(n.title || `Note ${n.id}`)} (${n.id}).md`, data: yaml({ created: n.createdAt.slice(0, 10), updated: n.updatedAt.slice(0, 10) }) + body });
  }
  return files;
}

/** A plain (stored, uncompressed) zip: small, and every tool opens it. */
export function zip(files: { path: string; data: string }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const data = Buffer.from(f.data, "utf8");
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(0, 8); head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10); dir.writeUInt16LE(time, 12); dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    parts.push(head, name, data);
    central.push(dir, name);
    offset += head.length + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
