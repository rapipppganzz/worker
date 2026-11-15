import { DatabaseSync } from "node:sqlite";
import { RoomEngine } from "../src/room/engine.js";

export function makeDb() {
  const d = new DatabaseSync(":memory:");
  return { all: (q, ...p) => d.prepare(q).all(...p).map((r) => ({ ...r })), run: (q, ...p) => { d.prepare(q).run(...p); } };
}
export function makeWorld(opts = {}) {
  const w = { t: 1_800_000_000_000, socks: [], alarm: null, wiped: false, seq: 0 };
  w.eng = new RoomEngine(makeDb(), {
    now: () => w.t, cap: opts.cap || 20,
    sockets: () => w.socks.filter((s) => !s.closed),
    setAlarm: (ms) => { w.alarm = ms; }, wipe: async () => { w.wiped = true; },
  });
  w.eng.migrate();
  w.advance = (ms) => { w.t += ms; };
  w.connect = (ident) => {
    let att = { sid: "s" + ++w.seq, userId: ident.id, n: 0, buf: false };
    const s = { inbox: [], closed: false, closeCode: null, n: 0,
      get sid() { return att.sid; }, get userId() { return att.userId; }, get att() { return att; }, setAtt(o) { att = o; },
      send(str) { this.inbox.push(JSON.parse(str)); }, close(c) { this.closed = true; this.closeCode = c; },
      say(t, o = {}) { w.eng.onMessage(this, JSON.stringify({ t, n: ++this.n, ...o })); },
      last(t) { return [...this.inbox].reverse().find((m) => m.t === t); }, all(t) { return this.inbox.filter((m) => m.t === t); } };
    w.socks.push(s); w.eng.onOpen(s, ident); return s;
  };
  w.disconnect = (s) => { s.closed = true; w.eng.onClose(s); };
  w.U = (id, name) => ({ id, name: name || id, avatar: "" });
  w.create = async (host, o = {}) => {
    const r = await w.eng.create({ roomId: "RP-TEST22", inviteKey: "a".repeat(32), host, name: "Room", visibility: "public", password: null, maxParticipants: 5, chatEnabled: true, media: null, ...o });
    return r;
  };
  w.joinWs = async (user, creds = {}) => { const j = await w.eng.join({ user, ...creds }); const id = w.eng.redeemTicket(j.ticket); return { j, sock: w.connect(id) }; };
  return w;
}
export const rejects = async (p, code) => { try { await p; } catch (e) { if (e.code === code) return; throw new Error("expected " + code + " got " + e.code); } throw new Error("expected " + code + " but resolved"); };
