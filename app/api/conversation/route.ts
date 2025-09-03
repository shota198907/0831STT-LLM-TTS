import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"
import { mapRecognitionConfig } from "@/lib/stt-utils"
import { randomUUID } from "crypto"
import { promises as fs } from "fs"
import path from "path"

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
  const corrId = request.headers.get("x-correlation-id") || randomUUID()
  let audioBuffer: Buffer | null = null
  let mime = ""
  try {
    const formData = await request.formData()
    const audioFile = formData.get("audio") as File | null
    if (audioFile) {
      audioBuffer = Buffer.from(await audioFile.arrayBuffer())
      mime = (audioFile.type || "").toLowerCase()
    }
    debugLog("Ingress", "conversation", {
      corr_id: corrId,
      fieldExists: !!audioFile,
      mime,
      bytes: audioBuffer?.length || 0,
      filename: audioFile?.name,
    })
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
    if (audioFile && audioBuffer) {
      if (audioBuffer.length < 10_000) {
        debugLog("Validation", "fail", {
          corr_id: corrId,
          reason: "too_small",
          thresholds: { minBytes: 10000 },
        })
        await saveSample(audioBuffer, corrId, mime)
        debugLog("REJECT", "conversation", { corr_id: corrId, reason: "too_small", echo: { mime, bytes: audioBuffer.length } })
        return NextResponse.json({ error: "Audio too small" }, { status: 400 })
      }

      const recCfg = mapRecognitionConfig(mime)
      if (!recCfg) {
        debugLog("Validation", "fail", { corr_id: corrId, reason: "unsupported_mime" })
        await saveSample(audioBuffer, corrId, mime)
        debugLog("REJECT", "conversation", { corr_id: corrId, reason: "unsupported_mime", echo: { mime, bytes: audioBuffer.length } })
        return NextResponse.json({ error: "Unsupported audio format" }, { status: 415 })
      }

      debugLog("RecCfg", "conversation", {
        corr_id: corrId,
        mime_in: mime,
        encoding: recCfg.encoding,
        sampleRateHertz: recCfg.sampleRateHertz,
      })

      debugLog("Validation", "pass", { corr_id: corrId })

      const { useBeta, ...sttOverrides } = recCfg as any
      userMessage = (
        await googleServices.speechToText(audioBuffer, sttOverrides, corrId)
      ).text

      if (!userMessage.trim()) {
        debugLog("Validation", "fail", { corr_id: corrId, reason: "no_speech" })
        await saveSample(audioBuffer, corrId, mime)
        debugLog("REJECT", "conversation", { corr_id: corrId, reason: "no_speech", echo: { mime, bytes: audioBuffer.length } })
        return NextResponse.json({ error: "No speech detected" }, { status: 400 })
      }
    }

    if (!userMessage) {
      debugLog("Validation", "fail", { corr_id: corrId, reason: "no_message" })
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
    debugLog("API Conversation", "tts_start", { corr_id: corrId })
    const aiAudioBuffer = await googleServices.textToSpeech(aiResponse, corrId)
    debugLog("API Conversation", "tts_result", { corr_id: corrId, bytes: aiAudioBuffer.length })
    const audioBase64 = aiAudioBuffer.toString("base64")

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
    if (audioBuffer) {
      await saveSample(audioBuffer, corrId, mime)
    }
    debugLog("REJECT", "conversation", { corr_id: corrId, reason: "error", echo: { mime, bytes: audioBuffer?.length || 0 } })
    debugLog("API Conversation", "error", { error: String(error) })
    return NextResponse.json({ error: `Conversation processing failed: ${error}` }, { status: 500 })
  }
}

async function saveSample(buffer: Buffer, corrId: string, mime: string) {
  const ext = mime.split("/")[1] || "bin"
  const storagePath = path.join(process.cwd(), "tmp", `${corrId}.${ext}`)
  await fs.mkdir(path.dirname(storagePath), { recursive: true })
  await fs.writeFile(storagePath, buffer)
  debugLog("SAVE SAMPLE", "conversation", { corr_id: corrId, storage_path: storagePath })
}
