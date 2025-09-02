import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"
import { mapRecognitionConfig } from "@/lib/stt-utils"

interface ProcessConversationRequest {
  audioFile?: File
  message?: string
  conversationHistory: Array<{
    role: "user" | "assistant"
    content: string
    timestamp: string
  }>
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const audioFile = formData.get("audio") as File
    debugLog("API Conversation", "received", { hasAudio: !!audioFile })
    const conversationHistoryStr = formData.get("conversationHistory") as string

    let conversationHistory = []
    if (conversationHistoryStr) {
      try {
        conversationHistory = JSON.parse(conversationHistoryStr)
      } catch (e) {
      }
    }

    const googleServices = GoogleCloudServices.getInstance()
    let userMessage = ""

    // Process audio if provided
    if (audioFile) {
      const audioBuffer = Buffer.from(await audioFile.arrayBuffer())
const mime = (audioFile.type || "").toLowerCase()
const recCfg = mapRecognitionConfig(mime)

if (audioBuffer.length < 10_000) {
  debugLog("API Conversation", "audio_too_small", {
    bytes: audioBuffer.length,
    mime,
  })
  return NextResponse.json({ error: "Audio too small" }, { status: 400 })
}

if (!recCfg) {
  debugLog("API Conversation", "unsupported_mime", { mime })
  return NextResponse.json({ error: "Unsupported audio format" }, { status: 415 })
}

debugLog("API Conversation", "stt_start", {
  bytes: audioBuffer.length,
  mime,
  encoding: recCfg.encoding,
  sampleRate: recCfg.sampleRateHertz,
  endpoint: recCfg.useBeta ? "v1p1beta1" : "v1",
})

const { useBeta, ...sttOverrides } = recCfg as any
userMessage = await googleServices.speechToText(audioBuffer, sttOverrides)

      debugLog("API Conversation", "stt_result", { text: userMessage })

      if (!userMessage.trim()) {
        return NextResponse.json({ error: "No speech detected" }, { status: 400 })
      }
    }

    if (!userMessage) {
      return NextResponse.json({ error: "No message to process" }, { status: 400 })
    }

    // Generate AI response
    const formattedHistory = conversationHistory.map((msg: any) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    }))

    const aiResponse = await googleServices.generateResponse(userMessage, formattedHistory)
    debugLog("API Conversation", "ai_response", { length: aiResponse.length })

    // Generate TTS audio for AI response
    debugLog("API Conversation", "tts_start")
    const audioBuffer = await googleServices.textToSpeech(aiResponse)
    debugLog("API Conversation", "tts_result", { bytes: audioBuffer.length })
    const audioBase64 = audioBuffer.toString("base64")

    // Analyze conversation state
    const isEndingConversation =
      aiResponse.includes("通信を終了") || aiResponse.includes("お電話ありがとうございました")

    const isAskingForMoreQuestions =
      aiResponse.includes("問い合わせは他にありますか") || aiResponse.includes("他にご質問")

    const isCheckingConnection = aiResponse.includes("お声届いていますでしょうか")

    return NextResponse.json({
      userMessage,
      aiResponse,
      audioBase64,
      mimeType: "audio/mpeg",
      timestamp: new Date().toISOString(),
      conversationState: {
        isEndingConversation,
        isAskingForMoreQuestions,
        isCheckingConnection,
        shouldContinueListening: !isEndingConversation,
      },
    })
  } catch (error) {
    debugLog("API Conversation", "error", { error: String(error) })
    return NextResponse.json({ error: `Conversation processing failed: ${error}` }, { status: 500 })
  }
}
