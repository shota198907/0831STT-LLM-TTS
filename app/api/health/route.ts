import { NextResponse } from "next/server"

export async function GET() {
  try {
    // Basic health check
    const healthStatus = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      version: process.env.npm_package_version || "unknown",
      services: {
        database: "not_configured", // Will be updated when database is connected
        speech_api: process.env.GOOGLE_CLOUD_PROJECT_ID ? "configured" : "not_configured",
        gemini_api: process.env.GEMINI_API_KEY ? "configured" : "not_configured",
      },
    }

    return NextResponse.json(healthStatus)
  } catch (error) {
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
