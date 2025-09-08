import { type NextRequest, NextResponse } from "next/server"
import { GoogleCloudServices } from "@/lib/google-services"
import { debugLog } from "@/lib/debug"
import { mapRecognitionConfig } from "@/lib/stt-utils"
import { randomUUID } from "crypto"
import { promises as fs } from "fs"
import path from "path"
import os from "node:os";

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

    debugLog("Ingress", "stt", {
      corr_id: corrId,
      fieldExists: !!audioFile,
      mime,
      bytes: audioBuffer?.length || 0,
      filename: audioFile?.name,
    })

    if (!audioFile || !audioBuffer) {
      debugLog("Validation", "fail", { corr_id: corrId, reason: "missing_field" })
      debugLog("REJECT", "stt", { corr_id: corrId, reason: "missing_field", echo: { mime: null, bytes: 0 } })
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 })
    }

    if (audioBuffer.length < 10_000) {
      debugLog("Validation", "fail", {
        corr_id: corrId,
        reason: "too_small",
        thresholds: { minBytes: 10000 },
      })
      await saveSample(audioBuffer, corrId, mime)
      debugLog("REJECT", "stt", { corr_id: corrId, reason: "too_small", echo: { mime, bytes: audioBuffer.length } })
      return NextResponse.json({ error: "Audio too small" }, { status: 400 })
    }

    const recCfg = mapRecognitionConfig(mime)
    if (!recCfg) {
      debugLog("Validation", "fail", { corr_id: corrId, reason: "unsupported_mime" })
      await saveSample(audioBuffer, corrId, mime)
      debugLog("REJECT", "stt", { corr_id: corrId, reason: "unsupported_mime", echo: { mime, bytes: audioBuffer.length } })
      return NextResponse.json({ error: "Unsupported audio format" }, { status: 415 })
    }

    debugLog("RecCfg", "stt", {
      corr_id: corrId,
      mime_in: mime,
      encoding: recCfg.encoding,
      sampleRateHertz: recCfg.sampleRateHertz,
    })

    debugLog("Validation", "pass", { corr_id: corrId })

    const { useBeta, ...overrides } = recCfg as any

    const googleServices = GoogleCloudServices.getInstance()
    const transcription = await googleServices.speechToText(audioBuffer, overrides, corrId)

    if (!transcription.text.trim()) {
      debugLog("Validation", "fail", { corr_id: corrId, reason: "no_speech" })
      await saveSample(audioBuffer, corrId, mime)
      debugLog("REJECT", "stt", { corr_id: corrId, reason: "no_speech", echo: { mime, bytes: audioBuffer.length } })
      return NextResponse.json({ error: "No speech detected" }, { status: 400 })
    }

    return NextResponse.json({
      transcription: transcription.text,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    if (audioBuffer) {
      await saveSample(audioBuffer, corrId, mime)
    }
    debugLog("REJECT", "stt", { corr_id: corrId, reason: "error", echo: { mime, bytes: audioBuffer?.length || 0 } })
    debugLog("API STT", "error", { error: String(error) })
    return NextResponse.json({ error: `Speech-to-text processing failed: ${error}` }, { status: 500 })
  }
}

async function saveSample(buffer: Buffer, corrId: string, mime: string) {
  const ext = mime.split("/")[1] || "bin"
  const storagePath = path.join(os.tmpdir(), `${corrId}.${ext}`)
  await fs.mkdir(path.dirname(storagePath), { recursive: true })
  await fs.writeFile(storagePath, buffer)
  debugLog("SAVE SAMPLE", "stt", { corr_id: corrId, storage_path: storagePath })
}
