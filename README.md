# WadGateway

WadGateway is a lightweight Node.js reverse-proxy gateway for on-demand self-hosted services (for example Immich).

It can:
- show a wake page when target server/service is offline
- power on the server via WOL or WadESP-PowerSW
- poll service health and open the proxied app when ready
- proxy app traffic on the same domain (no external redirects)
- optionally create one-time boot sessions for temporary startup lifecycle logic

## Features

- Universal target service support (`TARGET_URL` + health endpoint)
- Fast offline detection (ping + short health timeout)
- Wake modes:
  - Wake-on-LAN (`WOL_MAC`)
  - WadESP-PowerSW (`WadESPPowerSW=true`, `WadESP_IP`)
- Optional temporary startup session API for `wad-agent` integration
- Works without `wad-agent` (core gateway behavior is independent)

## Requirements

- Node.js 18+
- Network access from gateway host to:
  - target server
  - target service endpoint
  - optional WadESP switch

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Default listen port is from `.env` (`PORT`).

## Configuration

1. Copy `.env.example` to `.env`
2. Set your values

Main variables:

- `PORT` - gateway port
- `TARGET_URL` - target service URL (example: `http://192.168.100.10:2283`)
- `SERVER_PING_HOST` - host used for server reachability check
- `SERVICE_HEALTH_PATH` - relative path or full URL for service health
- `SERVICE_EXPECTED_TEXT` - optional expected text fragment in health response

Wake options:

- WadESP mode:
  - `WadESPPowerSW=true`
  - `WadESP_IP=192.168.100.21`
- WOL mode:
  - `WadESPPowerSW=false`
  - `WOL_MAC=AA:BB:CC:DD:EE:FF`

Performance/timeouts:

- `PING_INTERVAL_MS`
- `STATUS_CACHE_TTL_MS`
- `PING_TIMEOUT_MS`
- `PING_SUCCESS_MIN`
- `SERVICE_CHECK_TIMEOUT_MS`
- `WAKE_TIMEOUT_MS`

Temporary boot session options (optional):

- `SERVER_ID` (example: `immich-main`)
- `TEMPORARY_REASON` (example: `immich`)
- `SESSION_TTL_SECONDS` (example: `120`)
- `SHUTDOWN_ALLOWED` (`true/false`)
- `IDLE_TIMEOUT_MINUTES` (example: `30`)

## API

### Gateway status

```http
GET /gateway-api/status
```

Returns ping + service status summary.

### Wake server

```http
POST /gateway-api/wake
```

Creates temporary startup session and triggers configured power-on method.

### Debug status

```http
GET /gateway-api/debug
```

Detailed ping/service debug response.

### Start temporary power session

```http
POST /gateway-api/power/session/start
Content-Type: application/json

{
  "serverId": "immich-main",
  "reason": "immich"
}
```

### Consume startup session (for wad-agent)

```http
POST /gateway-api/power/session/consume
Content-Type: application/json

{
  "serverId": "immich-main",
  "bootId": "linux-boot-id"
}
```

Response:
- temporary mode if valid token exists and not expired
- manual mode if no pending token

### Inspect current pending session

```http
GET /gateway-api/power/session/current?serverId=immich-main
```

## Boot Session Model

Pending one-time temporary session contains:

- `serverId`
- `token` (UUID)
- `mode` = `temporary`
- `reason`
- `createdAt`
- `expiresAt`
- `consumed`
- `bootId`
- `consumedAt`

Behavior:
- token expires automatically by TTL
- token is consumed only once
- manual boot has no token, so consume returns `mode=manual`

## Notes

- Core gateway behavior does not require `wad-agent`.
- Without agent you still get wake page, power-on, checks, and reverse proxy.
- Agent is only needed for inactivity shutdown lifecycle features.

## License

MIT. See [LICENSE](./LICENSE).
