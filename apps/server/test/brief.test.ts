import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriftnet } from "@driftnet/core";
import { agentBrief } from "../src/brief.ts";
import { createMcpServer } from "../src/mcp.ts";

const MARK = "Reader's own description";
const judgement = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
const boot = () => createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-brief-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
const pend = (dn: ReturnType<typeof boot>, n: number) => { for (let i = 0; i < n; i++) dn.store.upsert({ url: `https://brief.test/${Math.random()}`, aliases: [], title: "t", judgement, summary: null, flags: [], source: "s" }); };

test("brief: the reader profile is left out when nothing was leased, and when an MCP session already had it", () => {
  const dn = boot();
  const env = { DRIFTNET_PROFILE: "Backend engineer" };
  assert.ok(agentBrief(dn, 2, env).includes(MARK));
  assert.ok(!agentBrief(dn, 0, env).includes(MARK), "no items, no profile");
  assert.ok(!agentBrief(dn, 2, env, false).includes(MARK), "already sent in this session");
});

test("brief: an MCP session gets the profile with its first lease that has items, then never again", async () => {
  const dn = boot();
  process.env.DRIFTNET_PROFILE = "Backend engineer, not into crypto";
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(dn, "t").connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const lease = async () => (await client.callTool({ name: "driftnet_lease_items", arguments: { limit: 1 } }) as { content: { text: string }[] }).content[0]!.text;
    assert.ok(!(await lease()).includes(MARK), "empty queue: nothing to write about");
    pend(dn, 3);
    assert.ok((await lease()).includes(MARK), "first lease with an item");
    assert.ok(!(await lease()).includes(MARK), "second lease, same session");
    // a different session starts over
    const [c, d] = InMemoryTransport.createLinkedPair();
    await createMcpServer(dn, "t2").connect(c);
    const client2 = new Client({ name: "t", version: "0" });
    await client2.connect(d);
    const text = ((await client2.callTool({ name: "driftnet_lease_items", arguments: { limit: 1 } })) as { content: { text: string }[] }).content[0]!.text;
    assert.ok(text.includes(MARK));
  } finally {
    delete process.env.DRIFTNET_PROFILE;
  }
});

test("lease rows: a video driftnet could not read carries one short hint; ordinary rows have none", async () => {
  const dn = boot();
  const add = (url: string, flags: string[]) => dn.store.upsert({ url, aliases: [], title: "t", judgement, summary: null, flags, source: "s" });
  add("https://brief.test/video", ["needs-transcript"]);
  add("https://brief.test/plain", []);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "t").connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const text = ((await client.callTool({ name: "driftnet_lease_items", arguments: { limit: 5 } })) as { content: { text: string }[] }).content[0]!.text;
  const rows = JSON.parse(text.slice(text.indexOf("[\n"))) as { url: string; hint?: string }[];
  assert.equal(rows.find((r) => r.url.endsWith("/video"))!.hint, "video: needs a transcript");
  assert.equal(rows.find((r) => r.url.endsWith("/plain"))!.hint, undefined);
});
