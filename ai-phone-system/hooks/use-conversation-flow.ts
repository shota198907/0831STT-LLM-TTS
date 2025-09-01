"use client"

import { useState, useCallback, useRef, useEffect } from "react"

interface ConversationMessage {
  id: string
  type: "user" | "ai"
  content: string
  timestamp: Date
}

type ConversationState =
  | "idle"
  | "greeting"
  | "listening"
  | "processing"
  | "ai-speaking"
  | "waiting-for-response"
  | "checking-connection"
  | "ending"
  | "ended"

export type CallEndReason =
  | "no-response"
  | "no-response-after-prompt"
  | "user-confirmed-end"
  | "ai-ended"

interface ConversationFlowOptions {
  onStateChange: (state: ConversationState) => void
  onMessageAdd: (type: "user" | "ai", content: string) => void
  onCallEnd: (reason: CallEndReason) => void
  silenceTimeoutDuration: number // 6 seconds for connection check
  maxSilenceBeforeEnd: number // 6 seconds after connection check
}

interface ConversationContext {
  hasAskedForMoreQuestions: boolean
  connectionCheckCount: number
  lastUserResponseTime: number
  isAwaitingEndConfirmation: boolean
}

export function useConversationFlow({
  onStateChange,
  onMessageAdd,
  onCallEnd,
  silenceTimeoutDuration = 6000,
  maxSilenceBeforeEnd = 6000,
}: ConversationFlowOptions) {
  const [state, setState] = useState<ConversationState>("idle")
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [context, setContext] = useState<ConversationContext>({
    hasAskedForMoreQuestions: false,
    connectionCheckCount: 0,
    lastUserResponseTime: Date.now(),
    isAwaitingEndConfirmation: false,
  })

  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const connectionCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const debugLog = useCallback((message: string, data?: any) => {
    if (process.env.NODE_ENV === "development") {
      console.log(`[Conversation Flow] ${message}`, data || "")
    }
  }, [])

  const addMessage = useCallback(
    (type: "user" | "ai", content: string) => {
      const newMessage: ConversationMessage = {
        id: Date.now().toString(),
        type,
        content,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, newMessage])
      onMessageAdd(type, content)

      debugLog(`Added ${type} message:`, content)

      // Update context based on message content
      if (type === "user") {
        setContext((prev) => ({
          ...prev,
          lastUserResponseTime: Date.now(),
        }))
      }

      return newMessage
    },
    [onMessageAdd, debugLog],
  )

  const changeState = useCallback(
    (newState: ConversationState) => {
      debugLog(`State change: ${state} → ${newState}`)
      setState(newState)
      onStateChange(newState)
    },
    [state, onStateChange, debugLog],
  )

  const analyzeAIResponse = useCallback((response: string) => {
    const lowerResponse = response.toLowerCase()

    const isAskingForMoreQuestions =
      lowerResponse.includes("問い合わせは他にありますか") ||
      lowerResponse.includes("他にご質問") ||
      lowerResponse.includes("他に何か") ||
      lowerResponse.includes("ほかにご質問")

    const isCheckingConnection =
      lowerResponse.includes("お声届いていますでしょうか") ||
      lowerResponse.includes("聞こえていますか") ||
      lowerResponse.includes("お声が聞こえません")

    const isEndingConversation =
      lowerResponse.includes("通信を終了") ||
      lowerResponse.includes("お電話ありがとうございました") ||
      lowerResponse.includes("失礼いたします")

    return {
      isAskingForMoreQuestions,
      isCheckingConnection,
      isEndingConversation,
    }
  }, [])

  const analyzeUserResponse = useCallback((response: string) => {
    const lowerResponse = response.toLowerCase()

    const isNegativeResponse =
      lowerResponse.includes("ないです") ||
      lowerResponse.includes("ありません") ||
      lowerResponse.includes("大丈夫です") ||
      lowerResponse.includes("結構です") ||
      lowerResponse.includes("いいえ") ||
      lowerResponse.includes("no") ||
      lowerResponse.includes("終了")

    const isPositiveResponse =
      lowerResponse.includes("あります") ||
      lowerResponse.includes("はい") ||
      lowerResponse.includes("お願いします") ||
      lowerResponse.includes("yes")

    return {
      isNegativeResponse,
      isPositiveResponse,
    }
  }, [])

  const startSilenceTimeout = useCallback(() => {
    debugLog("Starting silence timeout", { duration: silenceTimeoutDuration })

    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current)
    }

    silenceTimeoutRef.current = setTimeout(() => {
      debugLog("Silence timeout reached - checking connection")

      setContext((prev) => ({
        ...prev,
        connectionCheckCount: prev.connectionCheckCount + 1,
      }))

      const checkMessage = "お声届いていますでしょうか？"
      addMessage("ai", checkMessage)
      changeState("checking-connection")

      // Start final timeout for disconnection
      connectionCheckTimeoutRef.current = setTimeout(() => {
        debugLog("Final silence timeout - ending conversation")

        const endMessage =
          "通信が途絶えているようです。一度通信を終了いたします。何かご不明点あれば、またご連絡ください。お電話ありがとうございました。"
        addMessage("ai", endMessage)
        changeState("ending")

        // End call after message
        setTimeout(() => {
          changeState("ended")
          onCallEnd("no-response")
        }, 3000)
      }, maxSilenceBeforeEnd)
    }, silenceTimeoutDuration)
  }, [silenceTimeoutDuration, maxSilenceBeforeEnd, addMessage, changeState, onCallEnd, debugLog])

  const clearAllTimeouts = useCallback(() => {
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current)
      silenceTimeoutRef.current = null
    }
    if (connectionCheckTimeoutRef.current) {
      clearTimeout(connectionCheckTimeoutRef.current)
      connectionCheckTimeoutRef.current = null
    }
  }, [])

  const processUserMessage = useCallback(
    (userMessage: string) => {
      debugLog("Processing user message", { message: userMessage, state })

      clearAllTimeouts()
      addMessage("user", userMessage)
      changeState("processing")

      const userAnalysis = analyzeUserResponse(userMessage)

      // Handle different conversation states
      if (context.isAwaitingEndConfirmation && userAnalysis.isNegativeResponse) {
        debugLog("User confirmed no more questions - ending conversation")

        const endMessage = "承知いたしました。では、通信を終了いたします。お電話ありがとうございました。"
        addMessage("ai", endMessage)
        changeState("ending")

        setTimeout(() => {
          changeState("ended")
          onCallEnd("user-confirmed-end")
        }, 3000)

        return { shouldEndConversation: true }
      }

      if (state === "checking-connection") {
        debugLog("User responded during connection check - continuing conversation")
        setContext((prev) => ({
          ...prev,
          connectionCheckCount: 0,
        }))
      }

      return { shouldEndConversation: false }
    },
    [state, context, addMessage, changeState, onCallEnd, analyzeUserResponse, clearAllTimeouts, debugLog],
  )

  const processAIResponse = useCallback(
    (aiResponse: string) => {
      debugLog("Processing AI response", { response: aiResponse, state })

      addMessage("ai", aiResponse)
      const analysis = analyzeAIResponse(aiResponse)

      if (analysis.isEndingConversation) {
        debugLog("AI is ending conversation")
        changeState("ending")

        setTimeout(() => {
          changeState("ended")
          onCallEnd("ai-ended")
        }, 3000)

        return { shouldContinueListening: false }
      }

      if (analysis.isAskingForMoreQuestions) {
        debugLog("AI asked for more questions - awaiting confirmation")
        setContext((prev) => ({
          ...prev,
          hasAskedForMoreQuestions: true,
          isAwaitingEndConfirmation: true,
        }))
        changeState("waiting-for-response")
        return { shouldContinueListening: true }
      }

      if (analysis.isCheckingConnection) {
        debugLog("AI is checking connection")
        changeState("checking-connection")
        return { shouldContinueListening: true }
      }

      // Normal conversation flow
      changeState("waiting-for-response")
      return { shouldContinueListening: true }
    },
    [addMessage, changeState, onCallEnd, analyzeAIResponse, debugLog],
  )

  const startConversation = useCallback(() => {
    debugLog("Starting conversation")
    changeState("greeting")

    const greetingMessage = "アシスタントです。ご用件をどうぞ。"
    addMessage("ai", greetingMessage)
    // 音声再生と listening への遷移は呼び出し元で制御
  }, [addMessage, changeState, debugLog])

  const startListening = useCallback(() => {
    debugLog("Starting to listen for user input")
    changeState("listening")
    startSilenceTimeout()
  }, [changeState, startSilenceTimeout, debugLog])

  const stopListening = useCallback(() => {
    debugLog("Stopped listening")
    clearAllTimeouts()
  }, [clearAllTimeouts, debugLog])

  const endConversation = useCallback(() => {
    debugLog("Ending conversation")
    clearAllTimeouts()
    changeState("ended")
    setMessages([])
    setContext({
      hasAskedForMoreQuestions: false,
      connectionCheckCount: 0,
      lastUserResponseTime: Date.now(),
      isAwaitingEndConfirmation: false,
    })
  }, [clearAllTimeouts, changeState, debugLog])

  const resetConversation = useCallback(() => {
    debugLog("Resetting conversation")
    endConversation()
    changeState("idle")
  }, [endConversation, changeState, debugLog])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearAllTimeouts()
    }
  }, [clearAllTimeouts])

  return {
    state,
    messages,
    context,
    startConversation,
    startListening,
    stopListening,
    processUserMessage,
    processAIResponse,
    endConversation,
    resetConversation,
    clearAllTimeouts,
  }
}
