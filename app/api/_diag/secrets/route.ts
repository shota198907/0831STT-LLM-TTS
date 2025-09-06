export const runtime = 'nodejs'

import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const env = {
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      GOOGLE_CLOUD_PROJECT_ID: !!process.env.GOOGLE_CLOUD_PROJECT_ID,
      GOOGLE_APPLICATION_CREDENTIALS: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
      TTS_VOICE: !!process.env.TTS_VOICE,
    }
    return NextResponse.json({ status: 'ok', env })
  } catch (error) {
    return NextResponse.json({ status: 'error', error: String(error) }, { status: 500 })
  }
}

