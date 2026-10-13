import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 20;
const MAX_PLAYERS = 100;
const IDLE_MS = 12 * 60 * 60 * 1000; // wipe the room after 12 idle hours
const MAX_SECONDS = 180;             // hard cap on any question timer
const MIN_SECONDS = 5;
const DEFAULT_SECONDS = { solo: 180, teams: 180 };
const BASE_POINTS = 1000;
const SPEED_BONUS = 500;             // solo only, scaled to the question timer
const STALE_MS = 25000;              // no ping for this long = offline
const TICK_MS = 10000;               // how often the server re-checks who is online

const SAMPLE_QUESTIONS = [
  { text: "Which planet is known as the Red Planet?", options: ["Venus", "Mars", "Jupiter", "Mercury"], correct: 1 },
  { text: "How many sides does a hexagon have?", options: ["5", "6", "7", "8"], correct: 1 },
  { text: "What is the largest ocean on Earth?", options: ["Atlantic", "Indian", "Pacific", "Arctic"], correct: 2 },
  { text: "Which element has the chemical symbol O?", options: ["Gold", "Oxygen", "Osmium", "Iron"], correct: 1 },
  { text: "In what year did the Titanic sink?", options: ["1905", "1912", "1920", "1931"], correct: 1 },
];

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.lastSig = "";
    // Cloudflare answers "ping" with "pong" without waking this object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) ?? null;
      if (this.room) {
        const r = this.room;
        r.questions ??= SAMPLE_QUESTIONS;
        r.qIndex ??= -1;
        r.current ??= null;
        r.autoLock ??= false;
        r.idleAt ??= Date.now() + IDLE_MS;
      }
    });
  }

  // Called by the Worker (RPC) when a host creates a room.
  // Returns the host key, or null if this code is already taken.
  async init(mode) {
    if (this.room) return null;
    const hostKey = crypto.randomUUID();
    this.room = {
      mode, hostKey, phase: "lobby", players: {},
      questions: SAMPLE_QUESTIONS, qIndex: -1, current: null,
      autoLock: false, idleAt: Date.now() + IDLE_MS,
    };
    await this.save();
    return hostKey;
  }

  async save() {
    this.room.idleAt = Date.now() + IDLE_MS;
    await this.ctx.storage.put("room", this.room);
    await this.scheduleAlarm();
  }

  // One alarm serves three jobs: question deadline, presence check, idle cleanup.
  async scheduleAlarm() {
    const r = this.room;
    if (!r) return;
    let next = r.idleAt;
    if (r.phase === "question" && r.current) next = Math.min(next, r.current.deadline);
    if (this.ctx.getWebSockets().length > 0) next = Math.min(next, Date.now() + TICK_MS);
    await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    const r = this.room;
    if (!r) return;
    const now = Date.now();
    if (now >= r.idleAt) {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(1001, "Room expired"); } catch {}
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    if (r.phase === "question" && r.current && now >= r.current.deadline) {
      await this.lockQuestion(); // saves, broadcasts and reschedules
      return;
    }
    // Presence check: tell everyone if someone went quiet or came back
    if (this.presenceSig() !== this.lastSig) this.broadcast();
    await this.scheduleAlarm();
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

  error(ws, message) {
    this.send(ws, { type: "error", message });
  }

  cleanName(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  }

  // A player is online if their socket is open AND we heard from them recently.
  onlineIds() {
    const ids = new Set();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== 1) continue;
      const who = ws.deserializeAttachment();
      if (!who || !who.playerId) continue;
      const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const last = Math.max(who.at || 0, ts ? ts.getTime() : 0);
      if (now - last <= STALE_MS) ids.add(who.playerId);
    }
    return ids;
  }

  presenceSig() {
    return [...this.onlineIds()].sort().join(",");
  }

  duration(q) {
    const s = Number(q.seconds) || DEFAULT_SECONDS[this.room.mode];
    return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, s)) * 1000;
  }

  leaderboard() {
    const list = Object.values(this.room.players)
      .map((p) => ({ name: p.name, score: p.score ?? 0 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    let rank = 0, prev = null;
    list.forEach((p, i) => {
      if (p.score !== prev) { rank = i + 1; prev = p.score; }
      p.rank = rank;
    });
    return list;
  }

  progress(online) {
    const r = this.room, c = r.current;
    const ids = c.eligible.filter((id) => r.players[id]);
    const answered = ids.filter((id) => c.answers[id]).length;
    const disconnected = ids.filter((id) => !c.answers[id] && !online.has(id)).length;
    const waiting = ids.filter((id) => !c.answers[id] && online.has(id)).length;
    return {
      answered, total: ids.length, disconnected,
      allAnswered: answered > 0 && waiting === 0,
    };
  }

  // Each role gets only what it should see.
  snapshotFor(role, playerId) {
    const r = this.room;
    const online = this.onlineIds();
    const roster = Object.values(r.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) =>
        role === "host"
          ? { id: p.id, name: p.name, online: online.has(p.id) }
          : { name: p.name, online: online.has(p.id) }
      );

    const snap = {
      type: "state", now: Date.now(), mode: r.mode, phase: r.phase, roster,
      questionNumber: Math.max(0, r.qIndex + 1), questionTotal: r.questions.length,
    };

    const inQ = r.current && ["question", "locked", "reveal"].includes(r.phase);
    if (inQ) {
      const q = r.questions[r.qIndex], c = r.current;
      snap.question = { text: q.text, options: q.options };
      snap.progress = this.progress(online);
      if (r.phase === "question") { snap.deadline = c.deadline; snap.duration = c.duration; }
      if (r.phase === "reveal") {
        const counts = [0, 0, 0, 0];
        for (const [pid, a] of Object.entries(c.answers)) {
          if (r.players[pid]) counts[a.choice]++;
        }
        snap.reveal = { correct: q.correct, counts };
      }
      if (role === "host") snap.hostCorrect = q.correct;
    }

    if (role === "host") {
      snap.autoLock = r.autoLock;
      if (r.phase === "lobby") snap.questions = r.questions;
    }
    if (r.phase === "leaderboard" || r.phase === "final") snap.leaderboard = this.leaderboard();

    if (role === "player" && playerId && r.players[playerId]) {
      const me = { score: r.players[playerId].score ?? 0, submitted: false, eligible: false };
      if (inQ) {
        const a = r.current.answers[playerId];
        me.eligible = r.current.eligible.includes(playerId);
        me.submitted = !!a;
        if (a) me.choice = a.choice;
        if (r.phase === "reveal") {
          me.result = (r.current.results && r.current.results[playerId]) || { correct: false, gained: 0 };
        }
      }
      snap.me = me;
    }
    return snap;
  }

  broadcast() {
    if (!this.room) return;
    this.lastSig = this.presenceSig();
    for (const ws of this.ctx.getWebSockets()) {
      const who = ws.deserializeAttachment();
      if (!who) continue; // not joined yet
      this.send(ws, this.snapshotFor(who.role, who.playerId));
    }
  }

  // ---------- game flow ----------

  async openQuestion() {
    const r = this.room;
    r.qIndex += 1;
    const q = r.questions[r.qIndex];
    const duration = this.duration(q);
    const now = Date.now();
    r.phase = "question";
    r.current = {
      startedAt: now, deadline: now + duration, duration,
      eligible: [...this.onlineIds()].filter((id) => r.players[id]),
      answers: {},
    };
    await this.save();
    this.broadcast();
  }

  async lockQuestion() {
    const r = this.room;
    if (!r || r.phase !== "question") return;
    r.phase = "locked";
    await this.save();
    this.broadcast();
  }

  async revealQuestion() {
    const r = this.room;
    if (!r || (r.phase !== "question" && r.phase !== "locked")) return;
    const q = r.questions[r.qIndex], c = r.current;
    c.results = {};
    for (const [pid, a] of Object.entries(c.answers)) {
      const p = r.players[pid];
      if (!p) continue;
      const right = a.choice === q.correct;
      let gained = 0;
      if (right) {
        gained = BASE_POINTS;
        if (r.mode === "solo") {
          const elapsed = Math.min(c.duration, Math.max(0, a.at - c.startedAt));
          gained += Math.round(SPEED_BONUS * (1 - elapsed / c.duration));
        }
      }
      p.score = (p.score ?? 0) + gained;
      c.results[pid] = { correct: right, gained };
    }
    r.phase = "reveal";
    await this.save();
    this.broadcast();
  }

  validQuestions(list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > 100) return null;
    const out = [];
    for (const q of list) {
      if (!q || typeof q.text !== "string" || !q.text.trim() || q.text.length > 300) return null;
      if (!Array.isArray(q.options) || q.options.length !== 4) return null;
      if (!q.options.every((o) => typeof o === "string" && o.trim() && o.length <= 120)) return null;
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) return null;
      const item = { text: q.text.trim(), options: q.options.map((o) => o.trim()), correct: q.correct };
      if (q.seconds) item.seconds = Number(q.seconds) || undefined;
      out.push(item);
    }
    return out;
  }

  // ---------- messages ----------

  async webSocketMessage(ws, raw) {
    if (!this.room) return;
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return this.error(ws, "Bad message");
    }

    if (msg.type === "join") {
      await this.handleJoin(ws, msg);
      return this.scheduleAlarm(); // starts the presence check ticking
    }

    const who = ws.deserializeAttachment();
    if (!who) return this.error(ws, "Join first");

    if (msg.type === "submit") return this.handleSubmit(ws, who, msg);

    if (typeof msg.type === "string" && msg.type.startsWith("host:")) {
      if (who.role !== "host") return this.error(ws, "Host only");
      return this.handleHost(ws, msg);
    }
  }

  async handleSubmit(ws, who, msg) {
    const r = this.room;
    if (who.role !== "player") return this.error(ws, "Only players can submit");
    if (r.phase !== "question") return this.error(ws, "No question is open");
    const c = r.current;
    if (Date.now() > c.deadline) return this.error(ws, "Time is up");
    if (!c.eligible.includes(who.playerId)) {
      return this.error(ws, "You joined after this question started");
    }
    if (c.answers[who.playerId]) return this.error(ws, "Already submitted");
    const choice = msg.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) {
      return this.error(ws, "Invalid choice");
    }
    c.answers[who.playerId] = { choice, at: Date.now() };
    await this.save();
    this.send(ws, { type: "submitted" });
    this.broadcast();
    if (r.autoLock && this.progress(this.onlineIds()).allAnswered) {
      await this.lockQuestion();
    }
  }

  async handleHost(ws, msg) {
    const r = this.room;

    if (msg.type === "host:kick") {
      const id = msg.playerId;
      if (!r.players[id]) return;
      delete r.players[id];
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

    if (msg.type === "host:setQuestions") {
      if (r.phase !== "lobby") return this.error(ws, "Questions can only change in the lobby");
      const list = this.validQuestions(msg.questions);
      if (!list) return this.error(ws, "Invalid question list");
      r.questions = list;
      await this.save();
      return this.broadcast();
    }

    if (msg.type === "host:autoLock") {
      r.autoLock = !!msg.on;
      await this.save();
      return this.broadcast();
    }

    if (msg.type === "host:start") {
      if (r.phase !== "lobby") return this.error(ws, "Game already started");
      if (Object.keys(r.players).length < 1) return this.error(ws, "Need at least one player");
      if (r.questions.length < 1) return this.error(ws, "No questions loaded");
      return this.openQuestion();
    }

    if (msg.type === "host:lock") {
      if (r.phase !== "question") return this.error(ws, "No question is open");
      return this.lockQuestion();
    }

    if (msg.type === "host:reveal") {
      if (r.phase !== "question" && r.phase !== "locked") {
        return this.error(ws, "Nothing to reveal");
      }
      return this.revealQuestion();
    }

    if (msg.type === "host:leaderboard") {
      if (r.phase !== "reveal") return this.error(ws, "Reveal the answer first");
      r.phase = "leaderboard";
      await this.save();
      return this.broadcast();
    }

    if (msg.type === "host:reset") {
      if (r.phase !== "final") return this.error(ws, "The game isn't finished yet");
      r.phase = "lobby";
      r.qIndex = -1;
      r.current = null;
      for (const p of Object.values(r.players)) p.score = 0;
      await this.save();
      return this.broadcast();
    }

    if (msg.type === "host:next") {
      if (r.phase !== "reveal" && r.phase !== "leaderboard") {
        return this.error(ws, "Finish the current question first");
      }
      if (r.qIndex + 1 < r.questions.length) return this.openQuestion();
      r.phase = "final";
      r.current = null;
      await this.save();
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
      if (msg.hostKey !== room.hostKey) return this.error(ws, "Invalid host key");
      ws.serializeAttachment({ role: "host" });
      this.send(ws, { type: "joined", role: "host", mode: room.mode });
      return this.send(ws, this.snapshotFor("host"));
    }

    if (msg.role === "player") {
      // Reconnect: phone slept or Wi-Fi blipped
      if (msg.playerId && room.players[msg.playerId]) {
        const p = room.players[msg.playerId];
        ws.serializeAttachment({ role: "player", playerId: p.id, at: Date.now() });
        this.send(ws, {
          type: "joined", role: "player", mode: room.mode,
          playerId: p.id, name: p.name,
        });
        return this.broadcast();
      }

      // New player or team
      const label = room.mode === "teams" ? "team name" : "name";
      const name = this.cleanName(msg.name);
      if (!name) return this.error(ws, "Enter a " + label);
      const taken = Object.values(room.players).some(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (taken) return this.error(ws, "That " + label + " is already taken");
      if (Object.keys(room.players).length >= MAX_PLAYERS) {
        return this.error(ws, "Room is full");
      }

      const id = crypto.randomUUID();
      room.players[id] = { id, name, joinedAt: Date.now(), score: 0 };
      await this.save();
      ws.serializeAttachment({ role: "player", playerId: id, at: Date.now() });
      this.send(ws, {
        type: "joined", role: "player", mode: room.mode, playerId: id, name,
      });
      return this.broadcast();
    }

    this.error(ws, "Unknown role");
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(1000, "closing"); } catch {}
    this.broadcast();
  }

  async webSocketError(ws, error) {
    this.broadcast();
  }
}