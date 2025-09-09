"use client"

import { useEffect } from "react"
import type { LogLevel } from "@/lib/debug"

type Props = {
  enabled: boolean
  audioContext: AudioContext | null
  onFirstPlayStart: () => void
  onAllDrained: () => void
  addMessage: (type: "user" | "ai", content: string) => void
  clearAllTimeouts: () => void
  log: (message: string, data?: any, level?: LogLevel) => void
  wsClientRef: React.MutableRefObject<any>
  audioQueueRef: React.MutableRefObject<any>
  firstChunkLoggedRef: React.MutableRefObject<boolean>
  setAiSpeaking: () => void
  onWsStateChange?: (s: 'connecting' | 'open' | 'closed' | 'error') => void
}

export default function StreamingBoot({
  enabled,
  audioContext,
  onFirstPlayStart,
  onAllDrained,
  addMessage,
  clearAllTimeouts,
  log,
  wsClientRef,
  audioQueueRef,
  firstChunkLoggedRef,
  setAiSpeaking,
  onWsStateChange,
}: Props) {
  useEffect(() => {
    if (!enabled || !audioContext) return
    let cancelled = false
    ;(async () => {
      const [{ StreamingClient }, { AudioQueue }] = await Promise.all([
        import("@/lib/streaming-client"),
        import("@/lib/audio-queue"),
      ])
      if (cancelled) return

      if (!audioQueueRef.current) {
        audioQueueRef.current = new AudioQueue(audioContext, {
          onFirstPlayStart,
          onAllDrained,
        })
      }

      if (!wsClientRef.current) {
        const UrlCtor: any = (typeof window !== 'undefined' && (window as any).URL) ? (window as any).URL : (globalThis as any).URL
        const params = new UrlCtor(location.href).searchParams
        const q = params.get('ws')
        const qToken = params.get('token')
        const envOrigin = process.env.NEXT_PUBLIC_WS_ORIGIN ? String(process.env.NEXT_PUBLIC_WS_ORIGIN) : ''
        const envToken = process.env.NEXT_PUBLIC_WS_TOKEN ? String(process.env.NEXT_PUBLIC_WS_TOKEN) : ''
        // URL selection: query param wins (as-is, full URL expected). Env appends /ws if missing.
        let wsUrl: string
        if (q) {
          wsUrl = q
        } else if (envOrigin) {
          const trimmed = envOrigin.replace(/\/$/, '')
          wsUrl = /\/ws(\/?$)/.test(trimmed) ? trimmed : `${trimmed}/ws`
        } else {
          // Fallback to internal Next.js WebSocket route (which will return 426 and trigger REST fallback)
          wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws/conversation`
        }
        const token = qToken || envToken || ''
        const subprotocol = token ? [token] : undefined
        const client = new StreamingClient(wsUrl, {
          onOpen: () => { log("WS open"); onWsStateChange?.('open') },
          onClose: (e: any) => { 
            log("WS close", e); 
            onWsStateChange?.('closed');
            // If WebSocket fails, the app should fall back to REST API automatically
            if (e?.code === 426) {
              log("WebSocket not supported, falling back to REST API");
            }
          },
          onError: (e: any) => { 
            log("WS error", e); 
            onWsStateChange?.('error');
            // On WebSocket error, the app should fall back to REST API
            log("WebSocket connection failed, falling back to REST API");
          },
          onState: (s) => { onWsStateChange?.(s) },
          onText: (m: any) => {
            try {
              if (m.type === "ai_sentence") {
                addMessage("ai", m.text)
                setAiSpeaking()
                clearAllTimeouts()
                return
              }
              if (m.type === 'result' && m.result) {
                if (m.result.type === 'text' && typeof m.result.data === 'string') {
                  addMessage('ai', m.result.data)
                  setAiSpeaking()
                  clearAllTimeouts()
                  return
                }
                if (m.result.type === 'audio' && m.result.data) {
                  const mime = m.result.data.mime || 'audio/mpeg'
                  if (m.result.data.base64) {
                    const src = `data:${mime};base64,${m.result.data.base64}`
                    const a = new Audio(src)
                    void a.play().catch(() => {})
                    return
                  }
                  if (m.result.data.url) {
                    const a = new Audio(String(m.result.data.url))
                    void a.play().catch(() => {})
                    return
                  }
                }
                if (m.result.type === 'error') {
                  log('WS result error', m.result.data)
                  return
                }
              }
            } catch (e) {
              log('WS onText handler error', String(e))
            }
          },
          onTTS: (meta: any, bin: ArrayBuffer) => {
            if (!firstChunkLoggedRef.current) {
              firstChunkLoggedRef.current = true
              const t1 = performance.now()
              const t0 = (window as any).__ts_user_speech_ended as number | undefined
              log("perf", { evt: "first_tts_chunk_received", ts: t1, delta_ms: typeof t0 === "number" ? Math.round(t1 - t0) : undefined })
            }
            audioQueueRef.current?.enqueue({ arrayBuffer: bin, mime: meta.mime || "audio/mpeg", seq: meta.seq })
          },
        }, subprotocol)
        onWsStateChange?.('connecting')
        client.connect()
        wsClientRef.current = client
      }
    })()
    return () => { cancelled = true }
  }, [enabled, audioContext, onAllDrained, addMessage, clearAllTimeouts, log, wsClientRef, audioQueueRef, firstChunkLoggedRef, setAiSpeaking, onWsStateChange])

  return null
}
