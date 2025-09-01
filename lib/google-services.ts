import { SpeechClient } from "@google-cloud/speech"
import { TextToSpeechClient } from "@google-cloud/text-to-speech"
import { GoogleGenerativeAI, SafetySetting, HarmCategory, HarmBlockThreshold } from "@google/generative-ai"
import { debugLog } from "@/lib/debug"

type SttEncoding = "WEBM_OPUS" | "OGG_OPUS" | "LINEAR16" | "ENCODING_UNSPECIFIED"

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
      // Speech-to-Text
      this.speechClient = new SpeechClient({
        projectId: this.projectId,
        // ローカルで key ファイルを使う場合のみ指定（Cloud Run では ADC を使用）
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      })

      // Text-to-Speech
      this.ttsClient = new TextToSpeechClient({
        projectId: this.projectId,
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      })

      // Gemini
      if (process.env.GEMINI_API_KEY) {
        this.geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
      }
    } catch (error) {
    }
  }

  // ===== Speech-to-Text =====
  /**
   * 音声バッファをテキストに変換します。
   * @param audioBuffer PCM/Opus などの生バイト
   * @param configOverrides ルート側で判定したエンコーディング等を上書き
   */
  public async speechToText(
    audioBuffer: Buffer,
    configOverrides: Partial<{
      encoding: SttEncoding
      sampleRateHertz: number
      languageCode: string
    }> = {}
  ): Promise<string> {
    if (!this.speechClient) {
      throw new Error("Speech client not initialized")
    }

    try {
      const request = {
        audio: {
          content: audioBuffer.toString("base64"),
        },
        config: this.getSpeechToTextConfig(configOverrides),
      }

      debugLog("GoogleServices", "speechToText_request")
      const [response] = await this.speechClient.recognize(request)
      const transcription =
        response.results?.map((r) => r.alternatives?.[0]?.transcript).join("\n") || ""
      debugLog("GoogleServices", "speechToText_result", { transcription })
      return transcription
    } catch (error) {
      throw new Error(`Speech-to-text failed: ${error}`)
    }
  }

  /**
   * STT の基本設定。必要に応じて上書き（encoding / sampleRateHertz など）を適用。
   * - デフォルトは ENCODING_UNSPECIFIED（Google 側の自動判定）
   * - WAV(LINEAR16) のときだけ sampleRateHertz を有効化（未指定なら 16000）
   */
  public getSpeechToTextConfig(
    overrides: Partial<{
      encoding: SttEncoding
      sampleRateHertz: number
      languageCode: string
    }> = {}
  ) {
    const base = {
      encoding: "ENCODING_UNSPECIFIED" as const,
      languageCode: "ja-JP",
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      useEnhanced: true,
      model: "latest_long",
      // sampleRateHertz は必要時にのみ付与
    } as any

    const merged: any = { ...base, ...overrides }

    // LINEAR16 以外では sampleRateHertz を明示しない（Opus では不要）
    if (merged.encoding !== "LINEAR16") {
      delete merged.sampleRateHertz
    } else {
      if (!merged.sampleRateHertz) merged.sampleRateHertz = 16000
    }

    return merged
  }

  // ===== Text-to-Speech =====
  public async textToSpeech(text: string): Promise<Buffer> {
    if (!this.ttsClient) {
      throw new Error("TTS client not initialized")
    }

    try {
      const request = {
        input: { text },
        ...this.getTextToSpeechConfig(),
      }

      debugLog("GoogleServices", "textToSpeech_request", { text })
      const [response] = await this.ttsClient.synthesizeSpeech(request)

      if (!response.audioContent) {
        throw new Error("No audio content received from TTS")
      }

      const audioBuffer = Buffer.from(response.audioContent as Uint8Array)
      debugLog("GoogleServices", "textToSpeech_result", { bytes: audioBuffer.length })

      return audioBuffer
    } catch (error) {
      throw new Error(`Text-to-speech failed: ${error}`)
    }
  }

  /**
   * TTS 設定。環境変数 TTS_VOICE があればそれを優先。
   * 例: ja-JP-Chirp3-HD-Zephyr
   */
  public getTextToSpeechConfig() {
    const voiceName = process.env.TTS_VOICE || "ja-JP-Chirp3-HD-Zephyr"
    return {
      voice: {
        languageCode: "ja-JP",
        name: voiceName,
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

  // ===== Gemini (Chat) =====
  public async generateResponse(
    userMessage: string,
    conversationHistory: Array<{ role: string; content: string }> = [],
  ): Promise<string> {
    if (!this.geminiAI) {
      throw new Error("Gemini AI not initialized")
    }

    try {
      const { generationConfig, safetySettings } = this.getGeminiConfig()

      // v1beta の安定モデル（あなたの環境で通っているものを使用）
      const model = this.geminiAI.getGenerativeModel({
        model: "gemini-2.0-flash-exp",
        generationConfig,
        safetySettings,
      })

      const conversationContext = conversationHistory
        .map((msg) => `${msg.role}: ${msg.content}`)
        .join("\n")

      const prompt = `${this.getSystemPrompt()}

会話履歴:
${conversationContext}

ユーザー: ${userMessage}

アシスタント:`

      debugLog("GoogleServices", "generateResponse_request", { userMessage })
      const result = await model.generateContent(prompt)
      const response = result.response.text()
      debugLog("GoogleServices", "generateResponse_result", { length: response.length })

      return response
    } catch (error) {
      throw new Error(`AI response generation failed: ${error}`)
    }
  }

  // Gemini 設定
  public getGeminiConfig() {
    const safetySettings: SafetySetting[] = [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
    ]
    return {
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      },
      safetySettings,
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
