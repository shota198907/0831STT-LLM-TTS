// デバッグログをデフォルトで有効化し、必要な場合のみ環境変数で無効化できるようにする
export const debugEnabled =
  process.env.NEXT_PUBLIC_DEBUG_LOGS !== "false" &&
  process.env.DEBUG_LOGS !== "false";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelRanks: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
if (typeof window !== "undefined") {
  const w = window as any;
  const param = new URLSearchParams(window.location.search).get("log");
  currentLevel = (w.__LOG_LEVEL || param || "info") as LogLevel;
  w.__LOG_LEVEL = currentLevel;
} else if (process.env.LOG_LEVEL) {
  currentLevel = process.env.LOG_LEVEL as LogLevel;
}

const debugEnv = {
  NEXT_PUBLIC_DEBUG_LOGS: process.env.NEXT_PUBLIC_DEBUG_LOGS,
  DEBUG_LOGS: process.env.DEBUG_LOGS,
};

if (debugEnabled) {
  const ts = performance.now();
  const tsIso = new Date(performance.timeOrigin + ts).toISOString();
  console.log(
    JSON.stringify({ tsPerf: ts, tsIso, comp: "Debug", evt: "logging_enabled", level: "info", data: debugEnv }),
  );
} else {
  const ts = performance.now();
  const tsIso = new Date(performance.timeOrigin + ts).toISOString();
  console.log(
    JSON.stringify({ tsPerf: ts, tsIso, comp: "Debug", evt: "logging_disabled", level: "info", data: debugEnv }),
  );
}

export function debugLog(
  comp: string,
  evt: string,
  payload?: any,
  level: LogLevel = "info",
) {
  if (!debugEnabled) return;
  if (levelRanks[level] < levelRanks[currentLevel]) return;
  // Throttle identical events to once per 1000ms
  const key = `${comp}|${evt}`
  const now = performance.now();
  ;(debugLog as any)._last = (debugLog as any)._last || new Map<string, number>()
  const last: Map<string, number> = (debugLog as any)._last
  const prev = last.get(key) || 0
  if (now - prev < 1000) return
  last.set(key, now)
  let callId: any,
    corrId: any,
    data: any = undefined;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    ;({ callId, corrId, ...data } = payload)
  } else if (payload !== undefined) {
    data = payload
  }
  const tsPerf = performance.now();
  const tsIso = new Date(performance.timeOrigin + tsPerf).toISOString();
  const logObject: Record<string, any> = {
    tsPerf,
    tsIso,
    comp,
    evt,
    level,
  };
  if (callId) logObject.callId = callId;
  if (corrId) logObject.corrId = corrId;
  if (data !== undefined) logObject.data = data;
  console.log(JSON.stringify(logObject));
}

// Lightweight breadcrumbs and snapshot helpers for observability
export type Any = Record<string, unknown>

const _crumbs: Any[] = []

export function addCrumb(comp: string, evt: string, data: Any = {}) {
  _crumbs.push({ ts: Date.now(), comp, evt, ...data })
  if (_crumbs.length > 50) _crumbs.shift()
}

export function dumpCrumbs() {
  return _crumbs.slice(-25)
}

export function logSnapshot(comp: string, tag: string, data: Any) {
  debugLog(comp, "snapshot", { tag, ...data }, "info")
}
