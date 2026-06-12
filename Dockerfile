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
        -DBUILD_SHARED_LIBS=OFF \
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
# Stage 3 — Runtime
#
# node:22-slim rather than distroless: llama-server requires C++ runtime
# libraries (libstdc++, libgcc) that are present in debian:12-slim but absent
# from the distroless image.
#
# Build-time configuration:
#
#   docker build -t sharegrid-host .
#
# Place model .gguf files in the ./models/ directory before building.
# The host scans this directory at startup and loads the first model
# (alphabetically).
#
# See: docs/architecture_llmhost.md §2.5 (build-time configuration)
# =============================================================================
FROM node:22-slim AS runtime

# libgomp1 is required by llama-server (OpenMP runtime); not included in node:22-slim.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root user/group for the host process.
RUN groupadd --gid 1001 sharegrid \
    && useradd --uid 1001 --gid sharegrid --no-create-home sharegrid

ENV NODE_ENV=production \
    SHAREGRID_MODELS_DIR="/data/models"

USER sharegrid

COPY --from=llama-builder /app/llama-server     /app/llama-server
COPY --from=node-builder  /app/dist/bundle.cjs  /app/bundle.cjs
COPY models/ /data/models/

# Healthcheck script: probes llama.cpp's GET /health endpoint over the
# internal Unix socket.
COPY scripts/healthcheck.js /app/healthcheck.js

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["node", "/app/healthcheck.js"]

CMD ["node", "/app/bundle.cjs"]
