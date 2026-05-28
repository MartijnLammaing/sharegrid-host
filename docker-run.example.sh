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

docker run \
  --name sharegrid-host \
  --restart on-failure \
  \
  `# Drop all Linux capabilities — inference requires none` \
  --cap-drop ALL \
  \
  `# Read-only root filesystem; /tmp is the only writable path (llama.cpp socket)` \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  \
  `# Prevent privilege escalation via setuid/file capabilities` \
  --security-opt no-new-privileges \
  \
  `# Tuned seccomp profile — blocks ptrace, mount, unshare and other dangerous syscalls` \
  --security-opt seccomp=/path/to/seccomp-profile.json \
  \
  `# Isolated network bridge — container cannot see host interfaces` \
  --network sharegrid-net \
  \
  `# No shared memory with the host` \
  --ipc none \
  \
  `# Publish only the Session Manager TLS port` \
  -p <host-port>:9000 \
  \
  `# Required runtime configuration` \
  -e SHAREGRID_ROUTER_URL="https://router.example.com:8443?fp=sha256:<fingerprint>" \
  -e SHAREGRID_LISTEN_PORT=9000 \
  -e SHAREGRID_HEARTBEAT_INTERVAL=30 \
  \
  registry/llmhost-<model>@sha256:<digest>
