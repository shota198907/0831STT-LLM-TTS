// デバッグログをデフォルトで有効化し、必要な場合のみ環境変数で無効化できるようにする
export const debugEnabled =
  process.env.NEXT_PUBLIC_DEBUG_LOGS !== "false" &&
  process.env.DEBUG_LOGS !== "false";

if (debugEnabled) {
  console.log("[Debug] logging enabled");
} else {
  console.log("[Debug] logging disabled");
}

export function debugLog(scope: string, message: string, data?: any) {
  if (!debugEnabled) return;
  if (data !== undefined) {
    console.log(`[${scope}] ${message}`, data);
  } else {
    console.log(`[${scope}] ${message}`);
  }
}
