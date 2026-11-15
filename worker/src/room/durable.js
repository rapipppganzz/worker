/* Durable Object WatchRoom: adaptor tipis antara runtime Cloudflare dan RoomEngine.
   Memakai WebSocket Hibernation API (ctx.acceptWebSocket) supaya objek bisa tidur saat tidak ada pesan. */
import { DurableObject } from "cloudflare:workers";
import { RoomEngine } from "./engine.js";
import { HttpError, json, errorResponse, readJson } from "../http.js";
import { randomToken } from "../ids.js";

export class WatchRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const db = { all: (q, ...p) => sql.exec(q, ...p).toArray(), run: (q, ...p) => { sql.exec(q, ...p); } };
    const wrap = (ws) => {
      let att = ws.deserializeAttachment() || {};
      return {
        ws, get sid() { return att.sid; }, get userId() { return att.userId; }, get att() { return att; },
        setAtt(o) { att = o; ws.serializeAttachment(o); },
        send: (s) => ws.send(s), close: (c, r) => { try { ws.close(c, r); } catch (_) {} },
      };
    };
    this.wrap = wrap;
    const cap = Math.max(2, Math.min(50, parseInt(env.MAX_PARTICIPANTS_CAP || "20", 10) || 20));
    this.engine = new RoomEngine(db, {
      now: () => Date.now(), cap,
      sockets: () => ctx.getWebSockets().map(wrap),
      setAlarm: (ms) => { ctx.storage.setAlarm(ms); },
      wipe: async () => { await ctx.storage.deleteAlarm(); await ctx.storage.deleteAll(); },
    });
    ctx.blockConcurrencyWhile(async () => { this.engine.migrate(); });
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/create" && request.method === "POST") return json({ ok: true, ...(await this.engine.create(await readJson(request, 8192))) });
      if (url.pathname === "/join" && request.method === "POST") return json({ ok: true, ...(await this.engine.join(await readJson(request, 4096))) });
      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "UPGRADE_REQUIRED", "Butuh WebSocket.");
        const ident = this.engine.redeemTicket(url.searchParams.get("ticket"));
        if (!ident) throw new HttpError(401, "BAD_TICKET", "Tiket tidak valid atau kedaluwarsa.");
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ sid: randomToken(8), userId: ident.id, n: 0, buf: false });
        this.engine.onOpen(this.wrap(server), ident);
        return new Response(null, { status: 101, webSocket: client });
      }
      throw new HttpError(404, "NOT_FOUND", "Tidak ditemukan.");
    } catch (e) { return errorResponse(e); }
  }

  async webSocketMessage(ws, message) { this.engine.onMessage(this.wrap(ws), message); }
  async webSocketClose(ws, code, reason, wasClean) { try { ws.close(code, "closing"); } catch (_) {} this.engine.onClose(this.wrap(ws)); }
  async webSocketError(ws, error) { try { ws.close(1011, "error"); } catch (_) {} this.engine.onClose(this.wrap(ws)); }
  async alarm() { await this.engine.alarm(); }
}
