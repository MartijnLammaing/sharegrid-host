#!/usr/bin/env bash
# Full hardened docker run invocation for LLMHost.
# Replace <digest> with the SHA-256 digest of the model-specific image.
# Replace <host-port> with the port you want to expose on the host machine.
# The container port must match SHAREGRID_LISTEN_PORT.
#
# Reference the seccomp profile with the absolute path on the host machine:
#   --security-opt seccomp=/path/to/seccomp-profile.json
#
# See: docs/architecture_llmhost.md §5.3 (Docker hardening)

## Build (run from repo root)
docker build \                                                                                                                                                        
  -f sharegrid-host/Dockerfile \
  --build-arg MODEL_FILE=sharegrid-host/models/Phi-3.5-mini-instruct-IQ2_M.gguf \
  -t sharegrid-host \
  .


docker run --cap-drop ALL \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --security-opt no-new-privileges \
  --ipc=none \
  --restart=on-failure \
  -p 9000:9000 \
  -e SHAREGRID_ROUTER_URL="https://172.17.0.2:8443?fp=sha256:6059adc8a497ba0070f0f10af6ce130ae58a46c83e70c4ed98e12b5bfd01f98e" \
  -e SHAREGRID_LISTEN_PORT=9000 \
  sharegrid-host