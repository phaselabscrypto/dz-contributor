# syntax=docker/dockerfile:1
# Multi-stage build for Kubernetes-style platforms.
# Uses nightly because upstream network-shapley requires edition 2024 let-chains.

FROM rustlang/rust:nightly-slim@sha256:322ee09c3c24a57274945f82599eb9dfb54def9af9b39c8f247fdc846073b800 AS builder
WORKDIR /build

# network-shapley pulls `highs` (HiGHS LP solver), whose -sys crate compiles
# HiGHS C++ from source via cmake + a C/C++ toolchain, and generates FFI
# bindings via bindgen (libclang). pkg-config/libssl are for the AWS SDK's TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates git \
    cmake build-essential clang libclang-dev \
    && rm -rf /var/lib/apt/lists/*

# Cache deps separately from source for faster rebuilds.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
RUN mkdir src && echo 'fn main() { println!("placeholder"); }' > src/main.rs \
    && cargo fetch \
    && cargo build --release 2>/dev/null || true \
    && rm -rf src

COPY src ./src
RUN cargo build --release

# Runtime base MUST match the builder's Debian (rust:nightly-slim is trixie):
# the binary now dynamically links libstdc++ (HiGHS C++) and needs the builder's
# glibc (GLIBC_2.39) + libstdc++ (CXXABI_1.3.15, gcc-14). bookworm (glibc 2.36,
# no libstdc++) can't run it. trixie supplies both; libstdc++6/libgcc-s1 added.
# Pinned to Debian 13.7 (was 13.5): picks up the trixie security updates to
# libc6, libssl3t64, liblzma5, libpcre2, libsqlite3, gzip and util-linux.
# Refresh this digest periodically; the base layer gets no updates otherwise.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 libgcc-s1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r shapley && useradd -r -g shapley -d /app shapley

WORKDIR /app
COPY --from=builder /build/target/release/dz-shapley-service /app/dz-shapley-service
# OpenShift-compatible: such platforms assign a random non-root UID at runtime.
# Using group 0 (root) with g=u permissions ensures the binary is accessible
# regardless of which UID is injected. See:
# https://docs.openshift.com/container-platform/latest/openshift_images/create-images.html#use-uid_create-images
RUN chown -R shapley:0 /app && chmod -R g=u /app

USER shapley

ENV PORT=8080 RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["/app/dz-shapley-service"]
