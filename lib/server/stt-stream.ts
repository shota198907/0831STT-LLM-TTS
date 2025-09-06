import { SpeechClient } from '@google-cloud/speech'
import { EventEmitter } from 'events'

export type StartStreamingOpts = {
  lang?: string
  sampleRateHertz?: number
  encoding?: 'WEBM_OPUS' | 'OGG_OPUS' | 'LINEAR16' | 'ENCODING_UNSPECIFIED'
}

export type StreamingRecognizer = {
  write: (chunk: Buffer) => void
  end: () => void
  onInterim: (cb: (text: string) => void) => void
  onFinal: (cb: (text: string) => void) => void
  onError: (cb: (err: Error) => void) => void
}

export function startStreamingRecognizer(opts: StartStreamingOpts = {}): StreamingRecognizer {
  const client = new SpeechClient({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || undefined,
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
  })

  const emitter = new EventEmitter()

  const request = {
    config: {
      encoding: opts.encoding || 'WEBM_OPUS',
      languageCode: opts.lang || 'ja-JP',
      enableAutomaticPunctuation: true,
      // For Opus containers, Google can infer sample rate; keep optional
      ...(opts.sampleRateHertz ? { sampleRateHertz: opts.sampleRateHertz } : {}),
      useEnhanced: true,
      model: 'latest_long',
    },
    interimResults: true,
    singleUtterance: false,
  } as any

  const recognizeStream = client
    .streamingRecognize(request)
    .on('error', (e: any) => emitter.emit('error', e instanceof Error ? e : new Error(String(e))))
    .on('data', (data: any) => {
      const results = data.results || []
      for (const r of results) {
        const alt = r.alternatives?.[0]
        const text = alt?.transcript || ''
        if (!text) continue
        if (r.isFinal) emitter.emit('final', text)
        else emitter.emit('interim', text)
      }
    })

  return {
    write: (chunk: Buffer) => {
      try {
        recognizeStream.write({ audioContent: chunk })
      } catch (e) {
        emitter.emit('error', e as Error)
      }
    },
    end: () => {
      try { recognizeStream.end() } catch {}
    },
    onInterim: (cb) => { emitter.on('interim', cb) },
    onFinal: (cb) => { emitter.on('final', cb) },
    onError: (cb) => { emitter.on('error', cb) },
  }
}

