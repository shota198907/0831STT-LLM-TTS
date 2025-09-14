import "dotenv/config";
import http from "http";
import { WebSocketServer } from "ws";
import { parse as parseUrl } from "url";
import { randomUUID } from "crypto";
import fs from "fs";
import { openLiveSession } from "./live-bridge.mjs";

const {
  PORT = "8080",
  WS_ALLOWED_ORIGINS = "http://localhost:3000",
  GOOGLE_CLOUD_PROJECT = "",
  GOOGLE_CLOUD_LOCATION = "",
  LIVE_MODEL = "gemini-live-2.5-flash-preview-native-audio",
  LIVE_API_WS_URL = "", // 未設定時は echo 動作
  ENABLE_TEST_CLIENT = "false",
  GOOGLE_API_KEY = "",
  LIVE_READY_TIMEOUT_MS = "8000",
  REQUIRE_WS_TOKEN = "false",
  WS_TOKEN = "",
  LIVE_RESPONSE_MODALITIES = "TEXT",
  LIVE_ENABLE_INPUT_TRANSCRIPTION = "true",
  HTTP_LOG = "false",
  // PR#1 Hardened controls
  ALLOW_NO_ORIGIN = "false",
  ALLOW_QUERY_TOKEN = "false",
  WS_IDLE_TIMEOUT_SEC = "120",
  WS_MAX_PAYLOAD = "1048576", // 1 MiB
  WS_ENABLE_DEFLATE = "true",
} = process.env;

const allowedOrigins = new Set(
  WS_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
);

function maskSecrets(obj) {
  try {
    const SENSITIVE = /^(token|authorization|api[_-]?key)$/i;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (typeof v === "object" && v !== null) {
        out[k] = maskSecrets(v);
      } else if (SENSITIVE.test(k)) {
        out[k] = "***";
      } else {
        out[k] = v;
      }
    }
    return out;
  } catch { return obj; }
}

// 1行JSON構造化ログ（STDOUT）。PII/シークレットはマスク。
function logEvent(obj, level = "info") {
  try {
    const line = { ts: new Date().toISOString(), level, ...maskSecrets(obj) };
    if (level === "error") console.error(JSON.stringify(line));
    else console.log(JSON.stringify(line));
  } catch {}
}

const server = http.createServer((req, res) => {
  if (HTTP_LOG === "true") {
    try { console.log(`[HTTP] ${req.method} ${req.url}`); } catch {}
  }
  // Health endpoints (Cloud Run 用: 常時 200 OK)
  const path = (req.url || "").split("?")[0];
  if (path === "/livez" || path === "/healthz" || path === "/health" || path === "/readyz" || path === "/_ah/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Dev-only test client (ENABLE_TEST_CLIENT=true のときだけ配信)
  if (ENABLE_TEST_CLIENT === "true") {
    if (req.url === "/test") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      fs.createReadStream("testclient/index.html").pipe(res);
      return;
    }
    if (req.url === "/test.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      fs.createReadStream("testclient/app.js").pipe(res);
      return;
    }
  }

  // Fallback
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});


function chooseProtocol(protocols) {
  // Choose first of [token=..., bearer:...], else undefined
  if (!Array.isArray(protocols)) return undefined;
  for (const p of protocols) {
    const s = String(p || "").trim();
    if (s.startsWith("token=")) return s;
    if (s.toLowerCase().startsWith("bearer:")) return s; // note: includes opaque
  }
  return undefined;
}

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: WS_ENABLE_DEFLATE !== "false",
  maxPayload: Number(WS_MAX_PAYLOAD) || 1024 * 1024,
  handleProtocols: (protocols /*, request */) => chooseProtocol(protocols) || false,
});

wss.on("connection", (ws, request) => {
  const cid = randomUUID();
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.lastSeen = Date.now();

  /** クライアント1接続あたりの上流ブリッジ（必要時のみ接続） */
  let bridge = null;
  let appKeepalive = null;
  let sentReady = false;
  let acked = false;
  let upstreamReady = false;
  let readyTimer = null;
  let bytesIn = 0;
  let bytesOut = 0;

  function sendJson(obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  function startAppKeepalive() {
    if (appKeepalive) return;
    appKeepalive = setInterval(() => {
      sendJson({ type: "keepalive", ts: Date.now() });
    }, 15000);
  }

  function sendReadyOnce() {
    if (sentReady) return;
    sentReady = true;
    sendJson({ type: "status", state: "ready" });
  }

  ws.on("message", (data) => {
    ws.lastSeen = Date.now();
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "bad_json" }));
      return;
    }
    switch (msg.type) {
      case "ping":
        sendJson({ type: "pong", ts: Date.now() });
        logEvent({ corr_id: cid, event: "pong" });
        break;

      case "start":
        (async () => {
          // UIの初期無音タイムアウト回避
          sendReadyOnce();
          startAppKeepalive();
          if (LIVE_API_WS_URL) {
            try {
              bridge = await openLiveSession({
                wsUrl: LIVE_API_WS_URL,
                project: GOOGLE_CLOUD_PROJECT,
                location: GOOGLE_CLOUD_LOCATION,
                model: LIVE_MODEL,
                apiKey: GOOGLE_API_KEY,
                corrId: cid,
                responseModalities: LIVE_RESPONSE_MODALITIES.split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
                enableInputTranscription: LIVE_ENABLE_INPUT_TRANSCRIPTION !== "false",
                onEvent: (evt) => {
                  if (evt?.type === "server_audio" && typeof evt.chunk === "string") {
                    // bytesOutは非厳密（BASE64→PCM換算は約3/4）。
                    bytesOut += Math.floor((evt.chunk.length * 3) / 4);
                    sendJson(evt);
                    logEvent({ corr_id: cid, event: "server_audio", bytes_out: bytesOut });
                  } else if (evt?.type === "transcript") {
                    sendJson(evt);
                    logEvent({ corr_id: cid, event: "transcript", final: !!evt.final });
                  } else if (evt?.type === "status" && evt.state === "upstream_ready") {
                    upstreamReady = true;
                    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
                    sendJson(evt);
                    logEvent({ corr_id: cid, event: "upstream_ready" });
                    if (!acked) {
                      sendJson({ type: "ack", what: "start", upstream: "live", corr_id: cid });
                      logEvent({ corr_id: cid, event: "ack", upstream: "live" });
                      acked = true;
                    }
                  } else if (evt?.type === "error" && evt.error === "live_handshake_failed") {
                    if (!acked) {
                      sendJson({ type: "error", error: "live_connect_failed", detail: `http_status=${evt.http_status} ${evt.http_status_text || ""}`.trim() });
                      sendJson({ type: "ack", what: "start", upstream: "echo", corr_id: cid, note: "live_connect_failed" });
                      logEvent({ corr_id: cid, event: "ack", upstream: "echo", note: "live_connect_failed" });
                      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
                      acked = true;
                    }
                  } else if (evt?.type) {
                    // そのほかの情報系イベントは最小限で透過
                    sendJson(evt);
                  }
                },
                onClose: (code, reason, meta) => {
                  logEvent({ corr_id: cid, event: "upstream_close", code, reason });
                  if (!acked) {
                    // open前に切断 → 初回接続失敗とみなしフォールバック
                    sendJson({ type: "error", error: "live_connect_failed", detail: `close_code=${code} ${reason || ""}`.trim() });
                    sendJson({ type: "ack", what: "start", upstream: "echo", corr_id: cid, note: "live_connect_failed" });
                    logEvent({ corr_id: cid, event: "ack", upstream: "echo", note: "live_connect_failed" });
                    acked = true;
                  } else {
                    // 稼働後の切断は現状セッション終了
                    try { ws.close(code || 1011, reason || "upstream_closed"); } catch {}
                  }
                  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
                },
              });
              // ackは upstream_ready 到達時に送信。到達しない場合はタイムアウトでechoにフォールバック
              const to = Number(LIVE_READY_TIMEOUT_MS) || 8000;
              readyTimer = setTimeout(() => {
                if (!acked) {
                  sendJson({ type: "error", error: "live_connect_failed", detail: `ready_timeout=${to}` });
                  sendJson({ type: "ack", what: "start", upstream: "echo", corr_id: cid, note: "live_connect_failed" });
                  logEvent({ corr_id: cid, event: "ready_timeout", timeout_ms: to });
                  acked = true;
                  try { bridge?.close(); } catch {}
                }
              }, to);
            } catch (e) {
              // Live接続に失敗: エラーを通知しつつ echo にフォールバック
              sendJson({
                type: "error",
                error: "live_connect_failed",
                detail: String(e?.message || e)
              });
              sendJson({ type: "ack", what: "start", upstream: "echo", corr_id: cid, note: "live_connect_failed" });
              logEvent({ corr_id: cid, event: "ack", upstream: "echo", note: "live_connect_failed" });
              acked = true;
            }
          } else {
            sendJson({ type: "ack", what: "start", upstream: "echo", corr_id: cid });
            logEvent({ corr_id: cid, event: "ack", upstream: "echo" });
            acked = true;
          }
        })();
        break;

      case "client_audio":
        // 期待フォーマット: { format:"pcm16", rate:16000, chunk:"<BASE64>", duration_ms:~200 }
        if (typeof msg.chunk !== "string" || msg.format !== "pcm16" || Number(msg.rate) !== 16000) {
          sendJson({ type: "error", error: "bad_audio_format" });
          break;
        }
        try {
          const b64 = msg.chunk;
          // バイト数カウントのみ。実際にBufferへ復号は不要。
          bytesIn += Math.floor((b64.length * 3) / 4);
          if (bridge?.ready()) {
            bridge.sendAudio({ format: "pcm16", rate: 16000, chunk: b64, duration_ms: msg.duration_ms });
          } else {
            // echoモード: 何もしない（将来、簡易エコー実装可）
          }
          logEvent({ corr_id: cid, event: "client_audio", bytes_in: bytesIn });
        } catch {
          sendJson({ type: "error", error: "audio_send_failed" });
        }
        break;

      case "end_call":
        sendJson({ type: "bye" });
        try { bridge?.close(); } catch {}
        try { ws.close(1000, "done"); } catch {}
        break;

      default:
        // 未知typeはエラー応答（デバッグ用のエコーは廃止）
        sendJson({ type: "error", error: "unknown_type" });
    }
  });

  ws.on("error", (err) => {
    logEvent({ corr_id: cid, evt: "ws_error", error: err?.message || String(err) }, "error");
  });

  ws.on("close", () => {
    try { bridge?.close(); } catch {}
    if (appKeepalive) clearInterval(appKeepalive);
    logEvent({ corr_id: cid, evt: "ws_close" });
  });
});

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (!origin && ALLOW_NO_ORIGIN !== "true") {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (origin && !allowedOrigins.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const { pathname, query } = parseUrl(req.url || "/", true);
  if (pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  // 認証: サブプロトコル優先、次にヘッダ、最後に（許可時のみ）クエリ
  const sspRaw = String(req.headers["sec-websocket-protocol"] || "");
  const ssp = sspRaw.split(",").map(s => s.trim()).filter(Boolean);
  const tokenFromSSP = (() => {
    for (const p of ssp) {
      if (p.startsWith("token=")) return p.slice(6);
      if (p.toLowerCase().startsWith("bearer:")) return p.slice(7);
    }
    return "";
  })();
  const headerTokenRaw = req.headers["x-ws-token"]; // case-insensitive
  const headerToken = Array.isArray(headerTokenRaw) ? headerTokenRaw[0] : headerTokenRaw;
  const queryToken = ALLOW_QUERY_TOKEN === "true" && typeof query?.token === "string" ? query.token : undefined;
  const provided = tokenFromSSP || headerToken || queryToken || "";
  const expected = WS_TOKEN || "";
  if (REQUIRE_WS_TOKEN === "true" && (!expected || !provided || provided !== expected)) {
    logEvent({ evt: "auth_fail", remote: req.socket?.remoteAddress || "", origin: origin || "" });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // ここで wss がサブプロトコル選択を行う（handleProtocols）。
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
    const idle = Number(WS_IDLE_TIMEOUT_SEC) || 120;
    if (idle > 0 && Date.now() - (ws.lastSeen || 0) > idle * 1000) {
      try { ws.close(1001, "idle_timeout"); } catch {}
    }
  }
}, 15000);
wss.on("close", () => clearInterval(interval));

server.listen(Number(PORT), () => {
  console.log(`[HTTP] listening on :${PORT} (origins: ${[...allowedOrigins].join(", ")})`);
});

// Graceful shutdown (SIGTERM/SIGINT)
function shutdown() {
  try {
    logEvent({ evt: "shutdown_start" });
    server.close(() => {
      try { for (const ws of wss.clients) ws.close(1001, "gateway_shutdown"); } catch {}
      logEvent({ evt: "shutdown_complete" });
      process.exit(0);
    });
    setTimeout(() => {
      logEvent({ evt: "shutdown_forced" }, "error");
      process.exit(0);
    }, 5000).unref();
  } catch {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
