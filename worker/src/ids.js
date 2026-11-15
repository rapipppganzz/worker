/* Room ID, token acak, hash password. Hanya memakai WebCrypto (jalan di Workers dan Node 20+). */

// 31 karakter, tanpa 0/O/1/I/L supaya tidak tertukar saat diketik. 31^6 ≈ 887 juta kemungkinan.
export const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_ID_RE = /^RP-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function randomChars(n, alphabet = ROOM_ALPHABET) {
  const limit = 256 - (256 % alphabet.length); // rejection sampling → tanpa bias
  let out = "";
  while (out.length < n) {
    const buf = new Uint8Array(n * 2);
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      if (buf[i] < limit) out += alphabet[buf[i] % alphabet.length];
    }
  }
  return out;
}

export const generateRoomId = () => "RP-" + randomChars(6);

/** "rp-8k29xm" / "8K29XM" / " RP 8K29XM " → "RP-8K29XM"; selain itu null. */
export function normalizeRoomId(input) {
  if (typeof input !== "string" || input.length > 32) return null;
  let s = input.trim().toUpperCase().replace(/[\s_]+/g, "");
  if (/^[A-Z0-9]{6}$/.test(s)) s = "RP-" + s;
  else if (/^RP[A-Z0-9]{6}$/.test(s)) s = "RP-" + s.slice(2);
  return ROOM_ID_RE.test(s) ? s : null;
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function randomToken(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}
export const generateInviteKey = () => randomToken(16);

export function timingSafeEqualStr(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Workers membatasi PBKDF2 maksimal 100.000 iterasi. Hash dilakukan di Durable Object (batas CPU jauh lebih longgar daripada Worker Free 10 ms).
export const PBKDF2_ITER = 100000;
async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITER }, key, 256);
  return toHex(new Uint8Array(bits));
}
export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return { salt: toHex(salt), hash: await pbkdf2(password, salt) };
}
export async function verifyPassword(password, saltHex, hashHex) {
  if (typeof password !== "string" || !saltHex || !hashHex) return false;
  return timingSafeEqualStr(await pbkdf2(password, fromHex(saltHex)), hashHex);
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(d));
}
