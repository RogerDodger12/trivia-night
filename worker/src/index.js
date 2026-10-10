export { GameRoom } from "./GameRoom.js";

// Wide open for development. We lock this to your Pages domain later.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// No 0/O or 1/I so codes are easy to read aloud
const LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
function makeCode() {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // Host creates a game: body is { "mode": "solo" } or { "mode": "teams" }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch {}
      const mode = body.mode;
      if (mode !== "solo" && mode !== "teams") {
        return Response.json(
          { error: "mode must be solo or teams" },
          { status: 400, headers: CORS }
        );
      }
      // Retry in the unlikely event a code is already in use
      for (let i = 0; i < 10; i++) {
        const code = makeCode();
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
        const hostKey = await stub.init(mode);
        if (hostKey) {
          return Response.json({ code, mode, hostKey }, { headers: CORS });
        }
      }
      return Response.json(
        { error: "Could not create a room, try again" },
        { status: 503, headers: CORS }
      );
    }

    // WebSocket connection to a specific room
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z]{4})\/ws$/);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const id = env.GAME_ROOM.idFromName(match[1]);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    return new Response("Trivia Night API is running", { headers: CORS });
  },
};