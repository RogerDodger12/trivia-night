import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 20;
const MAX_PLAYERS = 100;
const IDLE_MS = 12 * 60 * 60 * 1000; // wipe the room after 12 idle hours

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) ?? null;
    });
  }

  // Called by the Worker (RPC) when a host creates a room.
  // Returns the host key, or null if this code is already taken.
  async init(mode) {
    if (this.room) return null;
    const hostKey = crypto.randomUUID();
    this.room = { mode, hostKey, phase: "lobby", players: {} };
    await this.save();
    return hostKey;
  }

  async save() {
    await this.ctx.storage.put("room", this.room);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async fetch(request) {
    if (!this.room) return new Response("Room not found", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); // hibernation API
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- helpers ----------

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  cleanName(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  }

  onlineIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const who = ws.deserializeAttachment();
      if (who && who.playerId) ids.add(who.playerId);
    }
    return ids;
  }

  // Each role gets only what it should see. The host also gets player IDs.
  snapshotFor(role) {
    const online = this.onlineIds();
    const roster = Object.values(this.room.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) =>
        role === "host"
          ? { id: p.id, name: p.name, online: online.has(p.id) }
          : { name: p.name, online: online.has(p.id) }
      );
    return { type: "state", mode: this.room.mode, phase: this.room.phase, roster };
  }

  broadcast() {
    if (!this.room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const who = ws.deserializeAttachment();
      if (!who) continue; // not joined yet
      this.send(ws, this.snapshotFor(who.role));
    }
  }

  // ---------- messages ----------

  async webSocketMessage(ws, raw) {
    if (!this.room) return;
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return this.send(ws, { type: "error", message: "Bad message" });
    }

    if (msg.type === "join") return this.handleJoin(ws, msg);

    const who = ws.deserializeAttachment();
    if (!who) return this.send(ws, { type: "error", message: "Join first" });

    if (msg.type === "host:kick") {
      if (who.role !== "host") {
        return this.send(ws, { type: "error", message: "Host only" });
      }
      const id = msg.playerId;
      if (!this.room.players[id]) return;
      delete this.room.players[id];
      await this.save();
      for (const s of this.ctx.getWebSockets()) {
        const w = s.deserializeAttachment();
        if (w && w.playerId === id) {
          this.send(s, { type: "kicked" });
          try { s.close(1000, "kicked"); } catch {}
        }
      }
      return this.broadcast();
    }
  }

  async handleJoin(ws, msg) {
    const room = this.room;

    if (msg.role === "display") {
      ws.serializeAttachment({ role: "display" });
      this.send(ws, { type: "joined", role: "display", mode: room.mode });
      return this.send(ws, this.snapshotFor("display"));
    }

    if (msg.role === "host") {
      if (msg.hostKey !== room.hostKey) {
        return this.send(ws, { type: "error", message: "Invalid host key" });
      }
      ws.serializeAttachment({ role: "host" });
      this.send(ws, { type: "joined", role: "host", mode: room.mode });
      return this.send(ws, this.snapshotFor("host"));
    }

    if (msg.role === "player") {
      // Reconnect: phone slept or Wi-Fi blipped
      if (msg.playerId && room.players[msg.playerId]) {
        const p = room.players[msg.playerId];
        ws.serializeAttachment({ role: "player", playerId: p.id });
        this.send(ws, {
          type: "joined", role: "player", mode: room.mode,
          playerId: p.id, name: p.name,
        });
        return this.broadcast();
      }

      // New player or team
      const label = room.mode === "teams" ? "team name" : "name";
      const name = this.cleanName(msg.name);
      if (!name) {
        return this.send(ws, { type: "error", message: "Enter a " + label });
      }
      const taken = Object.values(room.players).some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (taken) {
        return this.send(ws, {
          type: "error", message: "That " + label + " is already taken",
        });
      }
      if (Object.keys(room.players).length >= MAX_PLAYERS) {
        return this.send(ws, { type: "error", message: "Room is full" });
      }

      const id = crypto.randomUUID();
      room.players[id] = { id, name, joinedAt: Date.now() };
      await this.save();
      ws.serializeAttachment({ role: "player", playerId: id });
      this.send(ws, {
        type: "joined", role: "player", mode: room.mode, playerId: id, name,
      });
      return this.broadcast();
    }

    this.send(ws, { type: "error", message: "Unknown role" });
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(1000, "closing"); } catch {}
    this.broadcast();
  }

  async webSocketError(ws, error) {
    this.broadcast();
  }

  // Idle cleanup
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1001, "Room expired"); } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}