import http from 'http'
import crypto from 'crypto'
import { URL as NodeURL } from 'url'
import { setTimeout as delay } from 'timers/promises'
import { SpeechClient } from '@google-cloud/speech'
import { WebSocketServer } from 'ws'

/** env/config */
const PORT = Number(process.env.PORT || 8080)
const WS_PATH = process.env.WS_PATH || '/ws'
// Normalize origins: trim and remove internal whitespace/newlines that may leak from env UI pastes
const ORIGINS_A = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\s+/g, ''))
  .filter(Boolean)
const ORIGINS_B = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim().replace(/\s+/g, ''))
  .filter(Boolean)
const ALLOWED_ORIGIN = [...new Set([...ORIGINS_A, ...ORIGINS_B])]
const IDLE_SEC = Number(process.env.IDLE_SEC || 45)
const MAX_MSG_BYTES = Number(process.env.MAX_MSG_BYTES || 2 * 1024 * 1024)
const REQUIRE_TOKEN = String(process.env.REQUIRE_TOKEN || 'false').toLowerCase() === 'true'
const WS_TOKEN = process.env.WS_TOKEN || ''
// Normalize conversation URL to avoid newlines/whitespace breaking URL parsing
const CONVERSATION_URL = (process.env.CONVERSATION_URL || '').replace(/\s+/g, '')
const MAX_BYTES = Number(process.env.MAX_BYTES || 16 * 1024 * 1024)
const MAX_CONN_SECS = Number(process.env.MAX_CONN_SECS || 600)
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim()
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-1.5-flash').trim()
// Shorter defaults to improve perceived latency; can be overridden by env
const SILENCE_MS = Number(process.env.SILENCE_MS || 250)
const EOU_GRACE_MS = Number(process.env.EOU_GRACE_MS || 75)

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
const speechClient = new SpeechClient()

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
  let sttStream = null
  let sttActive = false
  let sttPlanned = false
  let sttLang = process.env.STT_LANG || 'ja-JP'
  let sttEncoding = 'WEBM_OPUS'
  let sttSampleRate = 48000
  let sttLastInterim = ''
  let sttLastFinal = ''
  let llmStarted = false
  let llmDone = false

  function armSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
      if (!forwarded && chunks.length > 0) {
        const text = (sttLastFinal && sttLastFinal.trim()) ? sttLastFinal : (sttLastInterim && sttLastInterim.trim()) ? sttLastInterim : ''
        if (!llmStarted && text) {
          llmStarted = true
          try { console.log(JSON.stringify({ evt: 'auto_llm', reason: 'silence', session_id: sessionId, frames, bytes })) } catch {}
          runLLMAndTTS(text).catch(() => {})
          return
        }
        // Avoid forwarding small/silent buffers that cause REST no_speech; keep the session open for more audio
        try { console.log(JSON.stringify({ evt: 'silence_hold', session_id: sessionId, frames, bytes, llmStarted })) } catch {}
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
      if (!llmStarted && !llmDone) {
        const text = (sttLastFinal && sttLastFinal.trim()) ? sttLastFinal : (sttLastInterim && sttLastInterim.trim()) ? sttLastInterim : ''
        if (text) { await runLLMAndTTS(text) }
        else if (!forwarded && chunks.length > 0) { await forwardAndRespond() }
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
        if (obj && (obj.type === 'hello' || obj.type === 'start')) {
          helloSeen = true
          ws.send(JSON.stringify({ type: 'ack', hello: true }))
          // Optional STT params
          if (obj.lang) sttLang = String(obj.lang)
          if (obj.sampleRate) sttSampleRate = Number(obj.sampleRate)
          if (obj.codec) {
            const c = String(obj.codec).toLowerCase()
            if (c.includes('opus') && c.includes('ogg')) sttEncoding = 'OGG_OPUS'
            else if (c.includes('opus')) sttEncoding = 'WEBM_OPUS'
          }
          sttPlanned = true // defer actual STT start until first audio chunk to allow container sniffing
          return
        }
        if (obj && obj.type === 'audio' && typeof obj.chunk === 'string') {
          const buf = Buffer.from(obj.chunk, 'base64')
          chunks.push(buf)
          armSilenceTimer()
          if (sttActive && sttStream) {
            try { sttStream.write({ audioContent: buf }) } catch {}
          }
          return
        }
        if (obj && obj.type === 'eos') {
          if (sttStream) { try { sttStream.end() } catch {} }
          if (!llmStarted) {
            const text = (sttLastFinal && sttLastFinal.trim()) ? sttLastFinal : (sttLastInterim && sttLastInterim.trim()) ? sttLastInterim : ''
            if (text) { llmStarted = true; void runLLMAndTTS(text); return }
          }
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
        // Lazy-start STT on first chunk with container sniff
        if (!sttActive) {
          try {
            const enc = sniffEncoding(buf)
            if (enc) sttEncoding = enc
          } catch {}
          if (sttPlanned) startStt()
        }
        chunks.push(buf)
        armSilenceTimer()
        if (sttActive && sttStream) {
          try { sttStream.write({ audioContent: buf }) } catch {}
        }
      } catch {}
      seq += 1
    }
  })

  function sniffEncoding(buf) {
    try {
      if (!buf || buf.length < 12) return null
      // OGG begins with "OggS"
      if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'OGG_OPUS'
      // WebM (Matroska) starts with EBML header 0x1A45DFA3
      if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'WEBM_OPUS'
      // MP4 often starts with ftyp within first 12 bytes
      const s = buf.toString('ascii', 4, 8)
      if (s === 'ftyp') return 'ENCODING_UNSPECIFIED'
    } catch {}
    return null
  }

  function startStt() {
    if (sttActive) return
    try {
      const request = {
        config: {
          encoding: sttEncoding,
          languageCode: sttLang,
          sampleRateHertz: sttSampleRate,
          enableAutomaticPunctuation: true,
          useEnhanced: true,
        },
        interimResults: true,
        singleUtterance: false,
      }
      sttStream = speechClient
        .streamingRecognize(request)
        .on('error', (e) => {
          try { ws.send(JSON.stringify({ type: 'stt_error', error: String(e) })) } catch {}
        })
        .on('data', (data) => {
          const results = data.results || []
          for (const r of results) {
            const alt = r.alternatives && r.alternatives[0] ? r.alternatives[0].transcript : ''
            if (!alt) continue
            try { ws.send(JSON.stringify({ type: r.isFinal ? 'stt_final' : 'stt_interim', text: alt })) } catch {}
            if (r.isFinal) {
              sttLastFinal = alt
              // Trigger LLM/TTS once per turn as soon as we have a final result
              if (!llmStarted && alt.trim()) {
                llmStarted = true
                runLLMAndTTS(String(alt)).catch(() => {})
              }
            } else {
              sttLastInterim = alt
              // Early trigger on strong interim (sentence end or length threshold)
              if (!llmStarted && (/[。．\.？！!?]\s*$/.test(alt) || alt.length >= 30)) {
                llmStarted = true
                runLLMAndTTS(String(alt)).catch(() => {})
              }
            }
          }
        })
      sttActive = true
    } catch {}
  }

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

  function buildTtsUrl() {
    // Prefer explicit TTS_URL; else derive from CONVERSATION_URL host
    const fromEnv = (process.env.TTS_URL || '').trim()
    if (fromEnv) return fromEnv
    try {
      const u = new NodeURL(CONVERSATION_URL)
      return new NodeURL('/api/tts', `${u.protocol}//${u.host}`).toString()
    } catch {
      return ''
    }
  }

  async function runLLMAndTTS(userText) {
    if (!GEMINI_API_KEY) {
      try { ws.send(JSON.stringify({ type: 'result', result: { type: 'error', data: { status: 500, message: 'GEMINI_API_KEY not set' } } })) } catch {}
      return
    }
    const sys = 'あなたは簡潔で丁寧な電話オペレーターです。最初の文を早めに出してください。'
    const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}`
    const genBody = {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [ { role: 'user', parts: [{ text: String(userText || '') }] } ],
      generationConfig: { temperature: 0.6, topP: 0.9 },
    }
    const ttsUrl = buildTtsUrl()
    let sentenceBuf = ''
    let inflight = 0
    let seqLocal = 0
    const MAX_INFLIGHT = 2

    const flushSentence = async (sentence) => {
      const s = String(sentence || '').trim(); if (!s) return
      try { ws.send(JSON.stringify({ type: 'ai_sentence', text: s })) } catch {}
      while (inflight >= MAX_INFLIGHT) await delay(10)
      inflight++
      const mySeq = seqLocal++
      ;(async () => {
        try {
          const tRes = await fetch(ttsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: s }) })
          if (!tRes.ok) throw new Error(`TTS failed: ${tRes.status}`)
          const { mime, audioBase64 } = await tRes.json()
          try { ws.send(JSON.stringify({ type: 'tts_chunk', seq: mySeq, eos: false, mime })) } catch {}
          const bin = Buffer.from(String(audioBase64 || ''), 'base64')
          try { ws.send(bin) } catch {}
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'tts_chunk', seq: mySeq, eos: false, error: String(e) })) } catch {}
        } finally { inflight-- }
      })()
    }

    try {
      const llmRes = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(genBody) })
      if (llmRes.ok && llmRes.body) {
        const reader = llmRes.body.getReader()
        const decoder = new TextDecoder()
        let carry = ''
        let done = false
        while (!done) {
          const { value, done: rdDone } = await reader.read()
          if (rdDone) break
          const chunk = decoder.decode(value, { stream: true })
          carry += chunk
          const lines = carry.split('\n')
          carry = lines.pop() || ''
          for (let line of lines) {
            line = line.trim(); if (!line) continue
            let payload = line; if (line.startsWith('data:')) payload = line.slice(5).trim()
            if (payload === '[DONE]') { done = true; break }
            try {
              const obj = JSON.parse(payload)
              const cands = obj.candidates || []
              if (cands.length) {
                const parts = (cands[0].content?.parts ?? [])
                let delta = ''
                for (const p of parts) if (typeof p.text === 'string') delta += p.text
                if (delta) {
                  try { ws.send(JSON.stringify({ type: 'ai_text_delta', text: delta })) } catch {}
                  sentenceBuf += delta
                  if (/[。．\.？！!?]\s*$/.test(sentenceBuf) || sentenceBuf.length >= 80) {
                    await flushSentence(sentenceBuf)
                    sentenceBuf = ''
                  }
                }
              }
            } catch {}
          }
        }
        if (sentenceBuf.trim()) await flushSentence(sentenceBuf)
        while (inflight > 0) await delay(10)
        llmDone = true
        try { ws.send(JSON.stringify({ type: 'ai_done' })) } catch {}
      } else {
        // Fallback single-shot generate
        const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
        const genRes = await fetch(genUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(genBody) })
        if (genRes.ok) {
          const j = await genRes.json()
          const cands = j.candidates || []
          const parts = (cands[0]?.content?.parts ?? [])
          const full = parts.map((p) => p.text || '').join('')
          const text = full || '(無応答)'
          try { ws.send(JSON.stringify({ type: 'ai_sentence', text })) } catch {}
          const tRes = await fetch(buildTtsUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
          if (tRes.ok) {
            const { mime, audioBase64 } = await tRes.json()
            try { ws.send(JSON.stringify({ type: 'tts_chunk', seq: 0, eos: true, mime })) } catch {}
            const bin = Buffer.from(String(audioBase64 || ''), 'base64')
            try { ws.send(bin) } catch {}
          }
          try { ws.send(JSON.stringify({ type: 'ai_done' })) } catch {}
        } else {
          try { ws.send(JSON.stringify({ type: 'ai_done', error: 'llm_error' })) } catch {}
        }
      }
    } catch (e) {
      try { ws.send(JSON.stringify({ type: 'ai_done', error: String(e) })) } catch {}
    }
  }
})

// startup log for observability
console.log(JSON.stringify({ evt: 'READY', transport: 'websocket', grpc_planned: false, ws_path: WS_PATH }))

server.listen(PORT, '0.0.0.0', () => {
  try { console.log(JSON.stringify({ evt: 'startup', port: PORT })) } catch {}
  console.log(`WS gateway listening on :${PORT}`)
})
