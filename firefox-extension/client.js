export class WebsocketClient {
  constructor(port, handler) {
    this.port = port;
    this.handler = handler;
    this.socket = null;
    this.timer = null;
    this.stopped = false;
  }

  connect() {
    if (this.stopped) return;
    const pending = new Map();
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.socket = socket;
    const connectTimer = setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, 5000);
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      console.log(`mcp-zen: connected on port ${this.port}`);
    });
    socket.addEventListener("close", () => {
      clearTimeout(connectTimer);
      for (const req of pending.values()) this.handler.cancel(req).catch(() => {});
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 2000);
    });
    socket.addEventListener("error", () => {});
    socket.addEventListener("message", async (event) => {
      let req;
      try { req = JSON.parse(event.data); }
      catch { socket.close(1008, "Invalid JSON"); return; }
      if (!req || typeof req.correlationId !== "string") return;
      if (req.cancel) {
        const original = pending.get(req.correlationId);
        if (original) this.handler.cancel(original).catch(() => {});
        return;
      }
      pending.set(req.correlationId, req);
      let response;
      try { response = { correlationId: req.correlationId, data: await this.handler.execute(req) }; }
      catch (error) {
        response = { correlationId: req.correlationId, error: { code: error.code || "BROWSER_ERROR", message: String(error.message || error) } };
      }
      pending.delete(req.correlationId);
      this.handler.cancelled?.delete(req.correlationId);
      // Reply only on the socket that received the request, never a replacement connection.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
    });
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }
}
