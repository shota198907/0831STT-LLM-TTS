"use client"

import { useRef, useCallback, useEffect, useState, MutableRefObject } from "react"
import { debugLog, addCrumb, dumpCrumbs, logSnapshot } from "@/lib/debug"

const genId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)

type Seconds = number
type Volume = number
export type StopReason =
  | "manual"
  | "hook_cleanup"
  | "max_duration"
  | "speech_end"
  | "unmount"
  | "error"
  | (string & {})

export interface VADOptions {
  // Threshold for detecting end-of-speech based on continuous silence length
  silenceThreshold?: Seconds
  // Volume threshold for detecting speech activity (0..1 scale)
  volumeThreshold?: Volume
  // Minimum duration required to consider it a valid speech segment
  minSpeechDuration?: Seconds
  // Minimum silence duration to confirm speech has ended
  minSilenceDuration?: Seconds
  // Hard cap on a single speech segment duration
  maxSpeechDuration?: Seconds
  onSpeechStart: () => void
  onSpeechEnd: () => void
  onMaxDurationReached: () => void
  lastRmsRef?: MutableRefObject<number>
  // guard for dev HMR/visibility unmount
  getConversationState?: () => string | undefined
  isUnmountingRef?: MutableRefObject<boolean>
  onVADReady?: () => void
  onFirstSpeechFrame?: () => void
  zeroInputWatchdogSec?: number
  onZeroInputDetected?: (durationSec: number) => void
}

export interface VADMetrics {
  currentVolume: Volume
  averageVolume: Volume
  speechDuration: Seconds
  silenceDuration: Seconds
  isSpeaking: boolean
}

export interface VADReturn {
  startVAD: (stream: MediaStream, audioContext: AudioContext, callId: string) => void
  stopVAD: (reason?: StopReason) => void
  vadMetrics: VADMetrics
  lastRmsRef: MutableRefObject<number>
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
  getConversationState,
  isUnmountingRef,
  onVADReady,
  onFirstSpeechFrame,
  zeroInputWatchdogSec,
  onZeroInputDetected,
}: VADOptions): VADReturn {
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const muteGainRef = useRef<GainNode | null>(null)
  const dataArrayRef = useRef<Float32Array | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSpeakingRef = useRef(false)
  const animationFrameRef = useRef<number | null>(null)
  const speechStartTimeRef = useRef<number | null>(null)
  const silenceStartTimeRef = useRef<number | null>(null)
  const volumeHistoryRef = useRef<number[]>([])
  const lastVolumeCheckRef = useRef(0)
  const lastMetricsLogRef = useRef<number>(0)
  const currentCallIdRef = useRef<string | null>(null)
  const lastRmsRef = (externalLastRmsRef ?? useRef(0)) as MutableRefObject<number>
  const effectIdRef = useRef<string>(genId())
  const isVADRunningRef = useRef(false)
  const getConversationStateRef = useRef<(() => string | undefined) | undefined>(undefined)
  const isUnmountingRefInternal = useRef<MutableRefObject<boolean> | undefined>(undefined)
  const vadReadyNotifiedRef = useRef(false)
  const firstSpeechNotifiedRef = useRef(false)
  const zeroInputAccumRef = useRef(0)
  const lastFrameTsRef = useRef<number | null>(null)

  // keep latest closures
  getConversationStateRef.current = getConversationState
  isUnmountingRefInternal.current = isUnmountingRef

  const [vadMetrics, setVadMetrics] = useState<VADMetrics>({
    currentVolume: 0,
    averageVolume: 0,
    speechDuration: 0,
    silenceDuration: 0,
    isSpeaking: false,
  })

  const analyzeAudio = useCallback(() => {
    if (!analyserRef.current || !dataArrayRef.current) return
    const arr = dataArrayRef.current
    analyserRef.current.getFloatTimeDomainData(arr as unknown as Float32Array<ArrayBuffer>)

    if (!vadReadyNotifiedRef.current) {
      vadReadyNotifiedRef.current = true
      try { onVADReady?.() } catch {}
    }

    let sumAbs = 0
    let sumSquares = 0
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      const av = Math.abs(v)
      sumAbs += av
      sumSquares += v * v
    }
    const average = arr.length > 0 ? sumAbs / arr.length : 0
    const normalizedVolume = average
    const rms = arr.length > 0 ? Math.sqrt(sumSquares / arr.length) : 0
    lastRmsRef.current = rms

    // maintain volume history (simple average)
    volumeHistoryRef.current.push(normalizedVolume)
    if (volumeHistoryRef.current.length > 100) volumeHistoryRef.current.shift()

    const now = performance.now()
    const speaking = normalizedVolume >= volumeThreshold

    // Zero-input watchdog accumulation (below a tiny epsilon)
    const dt = lastFrameTsRef.current ? now - lastFrameTsRef.current : 0
    lastFrameTsRef.current = now
    if (normalizedVolume <= 1e-4) {
      zeroInputAccumRef.current += dt
      const thMs = (typeof zeroInputWatchdogSec === "number" ? zeroInputWatchdogSec : 8) * 1000
      if (zeroInputAccumRef.current >= thMs) {
        // fire once per session
        if (zeroInputWatchdogSec && onZeroInputDetected) {
          try { onZeroInputDetected(zeroInputAccumRef.current / 1000) } catch {}
          // prevent repeated firing
          zeroInputAccumRef.current = -1
        }
      }
    } else if (zeroInputAccumRef.current >= 0) {
      zeroInputAccumRef.current = 0
    }

    if (speaking && !isSpeakingRef.current) {
      isSpeakingRef.current = true
      speechStartTimeRef.current = now
      silenceStartTimeRef.current = null
      onSpeechStart()
      if (!firstSpeechNotifiedRef.current) {
        firstSpeechNotifiedRef.current = true
        try { onFirstSpeechFrame?.() } catch {}
      }
      if (!maxDurationTimerRef.current) {
        maxDurationTimerRef.current = setTimeout(() => {
          onMaxDurationReached()
        }, maxSpeechDuration * 1000)
      }
    } else if (!speaking && isSpeakingRef.current) {
      if (silenceStartTimeRef.current == null) {
        silenceStartTimeRef.current = now
      }
      const silenceSec = (now - silenceStartTimeRef.current) / 1000
      const speechSec = speechStartTimeRef.current ? (now - speechStartTimeRef.current) / 1000 : 0
      if (silenceSec >= Math.max(silenceThreshold, minSilenceDuration) && speechSec >= minSpeechDuration) {
        isSpeakingRef.current = false
        speechStartTimeRef.current = null
        silenceStartTimeRef.current = null
        if (maxDurationTimerRef.current) {
          clearTimeout(maxDurationTimerRef.current)
          maxDurationTimerRef.current = null
        }
        onSpeechEnd()
      }
    }

    const speechDuration = speechStartTimeRef.current ? (now - speechStartTimeRef.current) / 1000 : 0
    const silenceDuration = silenceStartTimeRef.current ? (now - silenceStartTimeRef.current) / 1000 : 0
    setVadMetrics({
      currentVolume: normalizedVolume,
      averageVolume:
        volumeHistoryRef.current.reduce((a, b) => a + b, 0) / Math.max(1, volumeHistoryRef.current.length),
      speechDuration,
      silenceDuration,
      isSpeaking: isSpeakingRef.current,
    })

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
    lastRmsRef,
  ])

  const startVAD = useCallback(
    (stream: MediaStream, audioContext: AudioContext, callId: string) => {
      if (isVADRunningRef.current) return
      try {
        currentCallIdRef.current = callId
        lastMetricsLogRef.current = 0
        vadReadyNotifiedRef.current = false
        const track = stream.getAudioTracks()[0]
        const tset = (track && typeof track.getSettings === "function" ? track.getSettings() : {}) as any
        // Pre-start health snapshot
        logSnapshot("VAD", "pre_start", {
          callId,
          ctxState: audioContext.state,
          streamHasTrack: !!track,
          trackReadyState: track?.readyState,
          trackEnabled: track?.enabled,
          trackMuted: track?.muted,
          deviceId: tset?.deviceId,
          channelCount: tset?.channelCount,
          sampleRate: audioContext.sampleRate,
        })
        addCrumb("VAD", "pre_start", { callId, trackRS: track?.readyState })

        if (!track || track.readyState !== "live") {
          debugLog("VAD", "start_with_ended_or_missing_track", {
            callId,
            trackPresent: !!track,
            trackReadyState: track?.readyState,
          }, "warn")
        }
        debugLog("VAD", "config", {
          callId,
          threshold: volumeThreshold,
          silenceSec: silenceThreshold,
          sampleRate: audioContext.sampleRate,
          fftSize: 1024,
          channelCount: tset?.channelCount,
          deviceId: tset?.deviceId,
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
        const mute = audioContext.createGain()
        mute.gain.value = 0
        analyser.connect(mute)
        mute.connect(audioContext.destination)
        debugLog("VAD", "pull_through", { callId, connected: true })

        analyserRef.current = analyser
        sourceRef.current = source
        muteGainRef.current = mute
        dataArrayRef.current = new Float32Array(analyser.fftSize)

        // Reset state
        volumeHistoryRef.current = []
        speechStartTimeRef.current = null
        lastVolumeCheckRef.current = Date.now()
        firstSpeechNotifiedRef.current = false
        zeroInputAccumRef.current = 0
        lastFrameTsRef.current = null

        isVADRunningRef.current = true
        debugLog("VAD", "vad_start", { callId })
        addCrumb("VAD", "vad_start", { callId })
        animationFrameRef.current = requestAnimationFrame(analyzeAudio)
      } catch (error) {
        debugLog("VAD", "error_startVAD", { callId, error })
      }
    },
    [analyzeAudio, volumeThreshold, silenceThreshold],
  )

  const stopVAD = useCallback((reason: StopReason = "manual") => {
    if (!isVADRunningRef.current) return

    const stack =
      process.env.NODE_ENV !== "production" ? new Error().stack : undefined

    const convState = getConversationStateRef.current?.()
    // Snapshot before stopping
    logSnapshot("VAD", "pre_stop", {
      callId: currentCallIdRef.current ?? undefined,
      reason,
      conversationState: convState,
      speaking: isSpeakingRef.current,
      speechDur: vadMetrics.speechDuration,
      silenceDur: vadMetrics.silenceDuration,
    })
    addCrumb("VAD", "pre_stop", { reason, convState })
    const isUnmounting = isUnmountingRefInternal.current?.current

    // Guard: ignore unmount stop while listening unless true unmount
    if (reason === "unmount" && convState === "listening" && !isUnmounting) {
      debugLog("VAD", "vad_stop_guard_ignore", {
        callId: currentCallIdRef.current,
        conversationState: convState,
        reason,
        ...(stack ? { stack } : {}),
      })
      return
    }

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

    try {
      analyserRef.current?.disconnect()
      sourceRef.current?.disconnect()
      muteGainRef.current?.disconnect()
    } catch {}
    analyserRef.current = null
    sourceRef.current = null
    muteGainRef.current = null
    dataArrayRef.current = null
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

    debugLog("VAD", "vad_stop", {
      callId: currentCallIdRef.current,
      conversationState: convState,
      reason,
      ...(stack ? { stack } : {}),
      breadcrumbs: dumpCrumbs(),
    })
    addCrumb("VAD", "vad_stop", { reason })
    isVADRunningRef.current = false
  }, [vadMetrics])

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
    }, 5000)

    return () => {
      clearInterval(interval)
      // do not stop VAD here; parent controls lifecycle
    }
  }, [])

  return {
    startVAD,
    stopVAD,
    vadMetrics,
    lastRmsRef,
  }
}
