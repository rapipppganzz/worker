# Deploy Watch Party RapipMovies (Cloudflare Workers + Durable Objects)

Semua langkah di bawah dikerjakan **di komputer kamu** (butuh internet). Kode ini **belum pernah di-deploy atau dijalankan di Cloudflare asli** oleh saya; yang sudah diuji hanya logika di Node + browser dengan WebSocket tiruan (lihat bagian "Apa yang sudah / belum diuji").

## 0. Yang dibutuhkan
- Akun Cloudflare gratis (https://dash.cloudflare.com/sign-up)
- Node.js 20+ dan npm
- Folder ini (`watchparty-worker/`)

## 1. Pasang dependensi & login
```bash
cd watchparty-worker
npm install            # memasang wrangler
npx wrangler login     # membuka browser, izinkan akses
```

## 2. Cek konfigurasi `wrangler.jsonc`
| Kunci | Arti | Yang perlu kamu cek |
|---|---|---|
| `name` | nama Worker → URL `https://<name>.<subdomain-akunmu>.workers.dev` | boleh diganti |
| `compatibility_date` | tanggal perilaku runtime | biarkan |
| `durable_objects.bindings` | `ROOM` → kelas `WatchRoom`, `LIMITER` → kelas `RateLimiter` | jangan diubah |
| `migrations` | `new_sqlite_classes` untuk kedua kelas | **wajib `new_sqlite_classes`** (paket Free hanya mendukung Durable Object berbasis SQLite) |
| `vars.AUTH_API` | alamat API akun RapipMovies | sudah `https://website-gw-api.vercel.app` (sama dengan `RM_CONFIG.API`) |
| `vars.AUTH_VERIFY_PATH` | endpoint yang dipanggil untuk memvalidasi token | `/api/data` (harus membalas **200** untuk token sah dan **401** untuk token tidak sah) |
| `vars.ALLOWED_ORIGINS` | origin web yang boleh memakai API (pisahkan koma) | `https://apk-rapipmovies.vercel.app`. Tambahkan domain lain bila ada. **APK WebView memakai origin yang sama.** |
| `vars.MAX_PARTICIPANTS_CAP` | batas atas peserta per room | 20 |

Semua `vars` bukan rahasia. **Tidak ada secret yang wajib** untuk mode verifikasi bawaan (Worker meminta API akun memvalidasi token, lihat "Integrasi akun"). Jika nanti kamu menambah verifikasi token lokal (HMAC), simpan kuncinya dengan `npx wrangler secret put NAMA_SECRET`, jangan di `wrangler.jsonc` dan jangan di frontend.

## 3. Deploy
```bash
npx wrangler deploy
```
Pertama kali, Wrangler menerapkan migrasi `v1` (membuat kelas Durable Object `WatchRoom` dan `RateLimiter`). Di akhir keluar URL Worker, mis. `https://rapip-watchparty.<subdomain>.workers.dev`. Catat URL itu.

Cek cepat:
```bash
curl https://<url-worker-kamu>/api/health     # → {"ok":true,"service":"rapip-watchparty"}
```
Untuk melihat log: `npx wrangler tail` (log tidak berisi token, password, atau isi chat).

## 4. Sambungkan frontend
1. Di `config.js` isi: `WP_API: "https://<url-worker-kamu>"` (tanpa garis miring di akhir).
2. Unggah ke Vercel file: `config.js`, `app.js`, `index.html`, `watchparty.css`, `wp-api.js`, `wp-ui.js`, `wp-player.js`, `wp-main.js`.
3. Selama `WP_API` kosong, fitur **disembunyikan** (tombol "Nonton Bareng" dan link "Party" tidak muncul).
4. Service worker (`sw.js`) otomatis menyimpan skrip baru saat kunjungan berikutnya; pengguna mungkin perlu membuka web dua kali untuk mendapat versi baru.
5. **APK tidak perlu diubah** untuk fitur ini: WebView memuat web yang sama, dan `wss://*.workers.dev` tidak diblokir oleh daftar adblock bawaan. Jika kamu memakai daftar AdGuard yang agresif dan koneksi gagal, tambahkan domain Worker ke pengecualian.

## 5. Integrasi akun (tanpa sistem akun kedua)
- Frontend memakai token sesi yang sudah ada (`Auth.token`) hanya untuk panggilan REST (`Authorization: Bearer`), tidak pernah disimpan ulang oleh Watch Party dan **tidak dikirim lewat URL WebSocket**.
- Worker memeriksa bentuk & `exp` token, lalu memanggil `GET {AUTH_API}{AUTH_VERIFY_PATH}` dengan token itu. Hanya bila API akun membalas 200, `id`, nama, dan avatar dibaca dari payload token. Hasil di-cache 60 detik per isolate (kunci = hash SHA-256 token).
- Untuk masuk ke WebSocket, klien menukar token dengan **tiket sekali pakai** (30 detik) lewat `POST /api/rooms/:id/join`. Identitas & role dalam room selalu berasal dari server, tidak pernah dari pesan klien.
- Asumsi yang **harus kamu pastikan**: `GET /api/data` di API akun memverifikasi tanda tangan token dan membalas 401 bila tidak sah. (Saya tidak punya kode API akunmu.) Kalau mau lebih hemat panggilan, kirim `api/_lib.js` dan verifikasi HMAC bisa dibuat lokal di Worker.

## 6. Batas & biaya (paket Free)
- Worker Free punya batas CPU per request yang kecil (sekitar 10 ms). Hash password room (PBKDF2, 100.000 iterasi = maksimum yang diizinkan Workers) sengaja dijalankan **di dalam Durable Object**, bukan di Worker gateway.
- Durable Object Free: hanya SQLite-backed; ada kuota harian request, durasi, dan penyimpanan. Pesan WebSocket masuk dihitung 1 request per 20 pesan; pesan keluar gratis. **Cek angka terbaru** di https://developers.cloudflare.com/durable-objects/platform/pricing/ dan /platform/limits/ sebelum meluncurkan ke banyak pengguna.
- Desain hemat: tidak ada polling, `ping` tiap 30 detik, laporan posisi host tiap 5 detik hanya saat memutar, room kosong berakhir 10 menit, umur maksimum room 12 jam, data room dihapus 1 jam setelah berakhir.
- Tidak ada jaminan uptime 100%. Bila kuota harian habis, Cloudflare menolak request sampai reset; fitur akan gagal terhubung (aplikasi lain tidak terpengaruh).

## 7. Rollback / hapus
- Rollback: `npx wrangler rollback`.
- Matikan fitur tanpa menghapus Worker: kosongkan `WP_API` di `config.js` dan unggah ulang.
- Hapus total: `npx wrangler delete` (menghapus Worker dan data Durable Object-nya).

## 8. Menjalankan tes lokal
```bash
npm test      # 42 tes: engine room (SQL asli lewat node:sqlite), auth, validasi, Room ID, CORS
```
Tes ini **tidak** menjalankan runtime Cloudflare (workerd). Uji juga manual setelah deploy dengan daftar di README.md bagian "Checklist uji setelah deploy".
