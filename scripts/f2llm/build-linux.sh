#!/usr/bin/env bash
# Rebuild the F2LLM-v2-80M ONNX artifact on Linux (python:3.14-slim, pinned wheels) and verify it against
# manifest.json. Produces the directory the image bakes via `--build-arg F2LLM_BAKE=1`.
#
#   scripts/f2llm/build-linux.sh <out-dir> [<upstream-cache-dir>]
#
# Needs: docker, node. The result is byte-identical to the frozen artifact (proved on Windows and Linux):
# verify-artifact.mjs exits non-zero otherwise, so a drifted toolchain can never produce an "accepted" model.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${1:?usage: build-linux.sh <out-dir> [<upstream-cache-dir>]}"
upstream="${2:-$out/../f2llm-upstream}"

mkdir -p "$out" "$upstream"
out="$(cd "$out" && pwd)"
upstream="$(cd "$upstream" && pwd)"

# 1) pinned upstream snapshot, every file checked against manifest.json (hard failure on mismatch)
node "$here/fetch-upstream.mjs" "$upstream"

# 2) export + quantize inside a pinned container; toolchain versions come from the lock file only
docker run --rm \
  -v "$repo:/repo:ro" \
  -v "$upstream:/upstream:ro" \
  -v "$out:/out" \
  python:3.14-slim \
  bash -c 'set -e
    pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
      -r /repo/scripts/f2llm/requirements-build.lock.txt
    python /repo/scripts/f2llm/build-onnx.py --src /upstream --out /out/artifact --work /out/work'

# 3) behavior gate is inside build-onnx.py (golden vectors); identity gate is here
node "$here/verify-artifact.mjs" "$out/artifact"
echo "artifact ready: $out/artifact  (copy its contents into f2llm-artifact/ for F2LLM_BAKE=1)"
