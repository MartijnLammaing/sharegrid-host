#!/usr/bin/env bash
# macos-native/macos-run.sh — Run sharegrid-host natively on Apple Silicon macOS.
#
# Usage: ./macos-run.sh
#
# Environment (required):
#   SHAREGRID_ROUTER_URL — Host registration URL from the router banner
#
# Environment (optional):
#   SHAREGRID_HOST_PORT      — Port the host listens on (default: 9000)
#   SHAREGRID_MODELS_DIR     — Directory containing .gguf models (default: $HOST_DIR/models)
#   SHAREGRID_ADVERTISE_IP   — IP address advertised to the router (default: auto-detected)
#   SHAREGRID_LLAMA_BINARY   — Overrides the default macos-native/bin/llama-server
#   SHAREGRID_SANDBOX_PROFILE — Overrides the default macos-native/sandbox.sb

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Make an auto-provisioned cmake available if setup.sh created one. It lives
# outside the workspace (see setup.sh) so editor tooling does not auto-detect it
# as a project virtualenv and interfere with opencode. Override with
# SHAREGRID_CMAKE_VENV.
CMAKE_VENV_DIR="${SHAREGRID_CMAKE_VENV:-$HOME/Library/Caches/sharegrid/cmake-venv}"
if [[ -x "$CMAKE_VENV_DIR/bin/cmake" ]]; then
  export PATH="$CMAKE_VENV_DIR/bin:$PATH"
fi

PORT="${SHAREGRID_HOST_PORT:-9000}"
MODELS_DIR="${SHAREGRID_MODELS_DIR:-$HOST_DIR/models}"
LLAMA_BINARY="${SHAREGRID_LLAMA_BINARY:-$SCRIPT_DIR/bin/llama-server}"
SANDBOX_PROFILE="${SHAREGRID_SANDBOX_PROFILE:-$SCRIPT_DIR/sandbox.sb}"

log() { echo "[host] $*"; }

if [[ -z "${SHAREGRID_ROUTER_URL:-}" ]]; then
  log "ERROR: SHAREGRID_ROUTER_URL is not set."
  log "Run sharegrid-router/docker-run.sh first, then export the HOST REGISTRATION URL."
  exit 1
fi

# Decode base64-encoded router URL.
SHAREGRID_ROUTER_URL=$(printf '%s' "$SHAREGRID_ROUTER_URL" | openssl base64 -A -d)

# Derive the network mode from the router URL's `mode` query parameter.
if [[ "$SHAREGRID_ROUTER_URL" == *"mode=internet"* ]]; then
  MODE=internet
else
  MODE=lan
fi

# ── Detect advertised address (verbatim from docker-run.sh) ───────────────────

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

detect_global_ipv6() {
  case "$(uname -s)" in
    Darwin)
      ifconfig 2>/dev/null | awk '
        /inet6 / {
          ip=$2; sub(/%.*/, "", ip);
          if (ip !~ /^fe[89ab]/ && ip != "::1" && ip !~ /^f[cd]/) { print ip; exit }
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
    log "ERROR: Could not auto-detect a globally-routable IPv6 address (internet mode)."
    log "Set SHAREGRID_ADVERTISE_IP to the host machine's public IPv6 (e.g. 2001:db8::1)."
    exit 1
  fi
else
  ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-$(detect_lan_ip || true)}"
  if [[ -z "$ADVERTISE_IP" ]]; then
    log "ERROR: Could not auto-detect a LAN IPv4 address."
    log "Set SHAREGRID_ADVERTISE_IP to the host machine's LAN IPv4 (e.g. 192.168.1.42)."
    exit 1
  fi
fi

# ── Preconditions ─────────────────────────────────────────────────────────────

if [[ "$(uname -m)" != "arm64" ]]; then
  log "ERROR: macOS native mode is only supported on Apple Silicon (arm64)."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  log "ERROR: node is required. Install Node.js 22+ (e.g. via brew install node@22)."
  exit 1
fi

NODE_MAJOR="$(node --version | cut -d. -f1 | tr -d 'v')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  log "ERROR: Node.js 22+ is required; found $(node --version)."
  exit 1
fi

# ── Build host bundle if missing ──────────────────────────────────────────────

if [[ ! -f "$HOST_DIR/dist/bundle.cjs" ]]; then
  log "Building host bundle..."
  (cd "$HOST_DIR" && \
    npm ci --ignore-scripts && \
    (cd sharegrid-shared && npm ci --ignore-scripts && npm run build) && \
    npm run build)
fi

# ── Build llama-server if missing ─────────────────────────────────────────────

if ! "$SCRIPT_DIR/setup.sh" --check; then
  log "llama-server binary not found; building now (this may take several minutes)..."
  "$SCRIPT_DIR/setup.sh"
fi

# ── Launch with restart loop ──────────────────────────────────────────────────

log "Starting LLMHost (mode=${MODE}, advertising ${ADVERTISE_IP}:${PORT})..."
log "Using llama-server: $LLAMA_BINARY"
log "Using sandbox profile: $SANDBOX_PROFILE"
log "Models directory: $MODELS_DIR"

export NODE_ENV=production
export SHAREGRID_ROUTER_URL
export SHAREGRID_LISTEN_PORT="$PORT"
export SHAREGRID_LISTEN_HOST="$ADVERTISE_IP"
export SHAREGRID_MODELS_DIR="$MODELS_DIR"
export SHAREGRID_LLAMA_BINARY="$LLAMA_BINARY"
export SHAREGRID_SANDBOX_PROFILE="$SANDBOX_PROFILE"

while true; do
  log "Launching Node process..."
  if node "$HOST_DIR/dist/bundle.cjs"; then
    log "Node process exited cleanly."
    exit 0
  fi
  log "Node process exited with error; restarting in 2 seconds..."
  sleep 2
done &

NODE_PID=$!
log "Node process started (PID: $NODE_PID)."

# Keep the script alive so a supervising shell job can be killed with Ctrl+C.
wait "$NODE_PID"
