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
        const params = new URL(location.href).searchParams
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
          wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws/conversation`
        }
        const token = qToken || envToken || ''
        const subprotocol = token ? [token] : undefined
        const client = new StreamingClient(wsUrl, {
          onOpen: () => { log("WS open"); onWsStateChange?.('open') },
          onClose: () => { log("WS close"); onWsStateChange?.('closed') },
          onError: (e: any) => { log("WS error", e); onWsStateChange?.('error') },
          onState: (s) => { onWsStateChange?.(s) },
          onText: (m: any) => {
            if (m.type === "ai_sentence") {
              addMessage("ai", m.text)
              setAiSpeaking()
              clearAllTimeouts()
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
