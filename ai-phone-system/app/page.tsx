"use client"

import { useState, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Mic, MicOff, Phone, PhoneOff, Settings } from "lucide-react"
import { useWebRTCAudio } from "@/hooks/use-webrtc-audio"
import { useVoiceActivityDetection } from "@/hooks/use-voice-activity-detection"
import { useConversationFlow, CallEndReason } from "@/hooks/use-conversation-flow"
import { AudioVisualizer } from "@/components/audio-visualizer"
import { VADMonitor } from "@/components/vad-monitor"
import { APIClient } from "@/lib/api-client"

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

  const debugLog = useCallback((message: string, data?: any) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`[AI Phone Debug] ${message}`, data || "")
    }
  }, [])

  const addMessage = useCallback(
    (type: "user" | "ai", content: string) => {
      const newMessage: ChatMessage = {
        id: Date.now().toString(),
        type,
        content,
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, newMessage])
      debugLog(`Added ${type} message:`, content)
    },
    [debugLog],
  )

  const handleConversationStateChange = useCallback(
    (conversationState: any) => {
      debugLog("Conversation state changed:", conversationState)

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
    [debugLog],
  )

  const handleCallEnd = useCallback(
<<<<<<< ours
    () => {
      debugLog("Call ended by conversation flow")
=======
    (reason: CallEndReason) => {
      debugLog("Call ended by conversation flow", { reason })
>>>>>>> theirs
      endCall("flow")
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debugLog],
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
  } = useConversationFlow({
    onStateChange: handleConversationStateChange,
    onMessageAdd: addMessage,
    onCallEnd: handleCallEnd,
    silenceTimeoutDuration: 15000,
    maxSilenceBeforeEnd: 30000,
  })

  const handleAudioData = useCallback(
    async (audioBlob: Blob) => {
      try {
        debugLog("Processing audio data:", audioBlob.size)
        setCallState("processing")

        const apiClient = APIClient.getInstance()
        const result = await apiClient.processConversation(audioBlob, conversationMessages)

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

          audio.onended = () => {
            debugLog("AI speech completed")

            if (aiResult.shouldContinueListening) {
              startListening()
            }
          }

          audio.onerror = (error) => {
            debugLog("Audio playback error:", error)
            if (aiResult.shouldContinueListening) {
              startListening()
            }
          }

          await audio.play()
        } else if (aiResult.shouldContinueListening) {
          startListening()
        }
      } catch (error) {
        debugLog("Error processing audio:", error)
        setCallState("connected")
        startListening()
      }
    },
    [conversationMessages, processUserMessage, processAIResponse, startListening, debugLog],
  )

  const handleAudioError = useCallback(
    (error: Error) => {
      debugLog("Audio error:", error)
      alert(`音声エラー: ${error.message}`)
      endCall("error")
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debugLog],
  )

  const { initializeAudio, startRecording, stopRecording, cleanup, isRecording, stream, audioContext } = useWebRTCAudio(
    {
      onAudioData: handleAudioData,
      onError: handleAudioError,
    },
  )

  const handleSpeechStart = useCallback(() => {
    debugLog("Speech started")
    setCallState("user-speaking")
    stopListening() // Stop silence timeout while user is speaking
  }, [debugLog, stopListening])

  const handleSpeechEnd = useCallback(() => {
    debugLog("Speech ended")
    stopVAD()
    stopRecording()
  }, [stopRecording, debugLog])

  const handleSilenceDetected = useCallback(() => {
    debugLog("Silence detected - user finished speaking")
  }, [debugLog])

  const handleMaxDurationReached = useCallback(() => {
    debugLog("Maximum speech duration reached - forcing end")
    stopRecording()
  }, [stopRecording, debugLog])

  const { startVAD, stopVAD, vadMetrics } = useVoiceActivityDetection({
    silenceThreshold: 1.2,
    volumeThreshold: 0.01,
    minSpeechDuration: 0.3,
    maxSpeechDuration: 10,
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: handleSpeechEnd,
    onSilenceDetected: handleSilenceDetected,
    onMaxDurationReached: handleMaxDurationReached,
  })

  const startCall = useCallback(async () => {
    try {
      debugLog("Starting call...")
      setCallState("connecting")

      const { stream: audioStream, audioContext: context } = await initializeAudio()
      debugLog("Audio initialized successfully")

      setCallState("connected")
      startConversation() // Use conversation flow for greeting

      const greeting = "アシスタントです。ご用件をどうぞ。"
      try {
        const r = await fetch("/api/text-to-speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: greeting }),
        })
        const { audio, mimeType } = await r.json()
        const audioUrl = `data:${mimeType};base64,${audio}`
        const audioEl = new Audio(audioUrl)
        audioEl.onended = () => {
          startListening()
        }
        await audioEl.play()
      } catch (err) {
        debugLog("Greeting audio failed", err)
        startListening()
      }
    } catch (error) {
      debugLog("Error starting call:", error)
      setCallState("idle")
      alert("マイクへのアクセスが必要です。ブラウザの設定を確認してください。")
    }
  }, [initializeAudio, startConversation, startListening, debugLog])

  const endCall = useCallback(
    (reason: "user" | "flow" | "error") => {
      debugLog(`Ending call... reason=${reason}`)

      stopVAD()
      cleanup()
      resetConversation()

      setCallState("idle")
      setMessages([])

      debugLog("Call ended")
    },
    [stopVAD, cleanup, resetConversation, debugLog],
  )

  // Start listening when conversation flow indicates
  useEffect(() => {
<<<<<<< ours
    const state = audioContext?.state
    if (
      conversationState === "listening" &&
      stream &&
      audioContext &&
      state === "running" &&
      !isRecording
    ) {
      debugLog("Starting VAD and recording based on conversation state")
      startVAD(stream, audioContext)
      startRecording()
    } else {
      debugLog("Skip VAD start (missing stream/context or not running)", {
        conversationState,
        hasStream: !!stream,
        ctxState: state,
        isRecording,
      })
    }
=======
    const setup = async () => {
      if (
        conversationState === "listening" &&
        stream &&
        audioContext &&
        !isRecording
      ) {
        if (audioContext.state === "suspended") {
          try {
            await audioContext.resume()
            debugLog("AudioContext resumed before starting VAD")
          } catch (err) {
            debugLog("Failed to resume AudioContext", err)
          }
        }

        if (audioContext.state === "running") {
          debugLog("Starting recording and VAD based on conversation state")
          await startRecording()
          startVAD(stream, audioContext)
        } else {
          debugLog("AudioContext not running, skipping VAD start", {
            state: audioContext.state,
          })
        }
      } else {
        debugLog("Skip VAD start (missing stream/context or already recording)", {
          conversationState,
          hasStream: !!stream,
          ctxState: audioContext?.state,
          isRecording,
        })
      }
    }
    setup()
>>>>>>> theirs
  }, [conversationState, stream, audioContext, isRecording, startVAD, startRecording, debugLog])
  

  // Clean up only on component unmount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    return () => {
      debugLog("Unmount cleanup: stopping audio only")
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
