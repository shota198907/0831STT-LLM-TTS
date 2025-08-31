import { SpeechClient } from "@google-cloud/speech"
import { TextToSpeechClient } from "@google-cloud/text-to-speech"
import { GoogleGenerativeAI } from "@google/generative-ai"

export class GoogleCloudServices {
  private static instance: GoogleCloudServices
  private projectId: string
  private speechClient: SpeechClient | null = null
  private ttsClient: TextToSpeechClient | null = null
  private geminiAI: GoogleGenerativeAI | null = null

  private constructor() {
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || "stt-llm-tts-470704"
    this.initializeClients()
  }

  public static getInstance(): GoogleCloudServices {
    if (!GoogleCloudServices.instance) {
      GoogleCloudServices.instance = new GoogleCloudServices()
    }
    return GoogleCloudServices.instance
  }

  private initializeClients() {
    try {
      // Initialize Speech-to-Text client
      this.speechClient = new SpeechClient({
        projectId: this.projectId,
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      })

      // Initialize Text-to-Speech client
      this.ttsClient = new TextToSpeechClient({
        projectId: this.projectId,
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      })

      // Initialize Gemini AI
      if (process.env.GEMINI_API_KEY) {
        this.geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
      }

      this.debugLog("Google Cloud clients initialized successfully")
    } catch (error) {
      this.debugLog("Error initializing Google Cloud clients:", error)
    }
  }

  // Debug logging for development
  private debugLog(message: string, data?: any) {
    if (process.env.DEBUG_LOGGING === "true") {
      console.log(`[Google Services] ${message}`, data || "")
    }
  }

  // Speech-to-Text processing method
  public async speechToText(audioBuffer: Buffer): Promise<string> {
    if (!this.speechClient) {
      throw new Error("Speech client not initialized")
    }

    try {
      this.debugLog("Processing speech-to-text", { bufferSize: audioBuffer.length })

      const request = {
        audio: {
          content: audioBuffer.toString("base64"),
        },
        config: this.getSpeechToTextConfig(),
      }

      const [response] = await this.speechClient.recognize(request)
      const transcription = response.results?.map((result) => result.alternatives?.[0]?.transcript).join("\n") || ""

      this.debugLog("STT result:", transcription)
      return transcription
    } catch (error) {
      this.debugLog("STT error:", error)
      throw new Error(`Speech-to-text failed: ${error}`)
    }
  }

  // Text-to-Speech processing method
  public async textToSpeech(text: string): Promise<Buffer> {
    if (!this.ttsClient) {
      throw new Error("TTS client not initialized")
    }

    try {
      this.debugLog("Processing text-to-speech", { text })

      const request = {
        input: { text },
        ...this.getTextToSpeechConfig(),
      }

      const [response] = await this.ttsClient.synthesizeSpeech(request)

      if (!response.audioContent) {
        throw new Error("No audio content received from TTS")
      }

      const audioBuffer = Buffer.from(response.audioContent as Uint8Array)
      this.debugLog("TTS completed", { audioSize: audioBuffer.length })

      return audioBuffer
    } catch (error) {
      this.debugLog("TTS error:", error)
      throw new Error(`Text-to-speech failed: ${error}`)
    }
  }

  // Gemini AI chat processing method
  public async generateResponse(
    userMessage: string,
    conversationHistory: Array<{ role: string; content: string }> = [],
  ): Promise<string> {
    if (!this.geminiAI) {
      throw new Error("Gemini AI not initialized")
    }

    try {
      this.debugLog("Generating AI response", { userMessage, historyLength: conversationHistory.length })

      const model = this.geminiAI.getGenerativeModel({
        model: "gemini-2.0-flash-exp",
        generationConfig: this.getGeminiConfig().generationConfig,
        safetySettings: this.getGeminiConfig().safetySettings,
      })

      // Build conversation context
      const conversationContext = conversationHistory.map((msg) => `${msg.role}: ${msg.content}`).join("\n")

      const prompt = `${this.getSystemPrompt()}

会話履歴:
${conversationContext}

ユーザー: ${userMessage}

アシスタント:`

      const result = await model.generateContent(prompt)
      const response = result.response.text()

      this.debugLog("AI response generated:", response)
      return response
    } catch (error) {
      this.debugLog("Gemini AI error:", error)
      throw new Error(`AI response generation failed: ${error}`)
    }
  }

  // Speech-to-Text configuration
  public getSpeechToTextConfig() {
    return {
      encoding: "WEBM_OPUS" as const, // sampleRateHertz omitted for auto-detection
      languageCode: "ja-JP",
      model: "latest_long",
      useEnhanced: true,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
    }
  }

  // Text-to-Speech configuration with ja-JP-Chirp3-HD-Zephyr
  public getTextToSpeechConfig() {
    return {
      voice: {
        languageCode: "ja-JP",
        name: process.env.TTS_VOICE ?? "ja-JP-Chirp3-HD-Zephyr",
        ssmlGender: "NEUTRAL" as const,
      },
      audioConfig: {
        audioEncoding: "MP3" as const,
        speakingRate: 1.0,
        pitch: 0.0,
        volumeGainDb: 0.0,
      },
    }
  }

  // Gemini 2.5 Flash configuration
  public getGeminiConfig() {
    return {
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_MEDIUM_AND_ABOVE",
        },
      ],
    }
  }

  // System prompt for AI assistant
  public getSystemPrompt(): string {
    return `あなたは丁寧で親切な電話対応AIアシスタントです。

役割:
- お客様からの問い合わせに丁寧に対応する
- 簡潔で分かりやすい回答を心がける
- 不明な点は素直に「分からない」と伝える

対応方針:
- 敬語を使用し、丁寧な言葉遣いを心がける
- 相手の話をよく聞き、適切に応答する
- 問い合わせが終了したら「他にご質問はありますか？」と確認する

制約:
- 長すぎる回答は避け、要点を簡潔に伝える
- 推測や憶測での回答は行わない
- 個人情報や機密情報は扱わない`
  }
}
