import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"

interface ConversationMessage {
  role: "user" | "assistant"
  content: string
  timestamp: string
}

export async function POST(request: NextRequest) {
  const debugLog = (message: string, data?: any) => {
    if (process.env.DEBUG_LOGGING === "true") {
      console.log(`[AI Chat API] ${message}`, data || "")
    }
  }

  try {
    debugLog("AI Chat API request received")

    const { message, conversationHistory = [] } = await request.json()

    if (!message || typeof message !== "string") {
      debugLog("Invalid message provided")
      return NextResponse.json({ error: "Valid message is required" }, { status: 400 })
    }

    debugLog("Processing AI chat request", {
      message,
      historyLength: conversationHistory.length,
    })

    // Convert conversation history to the format expected by Gemini
    const formattedHistory = conversationHistory.map((msg: ConversationMessage) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    }))

    // Generate AI response
    const googleServices = GoogleCloudServices.getInstance()
    const aiResponse = await googleServices.generateResponse(message, formattedHistory)

    debugLog("AI response generated successfully", { response: aiResponse })

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
    debugLog("AI Chat API error:", error)
    return NextResponse.json({ error: `AI chat processing failed: ${error}` }, { status: 500 })
  }
}
