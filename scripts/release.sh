#!/usr/bin/env bash
# Runs ON THE SERVER, started by scripts/deploy.sh. Builds an uploaded release next to the live
# one and only switches to it once the build has succeeded.
#
#   release.sh <release-dir>    build, switch, restart, verify; roll back if it does not come up
#   release.sh --rollback       switch back to the release before the current one
#
# Layout under ~/atoms-demo (created by scripts/setup.sh):
#   node/               the Node runtime
#   shared/.env.local   secrets and settings, shared by every release
#   shared/deploy.env   per-server deploy settings (npm registry, port)
#   shared/data/        the SQLite database
#   releases/<id>/      one directory per deploy
#   current             symlink to the release being served
#   backups/            database copies (one before each deploy, plus the daily timer)
set -euo pipefail

ATOMS_HOME="${ATOMS_HOME:-$HOME/atoms-demo}"
# Per-server settings written by setup.sh (npm registry, port); values passed in by deploy.sh win.
# shellcheck disable=SC1091
[ -f "$ATOMS_HOME/shared/deploy.env" ] && . "$ATOMS_HOME/shared/deploy.env"
PORT="${PORT:-3100}"
SERVICE="${SERVICE:-atoms-demo}"
RESTART_CMD="${RESTART_CMD:-sudo -n systemctl restart $SERVICE}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
# How long to wait for running generations to finish before restarting (0 = do not wait).
DRAIN_SECONDS="${DRAIN_SECONDS:-300}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

[ -d "$ATOMS_HOME/node/bin" ] && export PATH="$ATOMS_HOME/node/bin:$PATH"
say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }

# Prints the number of running generation jobs; fails when the app does not answer.
health() {
  node -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/api/health`, { signal: AbortSignal.timeout(3000) })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body) => (body.ok ? console.log(body.jobs ?? 0) : Promise.reject()))
      .catch(() => process.exit(1));
  ' "$PORT" 2>/dev/null
}

wait_healthy() {
  for _ in $(seq 1 40); do
    health >/dev/null && return 0
    sleep 1
  done
  return 1
}

current_release() {
  [ -L "$ATOMS_HOME/current" ] && readlink "$ATOMS_HOME/current" || true
}

switch_to() {
  ln -sfn "$1" "$ATOMS_HOME/current"
  $RESTART_CMD
}

[ -f "$ATOMS_HOME/shared/.env.local" ] || die "$ATOMS_HOME/shared/.env.local is missing. Run scripts/setup.sh first (see docs/部署.md)."
mkdir -p "$ATOMS_HOME/shared/data" "$ATOMS_HOME/releases" "$ATOMS_HOME/backups"

if [ "${1:-}" = "--rollback" ]; then
  now="$(current_release)"
  [ -n "$now" ] || die "nothing is deployed yet"
  previous=""
  for dir in $(ls -1d "$ATOMS_HOME"/releases/*/ | sort); do
    dir="${dir%/}"
    [ "$dir" = "$now" ] && break
    previous="$dir"
  done
  [ -n "$previous" ] || die "there is no release older than $(basename "$now") to go back to"
  say "Rolling back from $(basename "$now") to $(basename "$previous")"
  switch_to "$previous"
  wait_healthy || die "the previous release did not come up either; check: journalctl -u $SERVICE -n 50"
  say "Rolled back. The database was not changed; restore a copy from $ATOMS_HOME/backups if you need to."
  exit 0
fi

RELEASE="${1:?usage: release.sh <release-dir> | --rollback}"
RELEASE="$(cd "$RELEASE" && pwd)"
cd "$RELEASE"

# Until the switch, a failure only costs this directory; the live site is untouched.
switched=0
trap '[ "$switched" = 1 ] || { echo "error: release failed before going live; the running version was not touched" >&2; rm -rf "$RELEASE"; }' EXIT

say "Installing dependencies"
ln -sfn "$ATOMS_HOME/shared/.env.local" .env.local
npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund

say "Building"
npm run build
# The database is linked in only after the build, so a build can never touch live data.
rm -rf data
ln -sfn "$ATOMS_HOME/shared/data" data

if [ -f "$ATOMS_HOME/shared/data/atoms.db" ]; then
  say "Backing up the database"
  node --env-file-if-exists=.env.local scripts/backup.mjs "$ATOMS_HOME/backups"
fi

# A restart cuts off running generations (they are refunded on the next start, but the user
# still has to ask again), so give them a chance to finish first.
if [ "$DRAIN_SECONDS" -gt 0 ] && jobs="$(health)" && [ "$jobs" -gt 0 ]; then
  say "Waiting up to ${DRAIN_SECONDS}s for $jobs running generation(s) to finish"
  deadline=$(( $(date +%s) + DRAIN_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ] && jobs="$(health)" && [ "$jobs" -gt 0 ]; do sleep 5; done
fi

previous="$(current_release)"
say "Switching to $(basename "$RELEASE") and restarting"
switched=1
switch_to "$RELEASE"

if ! wait_healthy; then
  echo "error: the new release did not pass the health check" >&2
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    say "Rolling back to $(basename "$previous")"
    switch_to "$previous"
    if wait_healthy; then
      say "Rolled back; the site is serving the previous release."
      rm -rf "$RELEASE"
    else
      echo "error: the previous release did not come up either" >&2
    fi
  fi
  die "deploy failed. Logs: journalctl -u $SERVICE -n 50"
fi

# Keep the newest few releases (rollback targets); never remove the one being served.
count=0
for dir in $(ls -1d "$ATOMS_HOME"/releases/*/ | sort -r); do
  dir="${dir%/}"
  count=$((count + 1))
  [ "$count" -le "$KEEP_RELEASES" ] || [ "$dir" = "$RELEASE" ] || rm -rf "$dir"
done

say "Live: $(basename "$RELEASE")"
