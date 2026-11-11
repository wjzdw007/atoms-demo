#!/usr/bin/env bash
# Deploys the current commit to a single server over SSH.
#
# One-time server setup (see README "部署"): Node unpacked at ~/atoms-demo/node, secrets in
# ~/atoms-demo/app/.env.local, and the atoms-demo systemd service installed.
# The SQLite database lives in ~/atoms-demo/app/data and is never touched by a deploy.
set -euo pipefail

HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to the SSH host to deploy to, e.g. DEPLOY_HOST=my-server ./scripts/deploy.sh}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

echo "==> Uploading $(git rev-parse --short HEAD) to $HOST"
# Clear the previous source first so files deleted from the repo do not linger on the server;
# secrets, the database, dependencies and the build cache are kept.
git archive HEAD | ssh "$HOST" 'mkdir -p ~/atoms-demo/app && cd ~/atoms-demo/app \
  && find . -mindepth 1 -maxdepth 1 ! -name .env.local ! -name data ! -name node_modules ! -name .next -exec rm -rf {} + \
  && tar -x -C ~/atoms-demo/app'

echo "==> Installing dependencies and building"
ssh "$HOST" "cd ~/atoms-demo/app && export PATH=\$HOME/atoms-demo/node/bin:\$PATH \
  && npm ci --registry=$REGISTRY --no-audit --no-fund \
  && npm run build \
  && sudo systemctl restart atoms-demo \
  && sleep 3 && systemctl is-active atoms-demo"
