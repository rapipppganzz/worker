/* Helper HTTP: CORS, JSON, error terstruktur. Tidak ada log berisi token / password / isi chat. */

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

export function allowedOrigins(env) {
  return String((env && env.ALLOWED_ORIGINS) || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !!origin && allowedOrigins(env).includes(origin);
}

export function corsHeaders(request, env) {
  const h = new Headers({ Vary: "Origin" });
  if (originAllowed(request, env)) {
    h.set("Access-Control-Allow-Origin", request.headers.get("Origin"));
    h.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    h.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
    h.set("Access-Control-Max-Age", "86400");
  }
  return h;
}

export function json(data, status = 200, headers) {
  const h = new Headers(headers || {});
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function errorResponse(err, headers) {
  if (err instanceof HttpError) {
    const body = { ok: false, error: { code: err.code, message: err.message } };
    if (err.extra) body.error.extra = err.extra;
    const h = new Headers(headers || {});
    if (err.extra && err.extra.retryAfterMs) h.set("Retry-After", String(Math.ceil(err.extra.retryAfterMs / 1000)));
    return json(body, err.status, h);
  }
  console.error("[wp] internal error:", err && err.name, err && err.message); // tanpa data pengguna
  return json({ ok: false, error: { code: "INTERNAL", message: "Terjadi kesalahan di server." } }, 500, headers);
}

export async function readJson(request, maxBytes = 4096) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Data terlalu besar.");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Data terlalu besar.");
  let obj;
  try { obj = text ? JSON.parse(text) : {}; } catch (e) { throw new HttpError(400, "BAD_JSON", "Format data tidak valid."); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new HttpError(400, "BAD_JSON", "Format data tidak valid.");
  return obj;
}
