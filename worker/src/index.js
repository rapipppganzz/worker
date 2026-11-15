/* Gateway Worker: CORS, autentikasi sesi RapipMovies, rate limit, lalu meneruskan ke Durable Object per room.
   Endpoint:
     GET  /api/health
     POST /api/rooms                 buat room            (Bearer)
     POST /api/rooms/:id/join        minta tiket masuk    (Bearer; body: {password?, invite?})
     GET  /api/rooms/:id/ws?ticket=  upgrade WebSocket    (tiket sekali pakai; Origin wajib diizinkan) */
import { HttpError, json, errorResponse, readJson, corsHeaders, originAllowed } from "./http.js";
import { authenticate } from "./auth.js";
import { rateLimit } from "./limiter.js";
import { generateRoomId, generateInviteKey, normalizeRoomId } from "./ids.js";
import { validateCreate } from "./validate.js";

export { WatchRoom } from "./room/durable.js";
export { RateLimiter } from "./limiter.js";

const ip = (req) => req.headers.get("CF-Connecting-IP") || "unknown";
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

async function toDO(env, roomId, path, body) {
  const res = await roomStub(env, roomId).fetch("https://room" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res;
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
      const out = new Response(res.body, res);
      cors.forEach((v, k) => out.headers.set(k, v));
      return out;
    }
    throw new HttpError(503, "ID_BUSY", "Gagal membuat ID room. Coba lagi.");
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
