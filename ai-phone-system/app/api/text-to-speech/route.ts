import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"

export async function POST(request: NextRequest) {
  const debugLog = (message: string, data?: any) => {
    if (process.env.DEBUG_LOGGING === "true") {
      console.log(`[TTS API] ${message}`, data || "")
    }
  }

  try {
    debugLog("TTS API request received")

    const { text } = await request.json()

    if (!text || typeof text !== "string") {
      debugLog("Invalid text provided")
      return NextResponse.json({ error: "Valid text is required" }, { status: 400 })
    }

    debugLog("Processing TTS request", { text })

    // Process with Google Text-to-Speech
    const googleServices = GoogleCloudServices.getInstance()
    const audioBuffer = await googleServices.textToSpeech(text)

    debugLog("TTS completed successfully", { audioSize: audioBuffer.length })

    // Return audio as base64 for easy frontend consumption
    const audioBase64 = audioBuffer.toString("base64")

    return NextResponse.json({
      audio: audioBase64,
      mimeType: "audio/mpeg",
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    debugLog("TTS API error:", error)
    return NextResponse.json({ error: `Text-to-speech processing failed: ${error}` }, { status: 500 })
  }
}
