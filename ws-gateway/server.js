import http from 'http'
import crypto from 'crypto'
import { URL as NodeURL } from 'url'
import { setTimeout as delay } from 'timers/promises'
import { WebSocketServer } from 'ws'

/** env/config */
const PORT = Number(process.env.PORT || 8080)
const WS_PATH = process.env.WS_PATH || '/ws'
const ORIGINS_A = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
const ORIGINS_B = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
const ALLOWED_ORIGIN = [...new Set([...ORIGINS_A, ...ORIGINS_B])]
const IDLE_SEC = Number(process.env.IDLE_SEC || 45)
const MAX_MSG_BYTES = Number(process.env.MAX_MSG_BYTES || 2 * 1024 * 1024)
const REQUIRE_TOKEN = String(process.env.REQUIRE_TOKEN || 'false').toLowerCase() === 'true'
const WS_TOKEN = process.env.WS_TOKEN || ''
const CONVERSATION_URL = process.env.CONVERSATION_URL || ''
const MAX_BYTES = Number(process.env.MAX_BYTES || 16 * 1024 * 1024)
const MAX_CONN_SECS = Number(process.env.MAX_CONN_SECS || 600)
const SILENCE_MS = Number(process.env.SILENCE_MS || 1200)
const EOU_GRACE_MS = Number(process.env.EOU_GRACE_MS || 300)

const server = http.createServer((req, res) => {
  const url = new NodeURL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  if (p === '/' || p === '/healthz' || p === '/healthz/' || p === '/livez' || p === '/livez/') {
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
  let openedAt = Date.now()
  let chunks = []
  let helloSeen = false
  let forwarded = false
  let silenceTimer = null

  function armSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
      if (!forwarded && chunks.length > 0) {
        try { console.log(JSON.stringify({ evt: 'auto_forward', reason: 'silence', session_id: sessionId, frames, bytes })) } catch {}
        forwardAndRespond().catch(() => {})
      }
    }, SILENCE_MS)
  }

  // keepalive ping
  const iv = setInterval(() => { try { ws.ping() } catch {} }, 5000)

  const idleTimer = setInterval(() => {
    const idle = (Date.now() - lastActivity) / 1000
    if (idle >= IDLE_SEC) {
      try { ws.close(1001, 'idle_timeout') } catch {}
    }
    const aliveSec = (Date.now() - openedAt) / 1000
    if (aliveSec >= MAX_CONN_SECS) {
      try { ws.close(1000, 'max_conn_secs') } catch {}
    }
  }, 1000)

  // Visible ACK on connect (helps client observers)
  try { ws.send(JSON.stringify({ type: 'ack', hello: true })) } catch {}

  ws.on('close', async (code, reason) => {
    clearInterval(iv); clearInterval(idleTimer)
    try {
      if (!forwarded && chunks.length > 0) {
        await forwardAndRespond()
      }
    } catch {}
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
    if (bytes > MAX_BYTES) { try { ws.close(1009, 'session_too_large') } catch {}; return }
    if (!isBinary) {
      const s = data.toString()
      if (s === 'ping') { ws.send('pong'); return }
      // try parse JSON control messages
      try {
        const obj = JSON.parse(s)
        if (obj && obj.type === 'hello' || obj && obj.type === 'start') {
          helloSeen = true
          ws.send(JSON.stringify({ type: 'ack', hello: true }))
          return
        }
        if (obj && obj.type === 'audio' && typeof obj.chunk === 'string') {
          const buf = Buffer.from(obj.chunk, 'base64')
          chunks.push(buf)
          armSilenceTimer()
          return
        }
        if (obj && obj.type === 'eos') {
          void forwardAndRespond()
          return
        }
        if (obj && obj.type === 'bye') {
          try { ws.close(1000, 'bye') } catch {}
          return
        }
      } catch {}
    }
    // binary frames => audio chunk
    if (isBinary) {
      try {
        const ab = data
        const buf = Buffer.from(ab)
        chunks.push(buf)
        armSilenceTimer()
      } catch {}
      seq += 1
    }
  })

  async function forwardAndRespond() {
    if (forwarded) return
    forwarded = true
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
    try { await delay(EOU_GRACE_MS) } catch {}
    const started = Date.now()
    const webm = Buffer.concat(chunks)
    chunks = []
    // log forwarding
    try { console.log(JSON.stringify({ evt: 'forward', forwarded_to: '/api/conversation', session_id: sessionId, frames, bytes })) } catch {}
    if (!CONVERSATION_URL) {
      ws.send(JSON.stringify({ type: 'result', result: { type: 'error', data: { status: 500, message: 'CONVERSATION_URL not set' } } }))
      try { ws.close(1011, 'config') } catch {}
      return
    }
    // Build JSON request body (matches existing Next API: { audioBase64, mimeType, messages })
    const audioBase64 = webm.toString('base64')
    const body = JSON.stringify({ audioBase64, mimeType: 'audio/webm;codecs=opus', messages: [] })
    const ct = 'application/json'
    try { console.log(JSON.stringify({ evt: 'conv_req_probe', ct, len: (body && body.length) || null })) } catch {}
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const res = await fetch(CONVERSATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': ct, 'X-Correlation-ID': sessionId },
        body,
        signal: ctrl.signal,
      })
      try { console.log(JSON.stringify({ evt: 'conv_res_probe', status: res.status, respCt: res.headers.get('content-type') || null })) } catch {}
      clearTimeout(to)
      const json = await res.json().catch(() => null)
      // debug: show keys of conversation response
      try {
        console.log(JSON.stringify({
          evt: 'conv_json_keys',
          session_id: sessionId,
          keys: (json && typeof json === 'object') ? Object.keys(json) : []
        }))
      } catch {}
      if (!res.ok || !json || json.ok === false) {
        const status = res.status
        const message = (json && (json.message || json.error)) || res.statusText
        ws.send(JSON.stringify({ type: 'result', result: { type: 'error', data: { status, message } } }))
        return
      }
      const elapsed = Date.now() - started
      try { console.log(JSON.stringify({ evt: 'reply', session_id: sessionId, elapsed_ms: elapsed })) } catch {}
      // Normalize response fields
      const txt = (json?.text ?? json?.ai_text ?? json?.aiResponse ?? json?.result?.text ?? null)
      const b64 = (json?.audioBase64 ?? json?.audio_base64 ?? json?.result?.audioBase64 ?? null)
      const url = (json?.tts_url ?? json?.audioUrl ?? json?.url ?? json?.result?.tts_url ?? null)
      const mime = (json?.mimeType ?? json?.mimetype ?? 'audio/mpeg')
      // debug: planned ws tx kinds
      try {
        console.log(JSON.stringify({
          evt: 'ws_tx_plan',
          session_id: sessionId,
          kinds: { text: !!txt, b64: !!b64, url: !!url },
          mime
        }))
      } catch {}

      // A) Generic result envelope
      if (txt)  ws.send(JSON.stringify({ type: 'result', result: { type: 'text',  data: txt } }))
      if (b64)  ws.send(JSON.stringify({ type: 'result', result: { type: 'audio', data: { base64: b64, mime } } }))
      else if (url) ws.send(JSON.stringify({ type: 'result', result: { type: 'audio', data: { url,    mime } } }))

      // B) Compatibility messages for existing UI handlers
      if (txt)  ws.send(JSON.stringify({ type: 'ai_sentence', text: txt }))
      if (b64)  ws.send(JSON.stringify({ type: 'tts_chunk',  base64: b64, mime }))
      else if (url) ws.send(JSON.stringify({ type: 'tts_url', url,   mime }))

      // TX observation
      try { console.log(JSON.stringify({ evt: 'ws_tx', kinds: { text: !!txt, b64: !!b64, url: !!url }, session_id: sessionId })) } catch {}

      if (!txt && !b64 && !url) {
        ws.send(JSON.stringify({ type: 'result', result: { type: 'error', data: { status: res.status, message: 'no_mappable_fields', keys: Object.keys(json || {}) } } }))
      }
      try { ws.send(JSON.stringify({ type: 'close', code: 1000, reason: 'ok' })) } catch {}
    } catch (e) {
      ws.send(JSON.stringify({ type: 'result', result: { type: 'error', data: { status: 500, message: String(e) } } }))
    } finally {
      clearTimeout(to)
    }
  }
})

// startup log for observability
console.log(JSON.stringify({ evt: 'READY', transport: 'websocket', grpc_planned: false, ws_path: WS_PATH }))

server.listen(PORT, '0.0.0.0', () => {
  try { console.log(JSON.stringify({ evt: 'startup', port: PORT })) } catch {}
  console.log(`WS gateway listening on :${PORT}`)
})
