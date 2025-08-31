"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

interface VADMetrics {
  currentVolume: number
  averageVolume: number
  speechDuration: number
  silenceDuration: number
  isSpeaking: boolean
}

interface VADMonitorProps {
  metrics: VADMetrics
  isActive: boolean
  className?: string
}

export function VADMonitor({ metrics, isActive, className = "" }: VADMonitorProps) {
  if (!isActive) {
    return null
  }

  return (
    <Card className={`${className}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">音声検出モニター</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Current Volume */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span>現在の音量</span>
            <span>{(metrics.currentVolume * 100).toFixed(1)}%</span>
          </div>
          <Progress value={metrics.currentVolume * 100} className="h-2" />
        </div>

        {/* Average Volume */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span>平均音量</span>
            <span>{(metrics.averageVolume * 100).toFixed(1)}%</span>
          </div>
          <Progress value={metrics.averageVolume * 100} className="h-2" />
        </div>

        {/* Speech Status */}
        <div className="flex justify-between items-center text-xs">
          <span>音声検出</span>
          <div
            className={`px-2 py-1 rounded-full text-xs ${
              metrics.isSpeaking ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"
            }`}
          >
            {metrics.isSpeaking ? "検出中" : "待機中"}
          </div>
        </div>

        {/* Duration Info */}
        {metrics.isSpeaking && metrics.speechDuration > 0 && (
          <div className="flex justify-between text-xs">
            <span>発話時間</span>
            <span>{metrics.speechDuration.toFixed(1)}秒</span>
          </div>
        )}

        {!metrics.isSpeaking && metrics.silenceDuration > 0 && (
          <div className="flex justify-between text-xs">
            <span>無音時間</span>
            <span>{metrics.silenceDuration.toFixed(1)}秒</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
