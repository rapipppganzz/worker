import test from "node:test";
import assert from "node:assert/strict";
import { parseToken, authenticate, _clearAuthCache } from "../src/auth.js";
import { normalizeRoomId, generateRoomId, ROOM_ID_RE, hashPassword, verifyPassword } from "../src/ids.js";
import { validateCreate, sanitizeChat, sanitizeMedia } from "../src/validate.js";
import { corsHeaders, originAllowed } from "../src/http.js";

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tok = (p) => b64u(p) + ".sig123456";
const req = (t, extra = {}) => new Request("https://x/api", { headers: { ...(t ? { Authorization: "Bearer " + t } : {}), ...extra } });
const env = { AUTH_API: "https://auth.example", AUTH_VERIFY_PATH: "/api/data", ALLOWED_ORIGINS: "https://site.example" };
const future = Math.floor(Date.now() / 1000) + 3600;

test("parseToken reads id/name/avatar, exp seconds→ms, rejects junk", () => {
  const c = parseToken(tok({ id: "u1", n: "Rapip", a: "av3", exp: future })); assert.equal(c.id, "u1"); assert.equal(c.name, "Rapip"); assert.equal(c.exp, future * 1000);
  for (const bad of [null, "", "abc", "a.b.c", tok({ n: "x" }), tok({ id: "../../x" }), "e30.sig".repeat(400)]) assert.equal(parseToken(bad), null);
});
test("authenticate: no header / bad token / expired → 401 without calling API", async () => {
  let calls = 0; const f = async () => { calls++; return new Response("", { status: 200 }); };
  for (const r of [req(null), req("garbage"), req(tok({ id: "u", exp: 1 }))]) await assert.rejects(authenticate(r, env, { fetchImpl: f }), (e) => e.status === 401);
  assert.equal(calls, 0);
});
test("authenticate: API says 200 → identity from payload; sends Bearer to AUTH_API; cached", async () => {
  _clearAuthCache(); let calls = 0, seen;
  const f = async (url, o) => { calls++; seen = { url, auth: o.headers.Authorization }; return new Response("{}", { status: 200 }); };
  const t = tok({ id: "u9", n: "Nina", exp: future });
  const id = await authenticate(req(t), env, { fetchImpl: f }); assert.deepEqual(id, { id: "u9", name: "Nina", avatar: "" });
  assert.equal(seen.url, "https://auth.example/api/data"); assert.equal(seen.auth, "Bearer " + t);
  await authenticate(req(t), env, { fetchImpl: f }); assert.equal(calls, 1);
});
test("authenticate: API 401 → rejected (+negative cache); API down → 503", async () => {
  _clearAuthCache(); let calls = 0;
  const t = tok({ id: "u1", exp: future });
  const f401 = async () => { calls++; return new Response("", { status: 401 }); };
  await assert.rejects(authenticate(req(t), env, { fetchImpl: f401 }), (e) => e.status === 401);
  await assert.rejects(authenticate(req(t), env, { fetchImpl: f401 }), (e) => e.status === 401); assert.equal(calls, 1);
  _clearAuthCache();
  await assert.rejects(authenticate(req(tok({ id: "u2", exp: future })), env, { fetchImpl: async () => { throw new Error("net"); } }), (e) => e.status === 503 && e.code === "AUTH_UNAVAILABLE");
  await assert.rejects(authenticate(req(tok({ id: "u3", exp: future })), env, { fetchImpl: async () => new Response("", { status: 500 }) }), (e) => e.status === 503);
});
test("client cannot choose identity via headers/body: only token payload counts", async () => {
  _clearAuthCache();
  const id = await authenticate(req(tok({ id: "real", n: "Real", exp: future }), { "X-User-Id": "admin" }), env, { fetchImpl: async () => new Response("{}", { status: 200 }) });
  assert.equal(id.id, "real");
});
test("room id format, normalization, uniqueness", () => {
  assert.equal(normalizeRoomId("rp-8k29xm"), "RP-8K29XM"); assert.equal(normalizeRoomId("8K29XM"), "RP-8K29XM");
  for (const bad of ["RP-8K29X0", "RP-8K29", "../../etc", "RP-8K29XMM", 5, null, "RP-8K29X1"]) assert.equal(normalizeRoomId(bad), null);
  const s = new Set(); for (let i = 0; i < 2000; i++) { const id = generateRoomId(); assert.match(id, ROOM_ID_RE); s.add(id); } assert.ok(s.size > 1990);
});
test("password hash: salted, verifies, rejects wrong", async () => {
  const a = await hashPassword("hunter22"), b = await hashPassword("hunter22"); assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPassword("hunter22", a.salt, a.hash), true); assert.equal(await verifyPassword("nope", a.salt, a.hash), false); assert.equal(await verifyPassword(null, a.salt, a.hash), false);
});
test("validateCreate", () => {
  const ok = validateCreate({ name: " Nobar  Malam ", visibility: "private", password: "abcd", maxParticipants: 6 }, { MAX_PARTICIPANTS_CAP: "20" });
  assert.equal(ok.name, "Nobar Malam"); assert.equal(ok.chatEnabled, true);
  for (const b of [{ name: "ab", visibility: "public" }, { name: "abc" }, { name: "abc", visibility: "public", password: "x" }, { name: "abc", visibility: "public", maxParticipants: 99 }, { name: "abc", visibility: "public", maxParticipants: 1 }])
    assert.throws(() => validateCreate(b, { MAX_PARTICIPANTS_CAP: "20" }), (e) => e.status === 400);
});
test("sanitize chat & media", () => {
  assert.equal(sanitizeChat("a‮b\u0007c\n\n d"), "a b c d");
  assert.throws(() => sanitizeMedia({ title: "x" })); assert.equal(sanitizeMedia({ id: "m1", poster: "javascript:alert(1)" }).poster, "");
});
test("CORS: only allowed origins echoed", () => {
  const ok = new Request("https://w", { headers: { Origin: "https://site.example" } }), bad = new Request("https://w", { headers: { Origin: "https://evil.example" } });
  assert.equal(originAllowed(ok, env), true); assert.equal(originAllowed(bad, env), false);
  assert.equal(corsHeaders(ok, env).get("Access-Control-Allow-Origin"), "https://site.example"); assert.equal(corsHeaders(bad, env).get("Access-Control-Allow-Origin"), null);
});
