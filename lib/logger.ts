// Minimal structured logger with level control, sampling, dedup, throttling, ring buffer
export type Level = "error" | "warn" | "info" | "debug" | "trace"

export type Log = {
  tsIso?: string
  tsPerf?: number
  build?: string
  sessionId?: string
  callId?: string
  comp: string
  evt: string
  level: Level
  data?: Record<string, any>
}

const defaultLevel: Level = "info"
const levelRank: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }

export const LogCfg = {
  levelByComp: new Map<string, Level>([["default", defaultLevel]]),
  sampling: new Map<string, number>([["VAD:summary", 0.2]]), // 20%
  burstPerSec: 200, // soft cap per second; above this, drop and emit guard log once
  ringSize: 500,
}

const ring: Log[] = []
const recentMap = new Map<string, { ts: number; hash: string; count: number }>()
let secBucket = { ts: 0, count: 0 }

// Read initial per-component levels from query/localStorage if present
;(() => {
  try {
    if (typeof window !== "undefined") {
      const search = new URLSearchParams(window.location.search)
      const q = search.get("log") || (window.localStorage && window.localStorage.getItem("LOG")) || ""
      if (q) setLogLevels(q)
    }
  } catch {}
})()

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const allow = (comp: string, lvl: Level) => levelRank[lvl] <= levelRank[LogCfg.levelByComp.get(comp) ?? LogCfg.levelByComp.get("default")!]
const keyOf = (log: Log) => `${log.comp}|${log.evt}|${log.data?.trigger ?? ""}|${log.data?.reason ?? ""}`
const hash = (o: any) => {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(o))).slice(0, 64))
  } catch {
    return String(Math.random())
  }
}

export function setLogLevels(spec: string) {
  // spec example: "vad=trace,webrtc=debug,flow=info"
  spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((p) => {
      const [k, v] = p.split("=")
      if (k && v && (v as Level) in levelRank) LogCfg.levelByComp.set(cap(k), v as Level)
    })
  try {
    if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem("LOG", spec)
  } catch {}
}

export function log(partial: Omit<Log, "tsIso" | "tsPerf">) {
  const nowPerf = performance.now()
  const nowIso = new Date().toISOString()
  const entry: Log = { tsIso: nowIso, tsPerf: nowPerf, ...partial }

  // 1) level gate
  if (!allow(entry.comp, entry.level)) return

  // 2) sampling per event
  const sampKey = `${entry.comp}:${entry.evt}`
  const rate = LogCfg.sampling.get(sampKey)
  if (rate !== undefined && Math.random() > rate) return

  // 3) burst control per second
  const bucket = Math.floor(nowPerf / 1000)
  if (secBucket.ts === 0) secBucket.ts = bucket
  if (bucket !== secBucket.ts) secBucket = { ts: bucket, count: 0 }
  secBucket.count++
  if (secBucket.count > LogCfg.burstPerSec) {
    // drop and, when first exceeding, emit guard log
    if (secBucket.count === LogCfg.burstPerSec + 1) {
      raw({ comp: "Logger", evt: "burst_guard", level: "warn", data: { burstPerSec: LogCfg.burstPerSec } })
    }
    return
  }

  // 4) deduplicate recent identical entries (within 2s)
  const k = keyOf(entry)
  const h = hash(entry.data)
  const rec = recentMap.get(k)
  if (rec && nowPerf - rec.ts < 2000 && rec.hash === h) {
    recentMap.set(k, { ts: nowPerf, hash: h, count: rec.count + 1 })
    return
  } else {
    // flush collapse summary if we had repeats
    if (rec && rec.count > 0) {
      raw({ comp: entry.comp, evt: entry.evt, level: "debug", data: { dedup: true, repeat: rec.count, lastHash: rec.hash } })
    }
    recentMap.set(k, { ts: nowPerf, hash: h, count: 0 })
  }

  // 5) emit and store in ring
  raw(entry)
}

function raw(e: Log) {
  const line = { ...e }
  const msg = `[${line.level}] ${line.comp} ${line.evt}`
  const method = line.level === "trace" ? "debug" : line.level
  ;(console as any)[method]?.(msg, line)

  ring.push(line)
  if (ring.length > LogCfg.ringSize) ring.shift()

  if (line.level === "error" || line.level === "warn") {
    ;(console as any)[line.level]("recent_logs_snapshot", ring.slice(-50))
  }
}

export function getRecentLogs(n = 50) {
  return ring.slice(-n)
}
