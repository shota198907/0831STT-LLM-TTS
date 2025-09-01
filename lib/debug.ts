export const debugEnabled =
  process.env.NEXT_PUBLIC_DEBUG_LOGS === "true" ||
  process.env.DEBUG_LOGS === "true"

export function debugLog(scope: string, message: string, data?: any) {
  if (!debugEnabled) return
  if (data !== undefined) {
    console.log(`[${scope}] ${message}`, data)
  } else {
    console.log(`[${scope}] ${message}`)
  }
}
