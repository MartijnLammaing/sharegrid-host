#!/usr/bin/env bash
# macos-native/setup.sh — Build llama-server with Metal support for macOS.
#
# Usage: ./setup.sh [--check]
#
#   --check   Exit 0 if macos-native/bin/llama-server already exists.
#
# The script reads the pinned llama.cpp tag from $HOST_DIR/LLAMA_TAG and builds
# a Metal-enabled, statically-linked llama-server binary into
# macos-native/bin/llama-server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Location for an auto-provisioned cmake. It is kept OUTSIDE the workspace so
# editor tooling (e.g. VS Code's Python extension) does not auto-detect it as a
# project virtualenv and inject `source .../activate` into new shells — that
# behaviour corrupts the stdin of TUI tools like opencode. Override with
# SHAREGRID_CMAKE_VENV.
CMAKE_VENV_DIR="${SHAREGRID_CMAKE_VENV:-$HOME/Library/Caches/sharegrid/cmake-venv}"
if [[ -x "$CMAKE_VENV_DIR/bin/cmake" ]]; then
  export PATH="$CMAKE_VENV_DIR/bin:$PATH"
fi

LLAMA_TAG_FILE="$HOST_DIR/LLAMA_TAG"
BUILD_DIR="$HOST_DIR/macos-native/.build"
BIN_DIR="$HOST_DIR/macos-native/bin"
BINARY="$BIN_DIR/llama-server"

log() { echo "[setup] $*"; }

# ── Platform checks ───────────────────────────────────────────────────────────

if [[ "$(uname -m)" != "arm64" ]]; then
  log "ERROR: macOS native mode is only supported on Apple Silicon (arm64)."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  log "ERROR: git is required but not installed."
  exit 1
fi

# Prefer the system cmake. If none is on PATH, provision one into a venv located
# OUTSIDE the workspace ($CMAKE_VENV_DIR) so the host can build llama.cpp without
# touching the system Python environment and without an editor-visible .venv that
# would interfere with opencode (see the note at the top of this file).
ensure_cmake() {
  if command -v cmake >/dev/null 2>&1; then
    return 0
  fi
  local venv_cmake="$CMAKE_VENV_DIR/bin/cmake"
  if [[ ! -x "$venv_cmake" ]]; then
    log "cmake not found on PATH; provisioning a copy in $CMAKE_VENV_DIR..."
    if ! command -v python3 >/dev/null 2>&1; then
      log "ERROR: cmake is not installed and python3 is not available to create a virtual environment."
      log "Install cmake (e.g. via Homebrew) or install Python 3."
      exit 1
    fi
    mkdir -p "$(dirname "$CMAKE_VENV_DIR")"
    python3 -m venv "$CMAKE_VENV_DIR"
    "$CMAKE_VENV_DIR/bin/pip" install --upgrade pip
    "$CMAKE_VENV_DIR/bin/pip" install cmake
  fi
  export PATH="$CMAKE_VENV_DIR/bin:$PATH"
}
ensure_cmake

if ! xcode-select -p >/dev/null 2>&1; then
  log "ERROR: Xcode Command Line Tools are not installed. Run: xcode-select --install"
  exit 1
fi

# Point the compiler to the active macOS SDK so C++ standard-library headers are found.
export SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
export CXXFLAGS="${CXXFLAGS:-} -isystem $SDKROOT/usr/include/c++/v1"

# ── Check existing binary ─────────────────────────────────────────────────────

if [[ "${1:-}" == "--check" ]]; then
  if [[ -x "$BINARY" ]]; then
    log "Found existing binary: $BINARY"
    exit 0
  fi
  log "Binary not found; a build is required."
  exit 1
fi

# ── Read pinned tag ───────────────────────────────────────────────────────────

if [[ ! -f "$LLAMA_TAG_FILE" ]]; then
  log "ERROR: LLAMA_TAG not found at $LLAMA_TAG_FILE"
  exit 1
fi
LLAMA_TAG="$(cat "$LLAMA_TAG_FILE")"
if [[ -z "$LLAMA_TAG" ]]; then
  log "ERROR: LLAMA_TAG is empty."
  exit 1
fi
log "Using llama.cpp tag: $LLAMA_TAG"

# ── Clone / update source ─────────────────────────────────────────────────────

SRC_DIR="$BUILD_DIR/llama.cpp"

if [[ ! -d "$SRC_DIR/.git" ]]; then
  log "Cloning llama.cpp..."
  rm -rf "$SRC_DIR"
  git clone --depth 1 --branch "$LLAMA_TAG" \
    https://github.com/ggml-org/llama.cpp "$SRC_DIR"
fi

# ── Build ─────────────────────────────────────────────────────────────────────

CMAKE_BUILD_DIR="$BUILD_DIR/cmake-build"

log "Configuring llama-server with Metal..."
cmake -S "$SRC_DIR" -B "$CMAKE_BUILD_DIR" \
  -DCMAKE_OSX_SYSROOT="$SDKROOT" \
  -DCMAKE_CXX_FLAGS="-isystem $SDKROOT/usr/include/c++/v1" \
  -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON \
  -DGGML_METAL=ON \
  -DGGML_NATIVE=ON \
  -DGGML_CUDA=OFF \
  -DLLAMA_CURL=OFF \
  -DBUILD_SHARED_LIBS=OFF

log "Building llama-server..."
cmake --build "$CMAKE_BUILD_DIR" --target llama-server -j"$(sysctl -n hw.logicalcpu)"

# ── Install ───────────────────────────────────────────────────────────────────

mkdir -p "$BIN_DIR"
cp "$CMAKE_BUILD_DIR/bin/llama-server" "$BINARY"
chmod +x "$BINARY"

log "Build complete: $BINARY"
