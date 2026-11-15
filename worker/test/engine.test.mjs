import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld, rejects } from "./helpers.mjs";

const H = { id: "h", name: "Host", avatar: "" }, A = { id: "a", name: "Ana", avatar: "" }, B = { id: "b", name: "Budi", avatar: "" }, C = { id: "c", name: "Cici", avatar: "" };

async function started(opts) {
  const w = makeWorld(); await w.create(H, opts);
  const j = await w.eng.join({ user: H }); const host = w.connect(w.eng.redeemTicket(j.ticket));
  const a = (await w.joinWs(A)).sock;
  host.say("start");
  return { w, host, a };
}

test("create public: waiting, host is member, inviteKey only to host", async () => {
  const w = makeWorld(); const r = await w.create(H);
  assert.equal(r.room.status, "waiting"); assert.equal(r.room.inviteKey, "a".repeat(32)); assert.ok(r.ticket);
  const j = await w.eng.join({ user: A }); assert.equal(j.room.inviteKey, undefined);
});
test("create twice → EXISTS", async () => { const w = makeWorld(); await w.create(H); await rejects(w.create(H), "EXISTS"); });
test("join nonexistent → NOT_FOUND", async () => { const w = makeWorld(); await rejects(w.eng.join({ user: A }), "NOT_FOUND"); });
test("private without invite/password → NOT_FOUND (same as missing)", async () => {
  const w = makeWorld(); await w.create(H, { visibility: "private" });
  await rejects(w.eng.join({ user: A }), "NOT_FOUND");
  await rejects(w.eng.join({ user: A, invite: "b".repeat(32) }), "NOT_FOUND");
});
test("private with valid invite → ok; later rejoin without invite → ok", async () => {
  const w = makeWorld(); await w.create(H, { visibility: "private" });
  await w.eng.join({ user: A, invite: "a".repeat(32) }); await w.eng.join({ user: A });
});
test("password: required (public), wrong, right; private wrong → NOT_FOUND", async () => {
  const w = makeWorld(); await w.create(H, { password: "rahasia1" });
  await rejects(w.eng.join({ user: A }), "PASSWORD_REQUIRED");
  await rejects(w.eng.join({ user: A, password: "salah" }), "BAD_PASSWORD");
  await w.eng.join({ user: A, password: "rahasia1" });
  const w2 = makeWorld(); await w2.create(H, { visibility: "private", password: "rahasia1" });
  await rejects(w2.eng.join({ user: A, password: "salah" }), "NOT_FOUND");
  await w2.eng.join({ user: A, password: "rahasia1" });
});
test("ticket is single-use and expires", async () => {
  const w = makeWorld(); await w.create(H);
  const j = await w.eng.join({ user: A });
  assert.ok(w.eng.redeemTicket(j.ticket)); assert.equal(w.eng.redeemTicket(j.ticket), null);
  const j2 = await w.eng.join({ user: A }); w.advance(31000); assert.equal(w.eng.redeemTicket(j2.ticket), null);
  assert.equal(w.eng.redeemTicket("zz"), null);
});
test("room full (counts online + pending tickets)", async () => {
  const w = makeWorld(); await w.create(H, { maxParticipants: 2 });
  await w.joinWs(H); await w.eng.join({ user: A }); // A has pending ticket → slot taken
  await rejects(w.eng.join({ user: B }), "ROOM_FULL");
});
test("multi-device: same user 2 sockets counts once; 4th rejected", async () => {
  const w = makeWorld(); await w.create(H, { maxParticipants: 3 });
  const s1 = (await w.joinWs(A)).sock, s2 = (await w.joinWs(A)).sock, s3 = (await w.joinWs(A)).sock;
  assert.equal(w.eng.onlineMap().size, 1);
  const s4 = (await w.joinWs(A)).sock; assert.equal(s4.closed, true);
  w.disconnect(s1); assert.equal(w.eng.onlineMap().has("a"), true);
});
test("non-host cannot play/pause/seek/start/end/kick/settings", async () => {
  const { w, host, a } = await started();
  for (const [t, o] of [["play", {}], ["pause", {}], ["seek", { pos: 5 }], ["rate", { rate: 1.5 }], ["end", {}], ["kick", { userId: "h" }], ["settings", { name: "xxx" }], ["pres", { id: 1, approve: true }], ["media", { media: { id: "x" } }]]) {
    a.say(t, o); assert.equal(a.last("error").code, "FORBIDDEN", t); a.inbox.length = 0;
  }
  assert.equal(w.eng.room().status, "active"); assert.equal(w.eng.room().p_playing, 0);
});
test("host play/pause/seek/rate update state, bump version, broadcast", async () => {
  const { w, host, a } = await started();
  const v0 = w.eng.room().p_ver;
  host.say("play", { pos: 10 }); let s = a.last("state").s; assert.equal(s.isPlaying, true); assert.equal(s.position, 10); assert.ok(s.version > v0);
  w.advance(5000); host.say("pause"); s = a.last("state").s; assert.equal(s.isPlaying, false); assert.ok(Math.abs(s.position - 15) < 0.01);
  host.say("seek", { pos: 100 }); assert.equal(a.last("state").s.position, 100);
  host.say("rate", { rate: 1.5 }); assert.equal(a.last("state").s.rate, 1.5);
  host.say("seek", { pos: "abc" }); assert.equal(host.last("error").code, "BAD_POSITION");
  host.say("rate", { rate: 9 }); assert.equal(host.last("error").code, "BAD_RATE");
});
test("playback not allowed before start (waiting)", async () => {
  const w = makeWorld(); await w.create(H); const { sock } = await w.joinWs(H);
  sock.say("play"); assert.equal(sock.last("error").code, "NOT_ACTIVE");
});
test("position extrapolates with rate; host report corrects drift only when large", async () => {
  const { w, host, a } = await started();
  host.say("play", { pos: 0 }); w.advance(10000);
  host.say("report", { pos: 10.5 }); assert.equal(a.all("state").length, 2); // play + (start) only → no rebase
  w.advance(5000); host.say("report", { pos: 3 }); // host far behind → rebase
  const s = a.last("state").s; assert.ok(Math.abs(s.position - 3) < 0.01);
});
test("replay: n must strictly increase", async () => {
  const { w, host } = await started();
  w.eng.onMessage(host, JSON.stringify({ t: "ping", n: 100 })); host.inbox.length = 0;
  w.eng.onMessage(host, JSON.stringify({ t: "ping", n: 100 })); assert.equal(host.last("error").code, "REPLAY");
  w.eng.onMessage(host, JSON.stringify({ t: "ping", n: 50 })); assert.equal(host.last("error").code, "REPLAY");
  w.eng.onMessage(host, JSON.stringify({ t: "ping", n: 101, c: 7 })); assert.equal(host.last("pong").c, 7);
});
test("oversize / bad json / flood", async () => {
  const { w, host } = await started();
  w.eng.onMessage(host, "x".repeat(3000)); assert.equal(host.closeCode, 1009);
  const { sock } = await w.joinWs(B); w.eng.onMessage(sock, "{bad"); assert.equal(sock.last("error").code, "BAD_JSON");
  const s2 = (await w.joinWs(C)).sock; for (let i = 0; i < 60; i++) s2.say("ping"); assert.equal(s2.closeCode, 1008);
});
test("pause request: viewer asks, host approves → paused; single use", async () => {
  const { w, host, a } = await started(); host.say("play", { pos: 0 }); w.advance(3000);
  a.say("preq", { kind: "pause" }); const req = host.last("preq").req; assert.equal(req.name, "Ana");
  host.say("pres", { id: req.id, approve: true });
  assert.equal(a.last("pres").status, "approved"); assert.equal(a.last("state").s.isPlaying, false);
  host.say("pres", { id: req.id, approve: true }); assert.equal(host.last("error").code, "REQUEST_CLOSED");
});
test("pause request: reject keeps playing; host cannot request; duplicates, cooldown, expiry", async () => {
  const { w, host, a } = await started(); host.say("play", { pos: 0 });
  host.say("preq", { kind: "pause" }); assert.equal(host.last("error").code, "HOST_NO_REQUEST");
  a.say("preq", { kind: "pause" }); const id = a.last("preq").req.id;
  a.say("preq", { kind: "pause" }); assert.equal(a.last("error").code, "ACTIVE_REQUEST");
  host.say("pres", { id, approve: false }); assert.equal(a.last("pres").status, "rejected"); assert.equal(w.eng.room().p_playing, 1);
  a.say("preq", { kind: "pause" }); assert.equal(a.last("error").code, "COOLDOWN");
  w.advance(21000); a.say("preq", { kind: "seek", seekTo: 60 }); const id2 = a.last("preq").req.id;
  w.advance(31000); host.say("pres", { id: id2, approve: true }); assert.equal(host.last("error").code, "REQUEST_EXPIRED");
  a.say("preq", { kind: "resume" }); assert.equal(a.last("error").code, "ALREADY_PLAYING");
  a.say("preq", { kind: "hack" }); assert.equal(a.last("error").code, "BAD_KIND");
});
test("pause request: seek approved moves position; viewer can cancel own only", async () => {
  const { w, host, a } = await started(); host.say("play", { pos: 0 });
  a.say("preq", { kind: "seek", seekTo: 300 }); const id = a.last("preq").req.id;
  const b = (await w.joinWs(B)).sock; b.say("pcancel", { id }); assert.equal(b.last("error").code, "REQUEST_NOT_FOUND");
  host.say("pres", { id, approve: true }); assert.equal(host.last("state").s.position >= 300, true);
});
test("chat: broadcast, sanitize, empty, length, rate limit → mute, chat off", async () => {
  const { w, host, a } = await started();
  a.say("chat", { text: "  halo\u0000 ‮dunia  " }); assert.equal(host.last("chat").m.text, "halo dunia");
  a.say("chat", { text: "   " }); assert.equal(a.last("error").code, "EMPTY");
  a.say("chat", { text: "x".repeat(900) }); assert.equal(host.last("chat").m.text.length, 300);
  for (let i = 0; i < 6; i++) { w.advance(100); a.say("chat", { text: "m" + i }); }
  const codes = a.all("error").map((e) => e.code); assert.ok(codes.includes("RATE_LIMIT")); assert.equal(codes[codes.length - 1], "MUTED");
  a.say("chat", { text: "still muted" }); assert.equal(a.last("error").code, "MUTED");
  w.advance(31000); a.say("chat", { text: "back" }); assert.equal(host.last("chat").m.text, "back");
  host.say("settings", { chatEnabled: false }); a.say("chat", { text: "no" }); assert.equal(a.last("error").code, "CHAT_OFF");
});
test("chat stores only last 50; hello includes history", async () => {
  const { w, host } = await started();
  for (let i = 0; i < 60; i++) { w.advance(11000); host.say("chat", { text: "pesan " + i }); }
  const c = (await w.joinWs(C)).sock; assert.equal(c.last("hello").chat.length, 50); assert.equal(c.last("hello").chat[49].text, "pesan 59");
});
test("reactions: only known keys, throttled", async () => {
  const { w, host, a } = await started();
  a.say("react", { k: "fire" }); assert.equal(host.last("react").k, "fire");
  a.say("react", { k: "<img>" }); assert.equal(a.last("error").code, "BAD_REACTION");
  const n = host.all("react").length; a.say("react", { k: "heart" }); assert.equal(host.all("react").length, n);
});
test("kick removes member and closes sockets; ban blocks rejoin", async () => {
  const { w, host, a } = await started();
  host.say("kick", { userId: "a", ban: true }); assert.equal(a.closed, true); assert.equal(a.last("kicked").ban, true);
  await rejects(w.eng.join({ user: A }), "NOT_FOUND");
  host.say("kick", { userId: "h" }); assert.equal(host.last("error").code, "BAD_TARGET");
});
test("settings: name, max (not below online), invalid", async () => {
  const { w, host, a } = await started();
  host.say("settings", { name: "Nobar Seru", maxParticipants: 8 }); assert.equal(a.last("room").room.name, "Nobar Seru"); assert.equal(w.eng.room().max_participants, 8);
  host.say("settings", { maxParticipants: 1 }); assert.equal(host.last("error").code, "BAD_MAX");
  host.say("settings", { name: "a" }); assert.equal(host.last("error").code, "BAD_NAME");
});
test("host disconnect: grace 90s then earliest online member promoted; returning host cancels", async () => {
  const { w, host, a } = await started(); const b = (await w.joinWs(B)).sock;
  w.disconnect(host); w.advance(60000); await w.eng.alarm(); assert.equal(w.eng.room().host_id, "h");
  w.advance(31000); await w.eng.alarm(); assert.equal(w.eng.room().host_id, "a"); assert.equal(b.last("notice").k, "host");
  const w2 = makeWorld(); await w2.create(H); const h1 = (await w2.joinWs(H)).sock; await w2.joinWs(A);
  w2.disconnect(h1); w2.advance(60000); await w2.joinWs(H); w2.advance(60000); await w2.eng.alarm(); assert.equal(w2.eng.room().host_id, "h");
});
test("host leave explicitly: hands over; alone → room ends", async () => {
  const { w, host, a } = await started(); host.say("leave"); assert.equal(w.eng.room().host_id, "a"); assert.equal(host.closed, true);
  a.say("leave"); assert.equal(w.eng.room().status, "ended");
});
test("host ends session: everyone told and disconnected; join → 410 (public) / NOT_FOUND (private non-member)", async () => {
  const { w, host, a } = await started(); host.say("end");
  assert.equal(a.last("ended").reason, "host_ended"); assert.equal(a.closed, true);
  await rejects(w.eng.join({ user: B }), "ROOM_ENDED");
  const w2 = makeWorld(); await w2.create(H, { visibility: "private" }); const { sock } = await w2.joinWs(H); sock.say("start"); sock.say("end");
  await rejects(w2.eng.join({ user: B, invite: "a".repeat(32) }), "NOT_FOUND");
});
test("empty room ends after 10 min; abandoned never-joined room too; wipe after 1h", async () => {
  const { w, host, a } = await started(); w.disconnect(host); w.disconnect(a);
  w.advance(9 * 60000); await w.eng.alarm(); assert.equal(w.eng.room().status, "active");
  w.advance(61000); await w.eng.alarm(); assert.equal(w.eng.room().status, "ended");
  w.advance(3600001); await w.eng.alarm(); assert.equal(w.wiped, true);
  const w2 = makeWorld(); await w2.create(H); w2.advance(601000); await w2.eng.alarm(); assert.equal(w2.eng.room().status, "ended");
});
test("max lifetime 12h", async () => {
  const { w } = await started(); w.advance(12 * 3600000 + 1); await w.eng.alarm(); assert.equal(w.eng.room().status, "ended"); assert.equal(w.eng.room().end_reason, "expired");
});
test("alarm scheduled for nearest deadline", async () => {
  const { w, host, a } = await started(); const t0 = w.t; w.alarm = null;
  w.disconnect(host); assert.equal(w.alarm, t0 + 90000);
});
test("hello snapshot has role, state, members; viewer role is viewer", async () => {
  const { w, host, a } = await started(); const h = a.last("hello");
  assert.equal(h.you.role, "viewer"); assert.equal(host.all("hello")[0].you.role, "host"); assert.equal(h.members.length, 2); assert.ok(h.state.version >= 0);
});
test("buffering flag shown in presence", async () => {
  const { w, host, a } = await started(); a.say("buf", { b: true });
  assert.equal(host.last("presence").members.find((m) => m.id === "a").buffering, true);
});
test("media: host sets, viewers notified; viewer cannot; bad media rejected", async () => {
  const { w, host, a } = await started();
  host.say("media", { media: { id: "tt1", tmdbId: 603, type: "movie", title: "The Matrix", poster: "https://image.tmdb.org/x.jpg" } });
  assert.equal(a.last("room").room.media.title, "The Matrix");
  host.say("media", { media: { title: "x" } }); assert.equal(host.last("error").code, "BAD_MEDIA");
});
