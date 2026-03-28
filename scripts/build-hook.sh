#!/bin/sh
set -e

# Resolve to the repo root (the directory containing this script's parent)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

HOOK_DIR="${REPO_ROOT}/hooks/fleet-copilot-go"
OUT_DIR="${REPO_ROOT}/hooks/bin"

mkdir -p "$OUT_DIR"

for target in "darwin/arm64" "darwin/amd64" "windows/amd64" "linux/amd64"; do
  GOOS="${target%/*}"
  GOARCH="${target#*/}"
  OUT="${OUT_DIR}/fleet-copilot-${GOOS}-${GOARCH}"
  if [ "$GOOS" = "windows" ]; then
    OUT="${OUT}.exe"
  fi
  echo "Building ${GOOS}/${GOARCH}..."
  (cd "$HOOK_DIR" && CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -ldflags="-s -w" -o "$OUT" .)
done

echo "All hook binaries built in ${OUT_DIR}/"
