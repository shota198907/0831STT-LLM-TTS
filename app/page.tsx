"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Mic, MicOff, Phone, PhoneOff, Settings } from "lucide-react"
import { useWebRTCAudio } from "@/hooks/use-webrtc-audio"
import { useVoiceActivityDetection } from "@/hooks/use-voice-activity-detection"
import { useConversationFlow, CallEndReason } from "@/hooks/use-conversation-flow"
import { AudioVisualizer } from "@/components/audio-visualizer"
import { VADMonitor } from "@/components/vad-monitor"
import { APIClient } from "@/lib/api-client"
import { debugLog } from "@/lib/debug"

// ページ読み込み時にモジュールが評価されたことをログに残す
debugLog("AI Phone", "Page module loaded")

interface ChatMessage {
  id: string
  type: "user" | "ai"
  content: string
  timestamp: Date
}

type CallState = "idle" | "connecting" | "connected" | "ai-speaking" | "user-speaking" | "processing"

export default function AIPhoneSystem() {
  const [callState, setCallState] = useState<CallState>("idle")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [showVADMonitor, setShowVADMonitor] = useState(false)
  const endCallRef = useRef<(reason: CallEndReason | "user" | "error") => void>(null)
  const ttsEndRef = useRef<number | null>(null)

  const log = useCallback(
    (message: string, data?: any) => debugLog("AI Phone", message, data),
    [],
  )

  useEffect(() => {
    log("Component mounted")
    return () => {
      log("Component unmounted")
    }
  }, [log])

  const addMessage = useCallback(
    (type: "user" | "ai", content: string) => {
      const newMessage: ChatMessage = {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`,
        type,
        content,
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, newMessage])
      log(`Added ${type} message:`, content)
    },
    [log],
  )

  const handleConversationStateChange = useCallback(
    (conversationState: any) => {
      log("Conversation state changed:", conversationState)

      // Map conversation states to call states
      switch (conversationState) {
        case "greeting":
        case "ai-speaking":
        case "ending":
          setCallState("ai-speaking")
          break
        case "listening":
        case "waiting-for-response":
        case "checking-connection":
          setCallState("connected")
          break
        case "processing":
          setCallState("processing")
          break
        case "ended":
          setCallState("idle")
          break
        default:
          break
      }
    },
    [log],
  )

  const handleCallEnd = useCallback(
    (reason: CallEndReason) => {
      log("Call ended by conversation flow", { reason })
      endCallRef.current?.(reason)
    },
    [log],
  )

  const {
    state: conversationState,
    messages: conversationMessages,
    startConversation,
    startListening,
    stopListening,
    processUserMessage,
    processAIResponse,
    resetConversation,
    clearAllTimeouts,
  } = useConversationFlow({
    onStateChange: handleConversationStateChange,
    onMessageAdd: addMessage,
    onCallEnd: handleCallEnd,
    silenceTimeoutDuration: 6000,
    maxSilenceBeforeEnd: 6000,
  })

  const handleAudioData = useCallback(
    async (audioBlob: Blob) => {
      try {
        log("Processing audio data:", audioBlob.size)
        log("eou_sent")
        setCallState("processing")

        log("Sending audio for STT and AI processing")
        const apiClient = APIClient.getInstance()
        const result = await apiClient.processConversation(
          audioBlob,
          conversationMessages,
        )
        log("ack_received")
        log("stt_text", result.userMessage)
        log("ai_text", result.aiResponse)
        log("tts_audio", { present: !!result.audioBase64 })
        log("conversation_result", {
          user: result.userMessage,
          ai: result.aiResponse,
          hasAudio: !!result.audioBase64,
        })

        // Process user message through conversation flow
        const userResult = processUserMessage(result.userMessage)

        if (userResult.shouldEndConversation) {
          return // Conversation flow will handle ending
        }

        // Process AI response through conversation flow
        const aiResult = processAIResponse(result.aiResponse)

        // Play AI audio response
        if (result.audioBase64) {
          const audioData = `data:${result.mimeType};base64,${result.audioBase64}`
          const audio = new Audio(audioData)

          setCallState("ai-speaking")

          let resumed = false
          const resumeListening = () => {
            if (resumed) return
            resumed = true
            const ts = performance.now()
            ttsEndRef.current = ts
            log("AI speech completed", { tts_end_ts: ts })
            if (aiResult.shouldContinueListening) {
              startListening()
            }
          }

          const fallbackId = setTimeout(() => {
            log("AI speech onended fallback triggered")
            resumeListening()
          }, 10000)

          audio.onended = () => {
            clearTimeout(fallbackId)
            resumeListening()
          }

          audio.onerror = (error) => {
            clearTimeout(fallbackId)
            log("Audio playback error:", error)
            resumeListening()
          }

          await audio.play()
        } else if (aiResult.shouldContinueListening) {
          startListening()
        }
      } catch (error) {
        log("Error processing audio:", error)
        setCallState("connected")
        startListening()
      }
    },
    [conversationMessages, processUserMessage, processAIResponse, startListening, log],
  )

  const handleAudioError = useCallback(
    (error: Error) => {
      log("Audio error:", error)
      alert(`音声エラー: ${error.message}`)
      endCall("error")
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log],
  )

  const { initializeAudio, startRecording, stopRecording, cleanup, isRecording, stream, audioContext } = useWebRTCAudio(
    {
      onAudioData: handleAudioData,
      onError: handleAudioError,
    },
  )

  const ensureAudioContextRunning = useCallback(
    async (ctx?: AudioContext) => {
      const target = ctx ?? audioContext
      if (target && target.state === "suspended") {
        try {
          await target.resume()
          log("AudioContext resumed")
        } catch (e) {
          log("Failed to resume AudioContext", e)
        }
      }
    },
    [audioContext, log],
  )

  const handleSpeechStart = useCallback(() => {
    log("Speech started")
    setCallState("user-speaking")
    clearAllTimeouts() // ユーザー発話中は沈黙タイマーのみ停止
  }, [log, clearAllTimeouts])

  const handleSpeechEnd = useCallback(async () => {
    log("Speech ended")
    await stopRecording()
  }, [stopRecording, log])

  const handleSilenceDetected = useCallback(async () => {
    log("Silence detected - user finished speaking")
    await stopRecording()
  }, [log, stopRecording])

  const handleMaxDurationReached = useCallback(async () => {
    log("Maximum speech duration reached - forcing stop")
    await stopRecording()
    log("Recording stopped due to max duration")
  }, [stopRecording, log])

  // DEBUG: thresholds can be overridden via env vars for verification
  const vadSilenceThreshold = Number(process.env.NEXT_PUBLIC_VAD_SILENCE_THRESHOLD ?? 1.2)
  const vadVolumeThreshold = Number(process.env.NEXT_PUBLIC_VAD_VOLUME_THRESHOLD ?? 0.03)

  const { startVAD, stopVAD, vadMetrics } = useVoiceActivityDetection({
    silenceThreshold: vadSilenceThreshold,
    volumeThreshold: vadVolumeThreshold,
    minSpeechDuration: 0.3,
    maxSpeechDuration: 10,
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: handleSpeechEnd,
    onSilenceDetected: handleSilenceDetected,
    onMaxDurationReached: handleMaxDurationReached,
  })

  // 再生解錠（無音オシレータで 0.1秒だけ音を出し、自動再生ブロックを解除）
  const unlockPlayback = useCallback(async (ctx?: AudioContext) => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
      const audioCtx = ctx ?? audioContext ?? new Ctx({ sampleRate: 16000 })
      if (audioCtx.state === "suspended") await audioCtx.resume()

      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      gain.gain.value = 0.0001 // ほぼ無音
      osc.connect(gain).connect(audioCtx.destination)
      osc.start()
      osc.stop(audioCtx.currentTime + 0.12)
      await new Promise((r) => setTimeout(r, 160))

      log("Playback unlocked")
    } catch (e) {
      log("Playback unlock failed (non-fatal):", e)
    }
  }, [audioContext, log])

  // ウェルカムTTSを再生 → 再生終了後に会話開始＆リッスン開始
  const playWelcomeThenStart = useCallback(async () => {
    try {
      setCallState("ai-speaking")

      const res = await fetch("/api/text-to-speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "お電話ありがとうございます。アシスタントです。ご用件をどうぞ。" }),
      })
      const data = await res.json()
      if (!data?.audio) throw new Error("TTS audio missing")

      // 念のため：再生前にもう一度解錠
      if (audioContext) {
        await audioContext.resume()
        await unlockPlayback(audioContext)
      } else {
        await unlockPlayback()
      }
      

      const url = `data:${data.mimeType};base64,${data.audio}`
      const audio = new Audio(url)

      let resumed = false
      const resumeStart = () => {
        if (resumed) return
        resumed = true
        setCallState("connected")
        startConversation()
        startListening()
      }

      const fallbackId = setTimeout(() => {
        log("Welcome TTS onended fallback triggered")
        resumeStart()
      }, 10000)

      audio.onended = () => {
        clearTimeout(fallbackId)
        log("Welcome TTS ended; start conversation & listening")
        resumeStart()
      }
      audio.onerror = (err) => {
        clearTimeout(fallbackId)
        log("Welcome TTS playback error:", err)
        resumeStart()
      }

      await audio.play()
    } catch (err) {
      log("Welcome TTS failed:", err)
      setCallState("connected")
      // 音が出なくても会話は続行できるようにフォールバック
      startConversation()
      startListening()
    }
  }, [audioContext, startConversation, startListening, unlockPlayback, log, setCallState])

  const startCall = useCallback(async () => {
    try {
      log("Starting call...")
      setCallState("connecting")

      const { stream: audioStream, audioContext: context } = await initializeAudio()
      log("Audio initialized successfully", { sampleRate: context?.sampleRate })

      // 先に再生解錠（これが無いとウェルカム音声がブロックされることがある）
      await unlockPlayback(context)

      // ここではまだ録音を開始しない。まずはウェルカムを流す。
      setCallState("connected")
      await playWelcomeThenStart()
    } catch (error) {
      log("Error starting call:", error)
      setCallState("idle")
      alert("マイクへのアクセスが必要です。ブラウザの設定を確認してください。")
    }
  }, [initializeAudio, unlockPlayback, playWelcomeThenStart, log])

  const endCall = useCallback(
    (reason: CallEndReason | "user" | "error") => {
      log(`Ending call... reason=${reason}`)

      const finalize = () => {
        stopVAD()
        cleanup()
        resetConversation()
        setCallState("idle")
        setMessages([])
        log("Call ended")
      }

      if (isRecording) {
        log("Stopping recording before ending call")
        stopRecording()
          .then(() => {
            log("Recording stopped prior to cleanup")
            finalize()
          })
          .catch((err) => {
            log("Failed to stop recording before end", err)
            finalize()
          })
      } else {
        finalize()
      }
    },
    [isRecording, stopRecording, stopVAD, cleanup, resetConversation, log],
  )
  endCallRef.current = endCall

  useEffect(() => {
    if (callState === "ai-speaking") {
      stopVAD()
      void stopRecording()
    }
  }, [callState, stopVAD, stopRecording])

  // Start listening when conversation flow indicates
  useEffect(() => {
    const setup = async () => {
      if (conversationState === "listening" && !isRecording) {
        let currentStream = stream
        let currentContext = audioContext

        if (!currentStream || !currentContext) {
          try {
            const result = await initializeAudio()
            currentStream = result.stream
            currentContext = result.audioContext
            log("Reinitialized audio for listening")
          } catch (err) {
            log("Failed to reinitialize audio", err)
            return
          }
        }

        await ensureAudioContextRunning(currentContext)

        if (currentContext.state === "running") {
          const recStart = performance.now()
          log("Starting recording and VAD based on conversation state")
          await startRecording()
          log("Recording started", {
            rec_start_ts: recStart,
            latency_ms: Math.round(recStart - (ttsEndRef.current ?? recStart)),
          })
          ttsEndRef.current = null
          startVAD(currentStream, currentContext)
        } else {
          log("AudioContext not running, skipping VAD start", {
            state: currentContext.state,
          })
        }
      } else {
        log("Skip VAD start (missing stream/context or already recording)", {
          conversationState,
          hasStream: !!stream,
          ctxState: audioContext?.state,
          isRecording,
        })
      }
    }
    setup()
  }, [
    conversationState,
    stream,
    audioContext,
    isRecording,
    startVAD,
    startRecording,
    initializeAudio,
    ensureAudioContextRunning,
    log,
  ])

  // Resume AudioContext and mic on visibility/focus changes
  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible") return

      if (audioContext?.state === "suspended") {
        try {
          await audioContext.resume()
          log("AudioContext resumed after visibility change")
        } catch (e) {
          log("AudioContext resume failed", e)
        }
      }

      const tracks = stream?.getAudioTracks() ?? []
      const ended = tracks.length > 0 && tracks.every((t) => t.readyState === "ended")
      if (!stream || ended) {
        try {
          const result = await initializeAudio()
          log("Reacquired audio after visibility change")
          if (conversationState === "listening" && !isRecording) {
            await ensureAudioContextRunning(result.audioContext)
            const recStart = performance.now()
            await startRecording()
            log("Recording restarted", {
              rec_start_ts: recStart,
              latency_ms: Math.round(recStart - (ttsEndRef.current ?? recStart)),
            })
            ttsEndRef.current = null
            startVAD(result.stream, result.audioContext)
          }
        } catch (err) {
          log("Failed to reacquire audio after visibility change", err)
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibility)
    window.addEventListener("focus", handleVisibility)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility)
      window.removeEventListener("focus", handleVisibility)
    }
  }, [
    audioContext,
    stream,
    initializeAudio,
    conversationState,
    isRecording,
    startRecording,
    startVAD,
    ensureAudioContextRunning,
    log,
  ])

  // Reacquire microphone when track ends
  useEffect(() => {
    if (!stream) return
    const handleTrackEnded = async () => {
      log("MediaStream track ended")
      try {
        const result = await initializeAudio()
        log("Reinitialized audio after track ended")
        if (conversationState === "listening" && !isRecording) {
          await ensureAudioContextRunning(result.audioContext)
          const recStart = performance.now()
          await startRecording()
          log("Recording restarted", {
            rec_start_ts: recStart,
            latency_ms: Math.round(recStart - (ttsEndRef.current ?? recStart)),
          })
          ttsEndRef.current = null
          startVAD(result.stream, result.audioContext)
        }
      } catch (err) {
        log("Failed to reinitialize audio after track ended", err)
      }
    }
    const tracks = stream.getTracks()
    tracks.forEach((track) => track.addEventListener("ended", handleTrackEnded))
    return () => {
      tracks.forEach((track) => track.removeEventListener("ended", handleTrackEnded))
    }
  }, [
    stream,
    initializeAudio,
    conversationState,
    isRecording,
    startRecording,
    startVAD,
    ensureAudioContextRunning,
    log,
  ])

  // Clean up only when component unmounts; avoid triggering endCall indirectly
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    return () => {
      log("Unmount cleanup: stopping audio only")
      stopVAD()
      cleanup()
      resetConversation()
    }
  }, [])

  const getStatusDisplay = () => {
    switch (callState) {
      case "idle":
        return { text: "未接続", color: "bg-gray-100 text-gray-800", dotColor: "bg-gray-500" }
      case "connecting":
        return { text: "接続中...", color: "bg-yellow-100 text-yellow-800", dotColor: "bg-yellow-500 animate-pulse" }
      case "connected":
        return { text: "接続中", color: "bg-green-100 text-green-800", dotColor: "bg-green-500" }
      case "ai-speaking":
        return { text: "AIが話しています", color: "bg-blue-100 text-blue-800", dotColor: "bg-blue-500 animate-pulse" }
      case "user-speaking":
        return { text: "録音中", color: "bg-red-100 text-red-800", dotColor: "bg-red-500 animate-pulse" }
      case "processing":
        return { text: "処理中...", color: "bg-purple-100 text-purple-800", dotColor: "bg-purple-500 animate-pulse" }
      default:
        return { text: "未接続", color: "bg-gray-100 text-gray-800", dotColor: "bg-gray-500" }
    }
  }

  const status = getStatusDisplay()

  return (
    <div className="min-h-screen bg-background p-4">
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

            <AudioVisualizer
              stream={stream}
              isActive={callState === "user-speaking" || callState === "connected"}
              className="py-4"
            />

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
                messages.map((message) => (
                  <div key={message.id} className={`flex ${message.type === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-xs px-4 py-2 rounded-lg ${
                        message.type === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <p className="text-sm">{message.content}</p>
                      <p className="text-xs opacity-70 mt-1">{message.timestamp.toLocaleTimeString("ja-JP")}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
