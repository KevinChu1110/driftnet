import type { DatabaseSync } from "node:sqlite";

export interface Hit { id: number; sim: number }

/**
 * Item embeddings: stored as Float32 BLOBs (L2-normalised, so cosine is a plain dot product) and
 * mirrored in one flat Float32Array so a search is a single tight loop with no per-row SQL.
 * Only vectors of the active model count; setModel() drops the rest.
 */
export class VectorIndex {
  private model: string | null = null;
  private dim = 0;
  private ids: number[] = [];
  private mat = new Float32Array(0);
  private pos = new Map<number, number>();
  private loaded = false;

  constructor(private readonly db: DatabaseSync) {}

  get activeModel(): string | null { return this.model; }

  /** Make `model` the one whose vectors are used; vectors of any other model are deleted. null = semantic search off. */
  setModel(model: string | null): void {
    if (model) this.db.prepare("DELETE FROM item_vec WHERE model <> ?").run(model);
    if (model !== this.model) this.reset();
    this.model = model;
  }

  private reset(): void {
    this.loaded = false; this.ids = []; this.pos.clear(); this.mat = new Float32Array(0); this.dim = 0;
  }

  meta(id: number): { model: string; hash: string } | undefined {
    return this.db.prepare("SELECT model, hash FROM item_vec WHERE item_id = ?").get(id) as { model: string; hash: string } | undefined;
  }

  put(id: number, model: string, hash: string, vec: Float32Array): void {
    const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db.prepare(
      `INSERT INTO item_vec (item_id, model, dim, hash, vec, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(item_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, hash = excluded.hash, vec = excluded.vec, updated_at = excluded.updated_at`,
    ).run(id, model, vec.length, hash, blob);
    if (this.loaded && model === this.model) this.cachePut(id, vec);
  }

  /** How many items have a vector for the active model. */
  count(): number {
    if (!this.model) return 0;
    this.load();
    return this.ids.length;
  }

  /** Items with no vector yet (newest first), for the background backfill. */
  missing(limit: number): number[] {
    return (this.db.prepare(
      "SELECT id FROM items WHERE id NOT IN (SELECT item_id FROM item_vec WHERE model = ?) ORDER BY id DESC LIMIT ?",
    ).all(this.model ?? "", limit) as { id: number }[]).map((r) => r.id);
  }

  vectorOf(id: number): Float32Array | undefined {
    this.load();
    const p = this.pos.get(id);
    return p === undefined ? undefined : this.mat.subarray(p * this.dim, (p + 1) * this.dim);
  }

  /** Items most similar to `q` (cosine ≥ floor), best first; `allowed` restricts the candidates. */
  nearest(q: Float32Array, o: { floor: number; max: number; allowed?: Set<number>; exclude?: number }): Hit[] {
    if (!this.model) return [];
    this.load();
    const { dim, mat, ids } = this;
    if (!ids.length || q.length !== dim) return [];
    const hits: Hit[] = [];
    for (let r = 0, off = 0; r < ids.length; r++, off += dim) {
      let dot = 0;
      for (let k = 0; k < dim; k++) dot += mat[off + k]! * q[k]!;
      if (dot < o.floor) continue;
      const id = ids[r]!;
      if (id === o.exclude || (o.allowed && !o.allowed.has(id))) continue;
      hits.push({ id, sim: dot });
    }
    return hits.sort((a, b) => b.sim - a.sim || a.id - b.id).slice(0, o.max);
  }

  private load(): void {
    if (this.loaded || !this.model) return;
    this.loaded = true;
    for (const r of this.db.prepare("SELECT item_id, dim, vec FROM item_vec WHERE model = ?").iterate(this.model) as Iterable<{ item_id: number; dim: number; vec: Uint8Array }>) {
      if (r.vec.byteLength !== r.dim * 4) continue;
      if (this.dim && r.dim !== this.dim) continue; // one model, one size; anything else is damage
      // Copy: the driver's buffer is not guaranteed 4-byte aligned.
      this.cachePut(r.item_id, new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)));
    }
  }

  private cachePut(id: number, vec: Float32Array): void {
    if (!this.dim) this.dim = vec.length;
    if (vec.length !== this.dim) return;
    let p = this.pos.get(id);
    if (p === undefined) {
      p = this.ids.length;
      if ((p + 1) * this.dim > this.mat.length) {
        const bigger = new Float32Array(Math.max(64, p * 2) * this.dim);
        bigger.set(this.mat);
        this.mat = bigger;
      }
      this.ids.push(id);
      this.pos.set(id, p);
    }
    this.mat.set(vec, p * this.dim);
  }
}
