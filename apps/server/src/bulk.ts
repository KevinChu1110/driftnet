import { z } from "zod";
import { FolderError, ItemError, type Store } from "@driftnet/core";

export const BULK_LIMIT = 500;

const ids = z.array(z.number().int().positive()).min(1).max(BULK_LIMIT);

const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), ids, folder: z.string() }),
  z.object({ action: z.enum(["trash", "restore", "favorite", "unfavorite"]), ids }),
]);

const undoRequest = z.object({
  previous: z
    .array(
      z.object({
        id: z.number().int().positive(),
        folder: z.string().optional(),
        user_placed: z.number().int().min(0).max(1).optional(),
        trashed_at: z.string().nullable().optional(),
        favorite: z.number().int().min(0).max(1).optional(),
      }),
    )
    .min(1)
    .max(BULK_LIMIT),
});

type Reply = { status: number; body: unknown };

/** Run one bulk action in a single transaction. Pure over the store so it can be tested without HTTP. */
export function bulkAction(store: Store, input: unknown, actor?: string): Reply {
  const parsed = request.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: `expected { ids: 1-${BULK_LIMIT} item ids, action: move | trash | restore | favorite | unfavorite, folder? }` } };
  const req = parsed.data;
  const unique = [...new Set(req.ids)];
  try {
    if (req.action === "move") {
      const previous = store.moveItems(unique, req.folder, actor).map(({ id, category, user_placed }) => ({ id, folder: category, user_placed }));
      return { status: 200, body: { ok: true, previous } };
    }
    if (req.action === "trash" || req.action === "restore") return { status: 200, body: { ok: true, previous: store.setTrashedMany(unique, req.action === "trash") } };
    return { status: 200, body: { ok: true, previous: store.setFavoriteMany(unique, req.action === "favorite") } };
  } catch (err) {
    return failure(err);
  }
}

/** Revert a whole batch from the `previous` a bulk action returned. */
export function bulkUndo(store: Store, input: unknown): Reply {
  const parsed = undoRequest.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: `expected { previous: 1-${BULK_LIMIT} entries from a bulk response }` } };
  try {
    store.restoreItems(parsed.data.previous.map(({ folder, ...rest }) => ({ ...rest, ...(folder !== undefined ? { category: folder } : {}) })));
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return failure(err);
  }
}

function failure(err: unknown): Reply {
  if (err instanceof ItemError) return { status: 404, body: { error: err.message } };
  if (err instanceof FolderError) return { status: 404, body: { error: err.message } };
  throw err;
}
