# AI Phone System — WS PoC

This repository contains a Next.js app (REST voice pipeline) and an optional WebSocket gateway (`ws-gateway/`) for a low-latency streaming PoC.

Important scope notes:
- Scope: WS PoC only. gRPC is not decided and MUST NOT be implemented at this stage.
- REST pipeline stays as-is for fallback and reliability.
- The WebSocket gateway runs as an independent Cloud Run service; the Next app only handles UI and REST fallback.

## WS Gateway

Directory: `ws-gateway/`

- `server.js`: Minimal HTTP + WebSocket (noServer) gateway.
  - `/healthz` returns 200 `ok`.
  - Env: `PORT`(8080), `WS_PATH`(`/ws`), `ALLOWED_ORIGIN`(comma-separated exact origins), `IDLE_SEC`(45), `MAX_MSG_BYTES`(2097152), `REQUIRE_TOKEN`(true/false), `WS_TOKEN`.
  - Upgrade path/origin/token checks; ping/pong keepalive; idle close; 2MB message cap.
  - Echo/ping-pong PoC; logs JSON `{ evt:"close", code, reason, session_id, frames, bytes }` on close.
- `Dockerfile`: Cloud Run ready.
- `cloudbuild.yaml`: Cloud Build configuration for deployment.
- `deploy-ws-gateway.sh`: Deployment script.

### Deployment

Deploy the gateway to Cloud Run:

```bash
# Set your project ID
export PROJECT_ID=your-project-id

# Deploy using the script
./scripts/deploy-ws-gateway.sh

# Or manually using gcloud
gcloud builds submit --config ws-gateway/cloudbuild.yaml
```

Set `ALLOWED_ORIGIN=https://<next-app-url>` and optionally `min-instances=1`.

## Front-end WS selection

The app connects to an external WS when available:

1. Query param `?ws=wss://host/path` (highest priority; full URL, typically ends with `/ws`)
2. Env `NEXT_PUBLIC_WS_ORIGIN=wss://host` (auto-appends `/ws` if missing)
3. Fallback to internal WS route `/api/ws/conversation`

If no WS is available/OPEN, the app falls back to REST automatically.

### Token via subprotocol

If a token is provided, the client sends it as Sec-WebSocket-Protocol during the handshake:
- Query param: `?token=XXXX`
- Env: `NEXT_PUBLIC_WS_TOKEN=XXXX`

Example: `...?ws=wss://gateway.run.app/ws&token=XXXX`

## ADR

See `docs/ADR/0001-transport-decision.md` for transport decision and scope.
