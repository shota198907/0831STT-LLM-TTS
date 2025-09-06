"use client"

import { useRef, useCallback, useState } from "react"
import { debugLog, addCrumb } from "@/lib/debug"

interface WebRTCAudioOptions {
  onAudioData: (audioBlob: Blob) => Promise<void> | void
  onError: (error: Error) => void
}

export function useWebRTCAudio({ onAudioData, onError }: WebRTCAudioOptions) {
  const [isRecording, setIsRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const isStartingRef = useRef(false)
  const isStoppingRef = useRef(false)
  const stopPromiseRef = useRef<Promise<void> | null>(null)
  const recordStartRef = useRef<number | null>(null)


  const initializeAudio = useCallback(async (): Promise<{ stream: MediaStream; audioContext: AudioContext }> => {
    try {

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
      })
      const trackSettings = stream.getAudioTracks()[0]?.getSettings()
      debugLog("WebRTC", "stream_settings", trackSettings)


      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 48000,
      })

      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }

      streamRef.current = stream
      audioContextRef.current = audioContext

      debugLog("WebRTC", "Audio initialized", {
        sampleRate: audioContext.sampleRate,
      })
      debugLog("AudioCtx", "state", {
        state: audioContext.state,
        sampleRate: audioContext.sampleRate,
      })
      audioContext.addEventListener("statechange", () => {
        debugLog("AudioCtx", "state_change", { state: audioContext.state })
      })

      return { stream, audioContext }
    } catch (error) {
      onError(error as Error)
      throw error
    }
  }, [onError])

  const startRecording = useCallback(async () => {
    if (!streamRef.current || isRecording || isStartingRef.current) {
      debugLog("WebRTC", "startRecording skipped", {
        hasStream: !!streamRef.current,
        isRecording,
        isStarting: isStartingRef.current,
      })
      return
    }

    isStartingRef.current = true
    try {
      debugLog("REC", "rec_state", { op: "start", reason: "startRecording", from: isRecording ? "active" : "idle" })
      // 🔑 重要: ユーザー操作直後に必ず resume（モバイル/Chrome対策）
      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume()
      }
      audioChunksRef.current = []

      const mediaRecorder = new MediaRecorder(streamRef.current, {
        mimeType: "audio/webm;codecs=opus",
      })
      debugLog("MR", "new", {
        streamId: streamRef.current.id,
        tracks: streamRef.current.getTracks().map((t) => ({
          id: t.id,
          muted: t.muted,
          enabled: t.enabled,
          readyState: t.readyState,
        })),
      })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onerror = () => {
        debugLog("REC", "unexpected_stop", { where: "onerror" }, "warn")
        onError(new Error("Recording failed"))
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start(1000) // 収集間隔を1秒に変更
      setIsRecording(true)
      recordStartRef.current = performance.now()

      debugLog("MR", "start")
      debugLog("REC", "rec_state", { op: "started", reason: "mediaRecorder.start", to: "active" })

    } catch (error) {
      onError(error as Error)
    } finally {
      isStartingRef.current = false
    }
  }, [isRecording, onAudioData, onError])

  const stopRecording = useCallback(async () => {
  if (!mediaRecorderRef.current) {
    debugLog("WebRTC", "stopRecording skipped", {
      hasRecorder: false,
      isRecording,
      isStopping: isStoppingRef.current,
    })
    return
  }

  if (isStoppingRef.current && stopPromiseRef.current) {
    debugLog("WebRTC", "stopRecording awaiting existing")
    return stopPromiseRef.current
  }

  if (!isRecording) {
    debugLog("WebRTC", "stopRecording skipped", {
      hasRecorder: !!mediaRecorderRef.current,
      isRecording,
      isStopping: isStoppingRef.current,
    })
    return
  }

  debugLog("MR", "stop_invoked")

    isStoppingRef.current = true
    const recorder = mediaRecorderRef.current
    const start = performance.now()

    stopPromiseRef.current = new Promise<void>((resolve, reject) => {
      recorder.onstop = async () => {
        try {
          const audioBlob = new Blob(audioChunksRef.current, {
            type: recorder.mimeType || "audio/webm;codecs=opus",
          })
          const durationMs = recordStartRef.current
            ? performance.now() - recordStartRef.current
            : 0
          debugLog("MR", "chunk", {
            size: audioBlob.size,
            type: audioBlob.type,
          })
          debugLog("MR", "stop", {
            duration_ms: Math.round(durationMs),
          })
          recordStartRef.current = null
          await onAudioData(audioBlob)
          const end = performance.now()
          debugLog("MR", "flush_last_chunk", {
            flush_last_chunk_ms: Math.round(end - start),
          })
          audioChunksRef.current = []
          debugLog("REC", "rec_state", { op: "stop", reason: "onstop", to: "idle" })
          resolve()
        } catch (err) {
          reject(err)
        } finally {
          isStoppingRef.current = false
          stopPromiseRef.current = null
        }
      }

      try {
        recorder.requestData()
        recorder.stop()
        setIsRecording(false)
        debugLog("WebRTC", "stop command issued")
      } catch (error) {
        onError(error as Error)
        isStoppingRef.current = false
        stopPromiseRef.current = null
        reject(error)
      }
    })

    return stopPromiseRef.current
  }, [isRecording, onAudioData, onError])

  const cleanup = useCallback((source: string = "manual") => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop()
      })
    }

    debugLog("WebRTC", "cleanup", { source, hadStream: !!streamRef.current, hadRecorder: !!mediaRecorderRef.current }, "info")
    addCrumb("WebRTC", "cleanup", { source })
    mediaRecorderRef.current = null
    streamRef.current = null
    setIsRecording(false)
  }, [isRecording])

  // Dispose for true unmount: also close AudioContext
  const dispose = useCallback(async () => {
    try {
      cleanup()
    } finally {
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        try {
          await audioContextRef.current.close()
        } catch {}
      }
      audioContextRef.current = null
    }
  }, [cleanup])

  return {
    initializeAudio,
    startRecording,
    stopRecording,
    cleanup,
    dispose,
    isRecording,
    stream: streamRef.current,
    audioContext: audioContextRef.current,
  }
}
