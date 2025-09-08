import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"
import { mapRecognitionConfig } from "@/lib/stt-utils"
import { transcribeAudioWebmOpusToText } from "@/lib/server/stt"
import { synthesizeTTS } from "@/lib/server/tts"
import { randomUUID } from "crypto"
import { promises as fs } from "fs"
import path from "path"
import os from "node:os";

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

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
    const ct = (request.headers.get("content-type") || "").toLowerCase()
    let conversationHistory: any[] = []

    if (ct.includes("application/json")) {
      const body = (await request.json()) as any
      const audioBase64 = body?.audioBase64 as string | undefined
      if (audioBase64) {
        audioBuffer = Buffer.from(audioBase64, "base64")
        mime = String(body?.mimeType || "audio/webm;codecs=opus").toLowerCase()
      }
      if (Array.isArray(body?.messages)) conversationHistory = body.messages
      debugLog("Ingress", "conversation_json", {
        corr_id: corrId,
        mime,
        bytes: audioBuffer?.length || 0,
      })
    } else if (ct.includes("multipart/form-data")) {
      const formData = await request.formData()
      const audioFile = formData.get("audio") as File | null
      if (audioFile) {
        audioBuffer = Buffer.from(await audioFile.arrayBuffer())
        mime = (audioFile.type || "").toLowerCase()
      }
      const conversationHistoryStr = formData.get("conversationHistory") as string
      if (conversationHistoryStr) {
        try { conversationHistory = JSON.parse(conversationHistoryStr) } catch {}
      }
      debugLog("Ingress", "conversation_multipart", {
        corr_id: corrId,
        mime,
        bytes: audioBuffer?.length || 0,
        filename: (audioFile as any)?.name,
      })
    } else if (ct.startsWith("audio/")) {
      const ab = await request.arrayBuffer()
      audioBuffer = Buffer.from(ab)
      mime = ct
      debugLog("Ingress", "conversation_audio_bin", { corr_id: corrId, mime, bytes: audioBuffer.length })
    }

    // Guard: audio required
    if (!audioBuffer || audioBuffer.length === 0) {
      return NextResponse.json(
        { ok: false, error: "no-audio", message: "audio is required", corr_id: corrId },
        { status: 400 },
      )
    }

    // Guard: required env for LLM
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "missing-env", message: "GEMINI_API_KEY is not set", corr_id: corrId },
        { status: 500 },
      )
    }

    const googleServices = GoogleCloudServices.getInstance()
    let userMessage = ""

    // Process audio if provided
    if (audioBuffer) {
      if (audioBuffer.length < 10_000) {
        debugLog("Validation", "fail", {
          corr_id: corrId,
          reason: "too_small",
          thresholds: { minBytes: 10000 },
        })
        await saveSample(audioBuffer, corrId, mime)
        debugLog("REJECT", "conversation", { corr_id: corrId, reason: "too_small", echo: { mime, bytes: audioBuffer.length } })
        return NextResponse.json(
          { ok: false, error: "audio-too-small", message: "Audio too small", corr_id: corrId },
          { status: 400 },
        )
      }

      // MIME fallback: coerce unknown or wobbly mime types to a safe default (WEBM_OPUS)
      const kind = mapMimeToRecognition(mime)
      if (!kind) {
        mime = "audio/webm;codecs=opus"
      }
      let recCfg = mapRecognitionConfig(mime)
      if (!recCfg) {
        // As a last resort, coerce to WEBM_OPUS again
        mime = "audio/webm;codecs=opus"
        recCfg = mapRecognitionConfig(mime)
        if (!recCfg) {
          debugLog("Validation", "fail", { corr_id: corrId, reason: "unsupported_mime" })
          await saveSample(audioBuffer, corrId, mime)
          debugLog("REJECT", "conversation", { corr_id: corrId, reason: "unsupported_mime", echo: { mime, bytes: audioBuffer.length } })
          return NextResponse.json(
            { ok: false, error: "unsupported-mime", message: "Unsupported audio format", corr_id: corrId },
            { status: 415 },
          )
        }
      }

      debugLog("RecCfg", "conversation", {
        corr_id: corrId,
        mime_in: mime,
        encoding: recCfg.encoding,
        sampleRateHertz: recCfg.sampleRateHertz,
      })

      debugLog("Validation", "pass", { corr_id: corrId })

      // Use shared server STT util (keeps compatibility)
      // Use shared server STT util (keeps compatibility)
      userMessage = (
        await transcribeAudioWebmOpusToText(new Blob([audioBuffer], { type: mime }) as unknown as Blob, "ja-JP")
      ).text

      if (!userMessage.trim()) {
        debugLog("Validation", "fail", { corr_id: corrId, reason: "no_speech" })
        await saveSample(audioBuffer, corrId, mime)
        debugLog("REJECT", "conversation", { corr_id: corrId, reason: "no_speech", echo: { mime, bytes: audioBuffer.length } })
        return NextResponse.json(
          { ok: false, error: "no-speech", message: "No speech detected", corr_id: corrId },
          { status: 400 },
        )
      }
    }

    if (!userMessage) {
      debugLog("Validation", "fail", { corr_id: corrId, reason: "no_message" })
      return NextResponse.json(
        { ok: false, error: "no-message", message: "No message to process", corr_id: corrId },
        { status: 400 },
      )
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
    const tts = await synthesizeTTS(aiResponse)
    debugLog("API Conversation", "tts_result", { corr_id: corrId, bytes: tts.audioBase64.length / 1.33 })
    const audioBase64 = tts.audioBase64

    // Analyze conversation state
    const isEndingConversation =
      aiResponse.includes("通信を終了") || aiResponse.includes("お電話ありがとうございました")

    const isAskingForMoreQuestions =
      aiResponse.includes("問い合わせは他にありますか") || aiResponse.includes("他にご質問")

    const isCheckingConnection = aiResponse.includes("お声届いていますでしょうか")

    return NextResponse.json({
      ok: true,
      userMessage,
      aiResponse,
      audioBase64,
      mimeType: tts.mime,
      timestamp: new Date().toISOString(),
      corr_id: corrId,
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
    return NextResponse.json(
      { ok: false, error: "internal", message: `Conversation processing failed: ${error}` , corr_id: corrId},
      { status: 500 },
    )
  }
}

// Map incoming mime to a coarse recognition kind; return null if totally unknown
function mapMimeToRecognition(mime: string) {
  const m = (mime || "").toLowerCase()
  if (m.includes("webm") && m.includes("opus")) return "WEBM_OPUS"
  if (m.includes("ogg") && m.includes("opus")) return "OGG_OPUS"
  if (m.includes("mp4")) return "MP4_AAC"
  if (m.includes("mpeg") || m.includes("mp3")) return "MP3"
  if (m.startsWith("audio/")) return "GENERIC_AUDIO"
  return null as any
}

async function saveSample(buffer: Buffer, corrId: string, mime: string) {
  const ext = mime.split("/")[1] || "bin"
  const storagePath = path.join(os.tmpdir(), `${corrId}.${ext}`)
  await fs.mkdir(path.dirname(storagePath), { recursive: true })
  await fs.writeFile(storagePath, buffer)
  debugLog("SAVE SAMPLE", "conversation", { corr_id: corrId, storage_path: storagePath })
}
