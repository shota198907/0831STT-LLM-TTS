import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"
import { randomUUID } from "crypto"

export async function POST(request: NextRequest) {
  const corrId = request.headers.get("x-correlation-id") || randomUUID()
  try {
    const { text } = await request.json()
    debugLog("Ingress", "tts", { corr_id: corrId, text_len: text?.length || 0 })

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Valid text is required" }, { status: 400 })
    }

    // Process with Google Text-to-Speech
    const googleServices = GoogleCloudServices.getInstance()
    const audioBuffer = await googleServices.textToSpeech(text, corrId)
    debugLog("API TTS", "generated", { corr_id: corrId, bytes: audioBuffer.length })

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
