#!/usr/bin/env bash
#
# it-server.sh — boot a real `brain-server` for the SDK integration tests.
#
# The SDK's unit + conformance suites are offline (mock transport + the golden
# byte corpus). The *integration* suites in each language talk to a real
# server over TCP, authenticating with a minted `brain_` data-plane key. This
# script boots that server from the production `brain:<tag>` image and prints
# the env vars the language harnesses read.
#
# Usage:
#   scripts/it-server.sh up        # boot + wait healthy, then print env exports
#   scripts/it-server.sh env       # print env exports for an already-booted server
#   scripts/it-server.sh down      # stop + remove the container
#   scripts/it-server.sh logs      # tail server logs
#
# Typical loop (bash/zsh):
#   eval "$(scripts/it-server.sh up)"     # boot + export BRAIN_SDK_IT_* into the shell
#   ( cd rust && cargo test --test it_encode -- --nocapture )
#   scripts/it-server.sh down
#
# The container binds three planes: data (wire), metrics/health, and admin
# (key minting). Only localhost publishes them. The admin secret is a throwaway
# test value — the admin plane is reachable only from this host.
#
# A REAL provider key is required. The server makes a 1-token completion at
# boot and refuses to start if it is rejected, so a placeholder no longer works
# even though wire-op tests never trigger an LLM call themselves:
#
#     BRAIN__LLM__API_KEY="$(tr -d '[:space:]' < ~/.brain_llm_key)" \
#       scripts/it-server.sh up
set -euo pipefail

NAME="${BRAIN_SDK_IT_NAME:-brain-sdk-it}"
IMAGE="brain:${BRAIN_SDK_IT_TAG:-latest}"
MODELS_VOLUME="${BRAIN_SDK_IT_MODELS_VOLUME:-brain-models}"
DATA_PORT="${BRAIN_SDK_IT_DATA_PORT:-18080}"
METRICS_PORT="${BRAIN_SDK_IT_METRICS_PORT:-19091}"
ADMIN_PORT="${BRAIN_SDK_IT_ADMIN_PORT:-19092}"
ADMIN_SECRET="${BRAIN_SDK_IT_ADMIN_SECRET:-sdk-it-admin-secret}"
NAMESPACE="${BRAIN_SDK_IT_NAMESPACE:-sdk-it}"
# The server refuses to boot without a WORKING provider key: write-time HyPE
# and extraction are always-on, and the boot preflight sends a 1-token
# completion, failing the start on a rejected key. An empty key is rejected
# earlier still, at config validation — so there is no placeholder path and no
# "disabled" mode. Export BRAIN__LLM__API_KEY before `up`.
LLM_KEY="${BRAIN__LLM__API_KEY:-}"

print_env() {
  echo "export BRAIN_SDK_IT_DATA=127.0.0.1:${DATA_PORT}"
  echo "export BRAIN_SDK_IT_ADMIN=127.0.0.1:${ADMIN_PORT}"
  echo "export BRAIN_SDK_IT_ADMIN_SECRET=${ADMIN_SECRET}"
  echo "export BRAIN_SDK_IT_NAMESPACE=${NAMESPACE}"
}

cmd_up() {
  if [ -z "$LLM_KEY" ]; then
    cat >&2 <<'MSG'
BRAIN__LLM__API_KEY is unset and the server will refuse to start without it.
The boot preflight sends a real 1-token completion; a placeholder is rejected,
and an empty key fails config validation earlier still.

    BRAIN__LLM__API_KEY="$(tr -d '[:space:]' < ~/.brain_llm_key)" \
      scripts/it-server.sh up
MSG
    return 2
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    --security-opt seccomp=unconfined --ulimit memlock=-1 \
    -p "${DATA_PORT}:8080" -p "${METRICS_PORT}:9091" -p "${ADMIN_PORT}:9092" \
    -v "${MODELS_VOLUME}:/models:ro" \
    -e BRAIN_EMBED_MODEL_DIR=/models/bge-small-en-v1.5 \
    -e BRAIN_RERANK_MODEL_DIR=/models/bge-reranker-base \
    -e BRAIN__EXTRACTORS__CLASSIFIER__MODEL_PATH=/models/gliner-small-v2.1 \
    -e BRAIN__SERVER__ADMIN_ADDR=0.0.0.0:9092 \
    -e BRAIN__ADMIN__TOKEN="${ADMIN_SECRET}" \
    -e BRAIN__LLM__API_KEY="${LLM_KEY}" \
    "$IMAGE" >/dev/null

  # Wait for the container healthcheck to report healthy.
  local i status
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo gone)"
    case "$status" in
      healthy) print_env; return 0 ;;
      gone|"") echo "server container exited during boot; see: $0 logs" >&2
               docker logs "$NAME" 2>&1 | tail -20 >&2 || true; return 1 ;;
    esac
    sleep 2
  done
  echo "server did not become healthy within ~120s; see: $0 logs" >&2
  return 1
}

case "${1:-}" in
  up)   cmd_up ;;
  env)  print_env ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "removed $NAME" >&2 ;;
  logs) docker logs "$NAME" 2>&1 | tail -"${2:-50}" ;;
  *)    echo "usage: $0 {up|env|down|logs}" >&2; exit 2 ;;
esac
