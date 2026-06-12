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
#   SHAREGRID_ADVERTISE_IP — address that users connect to (default: auto-detected)
#   MODEL_FILE             — Path to model .gguf file,    (default: models/Phi-3.5-mini-instruct-IQ2_M.gguf)
#                            relative to this directory
#
# The network mode (lan/internet) is read from the `mode` query parameter of
# SHAREGRID_ROUTER_URL — the host advertises its IP in the family the router's
# mode dictates (IPv4 for lan, globally-routable IPv6 for internet). IPv6
# auto-detection is best-effort; set SHAREGRID_ADVERTISE_IP for a reliable result.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${SHAREGRID_HOST_PORT:-9000}"
IMAGE="${SHAREGRID_HOST_IMAGE:-sharegrid-host}"
MODEL_FILE="${MODEL_FILE:-models/Phi-3.5-mini-instruct-IQ2_M.gguf}"
CONTAINER=sharegrid-host

if [[ -z "${SHAREGRID_ROUTER_URL:-}" ]]; then
  echo "[host] ERROR: SHAREGRID_ROUTER_URL is not set."
  echo "[host] Run sharegrid-router/docker-run.sh first, then export the HOST REGISTRATION URL."
  exit 1
fi

# Derive the network mode from the router URL's `mode` query parameter.
if [[ "$SHAREGRID_ROUTER_URL" == *"mode=internet"* ]]; then
  MODE=internet
else
  MODE=lan
fi

# Detect the host machine's LAN IPv4 address. A container on a bridge network
# cannot see this itself, so it must be injected from the host OS and advertised
# to the router as the endpoint users dial directly.
detect_lan_ip() {
  case "$(uname -s)" in
    Darwin)
      for iface in $(ipconfig getiflist 2>/dev/null); do
        ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
        [[ -n "$ip" ]] && { echo "$ip"; return 0; }
      done
      ;;
    *)
      ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
      [[ -n "$ip" ]] && { echo "$ip"; return 0; }
      ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
      [[ -n "$ip" ]] && { echo "$ip"; return 0; }
      ;;
  esac
  return 1
}

# Best-effort detection of a globally-routable IPv6 address. Excludes loopback
# (::1), link-local (fe80::/10) and unique-local (fc00::/7). Unreliable across
# environments — prefer setting SHAREGRID_ADVERTISE_IP explicitly.
detect_global_ipv6() {
  case "$(uname -s)" in
    Darwin)
      ifconfig 2>/dev/null | awk '
        /inet6 / {
          ip=$2; sub(/%.*/,"",ip);
          if (ip !~ /^fe80/ && ip != "::1" && ip !~ /^f[cd]/) { print ip; exit }
        }'
      ;;
    *)
      ip -6 -o addr show scope global 2>/dev/null | awk '
        { split($4,a,"/"); if (a[1] !~ /^f[cd]/) { print a[1]; exit } }'
      ;;
  esac
}

if [[ "$MODE" == "internet" ]]; then
  ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-$(detect_global_ipv6 || true)}"
  if [[ -z "$ADVERTISE_IP" ]]; then
    echo "[host] ERROR: Could not auto-detect a globally-routable IPv6 address (internet mode)."
    echo "[host] Set SHAREGRID_ADVERTISE_IP to the host machine's public IPv6 (e.g. 2001:db8::1)."
    exit 1
  fi
else
  ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-$(detect_lan_ip || true)}"
  if [[ -z "$ADVERTISE_IP" ]]; then
    echo "[host] ERROR: Could not auto-detect a LAN IPv4 address."
    echo "[host] Set SHAREGRID_ADVERTISE_IP to the host machine's LAN IPv4 (e.g. 192.168.1.42)."
    exit 1
  fi
fi

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "[host] WARNING: unknown flag: $arg" ;;
  esac
done

log() { echo "[host] $*"; }

# ── Build ─────────────────────────────────────────────────────────────────────

if [[ "$BUILD" -eq 1 ]]; then
  log "Building ${IMAGE}..."
  docker build \
    -f "$SCRIPT_DIR/Dockerfile" \
    -t "$IMAGE" \
    "$SCRIPT_DIR"
else
  log "Skipping build (--no-build)."
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

docker rm -f "$CONTAINER" 2>/dev/null || true

# ── Start ─────────────────────────────────────────────────────────────────────

log "Starting ${CONTAINER} (mode=${MODE}, advertising ${ADVERTISE_IP} on port ${PORT})..."
docker run -d \
  --name "$CONTAINER" \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --security-opt no-new-privileges \
  --ipc=none \
  --restart=on-failure \
  -p "${PORT}:${PORT}" \
  -e SHAREGRID_ROUTER_URL="$SHAREGRID_ROUTER_URL" \
  -e SHAREGRID_LISTEN_PORT="$PORT" \
  -e SHAREGRID_LISTEN_HOST="$ADVERTISE_IP" \
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
