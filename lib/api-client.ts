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

      debugLog("APIClient", "processConversation_send")
      const response = await fetch(`${this.baseUrl}/api/conversation`, {
        method: "POST",
        body: formData,
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

      debugLog("APIClient", "stt_send")
      const response = await fetch(`${this.baseUrl}/api/speech-to-text`, {
        method: "POST",
        body: formData,
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
      debugLog("APIClient", "tts_send")
      const response = await fetch(`${this.baseUrl}/api/text-to-speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
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
      debugLog("APIClient", "ai_chat_send")
      const response = await fetch(`${this.baseUrl}/api/ai-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message, conversationHistory }),
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
