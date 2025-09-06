import { debugLog } from "@/lib/debug"

type StartFn = () => Promise<void> | void
type StopFn = () => Promise<void> | void

interface Handlers {
  start: StartFn
  stop: StopFn
  isRecording: () => boolean
  hasStream: () => boolean
}

class RecorderSoTImpl {
  private h: Handlers | null = null
  private starting = false
  private stopping = false

  init(handlers: Handlers) {
    this.h = handlers
  }

  isActive() {
    return !!this.h?.isRecording()
  }

  async start(reason: string) {
    const enabled = (process.env.NEXT_PUBLIC_FF_RECORDER_SOT ?? "true") !== "false"
    if (!enabled || !this.h) return

    if (this.starting || this.isActive()) {
      debugLog("REC", "rec_state", { op: "start_skipped", reason, active: this.isActive(), starting: this.starting })
      return
    }
    if (!this.h.hasStream()) {
      debugLog("REC", "rec_state", { op: "start_blocked", reason, hasStream: false })
      return
    }
    this.starting = true
    debugLog("REC", "rec_state", { op: "start", reason })
    try {
      await this.h.start()
      debugLog("REC", "rec_state", { op: "started", reason })
    } finally {
      this.starting = false
    }
  }

  async stop(reason: string) {
    const enabled = (process.env.NEXT_PUBLIC_FF_RECORDER_SOT ?? "true") !== "false"
    if (!enabled || !this.h) return

    if (this.stopping || !this.isActive()) {
      debugLog("REC", "rec_state", { op: "stop_skipped", reason, active: this.isActive(), stopping: this.stopping })
      return
    }
    this.stopping = true
    debugLog("REC", "rec_state", { op: "stop", reason })
    try {
      await this.h.stop()
      debugLog("REC", "rec_state", { op: "stopped", reason })
    } finally {
      this.stopping = false
    }
  }
}

export const RecorderSoT = new RecorderSoTImpl()

