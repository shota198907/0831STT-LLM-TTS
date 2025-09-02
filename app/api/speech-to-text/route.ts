import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"
import { mapRecognitionConfig } from "@/lib/stt-utils"

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const audioFile = formData.get("audio") as File

    if (!audioFile) {
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 })
    }

    const audioBuffer = Buffer.from(await audioFile.arrayBuffer())

    const mime = (audioFile.type || "").toLowerCase()
const recCfg = mapRecognitionConfig(mime)
debugLog("API STT", "received", { mime, bytes: audioBuffer.length })

if (audioBuffer.length < 10_000) {
  debugLog("API STT", "audio_too_small", { bytes: audioBuffer.length, mime })
  return NextResponse.json({ error: "Audio too small" }, { status: 400 })
}

if (!recCfg) {
  debugLog("API STT", "unsupported_mime", { mime })
  return NextResponse.json({ error: "Unsupported audio format" }, { status: 415 })
}

    }

    const { useBeta, ...overrides } = recCfg as any

    const googleServices = GoogleCloudServices.getInstance()
    debugLog("API STT", "stt_start")
    const transcription = await googleServices.speechToText(audioBuffer, overrides)
    debugLog("API STT", "transcribed", { transcription })

    if (!transcription.trim()) {
      return NextResponse.json({ error: "No speech detected" }, { status: 400 })
    }

    return NextResponse.json({
      transcription,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    debugLog("API STT", "error", { error: String(error) })
    return NextResponse.json({ error: `Speech-to-text processing failed: ${error}` }, { status: 500 })
  }
}
