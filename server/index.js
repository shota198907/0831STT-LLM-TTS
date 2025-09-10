import "dotenv/config";
import http from "http";
import { WebSocketServer } from "ws";
import { parse as parseUrl } from "url";
import { randomUUID } from "crypto";

const {
  PORT = "8080",
  WS_ALLOWED_ORIGINS = "http://localhost:3000",
} = process.env;

const allowedOrigins = new Set(
  WS_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
);

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, request) => {
  const cid = randomUUID();
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "bad_json" }));
      return;
    }
    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        break;
      case "start":
        ws.send(JSON.stringify({ type: "ack", what: "start" }));
        break;
      case "end_call":
        ws.send(JSON.stringify({ type: "bye" }));
        try { ws.close(1000, "done"); } catch {}
        break;
      default:
        ws.send(JSON.stringify({ type: "echo", data: msg }));
    }
  });

  ws.on("error", (err) => {
    console.error(`[WS] error cid=${cid}`, err);
  });
});

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const { pathname } = parseUrl(req.url || "/");
  if (pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
wss.on("close", () => clearInterval(interval));

server.listen(Number(PORT), () => {
  console.log(`[HTTP] listening on :${PORT} (origins: ${[...allowedOrigins].join(", ")})`);
});
