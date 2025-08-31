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

  private debugLog(message: string, data?: any) {
    if (process.env.NODE_ENV === "development") {
      console.log(`[API Client] ${message}`, data || "")
    }
  }

  async processConversation(audioBlob: Blob, conversationHistory: any[] = []) {
    try {
      this.debugLog("Processing conversation", {
        audioSize: audioBlob.size,
        historyLength: conversationHistory.length,
      })

      const formData = new FormData()
      formData.append("audio", audioBlob, "audio.webm")
      formData.append("conversationHistory", JSON.stringify(conversationHistory))

      const response = await fetch(`${this.baseUrl}/api/conversation`, {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`)
      }

      const result = await response.json()
      this.debugLog("Conversation processed successfully", result)

      return result
    } catch (error) {
      this.debugLog("Conversation processing error:", error)
      throw error
    }
  }

  async speechToText(audioBlob: Blob) {
    try {
      this.debugLog("Converting speech to text", { audioSize: audioBlob.size })

      const formData = new FormData()
      formData.append("audio", audioBlob, "audio.webm")

      const response = await fetch(`${this.baseUrl}/api/speech-to-text`, {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`STT request failed: ${response.statusText}`)
      }

      const result = await response.json()
      this.debugLog("STT completed", result)

      return result
    } catch (error) {
      this.debugLog("STT error:", error)
      throw error
    }
  }

  async textToSpeech(text: string) {
    try {
      this.debugLog("Converting text to speech", { text })

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
      this.debugLog("TTS completed", { audioSize: result.audio?.length })

      return result
    } catch (error) {
      this.debugLog("TTS error:", error)
      throw error
    }
  }

  async generateAIResponse(message: string, conversationHistory: any[] = []) {
    try {
      this.debugLog("Generating AI response", { message, historyLength: conversationHistory.length })

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
      this.debugLog("AI response generated", result)

      return result
    } catch (error) {
      this.debugLog("AI response error:", error)
      throw error
    }
  }
}
