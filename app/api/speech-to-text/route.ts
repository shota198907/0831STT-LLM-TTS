import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const audioFile = formData.get("audio") as File

    if (!audioFile) {
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 })
    }

    const audioBuffer = Buffer.from(await audioFile.arrayBuffer())

    // ← ここで MIME からエンコーディングを判定
    const mime = (audioFile.type || "").toLowerCase()
    debugLog("API STT", "received", { mime })
    let overrides: any = {}
    if (mime.includes("webm")) {
      overrides = { encoding: "WEBM_OPUS" }
    } else if (mime.includes("ogg") || mime.includes("opus")) {
      overrides = { encoding: "OGG_OPUS" }
    } else if (mime.includes("wav") || mime.includes("x-wav") || mime.includes("wave")) {
      overrides = { encoding: "LINEAR16", sampleRateHertz: 16000 }
    } else {
      // 不明なら自動判定に委ねる
      overrides = { encoding: "ENCODING_UNSPECIFIED" }
    }

    const googleServices = GoogleCloudServices.getInstance()
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
    return NextResponse.json({ error: `Speech-to-text processing failed: ${error}` }, { status: 500 })
  }
}
