# sharegrid-host

The LLMHost is the compute provider for ShareGrid. It runs an LLM (via llama.cpp) inside a hardened Docker container or natively on Apple Silicon macOS, accepting router-authenticated inference sessions.

This is the most security-critical component: it runs untrusted model weights on your hardware, and is the gatekeeper for who may open a session. Up to `SHAREGRID_MAX_SESSIONS` concurrent sessions are enforced at the process level.

## How it fits in

```
LLMRouter <──── register / heartbeat ────> LLMHost
                                               │
             direct TLS (pinned cert)          │
LLMUser ═══════════════════════════════════════╝
  sends host key token → host validates → streams inference
```

1. On startup, the host scans `SHAREGRID_MODELS_DIR` for `.gguf` model files and picks the first alphabetically.
2. It spawns `llama-server` with the selected model, waiting for the Unix socket to be ready.
3. The host generates an ephemeral TLS keypair (in memory, never written to disk) and registers with the router, sending its model metadata and TLS fingerprint.
4. The router returns a signed host key token and its Ed25519 public key.
5. The host runs a heartbeat loop; the router returns a fresh token on each heartbeat.
6. When a user connects, the host validates the token (Ed25519 signature, host ID match, freshness), then proxies prompts to llama.cpp over a Unix socket.
7. On session teardown, the host calls `DELETE /slots/<slotId>` on llama.cpp to wipe the KV cache. If that fails, the process exits so Docker restarts it cleanly.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `SHAREGRID_ROUTER_URL` | Yes | — | Router URL with `?fp=sha256:<hex>` fingerprint and `key=<base64url>` registration secret |
| `SHAREGRID_LISTEN_PORT` | Yes | — | Port for the session manager TLS listener |
| `SHAREGRID_LISTEN_HOST` | Yes | — | Address advertised to the router; must be IPv4 for `lan` mode or global IPv6 for `internet` mode; set by `docker-run.sh` or `macos-run.sh` |
| `SHAREGRID_MODELS_DIR` | Yes | `/data/models` (Docker) | Directory scanned for `.gguf` model files; first alphabetically is loaded |
| `SHAREGRID_MODEL_CONTEXT_SIZE` | No | `32768` | Context window size in tokens |
| `SHAREGRID_MAX_SESSIONS` | No | `1` | Max concurrent sessions (1–32) |
| `SHAREGRID_HEARTBEAT_INTERVAL` | No | `30` | Seconds between heartbeat pings |
| `SHAREGRID_LLAMA_BINARY` | No | `/app/llama-server` | Path to the `llama-server` binary |
| `SHAREGRID_SANDBOX_PROFILE` | No | — | Path to a `sandbox-exec` SBPL profile (macOS native only) |

## Running with Docker

The `docker-run.sh` script handles building, auto-detecting your IP, and starting the container with full hardening flags:

```sh
export SHAREGRID_ROUTER_URL="https://192.168.1.10:8443?fp=sha256:<hex>&key=<secret>"
./docker-run.sh
```

Pass `--no-build` to skip rebuilding the image.

For a manual `docker run`:

```sh
docker run \
  --cap-drop ALL \
  --read-only \
  --no-new-privileges \
  --ipc=none \
  --restart=on-failure \
  -p 9000:9000 \
  -e SHAREGRID_ROUTER_URL="tls://router.example.com:8443?fp=sha256:<hex>&key=<secret>" \
  -e SHAREGRID_LISTEN_PORT=9000 \
  -e SHAREGRID_LISTEN_HOST=192.168.1.42 \
  sharegrid-host
```

See `docker-run.example.sh` for a full example including `--tmpfs` for `/tmp` and the recommended seccomp profile.

The Docker image uses a 3-stage build:
1. **llama-builder** — compiles `llama-server` CPU-only from a pinned source tag
2. **node-builder** — runs `npm ci` and bundles the TypeScript to `dist/bundle.cjs`
3. **runtime** — `node:22-slim` image; runs as `sharegrid` user (uid 1001); models baked in from `./models/`

## Running on macOS native

macOS native mode builds `llama-server` with Metal GPU acceleration and runs it under `sandbox-exec` for defense-in-depth. Requires Apple Silicon (M1+).

```sh
export SHAREGRID_ROUTER_URL="https://192.168.1.10:8443?fp=sha256:<hex>&key=<secret>"
./macos-run.sh
```

On first run, `macos-run.sh` will:
- Build `llama-server` with Metal from the pinned `LLAMA_TAG` tag into `macos-native/bin/llama-server`.
- Bundle the TypeScript sources to `dist/bundle.cjs`.

Subsequent starts reuse the existing binary and bundle. The `macos-run.sh` script auto-detects your LAN IPv4 or global IPv6 address based on the router's network mode.

> **Security note:** `sandbox-exec` is deprecated by Apple and is **not** a substitute for a full security boundary. It restricts the inference process's filesystem and network access as a defense-in-depth layer.

See `macos-native/README.md` for troubleshooting and optional environment variables.

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
  model-scanner.ts    # Discovers .gguf model files in SHAREGRID_MODELS_DIR
  llama-launcher.ts   # Spawns llama-server child process, waits for readiness
  router-client.ts    # TLS connection to LLMRouter: registration, heartbeat loop, reconnect backoff
  session-manager.ts  # TLS server for LLMUser connections: token validation, session slots, idle timer
  inference-proxy.ts  # HTTP bridge between session manager and llama.cpp (Unix socket)
  logger.ts           # Pino logger factory
```

### Key design details

- **Ephemeral TLS keypair** is generated fresh on each startup. The fingerprint is registered with the router and distributed to users via the host list. This means after a restart the old tokens are invalid — users must re-fetch the host list.
- **Session slots** — up to `SHAREGRID_MAX_SESSIONS` concurrent sessions. Each session gets a dedicated llama.cpp KV-cache slot. New connections while all slots are occupied receive `session_reject` with reason `busy`.
- **Token validation** (`validateToken()` in `session-manager.ts`) is a pure function: (1) Ed25519 signature check, (2) host ID match, (3) freshness against `currentToken` or `previousToken` within a 60-second grace window to handle heartbeat rotation races.
- **Idle timer** — 30 minutes of inactivity closes the session with `session_timeout`.
- **KV cache wipe** — `DELETE /slots/<slotId>` is called on every session teardown to prevent cross-session data leakage. If it fails, `process.exit(1)` is called so Docker's `--restart=on-failure` brings it back in a clean state.
- **Reconnect backoff** — router disconnections are retried with exponential backoff: 1s → 2s → 4s → ... capped at 60s.
