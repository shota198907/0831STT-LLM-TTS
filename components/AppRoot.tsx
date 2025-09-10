"use client"

export const dynamic = "force-dynamic"

import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Mic, MicOff, Phone, PhoneOff, Settings } from "lucide-react"
import { useWebRTCAudio } from "@/hooks/use-webrtc-audio"
import { useVoiceActivityDetection } from "@/hooks/use-voice-activity-detection"
import { useConversationFlow, CallEndReason } from "@/hooks/use-conversation-flow"
import { AudioVisualizer } from "@/components/audio-visualizer"
import { VADMonitor } from "@/components/vad-monitor"
import { APIClient } from "@/lib/api-client"
import { debugLog, LogLevel, addCrumb, dumpCrumbs } from "@/lib/debug"
import { RecorderSoT } from "@/lib/recorder"
import { resolveFeatureFlags } from "@/config/featureFlags"
import { useAudioStreaming } from "@/hooks/use-audio-streaming"
import StreamingBoot from "@/components/StreamingBoot"

const genId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)

debugLog("AI Phone", "Page module loaded")

interface ChatMessage {
  id: string
  type: "user" | "ai"
  content: string
  timestamp: Date
}

type CallState = "idle" | "connecting" | "connected" | "ai-speaking" | "user-speaking" | "processing"

export default function AppRoot() {
  const [callState, setCallState] = useState<CallState>("idle")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [partialUserText, setPartialUserText] = useState("")
  const [partialAiText, setPartialAiText] = useState("")
  const [showVADMonitor, setShowVADMonitor] = useState(false)
  const [maxSpeechDuration] = useState(30)
  const endCallRef = useRef<(reason: CallEndReason | "user" | "error") => void>(null)
  const ttsEndRef = useRef<number | null>(null)
  const lastRmsRef = useRef(0)
  const audioEffectIdRef = useRef<string>(genId())
  const callIdRef = useRef<string>("")
  const ff = useMemo(() => resolveFeatureFlags(), [])
  const streamingEnabled = ff.streaming.enabled
  const forceStreamAll = useMemo(() => {
    try {
      const sp = new URL(location.href).searchParams
      if (sp.get('force_stream_all') === '1') return true
    } catch {}
    return String(process.env.NEXT_PUBLIC_FORCE_STREAM_ALL || '').toLowerCase() === 'true'
  }, [])

  const log = useCallback(
    (message: string, data?: any, level: LogLevel = "info") =>
      debugLog("AI Phone", message, data, level),
    [],
  )

  useEffect(() => {
    log("Component mounted")
    return () => { log("Component unmounted") }
  }, [log])

  const addMessage = useCallback(
    (type: "user" | "ai", content: string) => {
      const newMessage: ChatMessage = {
        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        type,
        content,
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, newMessage])
      log(`Added ${type} message:`, content)
    },
    [log],
  )

  const isEndingRef = useRef(false)
  const handleConversationStateChange = useCallback((conversationState: any) => {
    log("Conversation state changed:", conversationState)
    isEndingRef.current = conversationState === "ending" || conversationState === "ended"
    switch (conversationState) {
      case "greeting":
      case "ai-speaking":
      case "ending":
        setCallState("ai-speaking"); break
      case "listening":
      case "waiting-for-response":
      case "checking-connection":
        setCallState("connected"); break
      case "processing":
        setCallState("processing"); break
      case "ended":
        setCallState("idle"); break
      default: break
    }
  }, [log])

  const handleCallEnd = useCallback((reason: CallEndReason) => {
    log("Call ended by conversation flow", { reason })
    endCallRef.current?.(reason)
  }, [log])

  const handleSttInterim = useCallback((text: string) => {
    setPartialUserText(text)
  }, [])

  const handleSttFinal = useCallback((text: string) => {
    setPartialUserText("")
    addMessage("user", text)
  }, [addMessage])

  const handleAiDelta = useCallback((delta: string) => {
    setPartialAiText((prev) => prev + delta)
  }, [])

  const handleAiSentence = useCallback((text: string) => {
    setPartialAiText("")
  }, [])

  const {
    state: conversationState,
    messages: conversationMessages,
    startConversation,
    startListening,
    armSilenceTimeout,
    stopListening,
    processUserMessage,
    processAIResponse,
    resetConversation,
    clearAllTimeouts,
  } = useConversationFlow({
    onStateChange: handleConversationStateChange,
    onMessageAdd: addMessage,
    onCallEnd: handleCallEnd,
    silenceTimeoutDuration: 7000,
    maxSilenceBeforeEnd: 3000,
  })

  const speechEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearSpeechEndTimer = useCallback(() => {
    if (speechEndTimerRef.current) { clearTimeout(speechEndTimerRef.current); speechEndTimerRef.current = null }
  }, [])

  const handleAudioData = useCallback(async (audioBlob: Blob) => {
    if (isEndingRef.current || conversationState === "ending" || conversationState === "ended") {
      log("send_skipped", { reason: "ending", state: conversationState }); return
    }
    try {
      log("Processing audio data:", audioBlob.size); log("eou_sent"); setCallState("processing")
      const apiClient = APIClient.getInstance()
      const result = await apiClient.processConversation(audioBlob, conversationMessages)
      log("ack_received"); log("stt_text", result.userMessage); log("ai_text", result.aiResponse); log("tts_audio", { present: !!result.audioBase64 })
      const userResult = processUserMessage(result.userMessage)
      if (userResult.shouldEndConversation) return
      const aiResult = processAIResponse(result.aiResponse)
      if (result.audioBase64) {
        const audioData = `data:${result.mimeType};base64,${result.audioBase64}`
        const audio = new Audio(audioData)
        setCallState("ai-speaking")
        let resumed = false
        const resumeListening = () => {
          if (resumed) return; resumed = true
          const ts = performance.now(); ttsEndRef.current = ts; log("AI speech completed", { tts_end_ts: ts })
          if (aiResult.shouldContinueListening) {
            startListening(); setTimeout(() => { log("silence_armed", { trigger: "tts_end", graceMs: silenceGraceMs }); armSilenceTimeout() }, silenceGraceMs)
          }
        }
        const fallbackId = setTimeout(() => { log("AI speech onended fallback triggered"); resumeListening() }, 10000)
        audio.onended = () => { clearTimeout(fallbackId); resumeListening() }
        audio.onerror = (error) => { clearTimeout(fallbackId); log("Audio playback error:", error); resumeListening() }
        await audio.play()
      } else if (aiResult.shouldContinueListening) {
        isCapturingRef.current = false
        startListening()
      }
    } catch (error) {
      log("Error processing audio:", error); setCallState("connected"); startListening()
    }
  }, [conversationMessages, processUserMessage, processAIResponse, startListening, log])

  const handleAudioError = useCallback((error: Error) => {
    log("Audio error:", error); alert(`音声エラー: ${error.message}`); endCallRef.current?.("error")
  }, [log])

  const { initializeAudio, startRecording, stopRecording, cleanup, dispose, isRecording, stream, audioContext } = useWebRTCAudio({ onAudioData: handleAudioData, onError: handleAudioError })

  useEffect(() => { /* placeholder to keep stable */ }, [])

  const isRecordingRef = useRef(isRecording); useEffect(() => { isRecordingRef.current = isRecording }, [isRecording])
  const streamRefLatest = useRef(stream); useEffect(() => { streamRefLatest.current = stream }, [stream])
  useEffect(() => { RecorderSoT.init({ start: startRecording, stop: stopRecording, isRecording: () => isRecordingRef.current, hasStream: () => !!streamRefLatest.current }) }, [startRecording, stopRecording])

  const stopVADRef = useRef<(reason?: string) => void>(() => {})
  const isUnmountingRef = useRef(false)

  const wsClientRef = useRef<any>(null)
  const audioQueueRef = useRef<any>(null)
  const firstChunkLoggedRef = useRef(false)
  const wsOpenRef = useRef(false)
  const isCapturingRef = useRef(false)
  const turnIdRef = useRef<string>("")
  const prevConvStateRef = useRef<string>("")
  const silenceArmedRef = useRef(false)
  const captureModeRef = useRef<'idle'|'ws'|'rest'>('idle')
  const sentFramesRef = useRef(0)
  const sentBytesRef = useRef(0)
  const sentTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopRecordingAndVAD = useCallback(async (reason: string = "manual") => {
    clearSpeechEndTimer(); stopListening()
    if (streamingEnabled) {
      try { wsClientRef.current?.send({ type: 'eos' }) } catch {}
      try { await stopStreamRec() } catch {}
    } else { await RecorderSoT.stop(reason) }
    stopVADRef.current(reason)
  }, [stopListening, clearSpeechEndTimer, streamingEnabled])

  const ensureAudioContextRunning = useCallback(async (ctx?: AudioContext) => {
    const target = ctx ?? audioContext
    if (target && target.state === "suspended") { try { await target.resume(); log("AudioContext resumed") } catch (e) { log("Failed to resume AudioContext", e) } }
  }, [audioContext, log])

  const handleSpeechStart = useCallback(() => { log("Speech started"); setCallState("user-speaking"); clearAllTimeouts(); clearSpeechEndTimer() }, [log, clearAllTimeouts, clearSpeechEndTimer])
  const handleSpeechEnd = useCallback(() => {
    log("Speech ended")
    if (streamingEnabled) {
      ;(window as any).__ts_user_speech_ended = performance.now()
      log("perf", { evt: "user_speech_ended", ts: (window as any).__ts_user_speech_ended })
    }
    // In force stream mode, do not stop recording on speech end; let GW silence timer auto-forward
    if (forceStreamAll) {
      log("Speech end ignored due to force_stream_all")
      return
    }
    clearSpeechEndTimer()
    speechEndTimerRef.current = setTimeout(() => { void stopRecordingAndVAD("speech_end") }, 800)
  }, [stopRecordingAndVAD, log, clearSpeechEndTimer, streamingEnabled, forceStreamAll])
  const handleMaxDurationReached = useCallback(async () => { log("Maximum speech duration reached - forcing stop"); await stopRecordingAndVAD("max_duration"); log("Recording stopped due to max duration") }, [stopRecordingAndVAD, log])

  const vadSilenceThreshold = Number(process.env.NEXT_PUBLIC_VAD_SILENCE_THRESHOLD ?? 1.2)
  // Lower default volume threshold to make speech detection less strict
  const vadVolumeThreshold = Number(process.env.NEXT_PUBLIC_VAD_VOLUME_THRESHOLD ?? 0.01)
  log("VAD thresholds", { silence: vadSilenceThreshold, volume: vadVolumeThreshold }, "debug")
  const silenceGraceMs = Number(process.env.NEXT_PUBLIC_SILENCE_GRACE_MS ?? 3000)

  const { startVAD, stopVAD, vadMetrics } = useVoiceActivityDetection({
    silenceThreshold: vadSilenceThreshold,
    volumeThreshold: vadVolumeThreshold,
    minSpeechDuration: 0.3,
    minSilenceDuration: 0.3,
    maxSpeechDuration,
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: handleSpeechEnd,
    onMaxDurationReached: handleMaxDurationReached,
    getConversationState: () => conversationState,
    isUnmountingRef,
    onFirstSpeechFrame: () => {
      if (silenceArmedRef.current) return
      silenceArmedRef.current = true
      log("silence_arm_scheduled", { trigger: "first_speech", graceMs: silenceGraceMs })
      setTimeout(() => { log("silence_armed", { trigger: "first_speech", graceMs: silenceGraceMs }); armSilenceTimeout() }, silenceGraceMs)
    },
    zeroInputWatchdogSec: Number(process.env.NEXT_PUBLIC_ZERO_INPUT_WATCHDOG_SEC ?? 8),
    onZeroInputDetected: async (durationSec: number) => {
      log("input_watchdog", { evt: "zero_input_detected", durationSec }); log("input_watchdog.reacquire_attempt", { active: RecorderSoT.isActive() })
      try { if (RecorderSoT.isActive()) { await RecorderSoT.stop("watchdog") } await initializeAudio(); await RecorderSoT.start("watchdog"); log("input_watchdog.reacquire_result", { ok: true }) }
      catch (e) { log("input_watchdog.reacquire_result", { ok: false, error: String(e) }) }
    },
  })
  useEffect(() => { stopVADRef.current = stopVAD }, [stopVAD])

  const onAllDrained = useCallback(() => {
    if (streamingEnabled) { startListening(); setTimeout(() => { log("silence_armed", { trigger: "tts_end_streaming", graceMs: silenceGraceMs }); armSilenceTimeout() }, silenceGraceMs) }
  }, [armSilenceTimeout, silenceGraceMs, startListening, log, streamingEnabled])

  const onFirstPlayStart = useCallback(() => {
    const t0 = (window as any).__ts_user_speech_ended as number | undefined
    const t1 = performance.now()
    if (typeof t0 === 'number') { const latency = Math.round(t1 - t0); log("perf", { evt: "first_audio_play_started", first_audio_latency_ms: latency }) }
    else { log("perf", { evt: "first_audio_play_started" }) }
  }, [log])

  const { start: startStreamRec, stop: stopStreamRec } = useAudioStreaming({
    getStream: () => streamRefLatest.current ?? stream ?? null,
    // Use ~200ms chunks to keep latency low while preserving container headers
    timesliceMs: 200,
    onChunk: (buf) => {
      try {
        if (captureModeRef.current === 'ws') {
          wsClientRef.current?.sendBinary(buf)
          sentFramesRef.current += 1
          sentBytesRef.current += (buf as ArrayBuffer).byteLength || 0
        }
      } catch {}
    },
  })

  const unlockPlayback = useCallback(async (ctx?: AudioContext) => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
      const audioCtx = ctx ?? audioContext ?? new Ctx({ sampleRate: 48000 })
      if (audioCtx.state === "suspended") await audioCtx.resume()
      const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain(); gain.gain.value = 0.0001
      osc.connect(gain).connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + 0.12)
      await new Promise((r) => setTimeout(r, 160)); log("Playback unlocked")
    } catch (e) { log("Playback unlock failed (non-fatal):", e) }
  }, [audioContext, log])

  const playWelcomeThenStart = useCallback(async () => {
    try {
      const api = APIClient.getInstance()
      const welcome = "アシスタントです。ご用件をどうぞ。"
      const tts = await api.textToSpeech(welcome)
      const audioData = `data:${tts.mimeType};base64,${tts.audio}`
      const audio = new Audio(audioData)
      setCallState("ai-speaking"); await audio.play(); setCallState("connected"); startConversation(); startListening()
    } catch (err) {
      log("Welcome TTS failed:", err); setCallState("connected"); startConversation(); startListening()
    }
  }, [startConversation, startListening, log, setCallState])

  const startCall = useCallback(async () => {
    try {
      log("Starting call..."); setCallState("connecting")
      const { audioContext: context } = await initializeAudio(); log("Audio initialized successfully", { sampleRate: context?.sampleRate })
      await unlockPlayback(context); setCallState("connected"); await playWelcomeThenStart()
    } catch (error) {
      log("Error starting call:", error); setCallState("idle"); alert("マイクへのアクセスが必要です。ブラウザの設定を確認してください。")
    }
  }, [initializeAudio, unlockPlayback, playWelcomeThenStart, log])

  const endCall = useCallback((reason: CallEndReason | "user" | "error") => {
    log(`Ending call... reason=${reason}`)
    const finalize = () => { clearSpeechEndTimer(); clearAllTimeouts(); cleanup(); resetConversation(); setCallState("idle"); setMessages([]); log("Call ended") }
    if (isRecording) {
      log("Stopping recording before ending call")
      stopRecordingAndVAD("end_call").then(() => { log("Recording stopped prior to cleanup"); finalize() }).catch((err) => { log("Failed to stop recording before end", err); finalize() })
    } else { stopVADRef.current("end_call"); finalize() }
    try { wsClientRef.current?.close() } catch {}
    isCapturingRef.current = false; turnIdRef.current = ""
  }, [isRecording, stopRecordingAndVAD, cleanup, resetConversation, log, clearSpeechEndTimer, clearAllTimeouts])
  endCallRef.current = endCall

  useEffect(() => { if (callState === "ai-speaking") { void stopRecordingAndVAD("ai_speaking"); isCapturingRef.current = false } }, [callState, stopRecordingAndVAD])

  // Safeguard: unlock capture when leaving 'listening'
  useEffect(() => {
    if (conversationState !== 'listening') {
      isCapturingRef.current = false
    }
  }, [conversationState])

  // Start capture exactly once on transition into 'listening'
  useEffect(() => {
    const prev = prevConvStateRef.current
    if (prev !== 'listening' && conversationState === 'listening') {
      silenceArmedRef.current = false
      ;(async () => {
        if (isCapturingRef.current) return
        isCapturingRef.current = true
        turnIdRef.current = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`

        let currentStream = stream; let currentContext = audioContext
        let track = currentStream?.getAudioTracks()[0]
        if (
          !currentStream ||
          !currentContext ||
          !track ||
          track.readyState !== "live" ||
          track.muted
        ) {
          try {
            const result = await initializeAudio()
            currentStream = result.stream
            currentContext = result.audioContext
            track = currentStream.getAudioTracks()[0]
            log("Reinitialized audio for listening", {
              reason: !currentStream
                ? "no_stream"
                : !currentContext
                  ? "no_context"
                  : !track
                    ? "no_track"
                    : track.readyState !== "live"
                      ? "track_not_live"
                      : "track_muted",
            })
          } catch (err) {
            log("Failed to reinitialize audio", err)
            isCapturingRef.current = false
            return
          }
        }
        await ensureAudioContextRunning(currentContext)
        if (currentContext.state !== 'running') { log("AudioContext not running, skipping VAD start", { state: currentContext.state }); isCapturingRef.current = false; return }

        const recStart = performance.now(); log("Starting recording and VAD based on conversation state", { forceStreamAll })
        const opusSupported = (() => {
          try {
            const M: any = (window as any).MediaRecorder
            if (!M || typeof M.isTypeSupported !== 'function') return false
            return M.isTypeSupported('audio/webm;codecs=opus') || M.isTypeSupported('audio/ogg;codecs=opus')
          } catch { return false }
        })()
        if ((streamingEnabled || forceStreamAll) && wsOpenRef.current && opusSupported) {
          try { wsClientRef.current?.send({ type: 'start', sessionId: callIdRef.current || 's', sampleRate: currentContext.sampleRate, lang: 'ja-JP', codec: 'opus' }) } catch {}
          captureModeRef.current = 'ws'
          sentFramesRef.current = 0
          sentBytesRef.current = 0
          if (forceStreamAll && !sentTickerRef.current) {
            sentTickerRef.current = setInterval(() => {
              log("STRM sent", { frames: sentFramesRef.current, bytes: sentBytesRef.current })
              sentFramesRef.current = 0
              sentBytesRef.current = 0
            }, 1000)
          }
          await startStreamRec()
        } else {
          if (!opusSupported) { log('Streaming disabled: opus container not supported (using REST)') }
          captureModeRef.current = 'rest'
          if (sentTickerRef.current) { clearInterval(sentTickerRef.current); sentTickerRef.current = null }
          await RecorderSoT.start("flow_listening")
        }
        log("Recording started", { rec_start_ts: recStart, latency_ms: Math.round(recStart - (ttsEndRef.current ?? recStart)) })
        ttsEndRef.current = null
        startVAD(currentStream!, currentContext!, callIdRef.current || "conversation_listening")
      })()
    }
    prevConvStateRef.current = conversationState
  }, [conversationState, streamingEnabled, stream, audioContext, initializeAudio, ensureAudioContextRunning, log, startVAD, startStreamRec])

  const depsRef = useRef({ log, cleanup, resetConversation, clearSpeechEndTimer })
  useEffect(() => {
    const prev = depsRef.current
    const changed = Object.entries({ log, cleanup, resetConversation, clearSpeechEndTimer }).filter(([k, v]) => (prev as any)[k] !== v).map(([k]) => k)
    if (changed.length) { debugLog("App", "effect_deps_changed", { effect: "unmount_cleanup", changed }, "info"); addCrumb("App", "deps_changed", { effect: "unmount_cleanup", changed }); depsRef.current = { log, cleanup, resetConversation, clearSpeechEndTimer } }
  }, [log, cleanup, resetConversation, clearSpeechEndTimer])

  useEffect(() => {
    return () => {
      debugLog("App", "unmount_cleanup", { reason: "react_effect_cleanup", conversationState, hasStream: !!stream, isRecording }, "info")
      log("Unmount cleanup: stopping audio only"); stopVADRef.current("unmount"); cleanup("react_effect_cleanup"); resetConversation(); clearSpeechEndTimer(); try { wsClientRef.current?.close() } catch {}
      isCapturingRef.current = false; turnIdRef.current = ""
      if (sentTickerRef.current) { clearInterval(sentTickerRef.current); sentTickerRef.current = null }
    }
  }, [])

  useEffect(() => {
    const handlePageUnload = () => { log("Page unload: disposing audio"); isUnmountingRef.current = true; stopVADRef.current("unmount"); void dispose(); debugLog("App", "page_unload", { breadcrumbs: dumpCrumbs() }, "info") }
    window.addEventListener("pagehide", handlePageUnload); window.addEventListener("beforeunload", handlePageUnload)
    return () => { window.removeEventListener("pagehide", handlePageUnload); window.removeEventListener("beforeunload", handlePageUnload) }
  }, [dispose, log])

  const getStatusDisplay = () => {
    switch (callState) {
      case "idle": return { text: "未接続", color: "bg-gray-100 text-gray-800", dotColor: "bg-gray-500" }
      case "connecting": return { text: "接続中...", color: "bg-yellow-100 text-yellow-800", dotColor: "bg-yellow-500 animate-pulse" }
      case "connected": return { text: "接続中", color: "bg-green-100 text-green-800", dotColor: "bg-green-500" }
      case "ai-speaking": return { text: "AIが話しています", color: "bg-blue-100 text-blue-800", dotColor: "bg-blue-500 animate-pulse" }
      case "user-speaking": return { text: "録音中", color: "bg-red-100 text-red-800", dotColor: "bg-red-500 animate-pulse" }
      case "processing": return { text: "処理中...", color: "bg-purple-100 text-purple-800", dotColor: "bg-purple-500 animate-pulse" }
      default: return { text: "未接続", color: "bg-gray-100 text-gray-800", dotColor: "bg-gray-500" }
    }
  }

  const status = getStatusDisplay()

  return (
    <div className="min-h-screen bg-background p-4">
      {/* Streaming boot (client-only init) */}
      {streamingEnabled && (
        <StreamingBoot
          enabled={streamingEnabled}
          audioContext={audioContext}
          onFirstPlayStart={onFirstPlayStart}
          onAllDrained={onAllDrained}
          addMessage={addMessage}
          clearAllTimeouts={clearAllTimeouts}
          log={log}
          wsClientRef={wsClientRef}
          audioQueueRef={audioQueueRef}
          firstChunkLoggedRef={firstChunkLoggedRef}
          setAiSpeaking={() => setCallState("ai-speaking")}
          onWsStateChange={(s) => { wsOpenRef.current = (s === 'open') }}
          onSttInterim={handleSttInterim}
          onSttFinal={handleSttFinal}
          onAiDelta={handleAiDelta}
          onAiSentence={handleAiSentence}
        />
      )}

      <div className="max-w-2xl mx-auto space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-center flex-1">AI電話対応システム</CardTitle>
              {process.env.NODE_ENV === "development" && (
                <Button variant="ghost" size="sm" onClick={() => setShowVADMonitor(!showVADMonitor)}>
                  <Settings className="w-4 h-4" />
                </Button>
              )}
            </div>
            {process.env.NODE_ENV === "development" && (
              <div className="text-xs text-muted-foreground text-center">会話状態: {conversationState}</div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-center">
              <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${status.color}`}>
                <div className={`w-2 h-2 rounded-full ${status.dotColor}`} />
                {status.text}
              </div>
            </div>

            <div className="flex justify-center gap-4">
              {callState === "idle" ? (
                <Button onClick={startCall} size="lg" className="bg-green-600 hover:bg-green-700">
                  <Phone className="w-5 h-5 mr-2" />
                  通話開始
                </Button>
              ) : (
                <Button onClick={() => endCall("user")} size="lg" variant="destructive">
                  <PhoneOff className="w-5 h-5 mr-2" />
                  通話終了
                </Button>
              )}
            </div>

            <AudioVisualizer stream={stream} isActive={callState === "user-speaking" || callState === "connected"} className="py-4" />

            {callState !== "idle" && (
              <div className="text-center">
                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full ${status.color}`}>
                  {callState === "ai-speaking" ? (
                    <>
                      <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                      AIが話しています...
                    </>
                  ) : callState === "user-speaking" ? (
                    <>
                      <Mic className="w-4 h-4 text-red-500 animate-pulse" />
                      録音中...
                    </>
                  ) : callState === "processing" ? (
                    <>
                      <div className="w-3 h-3 bg-purple-500 rounded-full animate-pulse" />
                      音声を処理中...
                    </>
                  ) : (
                    <>
                      <MicOff className="w-4 h-4 text-gray-500" />
                      待機中
                    </>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {showVADMonitor && <VADMonitor metrics={vadMetrics} isActive={callState !== "idle"} />}

        <Card>
          <CardHeader>
            <CardTitle>会話履歴</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {messages.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">通話を開始すると会話が表示されます</p>
              ) : (
                <>
                  {messages.map((message) => (
                    <div key={message.id} className={`flex ${message.type === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-xs px-4 py-2 rounded-lg ${message.type === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                        <p className="text-sm">{message.content}</p>
                        <p className="text-xs opacity-70 mt-1">{message.timestamp.toLocaleTimeString("ja-JP")}</p>
                      </div>
                    </div>
                  ))}
                  {partialAiText && (
                    <div className="flex justify-start" key="__partial_ai">
                      <div className="max-w-xs px-4 py-2 rounded-lg bg-muted text-muted-foreground italic opacity-70">
                        <p className="text-sm">{partialAiText}</p>
                        <p className="text-xs opacity-70 mt-1">AI応答生成中...</p>
                      </div>
                    </div>
                  )}
                  {partialUserText && (
                    <div className="flex justify-end" key="__partial">
                      <div className="max-w-xs px-4 py-2 rounded-lg bg-primary/40 text-primary-foreground italic opacity-70">
                        <p className="text-sm">{partialUserText}</p>
                        <p className="text-xs opacity-70 mt-1">音声入力中...</p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
