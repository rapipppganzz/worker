/* Sanitasi & validasi input. Dipakai Worker (create) dan engine (WS). */
import { HttpError } from "./http.js";

const CTRL = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

export function cleanLine(s, max) {
  if (typeof s !== "string") return "";
  const t = s.replace(CTRL, " ").replace(/\s+/g, " ").trim();
  return Array.from(t).slice(0, max).join("");
}
export const sanitizeName = (s) => cleanLine(s, 24);
export const sanitizeRoomName = (s) => cleanLine(s, 40);
export const sanitizeChat = (s) => cleanLine(s, 300);

export function sanitizeAvatar(a) {
  if (typeof a !== "string") return "";
  a = a.trim();
  if (a.length > 300) return "";
  if (/^https:\/\/[^\s"'<>]+$/.test(a)) return a;
  if (/^[\w.-]{1,40}$/.test(a)) return a; // id avatar/preset
  return "";
}

export const REACTIONS = ["heart", "fire", "laugh", "wow", "clap", "sad"];

/** Metadata tontonan: hanya data deskriptif, tidak ada URL video. */
export function sanitizeMedia(m) {
  if (m == null) return null;
  if (typeof m !== "object" || Array.isArray(m)) throw new HttpError(400, "BAD_MEDIA", "Data tontonan tidak valid.");
  const type = m.type === "tv" || m.type === "series" ? "tv" : "movie";
  const tmdbId = Number.isInteger(m.tmdbId) && m.tmdbId > 0 && m.tmdbId < 1e10 ? m.tmdbId : null;
  const id = typeof m.id === "string" && /^[\w:.-]{1,64}$/.test(m.id) ? m.id : null; // id item katalog RapipMovies
  if (!id && !tmdbId) throw new HttpError(400, "BAD_MEDIA", "Data tontonan tidak valid.");
  const poster = typeof m.poster === "string" && /^https:\/\/[^\s"'<>]{1,300}$/.test(m.poster) ? m.poster : "";
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  return {
    id, tmdbId, type,
    title: cleanLine(m.title, 120) || "Tanpa judul",
    poster,
    season: int(m.season, 0, 99), episode: int(m.episode, 0, 9999),
    // URL katalog (bukan URL video). Server tidak pernah mengambilnya; klien hanya memakainya bila diawali alamat API katalog miliknya sendiri.
    src: typeof m.src === "string" && /^https:\/\/[^\s"'<>]{1,400}$/.test(m.src) ? m.src : "",
  };
}

export function validateCreate(body, env) {
  const cap = Math.max(2, Math.min(50, parseInt((env && env.MAX_PARTICIPANTS_CAP) || "20", 10) || 20));
  const name = sanitizeRoomName(body.name);
  if (name.length < 3) throw new HttpError(400, "BAD_NAME", "Nama room minimal 3 karakter.");
  const visibility = body.visibility === "private" ? "private" : body.visibility === "public" ? "public" : null;
  if (!visibility) throw new HttpError(400, "BAD_VISIBILITY", "Pilih room Public atau Private.");
  let password = null;
  if (body.password != null && body.password !== "") {
    if (typeof body.password !== "string" || body.password.length < 4 || body.password.length > 64)
      throw new HttpError(400, "BAD_PASSWORD", "Password room 4–64 karakter.");
    password = body.password;
  }
  let max = body.maxParticipants == null ? Math.min(10, cap) : body.maxParticipants;
  if (!Number.isInteger(max) || max < 2 || max > cap) throw new HttpError(400, "BAD_MAX", `Jumlah peserta 2–${cap}.`);
  const chatEnabled = body.chatEnabled === false ? false : true;
  return { name, visibility, password, maxParticipants: max, chatEnabled, media: sanitizeMedia(body.media), cap };
}
