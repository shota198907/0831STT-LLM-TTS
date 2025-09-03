import { debugLog } from "@/lib/debug"

export class APIClient {
  private static instance: APIClient
  private baseUrl: string

  private constructor() {
    this.baseUrl = process.env.NODE_ENV === "development" ? "http://localhost:3000" : window.location.origin
  }

  public static getInstance(): APIClient {
    if (!APIClient.instance) {
      APIClient.instance = new APIClient()
    }
    return APIClient.instance
  }

  async processConversation(audioBlob: Blob, conversationHistory: any[] = []) {
    try {
      const formData = new FormData()
      formData.append("audio", audioBlob, "audio.webm")
      formData.append("conversationHistory", JSON.stringify(conversationHistory))

      const corrId = crypto.randomUUID()
      const audioField = formData.get("audio") as File | null
      debugLog("SEND", "conversation", {
        corr_id: corrId,
        hasAudio: !!audioField,
        type: audioField?.type,
        size: audioField?.size,
        name: audioField?.name,
      })
      const response = await fetch(`${this.baseUrl}/api/conversation`, {
        method: "POST",
        body: formData,
        headers: { "X-Correlation-ID": corrId },
      })

      debugLog("NET", "conversation", {
        corr_id: corrId,
        url: `${this.baseUrl}/api/conversation`,
        status: response.status,
      })

      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`)
      }

      const result = await response.json()
      debugLog("APIClient", "processConversation_ok")

      return result
    } catch (error) {
      throw error
    }
  }

  async speechToText(audioBlob: Blob) {
    try {
      const formData = new FormData()
      formData.append("audio", audioBlob, "audio.webm")

      const corrId = crypto.randomUUID()
      const audioField = formData.get("audio") as File | null
      debugLog("SEND", "stt", {
        corr_id: corrId,
        hasAudio: !!audioField,
        type: audioField?.type,
        size: audioField?.size,
        name: audioField?.name,
      })
      const response = await fetch(`${this.baseUrl}/api/speech-to-text`, {
        method: "POST",
        body: formData,
        headers: { "X-Correlation-ID": corrId },
      })

      debugLog("NET", "stt", {
        corr_id: corrId,
        url: `${this.baseUrl}/api/speech-to-text`,
        status: response.status,
      })

      if (!response.ok) {
        throw new Error(`STT request failed: ${response.statusText}`)
      }

      const result = await response.json()
      debugLog("APIClient", "stt_ok")

      return result
    } catch (error) {
      throw error
    }
  }

  async textToSpeech(text: string) {
    try {
      const corrId = crypto.randomUUID()
      debugLog("SEND", "tts", { corr_id: corrId, text_len: text.length })
      const response = await fetch(`${this.baseUrl}/api/text-to-speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": corrId,
        },
        body: JSON.stringify({ text }),
      })

      debugLog("NET", "tts", {
        corr_id: corrId,
        url: `${this.baseUrl}/api/text-to-speech`,
        status: response.status,
      })

      if (!response.ok) {
        throw new Error(`TTS request failed: ${response.statusText}`)
      }

      const result = await response.json()
      debugLog("APIClient", "tts_ok")

      return result
    } catch (error) {
      throw error
    }
  }

  async generateAIResponse(message: string, conversationHistory: any[] = []) {
    try {
      const corrId = crypto.randomUUID()
      debugLog("SEND", "ai_chat", { corr_id: corrId, text_len: message.length })
      const response = await fetch(`${this.baseUrl}/api/ai-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": corrId,
        },
        body: JSON.stringify({ message, conversationHistory }),
      })

      debugLog("NET", "ai_chat", {
        corr_id: corrId,
        url: `${this.baseUrl}/api/ai-chat`,
        status: response.status,
      })

      if (!response.ok) {
        throw new Error(`AI chat request failed: ${response.statusText}`)
      }

      const result = await response.json()
      debugLog("APIClient", "ai_chat_ok")

      return result
    } catch (error) {
      throw error
    }
  }
}
