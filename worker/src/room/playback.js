/* Logika sinkronisasi playback (murni, tanpa I/O). Waktu selalu dari jam server. */
export const MAX_POS = 86400; // 24 jam
export const DRIFT_REBASE_SEC = 1.5;

export function clampPos(x) {
  if (typeof x !== "number" && typeof x !== "string") return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_POS, Math.max(0, n));
}
export function validRate(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0.5 || n > 2) return null;
  return Math.round(n * 100) / 100;
}
export function currentPosition(r, now) {
  if (!r.p_playing) return r.p_pos;
  const dt = Math.max(0, now - r.p_at) / 1000;
  return Math.min(MAX_POS, r.p_pos + dt * r.p_rate);
}
const r3 = (n) => Math.round(n * 1000) / 1000;
/** Bentuk yang dikirim ke klien. position = posisi pada saat updatedAt (waktu server). */
export function viewState(r, now) {
  return { isPlaying: !!r.p_playing, position: r3(currentPosition(r, now)), rate: r.p_rate, updatedAt: now, version: r.p_ver };
}
/** Tulis perubahan playback, naikkan version, kembalikan baris room terbaru. */
export function applyPlayback(db, r, patch, now) {
  const playing = patch.playing === undefined ? r.p_playing : patch.playing ? 1 : 0;
  const pos = patch.pos === undefined ? currentPosition(r, now) : patch.pos;
  const rate = patch.rate === undefined ? r.p_rate : patch.rate;
  db.run("UPDATE room SET p_playing=?, p_pos=?, p_rate=?, p_at=?, p_ver=p_ver+1 WHERE k=1", playing, pos, rate, now);
  return db.all("SELECT * FROM room WHERE k=1")[0];
}
export function driftExceeded(r, reportedPos, now, threshold = DRIFT_REBASE_SEC) {
  return Math.abs(currentPosition(r, now) - reportedPos) > threshold;
}
