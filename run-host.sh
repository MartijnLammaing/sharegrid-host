#!/usr/bin/env bash
# run-host.sh — Interactive launcher for the sharegrid-host container or native macOS process.
#
# Usage: ./run-host.sh [--no-prompt] [--no-build]
#
# Prompts for the user-facing parameters needed by docker-run.sh or
# macos-native/macos-run.sh, then delegates to the chosen script with the
# answers exported as environment variables.
#
# Environment (all optional unless noted; used as defaults and passed through):
#   SHAREGRID_ROUTER_URL      — Host registration URL from the router banner (required).
#                               This is the base64 token printed as
#                               SHAREGRID_HOST_ROUTER_URL=... by docker-run.sh.
#   SHAREGRID_HOST_PORT       — Host port to publish            (default: 9000)
#   SHAREGRID_ADVERTISE_IP    — address advertised to router    (default: auto-detected)
#   SHAREGRID_HOST_TARGET     — docker or macos-native          (default: docker)
#   SHAREGRID_HOST_IMAGE      — Docker image name               (default: sharegrid-host)
#   SHAREGRID_MODELS_DIR      — Directory with .gguf models     (macOS native default: <repo>/sharegrid-host/models)
#   SHAREGRID_LLAMA_BINARY    — Path to llama-server binary     (macOS native default: macos-native/bin/llama-server)
#   SHAREGRID_SANDBOX_PROFILE — Path to sandbox-exec profile    (macOS native default: macos-native/sandbox.sb)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_NATIVE_DIR="$SCRIPT_DIR/macos-native"

# macOS native mode is only available on Apple Silicon.
HOST_TARGET_SUPPORTED=0
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  HOST_TARGET_SUPPORTED=1
fi

NO_PROMPT=0
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-prompt) NO_PROMPT=1 ;;
    --no-build)  NO_BUILD=1 ;;
    *) echo "[run-host] WARNING: unknown flag: $arg" >&2 ;;
  esac
done

log() { echo "[run-host] $*"; }

# Detect the host machine's LAN IPv4 address.
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

# Best-effort detection of a globally-routable IPv6 address.
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

# Read defaults from environment.
DEFAULT_ROUTER_URL="${SHAREGRID_ROUTER_URL:-}"
DEFAULT_PORT="${SHAREGRID_HOST_PORT:-9000}"
DEFAULT_ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-}"
DEFAULT_TARGET="${SHAREGRID_HOST_TARGET:-docker}"
DEFAULT_IMAGE="${SHAREGRID_HOST_IMAGE:-sharegrid-host}"
DEFAULT_MODELS_DIR="${SHAREGRID_MODELS_DIR:-$SCRIPT_DIR/models}"
DEFAULT_LLAMA_BINARY="${SHAREGRID_LLAMA_BINARY:-$MACOS_NATIVE_DIR/bin/llama-server}"
DEFAULT_SANDBOX_PROFILE="${SHAREGRID_SANDBOX_PROFILE:-$MACOS_NATIVE_DIR/sandbox.sb}"

if [[ "$NO_PROMPT" -eq 0 && -t 0 ]]; then
  # Interactive mode.
  if [[ -n "$DEFAULT_ROUTER_URL" ]]; then
    read -r -p "Paste HOST REGISTRATION URL (base64 token) [${DEFAULT_ROUTER_URL}]: " ROUTER_URL
    ROUTER_URL="${ROUTER_URL:-$DEFAULT_ROUTER_URL}"
  else
    read -r -p "Paste HOST REGISTRATION URL (base64 token) from the router banner: " ROUTER_URL
  fi

  # Derive network mode from URL for IP detection.
  if [[ -n "$ROUTER_URL" ]]; then
    DECODED_URL="$(printf '%s' "$ROUTER_URL" | openssl base64 -A -d 2>/dev/null || true)"
    if [[ "$DECODED_URL" == *"mode=internet"* ]]; then
      URL_MODE=internet
    else
      URL_MODE=lan
    fi
  else
    URL_MODE=lan
  fi

  read -r -p "Host port to publish [${DEFAULT_PORT}]: " PORT
  PORT="${PORT:-$DEFAULT_PORT}"

  if [[ -z "$DEFAULT_ADVERTISE_IP" ]]; then
    if [[ "$URL_MODE" == "internet" ]]; then
      DEFAULT_ADVERTISE_IP="$(detect_global_ipv6 || true)"
    else
      DEFAULT_ADVERTISE_IP="$(detect_lan_ip || true)"
    fi
  fi

  if [[ -n "$DEFAULT_ADVERTISE_IP" ]]; then
    read -r -p "Advertise IP [${DEFAULT_ADVERTISE_IP}]: " ADVERTISE_IP
    ADVERTISE_IP="${ADVERTISE_IP:-$DEFAULT_ADVERTISE_IP}"
  else
    read -r -p "Advertise IP (empty = auto-detect): " ADVERTISE_IP
  fi

  if [[ "$HOST_TARGET_SUPPORTED" -eq 1 ]]; then
    read -r -p "Deployment target (docker/macos-native) [${DEFAULT_TARGET}]: " TARGET
    TARGET="${TARGET:-$DEFAULT_TARGET}"
  else
    TARGET="$DEFAULT_TARGET"
  fi

  if [[ "$TARGET" == "docker" ]]; then
    read -r -p "Docker image name [${DEFAULT_IMAGE}]: " IMAGE
    IMAGE="${IMAGE:-$DEFAULT_IMAGE}"

    if [[ "$NO_BUILD" -eq 1 ]]; then
      BUILD_ANSWER="n"
    else
      read -r -p "Build Docker image before starting? [Y/n]: " BUILD_ANSWER
      BUILD_ANSWER="${BUILD_ANSWER:-y}"
    fi
  elif [[ "$TARGET" == "macos-native" ]]; then
    read -r -p "Models directory [${DEFAULT_MODELS_DIR}]: " MODELS_DIR
    MODELS_DIR="${MODELS_DIR:-$DEFAULT_MODELS_DIR}"

    read -r -p "llama-server binary [${DEFAULT_LLAMA_BINARY}]: " LLAMA_BINARY
    LLAMA_BINARY="${LLAMA_BINARY:-$DEFAULT_LLAMA_BINARY}"

    read -r -p "Sandbox profile [${DEFAULT_SANDBOX_PROFILE}]: " SANDBOX_PROFILE
    SANDBOX_PROFILE="${SANDBOX_PROFILE:-$DEFAULT_SANDBOX_PROFILE}"
  fi
else
  ROUTER_URL="$DEFAULT_ROUTER_URL"
  PORT="$DEFAULT_PORT"
  ADVERTISE_IP="$DEFAULT_ADVERTISE_IP"
  TARGET="$DEFAULT_TARGET"
  IMAGE="$DEFAULT_IMAGE"
  BUILD_ANSWER="$([[ "$NO_BUILD" -eq 1 ]] && echo "n" || echo "y")"
  MODELS_DIR="$DEFAULT_MODELS_DIR"
  LLAMA_BINARY="$DEFAULT_LLAMA_BINARY"
  SANDBOX_PROFILE="$DEFAULT_SANDBOX_PROFILE"
fi

# Validation
if [[ -z "$ROUTER_URL" ]]; then
  log "ERROR: SHAREGRID_ROUTER_URL is required." >&2
  log "Run sharegrid-router/docker-run.sh first and copy the HOST REGISTRATION URL." >&2
  exit 1
fi

if [[ "$PORT" =~ ^[0-9]+$ ]]; then
  if [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
    log "ERROR: port must be between 1 and 65535, got: $PORT" >&2
    exit 1
  fi
else
  log "ERROR: port must be a number, got: $PORT" >&2
  exit 1
fi

if [[ "$TARGET" != "docker" && "$TARGET" != "macos-native" ]]; then
  log "ERROR: deployment target must be 'docker' or 'macos-native', got: $TARGET" >&2
  exit 1
fi

if [[ "$TARGET" == "macos-native" && "$HOST_TARGET_SUPPORTED" -eq 0 ]]; then
  log "ERROR: macos-native target is only supported on Apple Silicon macOS." >&2
  exit 1
fi

if [[ "$TARGET" == "docker" && -z "$IMAGE" ]]; then
  log "ERROR: Docker image name cannot be empty" >&2
  exit 1
fi

if [[ "$TARGET" == "macos-native" && -z "$MODELS_DIR" ]]; then
  log "ERROR: Models directory cannot be empty" >&2
  exit 1
fi

if [[ "$TARGET" == "macos-native" && ! -x "$MACOS_NATIVE_DIR/macos-run.sh" ]]; then
  log "ERROR: macOS native runner not found: $MACOS_NATIVE_DIR/macos-run.sh" >&2
  exit 1
fi

# Build answer handling (Docker only)
BUILD_FLAG=""
if [[ "$TARGET" == "docker" ]]; then
  BUILD_ANSWER_LOWER="$(echo "$BUILD_ANSWER" | tr '[:upper:]' '[:lower:]')"
  case "$BUILD_ANSWER_LOWER" in
    y|yes) BUILD_FLAG="" ;;
    n|no)  BUILD_FLAG="--no-build" ;;
    *)
      log "ERROR: build answer must be 'y' or 'n', got: $BUILD_ANSWER" >&2
      exit 1
      ;;
  esac
fi

log "Launching host (target=${TARGET}, port=${PORT}, advertise=${ADVERTISE_IP:-auto-detect})..."

export SHAREGRID_ROUTER_URL="$ROUTER_URL"
export SHAREGRID_HOST_PORT="$PORT"
export SHAREGRID_ADVERTISE_IP="$ADVERTISE_IP"

if [[ "$TARGET" == "docker" ]]; then
  export SHAREGRID_HOST_IMAGE="$IMAGE"
  exec "$SCRIPT_DIR/docker-run.sh" ${BUILD_FLAG:-}
else
  export SHAREGRID_MODELS_DIR="$MODELS_DIR"
  export SHAREGRID_LLAMA_BINARY="$LLAMA_BINARY"
  export SHAREGRID_SANDBOX_PROFILE="$SANDBOX_PROFILE"
  exec "$MACOS_NATIVE_DIR/macos-run.sh"
fi
