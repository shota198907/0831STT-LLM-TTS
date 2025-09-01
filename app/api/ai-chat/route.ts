import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"

interface ConversationMessage {
  role: "user" | "assistant"
  content: string
  timestamp: string
}

export async function POST(request: NextRequest) {
  try {
    const { message, conversationHistory = [] } = await request.json()
    debugLog("API AI-Chat", "message", { message })

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Valid message is required" }, { status: 400 })
    }

    // Convert conversation history to the format expected by Gemini
    const formattedHistory = conversationHistory.map((msg: ConversationMessage) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    }))

    // Generate AI response
    const googleServices = GoogleCloudServices.getInstance()
    const aiResponse = await googleServices.generateResponse(message, formattedHistory)
    debugLog("API AI-Chat", "ai_response", { length: aiResponse.length })

    // Check for conversation ending conditions
    const isEndingConversation =
      aiResponse.includes("通信を終了") || aiResponse.includes("お電話ありがとうございました")

    const isAskingForMoreQuestions =
      aiResponse.includes("問い合わせは他にありますか") || aiResponse.includes("他にご質問")

    return NextResponse.json({
      response: aiResponse,
      timestamp: new Date().toISOString(),
      conversationState: {
        isEndingConversation,
        isAskingForMoreQuestions,
        shouldContinueListening: !isEndingConversation,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: `AI chat processing failed: ${error}` }, { status: 500 })
  }
}
