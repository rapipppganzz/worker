# RapipMovies Watch Party

Nonton bareng yang sinkron: Cloudflare Worker (gateway) + satu Durable Object per room (SQLite, WebSocket Hibernation) + frontend vanilla JS yang menempel ke RapipMovies tanpa mengubah login, Telegram, watchlist, riwayat, atau reminder.

## Arsitektur
```
Browser/APK WebView ──REST (Bearer)──► Worker (index.js) ──► WatchRoom DO (engine)  ◄─ SQLite per room
        │  POST /api/rooms, /api/rooms/:id/join                  ▲
        └──WebSocket (tiket sekali pakai)────────────────────────┘
Worker ──GET /api/data (validasi token)──► API akun RapipMovies yang sudah ada
```
- Video tidak lewat server. Tiap anggota memutar stream sendiri; WebSocket hanya membawa status `{isPlaying, position, rate, updatedAt, version}` (waktu server).
- Satu `RoomEngine` murni (SQL, jam, socket, alarm disuntikkan) → diuji di Node; `durable.js` hanya adaptor tipis.

## Daftar file
Backend (`watchparty-worker/`): `wrangler.jsonc`, `package.json`, `DEPLOY.md`, `src/index.js` (routing, CORS, rate limit), `src/auth.js` (verifikasi sesi), `src/http.js`, `src/ids.js` (Room ID, PBKDF2), `src/validate.js`, `src/limiter.js` (DO rate limiter), `src/room/engine.js` (aturan room), `src/room/playback.js`, `src/room/chat.js`, `src/room/pause.js`, `src/room/schema.js`, `src/room/durable.js` (DO), `test/*.test.mjs`.
Frontend (`site/`): `wp-api.js` (REST + WebSocket + sinkron jam), `wp-player.js` (adaptor pemutar), `wp-ui.js` (ikon & template), `wp-main.js` (pengendali), `watchparty.css`; diubah: `app.js` (route `#/party`, tombol di halaman judul, kartu di "Saya", jembatan `window.RM`), `index.html` (CSS/JS + link nav), `config.js` (`WP_API`).
Uji: `e2e/run.mjs` (browser sungguhan + engine asli + WebSocket tiruan).

## Aturan keamanan (semua di server)
Token divalidasi di Worker · identitas/role hanya dari sesi terverifikasi · tiket WS sekali pakai 30 dtk · Origin wajib diizinkan · Room ID `RP-` + 6 karakter acak (CSPRNG, 31^6 kemungkinan) · room private/ID salah/tanpa izin → jawaban sama "tidak ditemukan" · password PBKDF2-SHA256 + salt · rate limit create/join/tebak password, chat 5 pesan/10 dtk + mute, reaksi 1/dtk, flood socket · pesan ≤2 KB, nomor urut harus naik (anti-replay) · event host ditolak untuk non-host · validasi posisi/rate · pause request: 1 aktif/user, cooldown 20 dtk, kedaluwarsa 30 dtk, sekali pakai · chat dibersihkan dan dirender sebagai teks.

## Keterbatasan (jujur)
- **Sinkron penuh hanya untuk server "Direct"** (`<video>` mp4/m3u8/webm). Server iframe pihak ketiga tidak bisa dikendalikan dari luar → mode "Tanpa sinkron": UI menampilkan posisi host sebagai panduan saja. Tidak ada hls.js di aplikasi, jadi stream m3u8 hanya jalan di browser yang memutar HLS secara native (Safari/iOS; Chrome Android WebView umumnya mendukung).
- Tidak ada daftar room publik (sengaja, agar tidak bisa dienumerasi); "Public" = siapa pun yang tahu ID dan sudah login.
- Host yang buffering: viewer dikoreksi lewat laporan posisi 5 dtk (toleransi ±1,5 dtk), bukan pause otomatis.
- Rate limiter ada di memori shard DO (bisa reset bila objek dibuang runtime) → best-effort.
- Tema terang: gaya mengikuti `html[data-theme="light"]` atau class `light`; aplikasi saat ini hanya gelap.

## Apa yang sudah / belum diuji
Sudah: 42 tes unit/engine (Node 22, SQLite asli) dan 34 pemeriksaan end-to-end di Chromium (UI asli ↔ engine asli lewat WebSocket tiruan, 2 peserta): buat/gabung, private tanpa izin, password, sinkron play/seek/pause (selisih < 1,5 dtk), permintaan jeda, chat ter-escape, reaksi, reconnect, pindah host, akhiri sesi, layout mobile.
Belum: runtime Cloudflare (workerd), deploy nyata, WebSocket Hibernation sungguhan, kuota Free, `app.js` asli (tes memakai router mini; hook di `app.js` hanya dicek sintaks), APK, server video asli, banyak perangkat sungguhan, verifikasi token ke API akun asli.

## Checklist uji setelah deploy
1. `curl /api/health` OK. 2. Buat room Public & Private (+password). 3. Gabung dengan ID; ID salah; private tanpa link/password (harus "tidak ditemukan"). 4. Room penuh. 5. Host play/pause/seek → penonton mengikuti. 6. Penonton minta jeda → setujui/tolak. 7. Chat & reaksi. 8. Matikan WiFi penonton lalu nyalakan (reconnect). 9. Host keluar → host berpindah. 10. Akhiri sesi; gabung room berakhir. 11. Dua perangkat satu akun. 12. Pastikan non-host tidak bisa mengirim event host (lihat `test/engine.test.mjs`).
