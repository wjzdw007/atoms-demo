#!/usr/bin/env bash
# Deploys the current commit to a single server over SSH.
#
#   DEPLOY_HOST=my-server ./scripts/deploy.sh              deploy HEAD
#   DEPLOY_HOST=my-server ./scripts/deploy.sh --rollback   go back to the previous release
#
# The server must have been prepared once with scripts/setup.sh (see docs/部署.md). Each deploy
# is built in its own directory while the old version keeps serving; the switch happens only
# after a successful build, is verified through /api/health, and is undone if that check fails.
# The database (~/atoms-demo/shared/data) is backed up before the switch and otherwise untouched.
#
# Optional: NPM_REGISTRY (e.g. https://registry.npmmirror.com in mainland China),
#           DRAIN_SECONDS (how long to wait for running generations, default 300).
set -euo pipefail

HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to the SSH host to deploy to, e.g. DEPLOY_HOST=my-server ./scripts/deploy.sh}"
cd "$(git rev-parse --show-toplevel)"

# Settings passed through to the server, when set here.
remote_env=""
for name in NPM_REGISTRY DRAIN_SECONDS KEEP_RELEASES PORT; do
  [ -n "${!name:-}" ] && remote_env+="$name=$(printf '%q' "${!name}") "
done

if [ "${1:-}" = "--rollback" ]; then
  ssh "$HOST" "${remote_env}bash \"\$HOME/atoms-demo/current/scripts/release.sh\" --rollback"
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "note: there are uncommitted changes; only the last commit ($(git rev-parse --short HEAD)) is deployed." >&2
fi

release="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
echo "==> Uploading $release to $HOST"
git archive HEAD | ssh "$HOST" "mkdir -p \"\$HOME/atoms-demo/releases/$release\" && tar -x -C \"\$HOME/atoms-demo/releases/$release\""
ssh "$HOST" "${remote_env}bash \"\$HOME/atoms-demo/releases/$release/scripts/release.sh\" \"\$HOME/atoms-demo/releases/$release\""
