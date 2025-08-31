"use client"

import { useRef, useCallback, useState } from "react"

interface WebRTCAudioOptions {
  onAudioData: (audioBlob: Blob) => void
  onError: (error: Error) => void
}

export function useWebRTCAudio({ onAudioData, onError }: WebRTCAudioOptions) {
  const [isRecording, setIsRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  const debugLog = useCallback((message: string, data?: any) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`[WebRTC Debug] ${message}`, data || "")
    }
  }, [])

  const initializeAudio = useCallback(async (): Promise<{ stream: MediaStream; audioContext: AudioContext }> => {
    try {
      debugLog("Initializing audio...")

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

      debugLog("Audio initialized successfully", {
        sampleRate: audioContext.sampleRate,
        state: audioContext.state,
      })

      return { stream, audioContext }
    } catch (error) {
      debugLog("Error initializing audio:", error)
      onError(error as Error)
      throw error
    }
  }, [onError, debugLog])

  const startRecording = useCallback(() => {
    if (!streamRef.current || isRecording) {
      debugLog("Cannot start recording - no stream or already recording")
      return
    }

    try {
      debugLog("Starting audio recording...")

      audioChunksRef.current = []

      const mediaRecorder = new MediaRecorder(streamRef.current, {
        mimeType: "audio/webm;codecs=opus",
      })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
          debugLog("Audio chunk received:", event.data.size)
        }
      }

      mediaRecorder.onstop = () => {
        debugLog("Recording stopped, creating audio blob")
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm;codecs=opus" })
        onAudioData(audioBlob)
        audioChunksRef.current = []
      }

      mediaRecorder.onerror = (event) => {
        debugLog("MediaRecorder error:", event)
        onError(new Error("Recording failed"))
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start(100) // Collect data every 100ms
      setIsRecording(true)

      debugLog("Recording started successfully")
    } catch (error) {
      debugLog("Error starting recording:", error)
      onError(error as Error)
    }
  }, [isRecording, onAudioData, onError, debugLog])

  const stopRecording = useCallback(() => {
    if (!mediaRecorderRef.current || !isRecording) {
      debugLog("Cannot stop recording - no recorder or not recording")
      return
    }

    try {
      debugLog("Stopping audio recording...")
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    } catch (error) {
      debugLog("Error stopping recording:", error)
      onError(error as Error)
    }
  }, [isRecording, onError, debugLog])

  const cleanup = useCallback(() => {
    debugLog("Cleaning up WebRTC audio resources")

    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop()
        debugLog("Stopped audio track:", track.kind)
      })
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close()
    }

    mediaRecorderRef.current = null
    streamRef.current = null
    audioContextRef.current = null
    setIsRecording(false)
  }, [isRecording, debugLog])

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
