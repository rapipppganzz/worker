/* Verifikasi sesi RapipMovies. Worker TIDAK menyimpan akun/password dan TIDAK punya secret penandatangan token.
   Alurnya: (1) periksa bentuk token & exp secara lokal, (2) minta API akun yang sudah ada memvalidasi token
   (GET {AUTH_API}{AUTH_VERIFY_PATH} dengan header Bearer; 200 = sah, 401 = tidak sah), (3) identitas diambil dari payload token
   HANYA setelah API akun menyatakan token sah. Hasil di-cache singkat per isolate (kunci = SHA-256 token, token mentah tidak disimpan). */
import { HttpError } from "./http.js";
import { sha256Hex } from "./ids.js";
import { sanitizeName, sanitizeAvatar } from "./validate.js";

const POS_TTL = 60000, NEG_TTL = 15000, CACHE_MAX = 500;
const cache = new Map();

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Hanya membaca payload; TIDAK memverifikasi tanda tangan. Jangan dipercaya sebelum API akun menyetujui. */
export function parseToken(tok) {
  if (typeof tok !== "string" || tok.length < 10 || tok.length > 2048) return null;
  const parts = tok.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let p; try { p = JSON.parse(b64urlDecode(parts[0])); } catch (_) { return null; }
  if (!p || typeof p !== "object") return null;
  const id = p.id == null ? "" : String(p.id);
  if (!/^[\w:.-]{1,64}$/.test(id)) return null;
  let exp = Number(p.exp);
  if (Number.isFinite(exp) && exp > 0 && exp < 1e12) exp *= 1000; // detik → ms
  return { id, name: sanitizeName(p.n) || "Pengguna", avatar: sanitizeAvatar(p.a), exp: Number.isFinite(exp) && exp > 0 ? exp : null };
}

export function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

export async function authenticate(request, env, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch, now = (opts.now || Date.now)();
  const tok = bearer(request);
  if (!tok) throw new HttpError(401, "UNAUTHENTICATED", "Silakan login dulu.");
  const claims = parseToken(tok);
  if (!claims) throw new HttpError(401, "BAD_TOKEN", "Sesi tidak valid. Login ulang.");
  if (claims.exp && claims.exp <= now) throw new HttpError(401, "TOKEN_EXPIRED", "Sesi kedaluwarsa. Login ulang.");

  const key = await sha256Hex(tok);
  const hit = cache.get(key);
  if (hit && hit.until > now) { if (!hit.ok) throw new HttpError(401, "BAD_TOKEN", "Sesi tidak valid. Login ulang."); return toIdent(claims); }

  if (!env.AUTH_API) throw new HttpError(503, "AUTH_NOT_CONFIGURED", "Verifikasi akun belum dikonfigurasi.");
  let status;
  try {
    const res = await fetchImpl(String(env.AUTH_API).replace(/\/+$/, "") + (env.AUTH_VERIFY_PATH || "/api/data"), {
      method: "GET", headers: { Authorization: "Bearer " + tok, Accept: "application/json" }, signal: AbortSignal.timeout(5000),
    });
    status = res.status;
    try { await res.body?.cancel(); } catch (_) {}
  } catch (_) { throw new HttpError(503, "AUTH_UNAVAILABLE", "Server akun tidak merespons. Coba lagi sebentar."); }

  if (status === 200) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { ok: true, until: Math.min(now + POS_TTL, claims.exp || Infinity) });
    return toIdent(claims);
  }
  if (status === 401 || status === 403) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { ok: false, until: now + NEG_TTL });
    throw new HttpError(401, "BAD_TOKEN", "Sesi tidak valid. Login ulang.");
  }
  throw new HttpError(503, "AUTH_UNAVAILABLE", "Server akun bermasalah. Coba lagi sebentar.");
}
const toIdent = (c) => ({ id: c.id, name: c.name, avatar: c.avatar });
export function _clearAuthCache() { cache.clear(); }
