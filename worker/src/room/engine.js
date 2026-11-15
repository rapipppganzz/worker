/* RoomEngine: seluruh aturan room. Murni terhadap I/O: SQL, jam, socket, alarm, wipe disuntikkan (deps),
   sehingga bisa diuji di Node dan dipasang tipis di Durable Object (durable.js). */
import { HttpError } from "../http.js";
import { hashPassword, verifyPassword, randomToken, timingSafeEqualStr } from "../ids.js";
import { SCHEMA } from "./schema.js";
import { clampPos, validRate, viewState, applyPlayback, driftExceeded, currentPosition } from "./playback.js";
import { sanitizeRoomName, sanitizeMedia, REACTIONS } from "../validate.js";
import { sendChat, recentChat } from "./chat.js";
import { createRequest, takeRequest, pendingRequests, expireRequests, reqView } from "./pause.js";

export const LIMITS = {
  ticketMs: 30000, hostGraceMs: 90000, emptyMs: 600000, maxLifeMs: 12 * 3600000, endedKeepMs: 3600000,
  maxMembers: 100, maxSocketsPerUser: 3, maxMsgBytes: 2048, floodWindow: 10000, floodMax: 40, reactMs: 1000, reportMinMs: 2000,
};
const notFound = () => new HttpError(404, "NOT_FOUND", "Room tidak ditemukan, atau kamu tidak punya akses.");
const send = (s, o) => { try { s.send(JSON.stringify(o)); } catch (_) {} };

export class RoomEngine {
  /** deps: { now(), sockets(): Sock[], setAlarm(ms), wipe() }.  Sock: { sid, userId, att, setAtt(o), send(str), close(code, reason) } */
  constructor(db, deps) { this.db = db; this.d = deps; this.flood = new Map(); }

  migrate() { for (const q of SCHEMA) this.db.run(q); }
  room() { return this.db.all("SELECT * FROM room WHERE k=1")[0] || null; }
  member(id) { return this.db.all("SELECT * FROM members WHERE user_id=?", id)[0] || null; }

  /* ---------- tampilan ---------- */
  onlineMap() {
    const m = new Map();
    for (const s of this.d.sockets()) { const a = s.att || {}; if (!a.userId) continue; const e = m.get(a.userId) || { n: 0, buf: false }; e.n++; e.buf = e.buf || !!a.buf; m.set(a.userId, e); }
    return m;
  }
  membersView(r) {
    const on = this.onlineMap();
    return this.db.all("SELECT user_id, name, avatar, joined_at FROM members WHERE banned=0 ORDER BY joined_at").map((m) => ({
      id: m.user_id, name: m.name, avatar: m.avatar, role: m.user_id === r.host_id ? "host" : "viewer", online: on.has(m.user_id), buffering: !!(on.get(m.user_id) || {}).buf,
    }));
  }
  roomView(r, userId) {
    const on = this.onlineMap();
    const host = this.member(r.host_id);
    const v = {
      roomId: r.room_id, name: r.name, visibility: r.visibility, status: r.status, hostId: r.host_id, hostName: host ? host.name : "",
      participants: on.size, max: r.max_participants, chatEnabled: !!r.chat_enabled, hasPassword: !!r.pw_hash,
      media: r.media ? JSON.parse(r.media) : null, createdAt: r.created_at, endReason: r.end_reason || null,
    };
    if (userId && userId === r.host_id) v.inviteKey = r.invite_key;
    return v;
  }
  bcast(obj, exceptSid) {
    const str = JSON.stringify(obj);
    for (const s of this.d.sockets()) { if (exceptSid && s.sid === exceptSid) continue; try { s.send(str); } catch (_) {} }
  }
  pushRoom(r) { this.bcast({ t: "room", room: this.roomView(r), members: this.membersView(r) }); }

  /* ---------- HTTP-level (dipanggil Worker lewat DO) ---------- */
  async create(p) {
    if (this.room()) throw new HttpError(409, "EXISTS", "ID bentrok, coba lagi.");
    const now = this.d.now();
    let salt = null, hash = null;
    if (p.password) ({ salt, hash } = await hashPassword(p.password));
    if (this.room()) throw new HttpError(409, "EXISTS", "ID bentrok, coba lagi.");
    this.db.run(`INSERT INTO room (k,room_id,name,visibility,pw_salt,pw_hash,invite_key,max_participants,chat_enabled,host_id,status,created_at,empty_since,media,p_at)
      VALUES (1,?,?,?,?,?,?,?,?,?, 'waiting', ?, ?, ?, ?)`,
      p.roomId, p.name, p.visibility, salt, hash, p.inviteKey, p.maxParticipants, p.chatEnabled ? 1 : 0, p.host.id, now, now, p.media ? JSON.stringify(p.media) : null, now);
    this.db.run("INSERT INTO members (user_id,name,avatar,joined_at,last_seen) VALUES (?,?,?,?,?)", p.host.id, p.host.name, p.host.avatar, now, now);
    const r = this.room();
    const ticket = this.issueTicket(p.host, now);
    this.reschedule();
    return { ticket, room: this.roomView(r, p.host.id) };
  }

  /** Cek izin + kapasitas lalu keluarkan tiket WS sekali pakai. Identitas `user` berasal dari Worker (token terverifikasi), bukan klien. */
  async join({ user, password, invite }) {
    this.tick();
    const r0 = this.room();
    if (!r0) throw notFound();
    const pwOk = r0.pw_hash && typeof password === "string" && password ? await verifyPassword(password, r0.pw_salt, r0.pw_hash) : false;
    const r = this.room();
    if (!r) throw notFound();
    const now = this.d.now();
    const mem = this.member(user.id);
    if (mem && mem.banned) throw notFound();
    if (r.status === "ended") {
      if (r.visibility === "public" || mem) throw new HttpError(410, "ROOM_ENDED", "Sesi ini sudah berakhir.");
      throw notFound();
    }
    const isHost = r.host_id === user.id;
    let allowed = isHost || !!mem;
    if (!allowed) {
      const inviteOk = typeof invite === "string" && invite.length > 0 && timingSafeEqualStr(invite, r.invite_key);
      if (inviteOk || pwOk) allowed = true;
      else if (r.visibility === "public" && !r.pw_hash) allowed = true;
      else if (r.visibility === "public" && r.pw_hash) throw new HttpError(403, password ? "BAD_PASSWORD" : "PASSWORD_REQUIRED", password ? "Password salah." : "Room ini butuh password.");
      else throw notFound(); // private tanpa izin → jawaban sama dengan room tidak ada
    }
    // kapasitas: peserta unik yang online + tiket aktif milik orang lain
    const on = this.onlineMap();
    if (!isHost && !on.has(user.id)) {
      const pend = this.db.all("SELECT DISTINCT user_id FROM tickets WHERE expires_at>? AND user_id!=?", now, user.id).filter((t) => !on.has(t.user_id)).length;
      if (on.size + pend >= r.max_participants) throw new HttpError(409, "ROOM_FULL", "Room sudah penuh.");
    }
    if (!mem) {
      if (this.db.all("SELECT COUNT(*) AS c FROM members")[0].c >= LIMITS.maxMembers) throw new HttpError(409, "ROOM_FULL", "Room sudah penuh.");
      this.db.run("INSERT INTO members (user_id,name,avatar,joined_at,last_seen) VALUES (?,?,?,?,?)", user.id, user.name, user.avatar, now, now);
    } else {
      this.db.run("UPDATE members SET name=?, avatar=? WHERE user_id=?", user.name, user.avatar, user.id);
    }
    const ticket = this.issueTicket(user, now);
    this.reschedule();
    return { ticket, room: this.roomView(r, user.id) };
  }

  issueTicket(user, now) {
    this.db.run("DELETE FROM tickets WHERE expires_at<=? OR user_id=?", now, user.id);
    const ticket = randomToken(24);
    this.db.run("INSERT INTO tickets (ticket,user_id,name,avatar,expires_at) VALUES (?,?,?,?,?)", ticket, user.id, user.name, user.avatar || "", now + LIMITS.ticketMs);
    return ticket;
  }
  /** Tukar tiket (sekali pakai). Null bila tidak valid/kedaluwarsa/sudah dipakai. */
  redeemTicket(ticket) {
    if (typeof ticket !== "string" || !/^[0-9a-f]{48}$/.test(ticket)) return null;
    const now = this.d.now();
    const t = this.db.all("SELECT * FROM tickets WHERE ticket=?", ticket)[0];
    if (!t) return null;
    this.db.run("DELETE FROM tickets WHERE ticket=?", ticket);
    if (t.expires_at <= now) return null;
    const r = this.room(); const m = this.member(t.user_id);
    if (!r || r.status === "ended" || !m || m.banned) return null;
    return { id: t.user_id, name: m.name, avatar: m.avatar };
  }

  /* ---------- WebSocket ---------- */
  onOpen(sock, ident) {
    const now = this.d.now();
    const r = this.room();
    if (!r || r.status === "ended") { send(sock, { t: "ended", reason: r ? r.end_reason : "gone" }); sock.close(1000, "ended"); return; }
    const mine = this.d.sockets().filter((s) => s.userId === ident.id && s.sid !== sock.sid);
    if (mine.length >= LIMITS.maxSocketsPerUser) { send(sock, { t: "error", code: "TOO_MANY_CONNECTIONS" }); sock.close(1008, "too many"); return; }
    const first = mine.length === 0;
    sock.setAtt({ sid: sock.sid, userId: ident.id, n: 0, buf: false });
    this.db.run("UPDATE members SET last_seen=? WHERE user_id=?", now, ident.id);
    this.db.run("UPDATE room SET empty_since=NULL" + (ident.id === r.host_id ? ", host_away_since=NULL" : "") + " WHERE k=1");
    const r2 = this.room();
    send(sock, {
      t: "hello", you: { id: ident.id, role: ident.id === r2.host_id ? "host" : "viewer" }, serverTime: now,
      room: this.roomView(r2, ident.id), members: this.membersView(r2), state: viewState(r2, now),
      chat: r2.chat_enabled ? recentChat(this.db) : [], requests: pendingRequests(this.db, now),
    });
    if (first) { this.bcast({ t: "notice", k: "join", name: ident.name }, sock.sid); this.pushRoom(r2); }
    this.reschedule();
  }

  onMessage(sock, raw) {
    const now = this.d.now();
    if (typeof raw !== "string" || raw.length > LIMITS.maxMsgBytes) { sock.close(1009, "too big"); return; }
    const f = this.flood.get(sock.sid) || { s: now, c: 0 };
    if (now - f.s > LIMITS.floodWindow) { f.s = now; f.c = 0; }
    if (++f.c > LIMITS.floodMax) { sock.close(1008, "flood"); return; }
    this.flood.set(sock.sid, f);
    let m;
    try { m = JSON.parse(raw); } catch (_) { send(sock, { t: "error", code: "BAD_JSON" }); return; }
    if (!m || typeof m !== "object" || typeof m.t !== "string" || !Number.isInteger(m.n)) { send(sock, { t: "error", code: "BAD_MESSAGE" }); return; }
    const att = sock.att || {};
    if (!att.userId) { sock.close(1008, "no session"); return; }
    if (m.n <= att.n) { send(sock, { t: "error", code: "REPLAY", ref: m.t }); return; } // nomor urut harus naik terus
    sock.setAtt({ ...att, n: m.n });
    try {
      const r = this.room(); const me = this.member(att.userId);
      if (!r || r.status === "ended") { sock.close(1000, "ended"); return; }
      if (!me || me.banned) { send(sock, { t: "kicked" }); sock.close(1008, "removed"); return; }
      this.handle(sock, m, r, me, now);
    } catch (e) {
      if (e instanceof HttpError) send(sock, { t: "error", code: e.code, message: e.message, ref: m.t, retryAfterMs: e.extra && e.extra.retryAfterMs });
      else { console.error("[wp] handler error:", m.t, e && e.message); send(sock, { t: "error", code: "INTERNAL", ref: m.t }); }
    }
  }

  hostOnly(r, me) { if (r.host_id !== me.user_id) throw new HttpError(403, "FORBIDDEN", "Hanya host yang bisa melakukan ini."); }
  needActive(r) { if (r.status !== "active") throw new HttpError(409, "NOT_ACTIVE", "Sesi belum dimulai."); }

  handle(sock, m, r, me, now) {
    switch (m.t) {
      case "ping": return send(sock, { t: "pong", c: Number.isFinite(m.c) ? m.c : 0, s: now });
      case "buf": {
        const b = m.b === true;
        if (!!sock.att.buf !== b) { sock.setAtt({ ...sock.att, buf: b }); this.bcast({ t: "presence", members: this.membersView(r) }); }
        return;
      }
      case "chat": { const msg = sendChat(this.db, r, me, m.text, now); return this.bcast({ t: "chat", m: { ...msg, host: r.host_id === me.user_id } }); }
      case "react": {
        if (!REACTIONS.includes(m.k)) throw new HttpError(400, "BAD_REACTION", "Reaksi tidak valid.");
        if (now - me.last_react < LIMITS.reactMs) return; // diam-diam diabaikan
        this.db.run("UPDATE members SET last_react=? WHERE user_id=?", now, me.user_id);
        return this.bcast({ t: "react", uid: me.user_id, name: me.name, k: m.k });
      }
      case "preq": {
        const q = createRequest(this.db, r, me, m.kind, m.seekTo, now);
        this.bcast({ t: "preq", req: q }); this.reschedule(); return;
      }
      case "pcancel": {
        const q = this.db.all("SELECT * FROM pause_req WHERE id=?", m.id)[0];
        if (!q || q.user_id !== me.user_id) throw new HttpError(404, "REQUEST_NOT_FOUND", "Permintaan tidak ditemukan.");
        const done = takeRequest(this.db, m.id, "cancelled", now);
        return this.bcast({ t: "pres", id: done.id, status: "cancelled" });
      }
      case "leave": return this.leave(sock, r, me, now);
    }
    // ----- hanya host dari sini -----
    this.hostOnly(r, me);
    switch (m.t) {
      case "start": {
        if (r.status !== "waiting") throw new HttpError(409, "BAD_STATE", "Sesi sudah dimulai.");
        this.db.run("UPDATE room SET status='active', started_at=?, p_at=? WHERE k=1", now, now);
        const r2 = this.room(); this.pushRoom(r2); this.bcast({ t: "state", s: viewState(r2, now), by: me.user_id }); return;
      }
      case "play": case "pause": case "seek": case "rate": {
        this.needActive(r);
        const patch = {};
        if (m.t === "play") patch.playing = true;
        if (m.t === "pause") patch.playing = false;
        if (m.t === "play" || m.t === "pause" || m.t === "seek") {
          if (m.pos !== undefined || m.t === "seek") { const p = clampPos(m.pos); if (p == null) throw new HttpError(400, "BAD_POSITION", "Posisi tidak valid."); patch.pos = p; }
        }
        if (m.t === "rate") { const v = validRate(m.rate); if (v == null) throw new HttpError(400, "BAD_RATE", "Kecepatan tidak valid."); patch.rate = v; }
        const r2 = applyPlayback(this.db, r, patch, now);
        return this.bcast({ t: "state", s: viewState(r2, now), by: me.user_id });
      }
      case "report": { // laporan posisi berkala dari host: koreksi bila server melenceng
        this.needActive(r);
        const p = clampPos(m.pos); if (p == null) return;
        if (now - r.p_at < LIMITS.reportMinMs) return;
        if (r.p_playing && driftExceeded(r, p, now)) {
          const r2 = applyPlayback(this.db, r, { pos: p }, now);
          this.bcast({ t: "state", s: viewState(r2, now), by: me.user_id });
        }
        return;
      }
      case "media": {
        const media = sanitizeMedia(m.media);
        this.db.run("UPDATE room SET media=? WHERE k=1", media ? JSON.stringify(media) : null);
        let r2 = this.room();
        if (r2.status === "active") r2 = applyPlayback(this.db, r2, { playing: false, pos: 0 }, now); // judul baru → mulai dari awal, dijeda
        this.pushRoom(r2); this.bcast({ t: "state", s: viewState(r2, now), by: me.user_id }); return;
      }
      case "pres": {
        if (typeof m.approve !== "boolean") throw new HttpError(400, "BAD_MESSAGE", "Data tidak valid.");
        const q = takeRequest(this.db, m.id, m.approve ? "approved" : "rejected", now);
        this.bcast({ t: "pres", id: q.id, status: q.status, by: me.user_id });
        if (m.approve) {
          const r2 = q.kind === "pause" ? applyPlayback(this.db, r, { playing: false }, now)
            : q.kind === "resume" ? applyPlayback(this.db, r, { playing: true }, now)
            : applyPlayback(this.db, r, { pos: q.seekTo }, now);
          this.bcast({ t: "state", s: viewState(r2, now), by: me.user_id });
        }
        return;
      }
      case "kick": {
        if (typeof m.userId !== "string" || m.userId === me.user_id) throw new HttpError(400, "BAD_TARGET", "Target tidak valid.");
        const t = this.member(m.userId); if (!t) throw new HttpError(404, "NOT_MEMBER", "Peserta tidak ditemukan.");
        if (m.ban === true) this.db.run("UPDATE members SET banned=1 WHERE user_id=?", m.userId); else this.db.run("DELETE FROM members WHERE user_id=?", m.userId);
        for (const s of this.d.sockets().filter((x) => x.userId === m.userId)) { send(s, { t: "kicked", ban: m.ban === true }); s.close(1008, "kicked"); }
        this.bcast({ t: "notice", k: "kick", name: t.name }); this.pushRoom(this.room()); return;
      }
      case "settings": {
        const sets = [], vals = [];
        if (m.name !== undefined) { const n = sanitizeRoomName(m.name); if (n.length < 3) throw new HttpError(400, "BAD_NAME", "Nama room minimal 3 karakter."); sets.push("name=?"); vals.push(n); }
        if (m.chatEnabled !== undefined) { sets.push("chat_enabled=?"); vals.push(m.chatEnabled === false ? 0 : 1); }
        if (m.maxParticipants !== undefined) {
          const cap = this.d.cap || 20;
          if (!Number.isInteger(m.maxParticipants) || m.maxParticipants < Math.max(2, this.onlineMap().size) || m.maxParticipants > cap) throw new HttpError(400, "BAD_MAX", "Jumlah peserta tidak valid.");
          sets.push("max_participants=?"); vals.push(m.maxParticipants);
        }
        if (!sets.length) return;
        this.db.run(`UPDATE room SET ${sets.join(",")} WHERE k=1`, ...vals); return this.pushRoom(this.room());
      }
      case "end": return this.endRoom("host_ended");
      default: throw new HttpError(400, "UNKNOWN_EVENT", "Perintah tidak dikenal.");
    }
  }

  leave(sock, r, me, now) {
    const uid = me.user_id;
    if (uid === r.host_id) {
      const next = this.pickNextHost(r, uid);
      if (!next) return this.endRoom("host_left");
      this.setHost(next.user_id, now);
    }
    this.db.run("DELETE FROM members WHERE user_id=?", uid);
    for (const s of this.d.sockets().filter((x) => x.userId === uid)) { send(s, { t: "left" }); s.close(1000, "left"); }
    this.bcast({ t: "notice", k: "leave", name: me.name }); this.pushRoom(this.room()); this.afterPresence();
  }

  pickNextHost(r, exceptId) {
    const on = this.onlineMap();
    return this.db.all("SELECT * FROM members WHERE banned=0 AND user_id!=? ORDER BY joined_at", exceptId).find((m) => on.has(m.user_id) && m.user_id !== exceptId) || null;
  }
  setHost(userId, now) {
    this.db.run("UPDATE room SET host_id=?, host_away_since=NULL WHERE k=1", userId);
    const m = this.member(userId);
    this.pushRoom(this.room()); this.bcast({ t: "notice", k: "host", name: m ? m.name : "" });
  }

  onClose(sock) {
    const now = this.d.now();
    this.flood.delete(sock.sid);
    const uid = sock.userId; if (!uid) return;
    const r = this.room(); if (!r || r.status === "ended") return;
    const others = this.d.sockets().filter((s) => s.sid !== sock.sid);
    if (others.some((s) => s.userId === uid)) return; // masih ada perangkat lain
    this.db.run("UPDATE members SET last_seen=? WHERE user_id=?", now, uid);
    const m = this.member(uid);
    if (m) this.bcast({ t: "notice", k: "offline", name: m.name });
    this.pushRoomExcluding(r, sock.sid);
    this.afterPresence(sock.sid);
  }
  pushRoomExcluding(r, sid) {
    const on = new Map();
    for (const s of this.d.sockets()) if (s.sid !== sid && s.att && s.att.userId) on.set(s.att.userId, true);
    const members = this.db.all("SELECT user_id,name,avatar FROM members WHERE banned=0 ORDER BY joined_at").map((m) => ({
      id: m.user_id, name: m.name, avatar: m.avatar, role: m.user_id === r.host_id ? "host" : "viewer", online: on.has(m.user_id), buffering: false }));
    this.bcast({ t: "presence", members }, sid);
  }
  afterPresence(excludeSid) {
    const now = this.d.now(); const r = this.room(); if (!r || r.status === "ended") return;
    const socks = this.d.sockets().filter((s) => s.sid !== excludeSid);
    const online = new Set(socks.map((s) => s.userId));
    if (!online.size) this.db.run("UPDATE room SET empty_since=? WHERE k=1 AND empty_since IS NULL", now);
    if (!online.has(r.host_id)) this.db.run("UPDATE room SET host_away_since=? WHERE k=1 AND host_away_since IS NULL", now);
    this.reschedule();
  }

  endRoom(reason) {
    const now = this.d.now(); const r = this.room(); if (!r || r.status === "ended") return;
    this.db.run("UPDATE room SET status='ended', ended_at=?, end_reason=?, p_playing=0, p_pos=?, p_at=? WHERE k=1", now, reason, currentPosition(r, now), now);
    this.db.run("DELETE FROM tickets");
    this.bcast({ t: "ended", reason });
    for (const s of this.d.sockets()) s.close(1000, "ended");
    this.reschedule();
  }

  /* ---------- jadwal & kedaluwarsa ---------- */
  tick() {
    const now = this.d.now(); const r = this.room(); if (!r) return;
    this.db.run("DELETE FROM tickets WHERE expires_at<=?", now);
    if (r.status === "ended") return;
    for (const q of expireRequests(this.db, now)) this.bcast({ t: "pres", id: q.id, status: "expired" });
    if (now - r.created_at >= LIMITS.maxLifeMs) return this.endRoom("expired");
    const on = this.onlineMap();
    if (!on.size) {
      const since = r.empty_since || r.created_at;
      if (now - since >= LIMITS.emptyMs) return this.endRoom("empty");
    }
    if (r.host_away_since && !on.has(r.host_id) && now - r.host_away_since >= LIMITS.hostGraceMs) {
      const next = this.pickNextHost(r, r.host_id);
      if (next) this.setHost(next.user_id, now);
    }
  }
  nextAlarmAt() {
    const r = this.room(); if (!r) return null;
    if (r.status === "ended") return r.ended_at + LIMITS.endedKeepMs;
    const c = [r.created_at + LIMITS.maxLifeMs];
    if (r.empty_since) c.push(r.empty_since + LIMITS.emptyMs);
    if (r.host_away_since) c.push(r.host_away_since + LIMITS.hostGraceMs);
    const q = this.db.all("SELECT MIN(expires_at) AS e FROM pause_req WHERE status='pending'")[0];
    if (q && q.e) c.push(q.e);
    return Math.min(...c);
  }
  reschedule() {
    const at = this.nextAlarmAt(); const r = this.room(); if (!r || at == null) return;
    if (r.alarm_at !== at) { this.db.run("UPDATE room SET alarm_at=? WHERE k=1", at); this.d.setAlarm(Math.max(at, this.d.now() + 50)); }
  }
  /** Dipanggil dari alarm() Durable Object. */
  async alarm() {
    const r = this.room(); if (!r) return;
    const now = this.d.now();
    if (r.status === "ended" && now >= r.ended_at + LIMITS.endedKeepMs) { await this.d.wipe(); return; }
    this.db.run("UPDATE room SET alarm_at=NULL WHERE k=1");
    this.tick(); this.reschedule();
  }
}
