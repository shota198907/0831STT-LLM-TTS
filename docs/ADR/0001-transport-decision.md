# ADR-0001: Transport decision for voice streaming (PoC)

## Status
Accepted

## Context
We need a low-latency transport for voice streaming. Next.js API routes on Cloud Run do not reliably upgrade to WebSocket (101) in our setup. REST pipeline works well and must remain as a fallback.

## Decision
- WebSocket gateway is introduced as a separate Cloud Run service (`ws-gateway/`).
- Next.js app only handles UI and REST fallback.
- gRPC is not decided. We will NOT add any gRPC dependency or implementation in this PoC.

## Consequences
- Faster iteration: WS handshake is handled by a thin Node service that we fully control.
- Clear separation: transport concerns in gateway; UI and REST in Next.
- Future: If we adopt gRPC later, it will be added to the gateway (not the Next app).

## Rollback
Remove `NEXT_PUBLIC_WS_ORIGIN` and `?ws=` query; the app will use REST/internal WS only.

