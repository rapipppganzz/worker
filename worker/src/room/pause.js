/* Pause Request: viewer meminta pause/resume/seek, host menyetujui/menolak. Semua validasi di sini (server-side). */
import { HttpError } from "../http.js";
import { clampPos } from "./playback.js";

export const PAUSE_LIMITS = { expiryMs: 30000, cooldownMs: 20000, maxPending: 5, kinds: ["pause", "resume", "seek"] };

const view = (q) => ({ id: q.id, uid: q.user_id, name: q.name, kind: q.kind, seekTo: q.seek_to, status: q.status, createdAt: q.created_at, expiresAt: q.expires_at });
export const reqView = view;

export function pendingRequests(db, now) {
  return db.all("SELECT * FROM pause_req WHERE status='pending' AND expires_at>? ORDER BY id", now).map(view);
}

/** Tandai kedaluwarsa; kembalikan daftar yang baru saja expired (untuk disiarkan). */
export function expireRequests(db, now) {
  const rows = db.all("SELECT * FROM pause_req WHERE status='pending' AND expires_at<=?", now);
  if (rows.length) db.run("UPDATE pause_req SET status='expired', resolved_at=? WHERE status='pending' AND expires_at<=?", now, now);
  db.run("DELETE FROM pause_req WHERE created_at<?", now - 3600000);
  return rows.map((q) => ({ ...view(q), status: "expired" }));
}

export function createRequest(db, room, member, kind, seekTo, now) {
  if (room.status !== "active") throw new HttpError(409, "NOT_ACTIVE", "Sesi belum dimulai.");
  if (room.host_id === member.user_id) throw new HttpError(403, "HOST_NO_REQUEST", "Host tidak perlu mengajukan permintaan.");
  if (!PAUSE_LIMITS.kinds.includes(kind)) throw new HttpError(400, "BAD_KIND", "Jenis permintaan tidak valid.");
  if (kind === "pause" && !room.p_playing) throw new HttpError(409, "ALREADY_PAUSED", "Video sudah dijeda.");
  if (kind === "resume" && room.p_playing) throw new HttpError(409, "ALREADY_PLAYING", "Video sedang diputar.");
  let pos = null;
  if (kind === "seek") {
    pos = clampPos(seekTo);
    if (pos == null) throw new HttpError(400, "BAD_SEEK", "Posisi tidak valid.");
  }
  expireRequests(db, now);
  if (db.all("SELECT id FROM pause_req WHERE user_id=? AND status='pending'", member.user_id).length)
    throw new HttpError(409, "ACTIVE_REQUEST", "Kamu masih punya permintaan yang menunggu.");
  const last = db.all("SELECT created_at FROM pause_req WHERE user_id=? ORDER BY id DESC LIMIT 1", member.user_id)[0];
  if (last && now - last.created_at < PAUSE_LIMITS.cooldownMs)
    throw new HttpError(429, "COOLDOWN", "Tunggu sebentar sebelum mengajukan lagi.", { retryAfterMs: PAUSE_LIMITS.cooldownMs - (now - last.created_at) });
  if (db.all("SELECT id FROM pause_req WHERE status='pending'").length >= PAUSE_LIMITS.maxPending)
    throw new HttpError(429, "TOO_MANY_PENDING", "Terlalu banyak permintaan menunggu.");
  db.run("INSERT INTO pause_req (user_id,name,kind,seek_to,status,created_at,expires_at) VALUES (?,?,?,?, 'pending', ?, ?)",
    member.user_id, member.name, kind, pos, now, now + PAUSE_LIMITS.expiryMs);
  const id = db.all("SELECT last_insert_rowid() AS id")[0].id;
  return view(db.all("SELECT * FROM pause_req WHERE id=?", id)[0]);
}

/** Satu kali pakai: hanya status 'pending' & belum lewat waktu yang bisa diproses. */
export function takeRequest(db, id, status, now) {
  if (!Number.isInteger(id)) throw new HttpError(400, "BAD_ID", "ID permintaan tidak valid.");
  const q = db.all("SELECT * FROM pause_req WHERE id=?", id)[0];
  if (!q) throw new HttpError(404, "REQUEST_NOT_FOUND", "Permintaan tidak ditemukan.");
  if (q.status !== "pending") throw new HttpError(409, "REQUEST_CLOSED", "Permintaan ini sudah diproses.");
  if (q.expires_at <= now) {
    db.run("UPDATE pause_req SET status='expired', resolved_at=? WHERE id=?", now, id);
    throw new HttpError(410, "REQUEST_EXPIRED", "Permintaan sudah kedaluwarsa.");
  }
  db.run("UPDATE pause_req SET status=?, resolved_at=? WHERE id=? AND status='pending'", status, now, id);
  return { ...view(q), status };
}
