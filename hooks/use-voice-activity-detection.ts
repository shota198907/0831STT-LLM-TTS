"use client"

import { useRef, useCallback, useEffect, useState, MutableRefObject } from "react"
import { debugLog } from "@/lib/debug"

const genId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)

interface VADOptions {
  silenceThreshold: number // in seconds
  volumeThreshold: number // 0-1 scale
  minSpeechDuration: number // minimum speech duration in seconds
  minSilenceDuration: number // ignore silences shorter than this (seconds)
  maxSpeechDuration: number // maximum speech duration in seconds
  onSpeechStart: () => void
  onSpeechEnd: () => void
  onMaxDurationReached: () => void
  lastRmsRef?: MutableRefObject<number>
}

interface VADMetrics {
  currentVolume: number
  averageVolume: number
  speechDuration: number
  silenceDuration: number
  isSpeaking: boolean
}

export function useVoiceActivityDetection({
  silenceThreshold = 1.0,
  volumeThreshold = 0.03,
  minSpeechDuration = 0.3,
  minSilenceDuration = 0.3,
  maxSpeechDuration = 30,
  onSpeechStart,
  onSpeechEnd,
  onMaxDurationReached,
  lastRmsRef: externalLastRmsRef,
}: VADOptions) {
  const analyserRef = useRef<AnalyserNode | null>(null)
  const dataArrayRef = useRef<Float32Array>(new Float32Array())
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSpeakingRef = useRef(false)
  const animationFrameRef = useRef<number | null>(null)
  const speechStartTimeRef = useRef<number | null>(null)
  const silenceStartTimeRef = useRef<number | null>(null)
  const volumeHistoryRef = useRef<number[]>([])
  const lastVolumeCheckRef = useRef<number>(0)
  const lastMetricsLogRef = useRef<number>(0)
  const currentCallIdRef = useRef<string | null>(null)
  const lastRmsRef = externalLastRmsRef ?? useRef(0)
  const effectIdRef = useRef<string>(genId())
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

    analyserRef.current.getFloatTimeDomainData(dataArrayRef.current)

    // Calculate multiple volume metrics
    const sum = dataArrayRef.current.reduce((acc, value) => acc + Math.abs(value), 0)
    const average = sum / dataArrayRef.current.length
    const normalizedVolume = average

    // Calculate RMS (Root Mean Square) for better speech detection
    const rms = Math.sqrt(
      dataArrayRef.current.reduce((acc, value) => acc + value * value, 0) /
        dataArrayRef.current.length,
    )
    const peak = dataArrayRef.current.reduce(
      (m, v) => (Math.abs(v) > m ? Math.abs(v) : m),
      0,
    )

    // Maintain volume history for adaptive thresholding
    volumeHistoryRef.current.push(normalizedVolume)
    if (volumeHistoryRef.current.length > 100) {
      volumeHistoryRef.current.shift()
    }

    // Calculate adaptive threshold based on background noise
    const averageVolume =
      volumeHistoryRef.current.reduce((acc, vol) => acc + vol, 0) / volumeHistoryRef.current.length
    const adaptiveThreshold = Math.max(volumeThreshold, averageVolume * 1.5)

    const currentTime = Date.now()
    const isSpeaking = rms > adaptiveThreshold

    lastRmsRef.current = rms
    const callKey = currentCallIdRef.current ?? "global"
    const lastTs = lastMetricsLogRef.current
    if (currentTime - lastTs >= 200) {
      debugLog(
        "VAD",
        "rms",
        {
          callId: currentCallIdRef.current,
          rms: Number(rms.toFixed(3)),
          peak: Number(peak.toFixed(3)),
          isSpeaking,
        },
      )
      lastMetricsLogRef.current = currentTime
    }

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
      silenceStartTimeRef.current = null

      // Clear silence timer
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }

      // Set maximum duration timer
      maxDurationTimerRef.current = setTimeout(() => {
        debugLog("VAD", "max_duration_reached", { callId: currentCallIdRef.current })
        onMaxDurationReached()
      }, maxSpeechDuration * 1000)

      isSpeakingRef.current = true
      debugLog("VAD", "speech_start", { callId: currentCallIdRef.current })
      onSpeechStart()
    } else if (!isSpeaking && isSpeakingRef.current) {
      // Potential speech end - start silence timer
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
      }

      silenceStartTimeRef.current = silenceStartTimeRef.current ?? currentTime

      silenceTimerRef.current = setTimeout(() => {
        const speechDuration = speechStartTimeRef.current ? (Date.now() - speechStartTimeRef.current) / 1000 : 0
        const silenceDuration = silenceStartTimeRef.current ? (Date.now() - silenceStartTimeRef.current) / 1000 : 0

        // Only trigger speech end if minimum durations were met and volume stayed low
        if (
          speechDuration >= minSpeechDuration &&
          silenceDuration >= minSilenceDuration &&
          lastRmsRef.current < volumeThreshold
        ) {
          isSpeakingRef.current = false
          silenceStartTimeRef.current = null
          debugLog("VAD", "speech_end", { callId: currentCallIdRef.current, duration: speechDuration })
          onSpeechEnd()
          if (maxDurationTimerRef.current) {
            clearTimeout(maxDurationTimerRef.current)
            maxDurationTimerRef.current = null
          }
        }
      }, Math.max(silenceThreshold, minSilenceDuration) * 1000)
    }

    lastVolumeCheckRef.current = currentTime
    animationFrameRef.current = requestAnimationFrame(analyzeAudio)
  }, [
    volumeThreshold,
    silenceThreshold,
    minSpeechDuration,
    minSilenceDuration,
    maxSpeechDuration,
    onSpeechStart,
    onSpeechEnd,
    onMaxDurationReached,
  ])

  const startVAD = useCallback(
    (stream: MediaStream, audioContext: AudioContext, callId: string) => {
      if (isVADRunningRef.current) return
      try {
        currentCallIdRef.current = callId
        lastMetricsLogRef.current = 0
        const track = stream.getAudioTracks()[0]
        debugLog("VAD", "config", {
          callId,
          threshold: volumeThreshold,
          silenceSec: silenceThreshold,
          sampleRate: audioContext.sampleRate,
          fftSize: 1024,
          channelCount: track.getSettings().channelCount,
          deviceId: track.getSettings().deviceId,
        })
        const source = audioContext.createMediaStreamSource(stream)
        debugLog("VAD", "cms", {
          callId,
          streamId: stream.id,
          track: {
            id: track.id,
            muted: track.muted,
            enabled: track.enabled,
            readyState: track.readyState,
          },
        })
        const analyser = audioContext.createAnalyser()

        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.2
        analyser.minDecibels = -90
        analyser.maxDecibels = -10

        source.connect(analyser)
        const silent = audioContext.createGain()
        silent.gain.value = 0
        analyser.connect(silent)
        silent.connect(audioContext.destination)
        debugLog("VAD", "pull_through", { callId, connected: true })

        analyserRef.current = analyser
        dataArrayRef.current = new Float32Array(analyser.fftSize)

        // Reset state
        volumeHistoryRef.current = []
        speechStartTimeRef.current = null
        lastVolumeCheckRef.current = Date.now()

        isVADRunningRef.current = true
        debugLog("VAD", "vad_start", { callId })
        analyzeAudio()
      } catch (error) {
        debugLog("VAD", "error_startVAD", { callId, error })
      }
    },
    [analyzeAudio, volumeThreshold, silenceThreshold],
  )

  const stopVAD = useCallback((reason: string = "manual") => {
    if (!isVADRunningRef.current) return

    const stack =
      process.env.NODE_ENV !== "production" ? new Error().stack : undefined

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
    dataArrayRef.current = new Float32Array()
    isSpeakingRef.current = false
    speechStartTimeRef.current = null
    silenceStartTimeRef.current = null
    volumeHistoryRef.current = []

    setVadMetrics({
      currentVolume: 0,
      averageVolume: 0,
      speechDuration: 0,
      silenceDuration: 0,
      isSpeaking: false,
    })

    debugLog("VAD", "vad_stop", { callId: currentCallIdRef.current, reason, ...(stack ? { stack } : {}) })
    isVADRunningRef.current = false
  }, [])

  useEffect(() => {
    debugLog("Flow", "effect_mount", { effectId: effectIdRef.current, callId: currentCallIdRef.current })
    const interval = setInterval(() => {
      debugLog(
        "VAD",
        "summary",
        {
          callId: currentCallIdRef.current,
          avgVolume: vadMetrics.averageVolume.toFixed(3),
          currentVolume: vadMetrics.currentVolume.toFixed(3),
          isSpeaking: vadMetrics.isSpeaking,
        },
      )
    }, 1000)

    return () => {
      clearInterval(interval)
      stopVAD("hook_cleanup")
    }
  }, [stopVAD])

  return {
    startVAD,
    stopVAD,
    vadMetrics,
    lastRmsRef,
  }
}
