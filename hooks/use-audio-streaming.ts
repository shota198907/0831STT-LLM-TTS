"use client"

import { useCallback, useRef, useState } from "react"
import { debugLog } from "@/lib/debug"

interface UseAudioStreamingOptions {
  getStream: () => MediaStream | null
  timesliceMs?: number
  onChunk: (buf: ArrayBuffer, mime: string) => void
}

export function useAudioStreaming({ getStream, timesliceMs = 200, onChunk }: UseAudioStreamingOptions) {
  const [isRecording, setIsRecording] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const mimeRef = useRef<string>("audio/webm;codecs=opus")

  const pickMime = () => {
    try {
      // Prefer OGG Opus first; in practice some browsers produce chunks that STT handles better with OGG
      const cands = [
        "audio/ogg;codecs=opus",
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ]
      for (const m of cands) {
        if ((window as any).MediaRecorder && MediaRecorder.isTypeSupported(m)) return m
      }
      return null
    } catch {
      return null
    }
  }

  const start = useCallback(async () => {
    if (isRecording || recRef.current) return
    const stream = getStream()
    if (!stream) throw new Error("No stream available")
    const mime = pickMime()
    if (!mime) {
      console.warn("MediaRecorder unsupported")
      setIsRecording(false)
      return
    }
    mimeRef.current = mime
    const mr = new MediaRecorder(stream, { mimeType: mime })
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        ev.data.arrayBuffer().then((ab) => onChunk(ab, mimeRef.current))
      }
    }
    mr.start(timesliceMs)
    recRef.current = mr
    setIsRecording(true)
    debugLog("STRM", "rec_start", { mime, timesliceMs })
  }, [getStream, isRecording, timesliceMs, onChunk])

  const stop = useCallback(async () => {
    const mr = recRef.current
    if (!mr) return
    try {
      if (mr.state !== "inactive") mr.stop()
    } catch {}
    recRef.current = null
    setIsRecording(false)
    debugLog("STRM", "rec_stop")
  }, [])

  return { start, stop, isRecording }
}
