/* Direktori server publik: hanya menyimpan DAFTAR ID room publik (bukan datanya).
   Data tiap room (nama, host, peserta, tontonan) diambil langsung dari room-nya saat daftar diminta, jadi selalu segar. */
import { DurableObject } from "cloudflare:workers";

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL)");
  }
  add(id) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR REPLACE INTO rooms (room_id, added_at) VALUES (?, ?)", id, Date.now());
    sql.exec("DELETE FROM rooms WHERE room_id NOT IN (SELECT room_id FROM rooms ORDER BY added_at DESC LIMIT 200)");
  }
  remove(id) { this.ctx.storage.sql.exec("DELETE FROM rooms WHERE room_id = ?", id); }
  ids(limit) { return this.ctx.storage.sql.exec("SELECT room_id FROM rooms ORDER BY added_at DESC LIMIT ?", limit).toArray().map((r) => r.room_id); }
}
