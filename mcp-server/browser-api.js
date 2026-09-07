import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";

export class BrowserAPI {
  ws = null;
  wsServer = null;
  wsServers = [];
  pending = new Map();

  async init() {
    const port = Number(process.env.EXTENSION_PORT || 8765);
    const hosts = process.env.CONTAINERIZED ? ["0.0.0.0"] : port === 0 ? ["127.0.0.1"] : ["127.0.0.1", "::1"];
    const onConnection = (connection, request) => {
      // Do not allow arbitrary websites to connect to the local control socket.
      const origin = request.headers.origin;
      if (origin && !origin.startsWith("moz-extension://")) {
        connection.close(1008, "Only the Firefox extension may connect");
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        connection.close(1008, "An extension is already connected");
        return;
      }
      this.ws = connection;
      console.error("mcp-zen: extension connected");
      connection.on("message", (bytes) => {
        let message;
        try { message = JSON.parse(bytes.toString()); }
        catch { connection.close(1008, "Invalid JSON"); return; }
        const pending = this.pending.get(message?.correlationId);
        if (!pending) return;
        if (message.error) {
          const error = Object.assign(new Error(message.error.message), { code: message.error.code });
          pending.finish(error);
        } else pending.finish(null, message.data);
      });
      connection.on("close", () => {
        if (this.ws !== connection) return;
        this.ws = null;
        this.failPending(new Error("Browser extension disconnected; reconnect and retry"));
      });
      connection.on("error", (error) => console.error("mcp-zen: extension socket error:", error.message));
    };
    for (const host of hosts) {
      const server = new WebSocketServer({ host, port, maxPayload: 32 * 1024 * 1024 });
      server.on("connection", onConnection);
      server.on("error", (error) => console.error("mcp-zen: WebSocket error:", error.message));
      await once(server, "listening");
      this.wsServers.push(server);
      this.wsServer ??= server;
      const printed = host === "::1" ? "[::1]" : host;
      console.error(`mcp-zen: WebSocket server listening on ${printed}:${server.address().port}`);
    }
  }

  request(cmd, args = {}, { signal, deadline = Date.now() + 120000 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (Date.now() >= deadline) return Promise.reject(new Error("Tool deadline exceeded"));
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to the mcp-zen browser extension. Load the extension in Zen."));
    }
    return new Promise((resolve, reject) => {
      const correlationId = randomUUID();
      const abort = () => finish(signal.reason || new Error("Tool cancelled"));
      const timer = setTimeout(() => finish(new Error("Tool deadline exceeded")), Math.min(deadline - Date.now(), 2147483647));
      const finish = (error, data) => {
        if (!this.pending.delete(correlationId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(data);
      };
      // Install the resolver BEFORE send: local/mock responses may be immediate.
      this.pending.set(correlationId, { finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.ws.send(JSON.stringify({ correlationId, cmd, args, deadline }), (error) => {
        if (error) finish(error);
      });
    });
  }

  failPending(error) {
    for (const entry of this.pending.values()) entry.finish(error);
  }

  close() {
    this.failPending(new Error("mcp-zen is shutting down"));
    for (const server of this.wsServers) {
      for (const client of server.clients) client.terminate();
      server.close();
    }
  }
}
