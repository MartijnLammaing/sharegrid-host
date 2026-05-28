# =============================================================================
# Stage 1 — llama.cpp builder
#
# Builds a CPU-only llama-server binary from a pinned git tag.
# No CUDA, Metal, or ROCm — Phase 1 is CPU-only.
# See: docs/architecture_llmhost.md §2.4, §5.3
# =============================================================================
FROM debian:12-slim AS llama-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch b9371 \
        https://github.com/ggml-org/llama.cpp /src/llama.cpp

RUN cmake -S /src/llama.cpp -B /build \
        -DLLAMA_CURL=OFF \
        -DGGML_NATIVE=OFF \
        -DGGML_CUDA=OFF \
        -DGGML_METAL=OFF \
    && cmake --build /build --target llama-server -j"$(nproc)"

RUN mkdir -p /app && cp /build/bin/llama-server /app/llama-server

# =============================================================================
# Stage 2 — Node.js builder
#
# Builds the LLMHost TypeScript sources into a single self-contained CJS
# bundle via esbuild. Only bundle.cjs is copied to the final image.
# =============================================================================
FROM node:22-slim AS node-builder

WORKDIR /app

# Build @sharegrid/shared first — it is a file: dependency and must be
# compiled before npm ci can install it correctly.
COPY sharegrid-shared/package.json sharegrid-shared/package-lock.json \
     ./sharegrid-shared/
RUN cd sharegrid-shared && npm ci --ignore-scripts
COPY sharegrid-shared/src       ./sharegrid-shared/src
COPY sharegrid-shared/tsconfig.json \
     sharegrid-shared/tsconfig.build.json \
     ./sharegrid-shared/
RUN cd sharegrid-shared && npm run build

# Build the host bundle.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src         ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build

# =============================================================================
# Stage 3 — Runtime (distroless)
#
# Minimal runtime: only the llama-server binary and the Node.js bundle.
# No shell, no package manager, no debugging tools.
#
# Build-time ENV defaults for model metadata. Override when building a
# model-specific image variant, e.g.:
#
#   docker build \
#     --build-arg MODEL_NAME=llama-3-8b-instruct-q4 \
#     --build-arg MODEL_CONTEXT_SIZE=8192 \
#     -t registry/llmhost-llama3-8b:latest .
#
# See: docs/architecture_llmhost.md §2.5 (build-time configuration)
# =============================================================================
FROM gcr.io/distroless/nodejs22-debian12 AS runtime

# Placeholders — always overridden in model-specific image builds.
ENV SHAREGRID_MODEL_NAME="placeholder-model" \
    SHAREGRID_MODEL_CONTEXT_SIZE="4096"

# The distroless image ships a pre-created nonroot user (uid 65532).
USER nonroot:nonroot

COPY --from=llama-builder /app/llama-server     /app/llama-server
COPY --from=node-builder  /app/dist/bundle.cjs  /app/bundle.cjs

# Healthcheck script: probes llama.cpp's GET /health endpoint over the
# internal Unix socket. The distroless image has no shell so CMD must be
# the exec form invoking Node.js directly.
COPY scripts/healthcheck.js /app/healthcheck.js

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["node", "/app/healthcheck.js"]

CMD ["/app/bundle.cjs"]
