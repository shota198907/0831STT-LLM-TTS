export type FeatureFlags = {
  streaming: {
    enabled: boolean
    sentenceTTS: boolean
  }
  bargeIn: boolean
}

// Defaults are safe/off for production; can be overridden by env or query.
export const defaultFeatureFlags: FeatureFlags = {
  streaming: {
    enabled: false,
    sentenceTTS: true,
  },
  bargeIn: false,
}

export function resolveFeatureFlags(params?: URLSearchParams): FeatureFlags {
  const q = params ?? (typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : undefined)

  const fromEnv = {
    streamingEnabled: process.env.NEXT_PUBLIC_FF_STREAMING_ENABLED,
    sentenceTTS: process.env.NEXT_PUBLIC_FF_STREAMING_SENTENCE_TTS,
    bargeIn: process.env.NEXT_PUBLIC_FF_BARGE_IN,
  }

  const val = (v: string | null | undefined) => (v == null ? undefined : /^(1|true|on|yes)$/i.test(v))

  const streamingEnabled = val(q?.get('streaming')) ?? val(fromEnv.streamingEnabled) ?? defaultFeatureFlags.streaming.enabled
  const sentenceTTS = val(q?.get('sentenceTTS')) ?? val(fromEnv.sentenceTTS) ?? defaultFeatureFlags.streaming.sentenceTTS
  const bargeIn = val(q?.get('bargeIn')) ?? val(fromEnv.bargeIn) ?? defaultFeatureFlags.bargeIn

  return {
    streaming: {
      enabled: !!streamingEnabled,
      sentenceTTS: !!sentenceTTS,
    },
    bargeIn: !!bargeIn,
  }
}

