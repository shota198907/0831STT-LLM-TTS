export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { transcribeAudioWebmOpusToText } from '@/lib/server/stt'

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('audio') as File | null
    const lang = (form.get('lang') as string) || 'ja-JP'
    if (!file) return NextResponse.json({ error: 'no audio' }, { status: 400 })
    const { text } = await transcribeAudioWebmOpusToText(file as unknown as Blob, lang)
    return NextResponse.json({ text })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

