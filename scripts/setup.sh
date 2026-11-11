#!/usr/bin/env bash
# One-command install: prepares a fresh Ubuntu/Debian server and deploys the app to it.
#
#   DEPLOY_HOST=my-server DOMAIN=atoms.example.com EMAIL=me@example.com ./scripts/setup.sh
#
# Run it from your own machine, in this repository. DEPLOY_HOST is an SSH host you can log in to
# as a user with sudo. It is safe to run again: every step checks what is already there.
#
#   DOMAIN         public domain, already pointing at the server. With it, nginx and a Let's
#                  Encrypt certificate are set up. Without it the app only listens on
#                  127.0.0.1:<PORT> and you put your own reverse proxy in front.
#   EMAIL          contact address for Let's Encrypt (required with DOMAIN). Passing it means you
#                  accept the Let's Encrypt Subscriber Agreement.
#   PORT           local port of the app (default 3100)
#   NODE_VERSION   Node release to install under ~/atoms-demo/node (default 24.14.0)
#   NODE_SHA256    checksum of that Node tarball; needed to pin a version other than the default
#   NODE_MIRROR    where to download Node from (default https://nodejs.org/dist; in mainland
#                  China use https://npmmirror.com/mirrors/node)
#   NPM_REGISTRY   npm registry for builds on the server (default https://registry.npmjs.org;
#                  in mainland China use https://registry.npmmirror.com)
#   SETUP_ONLY=1   prepare the server but do not deploy
#
# What it changes on the server is listed in docs/部署.md.
set -euo pipefail

PORT="${PORT:-3100}"
NODE_VERSION="${NODE_VERSION:-24.14.0}"
NODE_MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"

say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# On your machine: copy this script and the config templates over, run the rest there, deploy.
# ---------------------------------------------------------------------------------------------
if [ "${1:-}" != "--on-server" ]; then
  HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to the SSH host to install on, e.g. DEPLOY_HOST=my-server ./scripts/setup.sh}"
  [ -z "$DOMAIN" ] || [ -n "$EMAIL" ] || die "EMAIL is required with DOMAIN (Let's Encrypt sends expiry notices to it)"
  cd "$(git rev-parse --show-toplevel)"
  say "Copying setup files to $HOST"
  git archive HEAD deploy scripts/setup.sh | ssh "$HOST" 'rm -rf "$HOME/.atoms-setup" && mkdir -p "$HOME/.atoms-setup" && tar -x -C "$HOME/.atoms-setup"'
  # -t: sudo on the server may ask for a password.
  ssh -t "$HOST" "$(printf 'PORT=%q NODE_VERSION=%q NODE_SHA256=%q NODE_MIRROR=%q NPM_REGISTRY=%q DOMAIN=%q EMAIL=%q' \
    "$PORT" "$NODE_VERSION" "${NODE_SHA256:-}" "$NODE_MIRROR" "$NPM_REGISTRY" "$DOMAIN" "$EMAIL") bash \"\$HOME/.atoms-setup/scripts/setup.sh\" --on-server"
  if [ "${SETUP_ONLY:-}" = "1" ]; then
    say "Server is ready. Deploy with: DEPLOY_HOST=$HOST ./scripts/deploy.sh"
  else
    DEPLOY_HOST="$HOST" ./scripts/deploy.sh
    say "Done. Settings live in ~/atoms-demo/shared/.env.local on the server (see .env.example)."
    say "Without LLM_API_KEY there the app runs in demo mode; after editing: ssh $HOST sudo systemctl restart atoms-demo"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# On the server
# ---------------------------------------------------------------------------------------------
ATOMS_HOME="$HOME/atoms-demo"
FILES="$HOME/.atoms-setup/deploy"
USER_NAME="$(id -un)"

[ "$(uname -s)" = "Linux" ] || die "the server must run Linux"
command -v systemctl >/dev/null || die "systemd is required"
command -v apt-get >/dev/null || die "this script supports Ubuntu and Debian (apt). On other systems follow the manual steps in docs/部署.md"
[ "$USER_NAME" != "root" ] || die "log in as a normal user with sudo, not as root: the app should not run as root"
# `sudo -v` asks for a password even where every command is allowed without one, so try that first.
sudo -n true 2>/dev/null || sudo -v || die "this user needs sudo"

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

missing=""
for tool in curl openssl tar; do command -v "$tool" >/dev/null || missing+=" $tool"; done
if [ -n "$missing" ]; then
  say "Installing$missing"
  sudo apt-get update -qq
  # shellcheck disable=SC2086
  sudo apt-get install -y -qq $missing
fi

# 1. Node, private to the app (does not touch any system-wide Node).
if [ "$("$ATOMS_HOME/node/bin/node" -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  say "Installing Node $NODE_VERSION"
  mkdir -p "$ATOMS_HOME"
  rm -rf "$ATOMS_HOME/node.new"
  mkdir "$ATOMS_HOME/node.new"
  tarball="node-v$NODE_VERSION-linux-$arch.tar.gz"
  curl -fsSL -o "$ATOMS_HOME/$tarball" "$NODE_MIRROR/v$NODE_VERSION/$tarball"
  # Never unpack a download that has not been checked. The checksum comes from NODE_SHA256, or
  # from the values pinned here for the default version (taken from nodejs.org), or as a last
  # resort from the mirror's own list, which only guards against a damaged download.
  expected="${NODE_SHA256:-}"
  if [ -z "$expected" ]; then
    case "$NODE_VERSION-$arch" in
      24.14.0-x64) expected=dbf5b8665dec15e59e6359a517fefb47b23fdb9152d8def975b9bca3dfc6d355 ;;
      24.14.0-arm64) expected=f44740cd218de8127f1c44c41510a3a740fa5c9c8d1cdce1c3bedada79f3cde7 ;;
      *)
        say "No pinned checksum for Node $NODE_VERSION; using the list published next to the download (set NODE_SHA256 to pin it)"
        expected="$(curl -fsSL "$NODE_MIRROR/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$tarball" '$2 == f { print $1 }')"
        ;;
    esac
  fi
  actual="$(sha256sum "$ATOMS_HOME/$tarball" | awk '{ print $1 }')"
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    rm -f "$ATOMS_HOME/$tarball"
    die "Node download failed its checksum (expected ${expected:-none}, got $actual)"
  fi
  tar -xzf "$ATOMS_HOME/$tarball" --strip-components=1 -C "$ATOMS_HOME/node.new"
  rm -f "$ATOMS_HOME/$tarball"
  "$ATOMS_HOME/node.new/bin/node" -v >/dev/null || die "the downloaded Node does not run"
  rm -rf "$ATOMS_HOME/node"
  mv "$ATOMS_HOME/node.new" "$ATOMS_HOME/node"
fi

# 2. Directories.
mkdir -p "$ATOMS_HOME/shared/data" "$ATOMS_HOME/releases"
mkdir -p -m 700 "$ATOMS_HOME/backups"

# 3. Coming from the old layout (everything in ~/atoms-demo/app)? Move settings and data across.
#    The service is stopped for this, so the database is not copied mid-write; the deploy that
#    follows brings the site back. The old code stays in ~/atoms-demo/app and can be deleted later.
if [ -d "$ATOMS_HOME/app" ] && [ ! -e "$ATOMS_HOME/shared/.env.local" ] && [ -f "$ATOMS_HOME/app/.env.local" ]; then
  say "Migrating settings and data from ~/atoms-demo/app (the site is down until the deploy finishes)"
  sudo systemctl stop atoms-demo 2>/dev/null || true
  mv "$ATOMS_HOME/app/.env.local" "$ATOMS_HOME/shared/.env.local"
  if [ -d "$ATOMS_HOME/app/data" ] && [ -z "$(ls -A "$ATOMS_HOME/shared/data")" ]; then
    rmdir "$ATOMS_HOME/shared/data"
    mv "$ATOMS_HOME/app/data" "$ATOMS_HOME/shared/data"
  fi
fi

# 4. Settings. A new file gets a session secret; an existing one is never modified.
if [ ! -e "$ATOMS_HOME/shared/.env.local" ]; then
  say "Creating ~/atoms-demo/shared/.env.local"
  (
    umask 077
    {
      echo "# Settings for the app. Every option is described in .env.example."
      echo "AUTH_SECRET=$(openssl rand -hex 32)"
      if [ -n "$DOMAIN" ]; then
        echo "APP_URL=https://$DOMAIN"
      else
        echo "# Served over plain http until a TLS proxy is in front; remove this line then."
        echo "ALLOW_HTTP=1"
      fi
      echo "# Without a key the app runs in demo mode (canned output)."
      echo "# LLM_API_KEY="
    } >"$ATOMS_HOME/shared/.env.local"
  )
fi
chmod 600 "$ATOMS_HOME/shared/.env.local"
{
  echo "# Written by scripts/setup.sh; read by scripts/release.sh on every deploy."
  echo ": \"\${NPM_REGISTRY:=$NPM_REGISTRY}\""
  echo ": \"\${PORT:=$PORT}\""
} >"$ATOMS_HOME/shared/deploy.env"

# 5. systemd: the app, and a daily database backup.
say "Installing systemd units"
fill() { sed -e "s|/home/ubuntu|$HOME|g" -e "s|^User=ubuntu|User=$USER_NAME|" -e "s|-p 3100 |-p $PORT |" "$1"; }
for unit in atoms-demo.service atoms-demo-backup.service atoms-demo-backup.timer; do
  fill "$FILES/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable atoms-demo.service >/dev/null 2>&1
sudo systemctl enable --now atoms-demo-backup.timer >/dev/null 2>&1

# 6. Let deploys restart the app without a password, and nothing else.
systemctl_path="$(command -v systemctl)"
rule="$USER_NAME ALL=(root) NOPASSWD: $systemctl_path restart atoms-demo, $systemctl_path start atoms-demo, $systemctl_path stop atoms-demo"
echo "$rule" | sudo tee /etc/sudoers.d/atoms-demo.new >/dev/null
sudo chmod 440 /etc/sudoers.d/atoms-demo.new
if sudo visudo -cf /etc/sudoers.d/atoms-demo.new >/dev/null; then
  sudo mv /etc/sudoers.d/atoms-demo.new /etc/sudoers.d/atoms-demo
else
  sudo rm -f /etc/sudoers.d/atoms-demo.new
  die "could not install the sudoers rule"
fi

# 7. nginx and a certificate, unless a site for this domain is already configured.
if [ -z "$DOMAIN" ]; then
  say "No DOMAIN given: skipping nginx. The app will listen on 127.0.0.1:$PORT."
elif sudo grep -rqs "server_name[^;]*[[:space:]]$DOMAIN[[:space:];]" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null; then
  say "nginx already has a site for $DOMAIN: leaving it alone."
else
  say "Setting up nginx for $DOMAIN"
  sudo apt-get update -qq
  sudo apt-get install -y -qq nginx certbot
  sudo mkdir -p /var/www/acme
  site=/etc/nginx/sites-available/atoms-demo
  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    # Port 80 only at first: nginx will not start with a certificate path that does not exist yet.
    sudo tee "$site" >/dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 503; }
}
NGINX
    sudo ln -sfn "$site" /etc/nginx/sites-enabled/atoms-demo
    sudo nginx -t
    sudo systemctl reload nginx
    say "Requesting a certificate from Let's Encrypt"
    sudo certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive \
      --deploy-hook "systemctl reload nginx"
  fi
  sed -e "s|atoms\.example\.com|$DOMAIN|g" -e "s|127\.0\.0\.1:3100|127.0.0.1:$PORT|" "$FILES/nginx.conf.example" | sudo tee "$site" >/dev/null
  sudo ln -sfn "$site" /etc/nginx/sites-enabled/atoms-demo
  sudo nginx -t
  sudo systemctl reload nginx
fi

rm -rf "$HOME/.atoms-setup"
say "Server is ready."
