export type OutboundStart = {
  type: 'start'
  sessionId: string
  sampleRate: number
  lang: string
  codec: 'opus' | 'mp3' | string
}

export type OutboundEnd = { type: 'end' }

export type InboundText =
  | { type: 'stt_interim'; text: string }
  | { type: 'stt_final'; text: string }
  | { type: 'ai_text_delta'; text: string }
  | { type: 'ai_sentence'; text: string }
  | { type: 'ai_done' }

export type InboundTTSMeta = { type: 'tts_chunk'; seq: number; eos?: boolean; mime?: string }

type Events = {
  onText?: (m: InboundText) => void
  onTTS?: (meta: InboundTTSMeta, bin: ArrayBuffer) => void
  onOpen?: () => void
  onClose?: (e?: any) => void
  onError?: (e: any) => void
  onState?: (s: 'connecting' | 'open' | 'closed' | 'error') => void
}

export class StreamingClient {
  private ws: WebSocket | null = null
  private url: string
  private events: Events
  private pendingTTSMeta: InboundTTSMeta | null = null
  private stateCbs: Array<(s: 'connecting' | 'open' | 'closed' | 'error') => void> = []

  constructor(url: string, events: Events = {}) {
    this.url = url
    this.events = events
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.ws = new WebSocket(this.url)
    this.ws.binaryType = 'arraybuffer'
    this._emitState('connecting')
    this.ws.onopen = () => { this.events.onOpen?.(); this._emitState('open') }
    this.ws.onclose = (e) => { this.events.onClose?.(e); this._emitState('closed') }
    this.ws.onerror = (e) => { this.events.onError?.(e); this._emitState('error') }
    this.ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        try {
          const obj = JSON.parse(evt.data)
          if (obj?.type === 'tts_chunk') {
            this.pendingTTSMeta = obj as InboundTTSMeta
          } else {
            this.events.onText?.(obj as InboundText)
          }
        } catch {}
      } else if (evt.data instanceof ArrayBuffer) {
        if (this.pendingTTSMeta) {
          const meta = this.pendingTTSMeta
          this.pendingTTSMeta = null
          this.events.onTTS?.(meta, evt.data)
        }
      } else if (evt.data instanceof Blob) {
        const b = evt.data as Blob
        b.arrayBuffer().then((buf) => {
          if (this.pendingTTSMeta) {
            const meta = this.pendingTTSMeta
            this.pendingTTSMeta = null
            this.events.onTTS?.(meta, buf)
          }
        })
      }
    }
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  onState(cb: (s: 'connecting' | 'open' | 'closed' | 'error') => void) {
    this.stateCbs.push(cb)
  }

  send(obj: OutboundStart | OutboundEnd) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(obj))
  }

  sendBinary(bin: ArrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(bin)
  }

  close() {
    try { this.ws?.close() } catch {}
    this.ws = null
  }

  private _emitState(s: 'connecting' | 'open' | 'closed' | 'error') {
    try { this.events.onState?.(s) } catch {}
    for (const cb of this.stateCbs) { try { cb(s) } catch {} }
  }
}
