export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { synthesizeTTS } from '@/lib/server/tts'

export async function POST(req: NextRequest) {
  try {
    const { text, voice } = await req.json()
    if (!text) return NextResponse.json({ error: 'no text' }, { status: 400 })
    const { mime, audioBase64 } = await synthesizeTTS(text, voice)
    return NextResponse.json({ mime, audioBase64 })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

