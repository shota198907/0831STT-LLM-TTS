import { GoogleCloudServices } from "@/lib/google-services"
import { mapRecognitionConfig } from "@/lib/stt-utils"

export async function transcribeAudioWebmOpusToText(blob: Blob, lang: string = "ja-JP"): Promise<{ text: string }> {
  const arrayBuf = await blob.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)
  const mime = (blob as any).type || "audio/webm;codecs=opus"
  const recCfg = mapRecognitionConfig(String(mime)) || { encoding: "ENCODING_UNSPECIFIED" }

  const google = GoogleCloudServices.getInstance()
  const result = await google.speechToText(buffer, { ...recCfg, languageCode: lang })
  return { text: result.text || "" }
}

