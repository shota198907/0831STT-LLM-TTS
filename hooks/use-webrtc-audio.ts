"use client"

import { useRef, useCallback, useState } from "react"
import { debugLog } from "@/lib/debug"

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


  const initializeAudio = useCallback(async (): Promise<{ stream: MediaStream; audioContext: AudioContext }> => {
    try {

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      })

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      })

      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }

      streamRef.current = stream
      audioContextRef.current = audioContext

      debugLog("WebRTC", "Audio initialized", {
        sampleRate: audioContext.sampleRate,
      })

      return { stream, audioContext }
    } catch (error) {
      onError(error as Error)
      throw error
    }
  }, [onError])

  const startRecording = useCallback(async () => {
    if (!streamRef.current || isRecording || isStartingRef.current) {
      return
    }

    isStartingRef.current = true
    try {
      // 🔑 重要: ユーザー操作直後に必ず resume（モバイル/Chrome対策）
      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume()
      }
      audioChunksRef.current = []

      const mediaRecorder = new MediaRecorder(streamRef.current, {
        mimeType: "audio/webm;codecs=opus",
      })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onerror = () => {
        onError(new Error("Recording failed"))
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start(250) // 収集間隔を少し長くして安定化
      setIsRecording(true)

      debugLog("WebRTC", "Recording started")

    } catch (error) {
      onError(error as Error)
    } finally {
      isStartingRef.current = false
    }
  }, [isRecording, onAudioData, onError])

  const stopRecording = useCallback(async () => {
    if (!mediaRecorderRef.current || !isRecording || isStoppingRef.current) {
      return
    }

    isStoppingRef.current = true
    const recorder = mediaRecorderRef.current
    const start = performance.now()

    return new Promise<void>((resolve, reject) => {
      recorder.onstop = async () => {
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm;codecs=opus" })
          await onAudioData(audioBlob)
          const end = performance.now()
          debugLog("WebRTC", "Flushed last chunk", {
            flush_last_chunk_ms: Math.round(end - start),
          })
          audioChunksRef.current = []
          resolve()
        } catch (err) {
          reject(err)
        } finally {
          isStoppingRef.current = false
        }
      }

      try {
        recorder.requestData()
        recorder.stop()
        setIsRecording(false)
      } catch (error) {
        onError(error as Error)
        isStoppingRef.current = false
        reject(error)
      }
    })
  }, [isRecording, onAudioData, onError])

  const cleanup = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop()
      })
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close()
    }

    mediaRecorderRef.current = null
    streamRef.current = null
    audioContextRef.current = null
    setIsRecording(false)
  }, [isRecording])

  return {
    initializeAudio,
    startRecording,
    stopRecording,
    cleanup,
    isRecording,
    stream: streamRef.current,
    audioContext: audioContextRef.current,
  }
}
