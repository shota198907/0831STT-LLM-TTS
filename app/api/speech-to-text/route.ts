import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"

export async function POST(request: NextRequest) {
  const debugLog = (message: string, data?: any) => {
    if (process.env.DEBUG_LOGGING === "true") {
      console.log(`[STT API] ${message}`, data || "")
    }
  }

  try {
    debugLog("STT API request received")

    const formData = await request.formData()
    const audioFile = formData.get("audio") as File

    if (!audioFile) {
      debugLog("No audio file provided")
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 })
    }

    debugLog("Processing audio file", {
      name: audioFile.name,
      size: audioFile.size,
      type: audioFile.type,
    })

    const audioBuffer = Buffer.from(await audioFile.arrayBuffer())

    // ← ここで MIME からエンコーディングを判定
    const mime = (audioFile.type || "").toLowerCase()
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

    if (!transcription.trim()) {
      debugLog("No transcription result")
      return NextResponse.json({ error: "No speech detected" }, { status: 400 })
    }

    debugLog("STT completed successfully", { transcription })

    return NextResponse.json({
      transcription,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    debugLog("STT API error:", error)
    return NextResponse.json({ error: `Speech-to-text processing failed: ${error}` }, { status: 500 })
  }
}
