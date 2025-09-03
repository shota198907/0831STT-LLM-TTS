"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { debugLog } from "@/lib/debug"

const genId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)

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
  getLastRms?: () => number
}

interface ConversationContext {
  hasAskedForMoreQuestions: boolean
  connectionCheckCount: number
  lastUserResponseTime: number
  isAwaitingEndConfirmation: boolean
  hasUserResponded: boolean
}

export function useConversationFlow({
  onStateChange,
  onMessageAdd,
  onCallEnd,
  silenceTimeoutDuration = 6000,
  maxSilenceBeforeEnd = 6000,
  getLastRms,
}: ConversationFlowOptions) {
  const [state, setState] = useState<ConversationState>("idle")
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [context, setContext] = useState<ConversationContext>({
    hasAskedForMoreQuestions: false,
    connectionCheckCount: 0,
    lastUserResponseTime: Date.now(),
    isAwaitingEndConfirmation: false,
    hasUserResponded: false,
  })
  const [callId, setCallId] = useState<string>("")

  const log = useCallback(
    (message: string, data?: any) => debugLog("ConversationFlow", message, data),
    [],
  )

  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const connectionCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const addMessage = useCallback(
    (type: "user" | "ai", content: string) => {
      const newMessage: ConversationMessage = {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`,
        type,
        content,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, newMessage])
      onMessageAdd(type, content)
      log(`addMessage_${type}`)

      // Update context based on message content
      if (type === "user") {
        setContext((prev) => ({
          ...prev,
          lastUserResponseTime: Date.now(),
        }))
      }

      return newMessage
    },
    [onMessageAdd, log],
  )

  const changeState = useCallback(
    (
      newState: ConversationState,
      reason?: string,
      extra?: { remainingSilenceMs?: number; lastRms?: number },
    ) => {
      const lastRms = extra?.lastRms ?? getLastRms?.()
      debugLog("Flow", "state_change", {
        callId,
        from: state,
        to: newState,
        reason,
        remainingSilenceMs: extra?.remainingSilenceMs,
        lastRms,
      })
      setState(newState)
      onStateChange(newState)
    },
    [state, onStateChange, callId, getLastRms],
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
    log("startSilenceTimeout")

    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current)
    }

    // If we're waiting for end confirmation, end the conversation after 8s of silence
    if (context.isAwaitingEndConfirmation) {
      silenceTimeoutRef.current = setTimeout(() => {

        const endMessage =
          "お問い合わせありがとうございました。また何かございましたらいつでもご連絡ください。失礼いたします。"
        addMessage("ai", endMessage)
        changeState("ending", "await_end_confirmation")

        setTimeout(() => {
          changeState("ended", "end_confirmation_timeout")
          onCallEnd("no-response-after-prompt")
        }, 3000)
      }, 8000)

      return
    }

    silenceTimeoutRef.current = setTimeout(() => {

      setContext((prev) => ({
        ...prev,
        connectionCheckCount: prev.connectionCheckCount + 1,
      }))

      const checkMessage = "お声届いていますでしょうか？"
      addMessage("ai", checkMessage)
      changeState("checking-connection", "silence_timeout", { remainingSilenceMs: 0 })

      // Start final timeout for disconnection
      connectionCheckTimeoutRef.current = setTimeout(() => {

        const endMessage =
          "通信が途絶えているようです。一度通信を終了いたします。何かご不明点あれば、またご連絡ください。お電話ありがとうございました。"
        addMessage("ai", endMessage)
        changeState("ending", "no_response")

        // End call after message
        setTimeout(() => {
          changeState("ended", "no_response_final")
          onCallEnd("no-response")
        }, 3000)
      }, maxSilenceBeforeEnd)
    }, silenceTimeoutDuration)
  }, [
    log,
    silenceTimeoutDuration,
    maxSilenceBeforeEnd,
    addMessage,
    changeState,
    onCallEnd,
    context.isAwaitingEndConfirmation,
  ])

  const clearAllTimeouts = useCallback(() => {
    log("clearAllTimeouts")
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current)
      silenceTimeoutRef.current = null
    }
    if (connectionCheckTimeoutRef.current) {
      clearTimeout(connectionCheckTimeoutRef.current)
      connectionCheckTimeoutRef.current = null
    }
  }, [log])

  const processUserMessage = useCallback(
    (userMessage: string) => {
      log("processUserMessage", userMessage)

      clearAllTimeouts()
      addMessage("user", userMessage)
      changeState("processing")
      setContext((prev) => ({ ...prev, hasUserResponded: true }))

      const userAnalysis = analyzeUserResponse(userMessage)

      // Handle different conversation states
      if (context.isAwaitingEndConfirmation && userAnalysis.isNegativeResponse) {

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
        setContext((prev) => ({
          ...prev,
          connectionCheckCount: 0,
        }))
      }

      return { shouldEndConversation: false }
    },
    [
      state,
      context,
      addMessage,
      changeState,
      onCallEnd,
      analyzeUserResponse,
      clearAllTimeouts,
      log,
    ],
  )

  const processAIResponse = useCallback(
    (aiResponse: string) => {
      log("processAIResponse")

      addMessage("ai", aiResponse)
      const analysis = analyzeAIResponse(aiResponse)

      if (analysis.isEndingConversation) {
        changeState("ending")

        setTimeout(() => {
          changeState("ended")
          onCallEnd("ai-ended")
        }, 3000)

        return { shouldContinueListening: false }
      }

      if (analysis.isAskingForMoreQuestions) {
        setContext((prev) => ({
          ...prev,
          hasAskedForMoreQuestions: true,
          isAwaitingEndConfirmation: true,
        }))
        changeState("waiting-for-response")
        return { shouldContinueListening: true }
      }

      if (analysis.isCheckingConnection) {
        changeState("checking-connection")
        return { shouldContinueListening: true }
      }

      // Normal conversation flow
      changeState("waiting-for-response")
      return { shouldContinueListening: true }
    },
    [addMessage, changeState, onCallEnd, analyzeAIResponse, log],
  )

  const startConversation = useCallback(() => {
    const newCallId = genId()
    setCallId(newCallId)
    log("startConversation", { callId: newCallId })
    changeState("greeting")

    const greetingMessage = "アシスタントです。ご用件をどうぞ。"
    addMessage("ai", greetingMessage)

    setTimeout(() => {
      changeState("listening")
    }, 2000)
  }, [addMessage, changeState, log])

  const startListening = useCallback(() => {
    log("startListening")
    changeState("listening")
    clearAllTimeouts()
    startSilenceTimeout()
  }, [changeState, startSilenceTimeout, clearAllTimeouts, log])

  const stopListening = useCallback(() => {
    log("stopListening")
    clearAllTimeouts()
  }, [clearAllTimeouts, log])

  const endConversation = useCallback(() => {
    log("endConversation", { callId })
    clearAllTimeouts()
    changeState("ended")
    setMessages([])
    setContext({
      hasAskedForMoreQuestions: false,
      connectionCheckCount: 0,
      lastUserResponseTime: Date.now(),
      isAwaitingEndConfirmation: false,
      hasUserResponded: false,
    })
    setCallId("")
  }, [clearAllTimeouts, changeState, log, callId])

  const resetConversation = useCallback(() => {
    log("resetConversation", { callId })
    endConversation()
    changeState("idle")
  }, [endConversation, changeState, log, callId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearAllTimeouts()
    }
  }, [clearAllTimeouts])

  return {
    state,
    callId,
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
