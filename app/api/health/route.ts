import { NextResponse } from "next/server"

export async function GET() {
  try {
    return NextResponse.json({
      status: "ok",
      uptime: process.uptime(),
      version: process.env.npm_package_version ?? "unknown",
    })
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        uptime: process.uptime(),
        version: process.env.npm_package_version ?? "unknown",
        error: error instanceof Error ? error.message : "unknown",
      },
      { status: 500 },
    )
  }
}
