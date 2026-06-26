# macOS native LLMHost

This directory contains the Apple Silicon native deployment path for `sharegrid-host`. It builds `llama-server` from the pinned [`LLAMA_TAG`](../LLAMA_TAG) with **Metal GPU** acceleration and runs it under `sandbox-exec`.

> **Security note:** `sandbox-exec` is deprecated by Apple and is **not** a substitute for a full security boundary. It is used here as a defense-in-depth layer to restrict the inference process's filesystem and network access. The operator is still a trusted participant in the ShareGrid network.

---

## Prerequisites

- Apple Silicon Mac (M1/M2/M3/M4 or later) running macOS 14+
- Xcode Command Line Tools: `xcode-select --install`
- [CMake](https://cmake.org/) (e.g. `brew install cmake`). If `cmake` is not on your `PATH`, `setup.sh` auto-provisions one into a Python venv at `~/Library/Caches/sharegrid/cmake-venv` — **outside** the workspace, so editors don't auto-activate it (see [Troubleshooting](#cmake-auto-provisioning)).
- [Git](https://git-scm.com/)
- Node.js 22+ (e.g. `brew install node@22`)

---

## Setup

1. Place one or more `.gguf` model files in the `sharegrid-host/models/` directory.
2. Obtain the **host registration URL** from the router banner.
3. From this directory run:

```bash
export SHAREGRID_ROUTER_URL="https://...?fp=sha256:...&key=..."
./macos-run.sh
```

On first run, `macos-run.sh` will:

- Run `npm ci` and `npm run build` in `sharegrid-host/` to produce `dist/bundle.cjs`.
- Run `setup.sh` to clone `llama.cpp` at the pinned tag and compile a Metal-enabled `llama-server` into `macos-native/bin/llama-server`.

Subsequent starts reuse the existing binary and bundle.

---

## Optional environment variables

| Variable | Default | Description |
|---|---|---|
| `SHAREGRID_HOST_PORT` | `9000` | Port the Session Manager listens on. |
| `SHAREGRID_MODELS_DIR` | `sharegrid-host/models` | Directory scanned for `.gguf` files. |
| `SHAREGRID_ADVERTISE_IP` | auto-detected | IPv4 (LAN mode) or global IPv6 (internet mode) advertised to the router. |
| `SHAREGRID_LLAMA_BINARY` | `macos-native/bin/llama-server` | Path to the `llama-server` binary. |
| `SHAREGRID_SANDBOX_PROFILE` | `macos-native/sandbox.sb` | Path to the SBPL sandbox profile. |
| `SHAREGRID_CMAKE_VENV` | `~/Library/Caches/sharegrid/cmake-venv` | Location of the auto-provisioned cmake venv (used only when `cmake` is not already on `PATH`). |

---

## Troubleshooting

### `sandbox-exec` denials

To see Seatbelt denials while the host is running, stream the log:

```bash
log stream --level debug --predicate 'eventMessage CONTAINS "sandbox"'
```

If Metal/IOKit access is denied, add the missing `(allow ...)` rule to `sandbox.sb` and re-run.

### Metal is not being used

Check the `llama-server` output for `ggml_metal_init`. If it is missing:

- Confirm you are on Apple Silicon (`uname -m` returns `arm64`).
- Confirm `setup.sh` built with `-DGGML_METAL=ON`.
- Check Seatbelt logs for IOKit denials.

### `SHAREGRID_ADVERTISE_IP` is wrong

Auto-detection is best-effort. Set `SHAREGRID_ADVERTISE_IP` explicitly to a LAN IPv4 or global IPv6 address that users can reach.

### Restart loop

`macos-run.sh` restarts the Node process automatically after a non-zero exit. To stop the script cleanly, press `Ctrl+C`.

### cmake auto-provisioning

When `cmake` is not on `PATH`, `setup.sh` creates a Python venv containing `cmake` at `~/Library/Caches/sharegrid/cmake-venv` (override with `SHAREGRID_CMAKE_VENV`). This is deliberately kept **outside** the repository: a `.venv` inside the workspace is auto-detected by editor tooling (e.g. VS Code's Python extension), which injects `source .../activate` into new shells and can corrupt the stdin of TUI tools such as opencode. To use your own cmake instead, `brew install cmake`; the venv is then never created. Remove it any time with `rm -rf ~/Library/Caches/sharegrid/cmake-venv`.

---

## Files

| File | Purpose |
|---|---|
| `setup.sh` | Builds `llama-server` with Metal from the pinned tag. |
| `sandbox.sb` | SBPL profile used by `sandbox-exec` to restrict the inference process. |
| `macos-run.sh` | Launch script for the native macOS host. |
| `README.md` | This file. |
