export interface RecConfig {
  encoding: string
  sampleRateHertz?: number
  useBeta?: boolean
}

export function mapRecognitionConfig(mime: string): RecConfig | null {
  const m = mime.toLowerCase()
  if (m.includes("audio/webm")) return { encoding: "WEBM_OPUS", sampleRateHertz: 48000 }
  if (m.includes("audio/ogg")) return { encoding: "OGG_OPUS", sampleRateHertz: 48000 }
  if (m.includes("audio/wav") || m.includes("x-wav") || m.includes("wave")) return { encoding: "LINEAR16" }
  if (m.includes("audio/mpeg") || m.includes("audio/mp3")) return { encoding: "MP3", useBeta: true }
  return null
}
