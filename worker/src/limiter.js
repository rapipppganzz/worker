/* Rate limiter jendela-geser untuk permintaan HTTP (create/join). Disebar ke 16 shard Durable Object.
   Penghitung ada di memori shard: bisa hilang jika objek dibuang runtime (best-effort, cukup untuk anti-spam). */
import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./http.js";

export class RateLimiter extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.b = new Map(); }
  async hit(key, limit, windowMs) {
    const now = Date.now();
    const arr = (this.b.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { this.b.set(key, arr); return { ok: false, retryAfterMs: windowMs - (now - arr[0]) }; }
    arr.push(now); this.b.set(key, arr);
    if (this.b.size > 5000) for (const [k, v] of this.b) if (!v.length || now - v[v.length - 1] > 120000) this.b.delete(k);
    return { ok: true };
  }
}

function shardOf(key) { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return h % 16; }

export async function rateLimit(env, key, limit, windowMs) {
  if (!env.LIMITER) return; // tanpa binding → lewati (dev)
  const stub = env.LIMITER.get(env.LIMITER.idFromName("shard-" + shardOf(key)));
  const r = await stub.hit(key, limit, windowMs);
  if (!r.ok) throw new HttpError(429, "RATE_LIMIT", "Terlalu banyak permintaan. Coba lagi sebentar.", { retryAfterMs: r.retryAfterMs });
}
