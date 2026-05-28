# sharegrid-host

The LLMHost is the compute provider for ShareGrid. It runs an LLM (via llama.cpp) inside a hardened Docker container and accepts only router-authenticated inference sessions.

This is the most security-critical component: it runs untrusted model weights on your hardware, and is the gatekeeper for who may open a session. One session at a time is enforced at the process level.

## How it fits in

```
LLMRouter <──── register / heartbeat ────> LLMHost
                                               │
              direct TLS (pinned cert)         │
LLMUser ═══════════════════════════════════════╝
  sends host key token → host validates → streams inference
```

1. On startup, the host generates an ephemeral TLS keypair (in memory, never written to disk) and registers with the router, sending its model metadata and TLS fingerprint.
2. The router returns a signed host key token and its Ed25519 public key.
3. The host runs a heartbeat loop; the router returns a fresh token on each heartbeat.
4. When a user connects, the host validates the token (Ed25519 signature, host ID match, freshness), then proxies prompts to llama.cpp over a Unix socket.
5. On session teardown, the host calls `DELETE /slots/0` on llama.cpp to wipe the KV cache. If that fails, the process exits so Docker restarts it cleanly.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `SHAREGRID_ROUTER_URL` | Yes | — | Router URL with `?fp=sha256:<hex>` fingerprint |
| `SHAREGRID_LISTEN_PORT` | Yes | — | Port for the session manager TLS listener |
| `SHAREGRID_MODEL_NAME` | Yes | baked in at build time | Human-readable model name reported to the router |
| `SHAREGRID_MODEL_CONTEXT_SIZE` | Yes | baked in at build time | Context window size in tokens |
| `SHAREGRID_HEARTBEAT_INTERVAL` | No | `30` | Seconds between heartbeat pings |

## Running with Docker

```sh
docker run \
  --cap-drop ALL \
  --read-only \
  --no-new-privileges \
  --ipc=none \
  --restart=on-failure \
  -p 9000:9000 \
  -e SHAREGRID_ROUTER_URL="tls://router.example.com:8443?fp=sha256:<hex>" \
  -e SHAREGRID_LISTEN_PORT=9000 \
  sharegrid-host
```

See `docker-run.example.sh` for a full example including the recommended seccomp profile and network flags.

The Docker image uses a 3-stage build:
1. **llama-builder** — compiles `llama-server` CPU-only from a pinned source tag
2. **node-builder** — runs `npm ci` and bundles the TypeScript to `dist/bundle.cjs`
3. **runtime** — distroless Node.js 22 image; no shell, no package manager, runs as `nonroot` (uid 65532)

## Development

```sh
npm install
npm run dev          # run with tsx (no build step)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test:unit
npm run test:integration
npm run build        # bundle to dist/bundle.cjs
```

Note: `npm run dev` requires a `llama-server` binary accessible at the expected Unix socket path. For local development without a real llama.cpp, mock it in the integration test setup.

## Source overview

```
src/
  index.ts            # Entry point: wires components, manages lifecycle
  config.ts           # Env var parsing and validation (zod)
  router-client.ts    # TLS connection to LLMRouter: registration, heartbeat loop, reconnect backoff
  session-manager.ts  # TLS server for LLMUser connections: token validation, session slot, idle timer
  inference-proxy.ts  # HTTP bridge between session manager and llama.cpp (Unix socket)
  logger.ts           # Pino logger factory
```

### Key design details

- **Ephemeral TLS keypair** is generated fresh on each startup. The fingerprint is registered with the router and distributed to users via the host list. This means after a restart the old tokens are invalid — users must re-fetch the host list.
- **Session slot** is a binary mutex: exactly one session at a time. New connections while a session is active receive `session_reject` with reason `host_busy`.
- **Token validation** (`validateToken()` in `session-manager.ts`) is a pure function: (1) Ed25519 signature check, (2) host ID match, (3) freshness against `currentToken` or `previousToken` within a 60-second grace window to handle heartbeat rotation races.
- **Idle timer** — 30 minutes of inactivity closes the session with `session_timeout`.
- **KV cache wipe** — `DELETE /slots/0` is called on every session teardown to prevent cross-session data leakage. If it fails, `process.exit(1)` is called so Docker's `--restart=on-failure` brings it back in a clean state.
- **Reconnect backoff** — router disconnections are retried with exponential backoff: 1s → 2s → 4s → ... capped at 60s.
