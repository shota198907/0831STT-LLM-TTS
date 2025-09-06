export const runtime = 'nodejs'

function okUpgrade(handler: (ws: WebSocket, req: Request) => void, request: Request): Response {
  // @ts-ignore - WebSocketPair is available in Next runtime
  const { 0: client, 1: server } = new WebSocketPair()
  const ws = server as unknown as WebSocket
  // @ts-ignore
  ws.accept?.()
  handler(ws, request)
  // @ts-ignore
  return new Response(null, { status: 101, webSocket: client }) as any
}

export async function GET(request: Request) {
  const up = request.headers.get('upgrade')?.toLowerCase()
  if (up !== 'websocket') {
    return new Response('Expected websocket', { status: 426 })
  }
  return okUpgrade((ws, req) => {
    let started = false
    let lang = 'ja-JP'
    let codec = 'opus'
    let stt: any = null
    let startedLLM = false
    let lastInterim = ''
    let closed = false
    let idleTimer: any = null
    let preStartBytes = 0
    const MAX_PRESTART_BYTES = 2 * 1024 * 1024 // 2MB safeguard before start

    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { try { ws.close(1000, 'idle_timeout') } catch {} }, 45000)
    }

    // start idle timer on open
    // @ts-ignore
    ;(ws as any).onopen = () => { touch() }

    ws.onmessage = async (ev) => {
      touch()
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          if (msg?.type === 'start') {
            started = true
            lang = msg.lang || 'ja-JP'
            codec = msg.codec || 'opus'
            const { startStreamingRecognizer } = await import('@/lib/server/stt-stream')
            stt = startStreamingRecognizer({ lang, encoding: codec === 'opus' ? 'WEBM_OPUS' : 'ENCODING_UNSPECIFIED' })
            stt.onInterim((t: string) => { lastInterim = t; try { ws.send(JSON.stringify({ type: 'stt_interim', text: t })) } catch {} })
            stt.onFinal(async (t: string) => { if (startedLLM || closed) return; startedLLM = true; await runLLMAndTTS(ws, req, t) })
            stt.onError(async (_e: Error) => {
              if (!startedLLM && !closed) {
                if (lastInterim) { startedLLM = true; await runLLMAndTTS(ws, req, lastInterim) }
                else { try { ws.send(JSON.stringify({ type: 'ai_done', error: 'stt_error' })) } catch {} }
              }
            })
            return
          }
          if (msg?.type === 'end') {
            try { stt?.end() } catch {}
            if (!startedLLM) {
              if (lastInterim.trim()) { startedLLM = true; await runLLMAndTTS(ws, req, lastInterim) }
              else { try { ws.send(JSON.stringify({ type: 'ai_done' })) } catch {} }
            }
            return
          }
        } catch {}
      } else if (ev.data instanceof ArrayBuffer) {
        if (started && stt) stt.write(Buffer.from(ev.data))
        else {
          preStartBytes += (ev.data as ArrayBuffer).byteLength
          if (preStartBytes > MAX_PRESTART_BYTES) { try { ws.close(1009, 'too_much_unstarted_data') } catch {} }
        }
      } else if (ev.data instanceof Blob) {
        if (started && stt) { const ab = await (ev.data as Blob).arrayBuffer(); stt.write(Buffer.from(ab)) }
        else {
          preStartBytes += (ev.data as Blob).size
          if (preStartBytes > MAX_PRESTART_BYTES) { try { ws.close(1009, 'too_much_unstarted_data') } catch {} }
        }
      }
    }

    ws.onclose = () => { closed = true; if (idleTimer) clearTimeout(idleTimer); try { stt?.end() } catch {} }

    // Ensure idle timer is running even if client sends nothing after connect
    try { touch() } catch {}
  }, request)
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, b) => a + b.byteLength, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.byteLength }
  return out
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  // Use Node-safe decode (Buffer) to avoid relying on atob
  const buf = Buffer.from(b64, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

async function runLLMAndTTS(ws: WebSocket, req: Request, userText: string) {
  const geminiKey = process.env.GEMINI_API_KEY || ''
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash'
  const sys = 'あなたは簡潔で丁寧な電話オペレーターです。最初の文を早めに出してください。'
  const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${geminiKey}`
  const llmRes = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    systemInstruction: { parts: [{ text: sys }] },
    contents: [ { role: 'user', parts: [{ text: userText }] } ],
    generationConfig: { temperature: 0.6, topP: 0.9 },
  }) })
  const ttsUrl = new URL('/api/tts', req.url).toString()
  let sentenceBuf = ''
  let inflight = 0
  let seq = 0
  const MAX_INFLIGHT = 2

  const flushSentence = async (sentence: string) => {
    const s = sentence.trim(); if (!s) return
    try { ws.send(JSON.stringify({ type: 'ai_sentence', text: s })) } catch {}
    while (inflight >= MAX_INFLIGHT) await new Promise(r => setTimeout(r, 10))
    inflight++
    const mySeq = seq++
    ;(async () => {
      try {
        const ttsRes = await fetch(ttsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: s }) })
        if (!ttsRes.ok) throw new Error('TTS failed')
        const { mime, audioBase64 } = await ttsRes.json()
        const bin = base64ToArrayBuffer(audioBase64)
        ws.send(JSON.stringify({ type: 'tts_chunk', seq: mySeq, eos: false, mime }))
        ws.send(bin)
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'tts_chunk', seq: mySeq, eos: false, error: String(e) })) } catch {}
      } finally { inflight-- }
    })()
  }

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
            const parts = (cands[0].content?.parts ?? []) as Array<{ text?: string }>
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
    while (inflight > 0) await new Promise(r => setTimeout(r, 10))
    try { ws.send(JSON.stringify({ type: 'ai_done' })) } catch {}
  } else {
    const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`
    const genRes = await fetch(genUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [ { role: 'user', parts: [{ text: userText }] } ],
      generationConfig: { temperature: 0.6, topP: 0.9 },
    }) })
    if (genRes.ok) {
      const j = await genRes.json()
      const cands = j.candidates || []
      const parts = (cands[0]?.content?.parts ?? []) as Array<{ text?: string }>
      const full = parts.map((p) => p.text || '').join('')
      const text = full || '(無応答)'
      try { ws.send(JSON.stringify({ type: 'ai_sentence', text })) } catch {}
      const ttsRes = await fetch(ttsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      if (ttsRes.ok) {
        const { mime, audioBase64 } = await ttsRes.json()
        const bin = base64ToArrayBuffer(audioBase64)
        ws.send(JSON.stringify({ type: 'tts_chunk', seq: 0, eos: true, mime }))
        ws.send(bin)
      }
      try { ws.send(JSON.stringify({ type: 'ai_done' })) } catch {}
    } else {
      try { ws.send(JSON.stringify({ type: 'ai_done', error: 'llm_error' })) } catch {}
    }
  }
}
