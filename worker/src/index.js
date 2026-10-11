export { GameRoom } from "./GameRoom.js";

// Websites allowed to use this Worker. Add more here if you ever host the pages elsewhere.
const ALLOWED_ORIGINS = ["https://rogerdodger12.github.io"];

function isPrivateHost(h) {
  return h === "localhost" || h === "127.0.0.1" ||
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

// Local testing: when this Worker itself runs on your PC or LAN (wrangler dev),
// pages served from a local address are allowed too. The live Worker never allows them.
function originAllowed(origin, url) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const o = new URL(origin);
    return isPrivateHost(url.hostname) && isPrivateHost(o.hostname);
  } catch {
    return false; // includes the "null" origin from file:// pages
  }
}

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
    const origin = request.headers.get("Origin");
    const ok = originAllowed(origin, url);
    const cors = ok
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin",
        }
      : { "Vary": "Origin" };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: ok ? 204 : 403, headers: cors });
    }

    // Host creates a game: body is { "mode": "solo" } or { "mode": "teams" }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      if (!ok) {
        return Response.json({ error: "Origin not allowed" }, { status: 403, headers: cors });
      }
      let body = {};
      try { body = await request.json(); } catch {}
      const mode = body.mode;
      if (mode !== "solo" && mode !== "teams") {
        return Response.json(
          { error: "mode must be solo or teams" },
          { status: 400, headers: cors }
        );
      }
      // Retry in the unlikely event a code is already in use
      for (let i = 0; i < 10; i++) {
        const code = makeCode();
        const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
        const hostKey = await stub.init(mode);
        if (hostKey) {
          return Response.json({ code, mode, hostKey }, { headers: cors });
        }
      }
      return Response.json(
        { error: "Could not create a room, try again" },
        { status: 503, headers: cors }
      );
    }

    // WebSocket connection to a specific room
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z]{4})\/ws$/);
    if (match) {
      if (!ok) return new Response("Origin not allowed", { status: 403 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const id = env.GAME_ROOM.idFromName(match[1]);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    return new Response("Trivia Night API is running", { headers: cors });
  },
};