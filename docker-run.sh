#!/usr/bin/env bash
# docker-run.sh — Build and start the sharegrid-host container.
#
# Usage: ./docker-run.sh [--no-build]
#
# Builds the Docker image, stops any existing host container, then starts a
# new one with full hardening flags. Waits for registration with the router.
#
# Environment (required):
#   SHAREGRID_ROUTER_URL — Host registration URL from the router banner
#
# Environment (optional):
#   SHAREGRID_HOST_PORT    — Host port to publish         (default: 9000)
#   SHAREGRID_HOST_IMAGE   — Docker image name            (default: sharegrid-host)
#   MODEL_FILE             — Path to model .gguf file,    (default: models/Phi-3.5-mini-instruct-IQ2_M.gguf)
#                            relative to this directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${SHAREGRID_HOST_PORT:-9000}"
IMAGE="${SHAREGRID_HOST_IMAGE:-sharegrid-host}"
MODEL_FILE="${MODEL_FILE:-models/Phi-3.5-mini-instruct-IQ2_M.gguf}"
NETWORK=sharegrid-net
CONTAINER=sharegrid-host

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "[host] WARNING: unknown flag: $arg" ;;
  esac
done

if [[ -z "${SHAREGRID_ROUTER_URL:-}" ]]; then
  echo "[host] ERROR: SHAREGRID_ROUTER_URL is not set."
  echo "[host] Run sharegrid-router/docker-run.sh first, then export the HOST REGISTRATION URL."
  exit 1
fi

log() { echo "[host] $*"; }

# ── Build ─────────────────────────────────────────────────────────────────────

if [[ "$BUILD" -eq 1 ]]; then
  log "Building ${IMAGE}..."
  docker build \
    -f "$SCRIPT_DIR/Dockerfile" \
    --build-arg "MODEL_FILE=${MODEL_FILE}" \
    -t "$IMAGE" \
    "$SCRIPT_DIR"
else
  log "Skipping build (--no-build)."
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

docker rm -f "$CONTAINER" 2>/dev/null || true

# ── Start ─────────────────────────────────────────────────────────────────────

log "Starting ${CONTAINER}..."
docker run -d \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --security-opt no-new-privileges \
  --ipc=none \
  --restart=on-failure \
  -p "${PORT}:${PORT}" \
  -e SHAREGRID_ROUTER_URL="$SHAREGRID_ROUTER_URL" \
  -e SHAREGRID_LISTEN_PORT="$PORT" \
  "$IMAGE"

# ── Wait for registration ─────────────────────────────────────────────────────

log "Waiting for host to register with router..."
for i in $(seq 1 60); do
  if docker logs "$CONTAINER" 2>&1 | grep -q '"registered with router"'; then
    log "Host registered."
    exit 0
  fi
  sleep 1
done

log "ERROR: Host did not register with the router within 60s."
log "Host logs:"
docker logs "$CONTAINER" 2>&1 || true
exit 1
