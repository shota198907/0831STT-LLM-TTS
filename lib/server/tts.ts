import { GoogleCloudServices } from "@/lib/google-services"

export async function synthesizeTTS(text: string, voice?: string): Promise<{ mime: string; audioBase64: string }> {
  const google = GoogleCloudServices.getInstance()
  const buf = await google.textToSpeech(text)
  // Current Google config returns MP3
  return { mime: "audio/mpeg", audioBase64: buf.toString("base64") }
}

