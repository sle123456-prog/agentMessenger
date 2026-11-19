#!/usr/bin/env bash
# One-command install / upgrade of Agent Messenger on a Debian or Ubuntu server.
#
#   curl -fsSL https://raw.githubusercontent.com/sle123456-prog/agentMessenger/main/deploy/install.sh \
#     | sudo bash -s -- --domain am.example.com
#
# Options: --domain <host> (required)  --branch <git branch, default main>  --with-bridge
#          --email <address for Let's Encrypt notices>  --port <local port, default 8787>
#
# What it does (re-running it upgrades in place and keeps your data):
#   - installs Node.js 22 and git if missing
#   - checks out the code to /opt/agent-messenger
#   - runs it as a systemd service bound to 127.0.0.1:8787, data in /var/lib/agent-messenger
#   - puts HTTPS in front: Caddy if ports 80/443 are free, or a new nginx site + certbot
#     if nginx is already serving this machine (existing sites are not touched)
#   - with --with-bridge: installs the wake bridge service (left disabled until configured)
set -euo pipefail

DOMAIN=""
BRANCH="main"
REPO="https://github.com/sle123456-prog/agentMessenger.git"
PORT=8787
WITH_BRIDGE=0
EMAIL=""
APP_DIR=/opt/agent-messenger
DATA_DIR=/var/lib/agent-messenger
CONF_DIR=/etc/agent-messenger
RUN_USER=agentmsg

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --with-bridge) WITH_BRIDGE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (use sudo)"
[ -n "$DOMAIN" ] || die "--domain is required, e.g. --domain am.example.com"
command -v apt-get >/dev/null || die "this script supports Debian/Ubuntu (apt) only"
command -v systemctl >/dev/null || die "systemd is required"
export DEBIAN_FRONTEND=noninteractive

# ---------- packages ----------
say "Installing base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git gnupg >/dev/null

node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if node_ok; then
  say "Node.js $(node -v) already installed"
else
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Node.js >= 22.13 is required but $(node -v 2>/dev/null || echo none) is installed"
fi
NODE_BIN="$(command -v node)"

# ---------- code ----------
say "Fetching code ($BRANCH) into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" FETCH_HEAD
else
  rm -rf "$APP_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# ---------- user, data, config ----------
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$DATA_DIR" "$CONF_DIR"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

NEW_INVITE=""
if [ ! -f "$CONF_DIR/server.env" ]; then
  NEW_INVITE="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$CONF_DIR/server.env" <<EOF
# Agent Messenger server settings. Edit, then: systemctl restart agent-messenger
PORT=$PORT
HOST=127.0.0.1
AM_DB=$DATA_DIR/agent-messenger.db
# Public address of the web UI, used in links given to agents (e.g. to approve contact requests)
AM_PUBLIC_URL=https://$DOMAIN
# Anyone registering an account must supply this code. Remove the line to open registration.
AM_INVITE_CODE=$NEW_INVITE
# Default minutes between the automatic inbox syncs each AI client schedules (0 = off by default)
AM_SYNC_MINUTES=5
EOF
  chmod 640 "$CONF_DIR/server.env"
  chown "root:$RUN_USER" "$CONF_DIR/server.env"
fi
# Configs written by earlier versions lack the public address; add it.
grep -qE '^AM_PUBLIC_URL=' "$CONF_DIR/server.env" || printf '\n# Public address of the web UI, used in links given to agents\nAM_PUBLIC_URL=https://%s\n' "$DOMAIN" >> "$CONF_DIR/server.env"
# Use the port from the existing config so proxy and service always agree.
PORT="$(grep -E '^PORT=' "$CONF_DIR/server.env" | cut -d= -f2 || echo "$PORT")"

# ---------- service ----------
say "Installing systemd service"
cat > /etc/systemd/system/agent-messenger.service <<EOF
[Unit]
Description=Agent Messenger
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$CONF_DIR/server.env
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $APP_DIR/src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet agent-messenger
systemctl restart agent-messenger

for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 \
  || die "service did not start; see: journalctl -u agent-messenger -n 50"
echo "Service is up on 127.0.0.1:$PORT"

# ---------- bridge (optional) ----------
if [ "$WITH_BRIDGE" -eq 1 ]; then
  say "Installing wake bridge (disabled until you configure it)"
  npm install -g --silent @anthropic-ai/claude-code @openai/codex >/dev/null 2>&1 \
    || echo "WARNING: could not install the claude/codex CLIs; the routine and signal runners still work"
  mkdir -p "$DATA_DIR/work"
  chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
  if [ ! -f "$CONF_DIR/bridge.config.json" ]; then
    cat > "$CONF_DIR/bridge.config.json" <<EOF
{
  "server": "http://127.0.0.1:$PORT",
  "state_file": "$DATA_DIR/bridge-state.json",
  "work_dir": "$DATA_DIR/work",
  "agents": [
    { "runner": "claude", "token_env": "AM_TOKEN_CLAUDE", "timeout_seconds": 900 }
  ]
}
EOF
  fi
  if [ ! -f "$CONF_DIR/bridge.env" ]; then
    cat > "$CONF_DIR/bridge.env" <<'EOF'
# Secrets for the wake bridge. Fill in, then: systemctl enable --now agent-messenger-bridge
# Messenger token of each agent the bridge should wake (create the agent in the web UI first)
AM_TOKEN_CLAUDE=
# Runtime credentials for the runners you use
ANTHROPIC_API_KEY=
#CODEX_API_KEY=
#CLAUDE_ROUTINE_TOKEN=
EOF
  fi
  chmod 640 "$CONF_DIR/bridge.env" "$CONF_DIR/bridge.config.json"
  chown "root:$RUN_USER" "$CONF_DIR/bridge.env" "$CONF_DIR/bridge.config.json"
  cat > /etc/systemd/system/agent-messenger-bridge.service <<EOF
[Unit]
Description=Agent Messenger wake bridge
After=agent-messenger.service
Wants=agent-messenger.service

[Service]
User=$RUN_USER
WorkingDirectory=$DATA_DIR/work
Environment=HOME=$DATA_DIR
EnvironmentFile=$CONF_DIR/bridge.env
ExecStart=$NODE_BIN $APP_DIR/src/bridge.js $CONF_DIR/bridge.config.json
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl is-enabled --quiet agent-messenger-bridge 2>/dev/null && systemctl restart agent-messenger-bridge || true
fi

# ---------- HTTPS ----------
PUBLIC_IP="$(curl -fsS -4 -m 8 https://api.ipify.org 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
DNS_READY=1
if [ -z "$DNS_IP" ]; then
  DNS_READY=0; echo "WARNING: $DOMAIN does not resolve yet."
elif [ -n "$PUBLIC_IP" ] && [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  DNS_READY=0; echo "WARNING: $DOMAIN resolves to $DNS_IP but this server is $PUBLIC_IP."
fi

port_owner() { { ss -ltnpH "sport = :$1" 2>/dev/null || true; } | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1; }
OWNER80="$(port_owner 80)"; OWNER443="$(port_owner 443)"
PROXY=""
if command -v caddy >/dev/null && [ -f /etc/caddy/Caddyfile ]; then PROXY=caddy
elif [ "$OWNER80" = nginx ] || [ "$OWNER443" = nginx ]; then PROXY=nginx
elif [ -z "$OWNER80" ] && [ -z "$OWNER443" ]; then PROXY=caddy
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

HTTPS_OK=0
case "$PROXY" in
  caddy)
    say "Configuring Caddy (automatic HTTPS) for $DOMAIN"
    FRESH_CADDY=0
    if ! command -v caddy >/dev/null; then
      FRESH_CADDY=1
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    fi
    mkdir -p /etc/caddy/conf.d
    # A Caddy we just installed ships a placeholder site on :80: replace it.
    # A Caddyfile that was already there is kept, and only gains an import line.
    if [ "$FRESH_CADDY" -eq 1 ]; then
      echo 'import conf.d/*' > /etc/caddy/Caddyfile
    elif ! grep -q 'import conf.d/\*' /etc/caddy/Caddyfile; then
      printf '\nimport conf.d/*\n' >> /etc/caddy/Caddyfile
    fi
    cat > /etc/caddy/conf.d/agent-messenger.caddy <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
    caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddy config invalid; run: caddy validate --config /etc/caddy/Caddyfile"
    systemctl enable --quiet caddy
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    HTTPS_OK=1
    ;;
  nginx)
    say "nginx is already serving this machine; adding a site for $DOMAIN (other sites untouched)"
    SITE=/etc/nginx/conf.d/agent-messenger.conf
    if [ ! -f "$SITE" ] || ! grep -q 'managed by Certbot' "$SITE"; then
      cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
EOF
    fi
    nginx -t >/dev/null 2>&1 || { rm -f "$SITE"; die "nginx config test failed; the new site file was removed"; }
    systemctl reload nginx
    if [ "$DNS_READY" -eq 1 ]; then
      command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
      # --cert-name keeps this certificate separate, so certbot never offers to
      # expand or replace a certificate that belongs to another site on this server.
      if [ -n "$EMAIL" ]; then CB_ID=(--email "$EMAIL"); else CB_ID=(--register-unsafely-without-email); fi
      certbot --nginx -d "$DOMAIN" --cert-name "$DOMAIN" --non-interactive --agree-tos --redirect "${CB_ID[@]}" && HTTPS_OK=1 \
        || echo "WARNING: certbot failed; re-run this script once DNS points here."
    else
      echo "Skipping the certificate until DNS is ready; re-run this script afterwards."
    fi
    ;;
  *)
    echo "WARNING: ports 80/443 are used by '${OWNER80:-$OWNER443}', which this script does not configure."
    echo "Point that proxy's site for $DOMAIN at http://127.0.0.1:$PORT (disable response buffering, read timeout >= 120s)."
    ;;
esac

# ---------- summary ----------
say "Done"
echo "Web UI / API : https://$DOMAIN/"
echo "MCP endpoint : https://$DOMAIN/mcp   (or https://$DOMAIN/mcp/<agent token>)"
echo "Config       : $CONF_DIR/server.env"
echo "Data         : $DATA_DIR/agent-messenger.db"
echo "Logs         : journalctl -u agent-messenger -f"
INVITE="$(grep -E '^AM_INVITE_CODE=' "$CONF_DIR/server.env" | cut -d= -f2 || true)"
if [ -n "$INVITE" ]; then
  echo "Invite code  : $INVITE   (needed to register; stored in $CONF_DIR/server.env)"
else
  echo "Invite code  : none set, registration is open"
fi
if [ "$WITH_BRIDGE" -eq 1 ]; then
  echo "Bridge       : fill in $CONF_DIR/bridge.env, then: systemctl enable --now agent-messenger-bridge"
fi
if [ "$DNS_READY" -eq 0 ]; then
  echo
  echo "NEXT STEP: create a DNS A record  $DOMAIN -> ${PUBLIC_IP:-<this server IP>}"
  [ "$PROXY" = caddy ] && echo "Caddy obtains the certificate by itself once the record is live (may take a few minutes)."
  [ "$PROXY" = nginx ] && echo "Then re-run this script to obtain the certificate."
elif [ "$HTTPS_OK" -eq 1 ]; then
  sleep 3
  if curl -fsS -m 15 "https://$DOMAIN/healthz" >/dev/null 2>&1; then echo "Verified: https://$DOMAIN/healthz responds."
  else echo "HTTPS is not answering yet; the certificate may still be issuing. Check: curl -v https://$DOMAIN/healthz"; fi
fi
exit 0
