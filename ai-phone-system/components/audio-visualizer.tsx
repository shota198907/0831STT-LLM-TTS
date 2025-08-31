"use client"

import { useEffect, useRef } from "react"

interface AudioVisualizerProps {
  stream: MediaStream | null
  isActive: boolean
  className?: string
}

export function AudioVisualizer({ stream, isActive, className = "" }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  useEffect(() => {
    if (!stream || !isActive) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()

    analyser.fftSize = 64
    analyser.smoothingTimeConstant = 0.8
    source.connect(analyser)

    analyserRef.current = analyser

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const ctx = canvas.getContext("2d")!

    const draw = () => {
      if (!analyserRef.current) return

      analyserRef.current.getByteFrequencyData(dataArray)

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const barWidth = canvas.width / dataArray.length
      let x = 0

      for (let i = 0; i < dataArray.length; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height * 0.8

        // Create gradient
        const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight)
        gradient.addColorStop(0, "#3b82f6")
        gradient.addColorStop(1, "#1d4ed8")

        ctx.fillStyle = gradient
        ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight)

        x += barWidth
      }

      animationFrameRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      if (audioContext.state !== "closed") {
        audioContext.close()
      }
    }
  }, [stream, isActive])

  if (!isActive) {
    return null
  }

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <canvas ref={canvasRef} width={200} height={60} className="rounded-lg bg-gray-50 dark:bg-gray-800" />
    </div>
  )
}
