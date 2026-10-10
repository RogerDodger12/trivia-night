import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: the object can sleep between messages
    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: "welcome",
        connected: this.ctx.getWebSockets().length,
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // Skeleton behavior: echo to everyone in the room
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(JSON.stringify({ type: "echo", data: String(message) }));
    }
  }

  async webSocketClose(ws, code, reason) {
    ws.close(code, reason);
  }
}