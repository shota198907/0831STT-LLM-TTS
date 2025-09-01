import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"

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
      userMessage = await googleServices.speechToText(audioBuffer)

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
    const audioBuffer = await googleServices.textToSpeech(aiResponse)
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
    return NextResponse.json({ error: `Conversation processing failed: ${error}` }, { status: 500 })
  }
}
