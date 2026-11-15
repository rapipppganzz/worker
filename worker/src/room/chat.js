/* Chat: sanitasi, rate limit, anti-spam, riwayat terbatas. Teks disimpan apa adanya (sudah dibersihkan dari karakter kontrol);
   klien WAJIB merender dengan textContent / esc(), bukan innerHTML mentah. */
import { HttpError } from "../http.js";
import { sanitizeChat } from "../validate.js";

export const CHAT_LIMITS = { window: 10000, perWindow: 5, strikesToMute: 3, muteMs: 30000, dupMs: 5000, keep: 50 };

export function sendChat(db, room, member, rawText, now) {
  if (!room.chat_enabled) throw new HttpError(403, "CHAT_OFF", "Chat dimatikan oleh host.");
  if (member.muted_until > now) throw new HttpError(429, "MUTED", "Kamu sedang dibatasi sementara karena terlalu cepat mengirim pesan.", { retryAfterMs: member.muted_until - now });
  const text = sanitizeChat(rawText);
  if (!text) throw new HttpError(400, "EMPTY", "Pesan kosong.");
  const recent = db.all("SELECT text, ts FROM chat WHERE user_id=? AND ts>? ORDER BY id DESC", member.user_id, now - CHAT_LIMITS.window);
  if (recent.length >= CHAT_LIMITS.perWindow) {
    const strikes = member.strikes + 1;
    if (strikes >= CHAT_LIMITS.strikesToMute) {
      db.run("UPDATE members SET strikes=0, muted_until=? WHERE user_id=?", now + CHAT_LIMITS.muteMs, member.user_id);
      throw new HttpError(429, "MUTED", "Terlalu banyak pesan. Chat dibatasi 30 detik.", { retryAfterMs: CHAT_LIMITS.muteMs });
    }
    db.run("UPDATE members SET strikes=? WHERE user_id=?", strikes, member.user_id);
    throw new HttpError(429, "RATE_LIMIT", "Pelan-pelan, pesan terlalu cepat.", { retryAfterMs: 2000 });
  }
  if (recent[0] && recent[0].text === text && now - recent[0].ts < CHAT_LIMITS.dupMs) throw new HttpError(429, "DUPLICATE", "Pesan sama terlalu cepat.");
  db.run("INSERT INTO chat (user_id, name, text, ts) VALUES (?,?,?,?)", member.user_id, member.name, text, now);
  const id = db.all("SELECT last_insert_rowid() AS id")[0].id;
  db.run("DELETE FROM chat WHERE id <= ?", id - CHAT_LIMITS.keep);
  return { id, uid: member.user_id, name: member.name, text, ts: now };
}

export function recentChat(db) {
  return db.all("SELECT id, user_id AS uid, name, text, ts FROM chat ORDER BY id DESC LIMIT ?", CHAT_LIMITS.keep).reverse();
}
