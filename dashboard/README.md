# dashboard

Telemetry dashboard for `claude-plan-api`.

This app visualizes backend telemetry with tabs for:

- Overview (metrics + charts)
- Logs
- Requests
- Sessions
- Live SSE stream

## Run Locally

From `dashboard/`:

```bash
bun install
bun run dev
```

Then open `http://localhost:3000`.

## Backend Dependency

The dashboard expects the backend API to be running (default `http://127.0.0.1:3456`).

Start backend from repo root:

```bash
bun run src/index.ts
```

## Proxy and Env

- `BACKEND_URL` (server-side): target backend URL used by proxy route
- `NEXT_PUBLIC_API_URL` (optional): direct API URL override

Proxy route:

- `src/app/api/proxy/[...path]/route.ts`

## Main UI Routes

- `/observability` (default landing)
- `/observability/request/[traceId]` (deep-link request details)

Root route `/` redirects to `/observability`.

## Telemetry Client Modules

- `src/lib/telemetry/capture.ts`: browser event capture
- `src/lib/telemetry/buffer.ts`: IndexedDB queue and batch flush
- `src/lib/telemetry/client.ts`: API queries for logs/requests/metrics
- `src/lib/telemetry/sse.ts`: live stream handling

## Notes

- Internal telemetry flush requests are tagged to avoid self-capture loops.
- UI polling refreshes key metrics every 10 seconds.
