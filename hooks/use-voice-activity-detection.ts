"use client"

import { useRef, useCallback, useEffect, useState } from "react"
import { debugLog } from "@/lib/debug"

interface VADOptions {
  silenceThreshold: number // in seconds
  volumeThreshold: number // 0-1 scale
  minSpeechDuration: number // minimum speech duration in seconds
  maxSpeechDuration: number // maximum speech duration in seconds
  onSpeechStart: () => void
  onSpeechEnd: () => void
  onSilenceDetected: () => void
  onMaxDurationReached: () => void
}

interface VADMetrics {
  currentVolume: number
  averageVolume: number
  speechDuration: number
  silenceDuration: number
  isSpeaking: boolean
}

export function useVoiceActivityDetection({
  silenceThreshold = 0.8,
  volumeThreshold = 0.03,
  minSpeechDuration = 0.3,
  maxSpeechDuration = 30,
  onSpeechStart,
  onSpeechEnd,
  onSilenceDetected,
  onMaxDurationReached,
}: VADOptions) {
  const analyserRef = useRef<AnalyserNode | null>(null)
  const dataArrayRef = useRef<Uint8Array>(new Uint8Array())
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const maxDurationTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isSpeakingRef = useRef(false)
  const animationFrameRef = useRef<number | null>(null)
  const speechStartTimeRef = useRef<number | null>(null)
  const volumeHistoryRef = useRef<number[]>([])
  const lastVolumeCheckRef = useRef<number>(0)
  const isVADRunningRef = useRef(false)

  const [vadMetrics, setVadMetrics] = useState<VADMetrics>({
    currentVolume: 0,
    averageVolume: 0,
    speechDuration: 0,
    silenceDuration: 0,
    isSpeaking: false,
  })



  const analyzeAudio = useCallback(() => {
    if (!analyserRef.current || !dataArrayRef.current) return

    analyserRef.current.getByteFrequencyData(dataArrayRef.current as any)

    // Calculate multiple volume metrics
    const sum = dataArrayRef.current.reduce((acc, value) => acc + value, 0)
    const average = sum / dataArrayRef.current.length
    const normalizedVolume = average / 255

    // Calculate RMS (Root Mean Square) for better speech detection
    const rms = Math.sqrt(
      dataArrayRef.current.reduce((acc, value) => acc + (value / 255) ** 2, 0) / dataArrayRef.current.length,
    )

    // Maintain volume history for adaptive thresholding
    volumeHistoryRef.current.push(normalizedVolume)
    if (volumeHistoryRef.current.length > 100) {
      volumeHistoryRef.current.shift()
    }

    // Calculate adaptive threshold based on background noise
    const averageVolume = volumeHistoryRef.current.reduce((acc, vol) => acc + vol, 0) / volumeHistoryRef.current.length
    const adaptiveThreshold = Math.max(volumeThreshold, averageVolume * 1.5)

    const currentTime = Date.now()
    const isSpeaking = rms > adaptiveThreshold

    setVadMetrics((prev) => ({
      ...prev,
      currentVolume: normalizedVolume,
      averageVolume,
      isSpeaking,
      speechDuration:
        isSpeakingRef.current && speechStartTimeRef.current ? (currentTime - speechStartTimeRef.current) / 1000 : 0,
      silenceDuration: !isSpeakingRef.current ? (currentTime - lastVolumeCheckRef.current) / 1000 : 0,
    }))


    if (isSpeaking && !isSpeakingRef.current) {
      // Speech started
      speechStartTimeRef.current = currentTime

      // Clear silence timer
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }

      // Set maximum duration timer
      maxDurationTimerRef.current = setTimeout(() => {
        debugLog("VAD", "max_duration_reached")
        onMaxDurationReached()
      }, maxSpeechDuration * 1000)

      isSpeakingRef.current = true
      debugLog("VAD", "speech_start")
      onSpeechStart()
    } else if (!isSpeaking && isSpeakingRef.current) {
      // Potential speech end - start silence timer

      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
      }

      silenceTimerRef.current = setTimeout(() => {
        const speechDuration = speechStartTimeRef.current ? (Date.now() - speechStartTimeRef.current) / 1000 : 0

        // Only trigger speech end if minimum duration was met
        if (speechDuration >= minSpeechDuration) {
          isSpeakingRef.current = false
          debugLog("VAD", "speech_end", { duration: speechDuration })
          onSpeechEnd()
          debugLog("VAD", "silence_detected")
          onSilenceDetected()
          if (maxDurationTimerRef.current) {
            clearTimeout(maxDurationTimerRef.current)
            maxDurationTimerRef.current = null
          }
        }
      }, silenceThreshold * 1000)
    }

    lastVolumeCheckRef.current = currentTime
    animationFrameRef.current = requestAnimationFrame(analyzeAudio)
  }, [
    volumeThreshold,
    silenceThreshold,
    minSpeechDuration,
    maxSpeechDuration,
    onSpeechStart,
    onSpeechEnd,
    onSilenceDetected,
    onMaxDurationReached,
  ])

  const startVAD = useCallback(
    (stream: MediaStream, audioContext: AudioContext) => {
      if (isVADRunningRef.current) return
      try {

        const source = audioContext.createMediaStreamSource(stream)
        const analyser = audioContext.createAnalyser()

        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.3
        analyser.minDecibels = -90
        analyser.maxDecibels = -10

        source.connect(analyser)

        analyserRef.current = analyser
        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount)

        // Reset state
        volumeHistoryRef.current = []
        speechStartTimeRef.current = null
        lastVolumeCheckRef.current = Date.now()

        isVADRunningRef.current = true
        debugLog("VAD", "vad_start")
        analyzeAudio()

      } catch (error) {
      }
    },
    [analyzeAudio],
  )

  const stopVAD = useCallback(() => {
    if (!isVADRunningRef.current) return

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }

    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current)
      maxDurationTimerRef.current = null
    }

    analyserRef.current = null
    dataArrayRef.current = new Uint8Array()
    isSpeakingRef.current = false
    speechStartTimeRef.current = null
    volumeHistoryRef.current = []

    setVadMetrics({
      currentVolume: 0,
      averageVolume: 0,
      speechDuration: 0,
      silenceDuration: 0,
      isSpeaking: false,
    })

    debugLog("VAD", "vad_stop")
    isVADRunningRef.current = false
  }, [])

  useEffect(() => {
    return () => {
      stopVAD()
    }
  }, [stopVAD])

  return {
    startVAD,
    stopVAD,
    vadMetrics,
  }
}
