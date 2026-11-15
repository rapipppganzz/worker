/* Gateway Worker: CORS, autentikasi sesi RapipMovies, rate limit, lalu meneruskan ke Durable Object per room.
   Endpoint:
     GET  /api/health
     POST /api/rooms                 buat room            (Bearer)
     POST /api/rooms/:id/join        minta tiket masuk    (Bearer; body: {password?, invite?})
     GET  /api/rooms                 daftar server publik (Bearer)
     DELETE /api/rooms/:id           hapus room           (Bearer; host saja)
     POST /api/rooms/alive           {ids:[...]} → id yang masih hidup & milik/anggota pemanggil (Bearer)
     GET  /api/rooms/:id/ws?ticket=  upgrade WebSocket    (tiket sekali pakai; Origin wajib diizinkan) */
import { HttpError, json, errorResponse, readJson, corsHeaders, originAllowed } from "./http.js";
import { authenticate } from "./auth.js";
import { rateLimit } from "./limiter.js";
import { generateRoomId, generateInviteKey, normalizeRoomId } from "./ids.js";
import { validateCreate } from "./validate.js";

export { WatchRoom } from "./room/durable.js";
export { RateLimiter } from "./limiter.js";
export { Directory } from "./directory.js";

const ip = (req) => req.headers.get("CF-Connecting-IP") || "unknown";
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

async function toDO(env, roomId, path, body) {
  const res = await roomStub(env, roomId).fetch("https://room" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res;
}

const directory = (env) => env.DIRECTORY && env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
const officialIds = (env) => new Set(String(env.OFFICIAL_HOST_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
let dirCache = { at: 0, rooms: null }; // cache singkat per isolate supaya polling klien tidak membanjiri Durable Object
async function listPublic(env) {
  const dir = directory(env); if (!dir) return [];
  if (dirCache.rooms && Date.now() - dirCache.at < 8000) return dirCache.rooms;
  const ids = await dir.ids(20);
  const got = await Promise.all(ids.map(async (id) => {
    try {
      const r = await toDO(env, id, "/summary", {});
      if (r.status === 404) { await dir.remove(id); return null; }
      return r.ok ? (await r.json()).room : null;
    } catch (_) { return null; }
  }));
  dirCache = { at: Date.now(), rooms: got.filter(Boolean) };
  return dirCache.rooms;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (path === "/api/health") return json({ ok: true, service: "rapip-watchparty" }, 200, cors);

  const origin = request.headers.get("Origin");
  if (origin && !originAllowed(request, env)) throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Origin tidak diizinkan.");

  // ---- WebSocket ----
  let m = /^\/api\/rooms\/([^/]+)\/ws$/.exec(path);
  if (m && request.method === "GET") {
    if (!originAllowed(request, env)) throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Origin tidak diizinkan.");
    const id = normalizeRoomId(decodeURIComponent(m[1]));
    if (!id) throw new HttpError(404, "NOT_FOUND", "Room tidak ditemukan, atau kamu tidak punya akses.");
    await rateLimit(env, "ws:" + ip(request), 60, 60000);
    return roomStub(env, id).fetch(request); // tiket divalidasi di dalam Durable Object
  }

  // ---- daftar server publik (resmi di atas, lalu buatan pengguna) ----
  if (path === "/api/rooms" && request.method === "GET") {
    const user = await authenticate(request, env);
    await rateLimit(env, "list:u:" + user.id, 30, 60000);
    const off = officialIds(env);
    const rooms = (await listPublic(env)).map(({ hostId, ...r }) => ({ ...r, official: off.has(hostId), mine: hostId === user.id }))
      .sort((a, b) => (b.official - a.official) || (b.participants - a.participants) || (b.createdAt - a.createdAt));
    return json({ ok: true, rooms, me: off.size ? undefined : user.id }, 200, cors); // `me` hanya muncul selama OFFICIAL_HOST_IDS belum diisi
  }

  // ---- buat room ----
  if (path === "/api/rooms" && request.method === "POST") {
    const user = await authenticate(request, env);
    await rateLimit(env, "create:u:" + user.id, 5, 60000);
    await rateLimit(env, "create:ip:" + ip(request), 15, 60000);
    const body = validateCreate(await readJson(request, 4096), env);
    for (let i = 0; i < 5; i++) {
      const roomId = generateRoomId();
      const res = await toDO(env, roomId, "/create", { ...body, roomId, inviteKey: generateInviteKey(), host: user });
      if (res.status === 409) continue; // ID bentrok (sangat jarang)
      if (res.ok && body.visibility === "public") { try { await directory(env)?.add(roomId); dirCache.at = 0; } catch (_) {} }
      const out = new Response(res.body, res);
      cors.forEach((v, k) => out.headers.set(k, v));
      return out;
    }
    throw new HttpError(503, "ID_BUSY", "Gagal membuat ID room. Coba lagi.");
  }

  // ---- cek room mana yang masih hidup (hanya milik/anggota si pemanggil) ----
  if (path === "/api/rooms/alive" && request.method === "POST") {
    const user = await authenticate(request, env);
    await rateLimit(env, "alive:u:" + user.id, 20, 60000);
    const body = await readJson(request, 1024);
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 10).map((x) => normalizeRoomId(String(x))).filter(Boolean);
    const alive = [];
    await Promise.all(ids.map(async (id) => {
      try { const r = await toDO(env, id, "/alive", { user }); if (r.ok && (await r.json()).alive) alive.push(id); } catch (_) {}
    }));
    return json({ ok: true, alive }, 200, cors);
  }

  // ---- join ----
  m = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
  if (m && request.method === "POST") {
    const user = await authenticate(request, env);
    const id = normalizeRoomId(decodeURIComponent(m[1]));
    if (!id) throw new HttpError(404, "NOT_FOUND", "Room tidak ditemukan, atau kamu tidak punya akses.");
    await rateLimit(env, "join:u:" + user.id, 20, 60000);
    await rateLimit(env, "join:ip:" + ip(request), 40, 60000);
    const body = await readJson(request, 1024);
    const password = typeof body.password === "string" && body.password.length <= 64 ? body.password : null;
    const invite = typeof body.invite === "string" && /^[0-9a-f]{32}$/.test(body.invite) ? body.invite : null;
    if (password) await rateLimit(env, "pw:" + user.id + ":" + id, 5, 60000); // batasi tebak password
    const res = await toDO(env, id, "/join", { user, password, invite });
    const out = new Response(res.body, res);
    cors.forEach((v, k) => out.headers.set(k, v));
    return out;
  }

  // ---- hapus room (host saja; peserta lain dapat 404 yang sama dengan room tidak ada) ----
  m = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (m && request.method === "DELETE") {
    const user = await authenticate(request, env);
    const id = normalizeRoomId(decodeURIComponent(m[1]));
    if (!id) throw new HttpError(404, "NOT_FOUND", "Room tidak ditemukan, atau kamu tidak punya akses.");
    await rateLimit(env, "del:u:" + user.id, 10, 60000);
    const res = await toDO(env, id, "/destroy", { user });
    if (res.ok) { try { await directory(env)?.remove(id); dirCache.at = 0; } catch (_) {} }
    const out = new Response(res.body, res);
    cors.forEach((v, k) => out.headers.set(k, v));
    return out;
  }

  throw new HttpError(404, "NOT_FOUND", "Endpoint tidak ada.");
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) {
      if (e instanceof HttpError) return errorResponse(e, corsHeaders(request, env));
      return errorResponse(e, corsHeaders(request, env));
    }
  },
};
