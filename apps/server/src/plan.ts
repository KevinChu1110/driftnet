import { randomBytes } from "node:crypto";
import { z } from "zod";
import { applyPlan, FolderError, ItemError, proposePlan, type Driftnet, type PlanOp } from "@driftnet/core";
import { saveUndo } from "./bulk.ts";

type Reply = { status: number; body: unknown };

/** Proposed plans wait in the state table (a day, the last 5), so Apply can't be handed operations the model never proposed. */
const PLAN_PREFIX = "plan:";
const PLAN_KEEP = 5;
const PLAN_TTL_MS = 24 * 3600 * 1000;

const applyRequest = z.object({ plan: z.string().min(1).max(64), accept: z.array(z.string().max(8)).max(100) });

export const NO_MODEL = "needs an AI model (Settings → AI)";

/** The plan as the page shows it: card names next to the ids a move names. */
function present(dn: Driftnet, ops: PlanOp[]) {
  return ops.map((o) => o.op !== "move" ? o : { ...o, cards: o.cards.map((id) => {
    const it = dn.store.get(id);
    return { id, name: it?.summary?.name ?? it?.title ?? String(id) };
  }) });
}

/** Ask the model for a plan and keep it for review. Nothing changes in the catalogue. */
export async function suggestFolders(dn: Driftnet, language: string, now = Date.now()): Promise<Reply> {
  if (!dn.llm) return { status: 409, body: { error: NO_MODEL } };
  let ops: PlanOp[];
  try {
    ops = await proposePlan(dn.store, dn.llm, { choices: dn.categories, language });
  } catch (err) {
    return { status: 502, body: { error: `the model could not make a plan: ${(err as Error).message.slice(0, 200)}` } };
  }
  const id = randomBytes(6).toString("base64url");
  dn.store.setState(PLAN_PREFIX + id, JSON.stringify({ at: now, ops }));
  const all = dn.store.stateWithPrefix(PLAN_PREFIX).map((r) => ({ key: r.key, at: (JSON.parse(r.value) as { at: number }).at })).sort((a, b) => b.at - a.at);
  for (const old of all.slice(PLAN_KEEP)) dn.store.deleteState(old.key);
  return { status: 200, body: { plan: id, operations: present(dn, ops) } };
}

/** Run the operations the reader ticked, in one transaction, and return the id that undoes them all. */
export function applySuggested(dn: Driftnet, input: unknown, now = Date.now()): Reply {
  const parsed = applyRequest.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "expected { plan: the id a suggestion returned, accept: operation ids }" } };
  const key = PLAN_PREFIX + parsed.data.plan;
  const raw = dn.store.getState(key);
  const saved = raw ? (JSON.parse(raw) as { at: number; ops: PlanOp[] }) : null;
  if (!saved || now - saved.at > PLAN_TTL_MS) {
    if (saved) dn.store.deleteState(key);
    return { status: 404, body: { error: "unknown or expired plan; ask for a new one" } };
  }
  try {
    const r = applyPlan(dn.store, saved.ops, new Set(parsed.data.accept));
    if (!r.applied.length) return { status: 409, body: { error: "nothing to apply: the cards or folders changed since the plan was made", skipped: r.skipped } };
    dn.store.deleteState(key);
    const undo = saveUndo(dn.store, r.previousItems, now, r.previousFolders);
    return { status: 200, body: { ok: true, undo, applied: r.applied, skipped: r.skipped, count: r.applied.length } };
  } catch (err) {
    if (err instanceof FolderError || err instanceof ItemError) return { status: 409, body: { error: err.message } };
    throw err;
  }
}

/** The plan as plain data, for the MCP tool (which never applies it). */
export async function planForAgent(dn: Driftnet, language: string): Promise<{ ok: true; operations: unknown[] } | { ok: false; error: string; status: number }> {
  if (!dn.llm) return { ok: false, error: NO_MODEL, status: 409 };
  try {
    const ops = await proposePlan(dn.store, dn.llm, { choices: dn.categories, language });
    return { ok: true, operations: present(dn, ops) };
  } catch (err) {
    return { ok: false, error: `the model could not make a plan: ${(err as Error).message.slice(0, 200)}`, status: 502 };
  }
}
