import { NextResponse } from "next/server"

export async function GET() {
  try {
    return NextResponse.json({ status: "ready", timestamp: new Date().toISOString() })
  } catch (error) {
    return NextResponse.json(
      { status: "not_ready", error: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    )
  }
}
