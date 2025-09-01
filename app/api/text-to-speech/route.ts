import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"

export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json()
    debugLog("API TTS", "text", { text })

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Valid text is required" }, { status: 400 })
    }

    // Process with Google Text-to-Speech
    const googleServices = GoogleCloudServices.getInstance()
    const audioBuffer = await googleServices.textToSpeech(text)
    debugLog("API TTS", "generated", { bytes: audioBuffer.length })

    // Return audio as base64 for easy frontend consumption
    const audioBase64 = audioBuffer.toString("base64")

    return NextResponse.json({
      audio: audioBase64,
      mimeType: "audio/mpeg",
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json({ error: `Text-to-speech processing failed: ${error}` }, { status: 500 })
  }
}
