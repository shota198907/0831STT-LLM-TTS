export type QueueItem = { arrayBuffer: ArrayBuffer; mime: string; seq?: number }

type Events = {
  onFirstPlayStart?: (seq?: number) => void
  onAllDrained?: () => void
}

export class AudioQueue {
  private ctx: AudioContext
  private queue: QueueItem[] = []
  private playing = false
  private firstStarted = false
  private events: Events

  constructor(ctx: AudioContext, events: Events = {}) {
    this.ctx = ctx
    this.events = events
  }

  enqueue(item: QueueItem) {
    this.queue.push(item)
    void this.playLoop()
  }

  private async decodeAudioDataSafe(arr: ArrayBuffer): Promise<AudioBuffer> {
    // Safari needs a copy sometimes
    const copy = arr.slice(0)
    return await this.ctx.decodeAudioData(copy as any)
  }

  private playBuffer(buf: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.ctx.destination)
      src.onended = () => resolve()
      src.start(0)
    })
  }

  private async playLoop() {
    if (this.playing) return
    this.playing = true
    while (this.queue.length) {
      const item = this.queue.shift()!
      if (!this.firstStarted) {
        this.firstStarted = true
        try { this.events.onFirstPlayStart?.(item.seq) } catch {}
      }
      const audioBuf = await this.decodeAudioDataSafe(item.arrayBuffer)
      await this.playBuffer(audioBuf)
    }
    this.playing = false
    this.firstStarted = false
    try { this.events.onAllDrained?.() } catch {}
  }
}

