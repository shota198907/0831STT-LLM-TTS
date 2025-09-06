import http from 'http'
import crypto from 'crypto'
import { URL as NodeURL } from 'url'
import { WebSocketServer } from 'ws'

/** env/config */
const PORT = Number(process.env.PORT || 8080)
const WS_PATH = process.env.WS_PATH || '/ws'
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
const IDLE_SEC = Number(process.env.IDLE_SEC || 45)
const MAX_MSG_BYTES = Number(process.env.MAX_MSG_BYTES || 2 * 1024 * 1024)
const REQUIRE_TOKEN = String(process.env.REQUIRE_TOKEN || 'false').toLowerCase() === 'true'
const WS_TOKEN = process.env.WS_TOKEN || ''

const server = http.createServer((req, res) => {
  const url = new NodeURL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  if (p === '/healthz' || p === '/healthz/' || p === '/livez' || p === '/livez/') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    if (req.method === 'HEAD') { res.end(); return }
    res.end('ok'); return
  }
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end(`WebSocket endpoint is at ${WS_PATH}`)
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { url, headers } = req
  // path check
  if (!url || !url.startsWith(WS_PATH)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  // origin allowlist (exact match)
  if (ALLOWED_ORIGIN.length && headers.origin && !ALLOWED_ORIGIN.includes(String(headers.origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy(); return
  }
  // bearer token check (optional)
  if (REQUIRE_TOKEN) {
    const auth = headers['sec-websocket-protocol'] || headers['authorization']
    const token = Array.isArray(auth) ? auth[0] : String(auth || '')
    const matched = token === WS_TOKEN || token === `Bearer ${WS_TOKEN}`
    if (!matched) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy(); return
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws, req) => {
  const sessionId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`
  let frames = 0
  let bytes = 0
  let seq = 0
  let lastActivity = Date.now()

  // keepalive ping
  const iv = setInterval(() => { try { ws.ping() } catch {} }, 5000)

  const idleTimer = setInterval(() => {
    const idle = (Date.now() - lastActivity) / 1000
    if (idle >= IDLE_SEC) {
      try { ws.close(1001, 'idle_timeout') } catch {}
    }
  }, 1000)

  ws.on('close', (code, reason) => {
    clearInterval(iv); clearInterval(idleTimer)
    try {
      console.log(JSON.stringify({ evt: 'close', code, reason: reason?.toString(), session_id: sessionId, frames, bytes }))
    } catch {}
  })
  ws.on('error', () => {})

  ws.on('message', (data, isBinary) => {
    lastActivity = Date.now()
    frames += 1
    const size = isBinary ? (data?.byteLength || 0) : Buffer.byteLength(String(data || ''))
    bytes += size
    // per-message max size check
    if (size > MAX_MSG_BYTES) {
      try { ws.close(1009, 'too_large') } catch {}
      return
    }
    if (!isBinary) {
      const s = data.toString()
      if (s === 'ping') { ws.send('pong'); return }
    }
    // echo back with a simple seq header for debugging
    try { ws.send(data, { binary: isBinary }) } catch {}
    seq += 1
  })
})

// startup log for observability
console.log(JSON.stringify({ evt: 'READY', transport: 'websocket', grpc_planned: false, ws_path: WS_PATH }))

server.listen(PORT, () => {
  console.log(`WS gateway listening on :${PORT}`)
})
