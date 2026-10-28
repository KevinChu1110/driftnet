import { randomBytes } from "node:crypto";
import { z } from "zod";
import { FolderError, ItemError, type FolderRow, type Store } from "@driftnet/core";

export const BULK_LIMIT = 500;

const ids = z.array(z.number().int().positive()).min(1).max(BULK_LIMIT);

const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), ids, folder: z.string() }),
  z.object({ action: z.enum(["trash", "restore", "favorite", "unfavorite"]), ids }),
]);

const undoRequest = z.object({ undo: z.string().min(1).max(64) });

const snapshotSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    folder: z.string().optional(),
    user_placed: z.number().int().min(0).max(1).optional(),
    trashed_at: z.string().nullable().optional(),
    favorite: z.number().int().min(0).max(1).optional(),
  }),
);
type Snapshot = z.infer<typeof snapshotSchema>;

/** A folder-tree snapshot, kept with an AI plan's undo so the whole plan can be reverted. */
const folderSnapshotSchema = z.array(z.object({
  id: z.string(), parent: z.string().nullable(), name: z.string().nullable(),
  description: z.string(), position: z.number().int(), builtin: z.number().int().min(0).max(1),
}));

/** Undo snapshots live in the store's state table, so they survive a restart; only the last few, and only for a day. */
const UNDO_PREFIX = "undo:";
const UNDO_KEEP = 20;
const UNDO_TTL_MS = 24 * 3600 * 1000;

/** Keep what a batch changed, return the id that undoes it, and drop snapshots beyond the newest 20. */
export function saveUndo(store: Store, previous: Snapshot, now = Date.now(), folders?: FolderRow[]): string {
  const id = randomBytes(6).toString("base64url");
  store.setState(UNDO_PREFIX + id, JSON.stringify({ at: now, previous, ...(folders ? { folders } : {}) }));
  const all = store.stateWithPrefix(UNDO_PREFIX).map((r) => ({ key: r.key, at: (JSON.parse(r.value) as { at: number }).at })).sort((a, b) => b.at - a.at);
  for (const old of all.slice(UNDO_KEEP)) store.deleteState(old.key);
  return id;
}

type Reply = { status: number; body: unknown };

/** Run one bulk action in a single transaction. Pure over the store so it can be tested without HTTP. */
export function bulkAction(store: Store, input: unknown, actor?: string, now = Date.now()): Reply {
  const parsed = request.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: `expected { ids: 1-${BULK_LIMIT} item ids, action: move | trash | restore | favorite | unfavorite, folder? }` } };
  const req = parsed.data;
  const unique = [...new Set(req.ids)];
  try {
    let previous: Snapshot;
    if (req.action === "move") previous = store.moveItems(unique, req.folder, actor).map(({ id, category, user_placed }) => ({ id, folder: category, user_placed }));
    else if (req.action === "trash" || req.action === "restore") previous = store.setTrashedMany(unique, req.action === "trash");
    else previous = store.setFavoriteMany(unique, req.action === "favorite");
    return { status: 200, body: { ok: true, undo: saveUndo(store, previous, now), count: unique.length } };
  } catch (err) {
    return failure(err);
  }
}

/** Revert a whole batch from the snapshot the server kept for it. One-shot: the snapshot is deleted. */
export function bulkUndo(store: Store, input: unknown, now = Date.now()): Reply {
  const parsed = undoRequest.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "expected { undo: the id a bulk response returned }" } };
  try {
    const count = undoById(store, parsed.data.undo, now);
    return count ? { status: 200, body: { ok: true, count } } : { status: 404, body: { error: "nothing to undo: unknown or expired id" } };
  } catch (err) {
    return failure(err);
  }
}

/** Restore a stored snapshot and delete it; the number of items put back, or 0 when there is none (or it is older than 24 h). */
export function undoById(store: Store, id: string, now = Date.now()): number {
  const key = UNDO_PREFIX + id;
  const raw = store.getState(key);
  if (!raw) return 0;
  const snap = JSON.parse(raw) as { at: number; previous: unknown; folders?: unknown };
  if (now - snap.at > UNDO_TTL_MS) { store.deleteState(key); return 0; }
  const previous = snapshotSchema.parse(snap.previous);
  const folders = snap.folders ? folderSnapshotSchema.parse(snap.folders) : null;
  // Restore first: if a folder or card has since been deleted this throws and the snapshot stays.
  // An AI plan also changed the folder tree: put that back before the cards, in the same transaction.
  store.transaction(() => {
    if (folders) store.restoreFolders(folders);
    store.restoreItems(previous.map(({ folder, ...rest }) => ({ ...rest, ...(folder !== undefined ? { category: folder } : {}) })));
  });
  store.deleteState(key);
  return previous.length || folders?.length || 0;
}

function failure(err: unknown): Reply {
  if (err instanceof ItemError) return { status: 404, body: { error: err.message } };
  if (err instanceof FolderError) return { status: 404, body: { error: err.message } };
  throw err;
}
