#!/usr/bin/env bash
# Full hardened docker run invocation for LLMHost.
# Replace <digest> with the SHA-256 digest of the model-specific image.
# Replace <host-port> with the port you want to expose on the host machine.
# The container port must match SHAREGRID_LISTEN_PORT.
#
# SHAREGRID_LISTEN_HOST must be this machine's advertised address — it is the
# endpoint users dial directly. A container cannot detect the host address itself,
# so it must be supplied here (docker-run.sh auto-detects it for you). It must
# match the router's network mode: a LAN IPv4 address when the router URL has no
# mode param, or a globally-routable IPv6 address when the URL carries
# mode=internet (e.g. SHAREGRID_LISTEN_HOST=2001:db8::2).
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
  -e SHAREGRID_ROUTER_URL="https://192.168.1.10:8443?fp=sha256:6059adc8a497ba0070f0f10af6ce130ae58a46c83e70c4ed98e12b5bfd01f98e&key=<host-secret-from-router-banner>" \
  -e SHAREGRID_LISTEN_PORT=9000 \
  -e SHAREGRID_LISTEN_HOST=192.168.1.42 \
  sharegrid-host