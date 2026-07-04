#!/usr/bin/env bash
# =============================================================================
# GusVoice — turnkey installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Gleb1290/gusvoice/main/install.sh | bash
#   # or: git clone … && cd gusvoice && ./install.sh
#
# Installs Docker if it's missing, asks a few questions, GENERATES ALL SECRETS,
# writes .env and brings the whole stack up (postgres · redis · livekit · backend ·
# presence · client). TLS is either the BUNDLED Caddy (automatic Let's Encrypt) or
# YOUR OWN reverse proxy (Nginx Proxy Manager / nginx / Traefik) — the installer
# asks, so it never fights an existing proxy for ports 80/443. Manual steps left to
# you: DNS records + opening the LiveKit media ports.
#
# Idempotent-ish: re-running keeps an existing .env (won't clobber your secrets).
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Public prebuilt images (GHCR). Override the registry/tag with the REGISTRY / TAG env vars.
REGISTRY_DEFAULT="${REGISTRY:-ghcr.io/gleb1290/gusvoice}"
TAG_DEFAULT="${TAG:-latest}"

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
info() { printf '  \033[0;90m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

gen_secret() { openssl rand -hex 32; }

ask() { # ask "Prompt" "default" -> echoes the answer. Reads /dev/tty so a piped
        # `curl … | bash` (where stdin IS the script text) still prompts the real terminal.
  local prompt="$1" def="${2:-}" ans
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " ans </dev/tty || ans=""; echo "${ans:-$def}"
  else read -r -p "$prompt: " ans </dev/tty || ans=""; echo "$ans"; fi
}
yes_no() { # yes_no "Prompt" "Y|N default" -> 0 for yes, 1 for no
  local ans; ans="$(ask "$1" "${2:-N}")"; case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# --- Self-bootstrap: fetch the repo if the stack files aren't here ----------
# Run via `curl … | bash`, ONLY this script exists — docker-compose.yml + config/
# do not. Clone the repo and continue from inside it, so one piped command really
# installs everything. (Running ./install.sh from a git clone skips this.)
if [ ! -f docker-compose.yml ]; then
  command -v git >/dev/null 2>&1 || die "git is required to fetch GusVoice (e.g. apt install -y git), then re-run."
  TARGET="${GUSVOICE_DIR:-gusvoice}"
  say "Fetching GusVoice into ./${TARGET} …"
  if [ -d "$TARGET/.git" ]; then ( cd "$TARGET" && git pull --ff-only ) || info "(using existing ./$TARGET as-is)"
  else git clone --depth 1 https://github.com/Gleb1290/gusvoice.git "$TARGET" || die "git clone failed — check the network."; fi
  cd "$TARGET"
fi

# --- Prerequisites (bootstrap Docker if missing) ----------------------------
say "GusVoice installer"
command -v openssl >/dev/null 2>&1 || die "openssl is required (e.g. apt install -y openssl)"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  info "Docker (Engine + Compose v2) was not found on this machine."
  command -v curl >/dev/null 2>&1 || die "curl is needed to install Docker (apt install -y curl) — or install Docker yourself: https://docs.docker.com/engine/install/"
  if yes_no 'Install Docker now via the official get.docker.com script?' 'Y'; then
    say "Installing Docker…"
    curl -fsSL https://get.docker.com | sh || die "Docker install failed — install it manually: https://docs.docker.com/engine/install/"
    docker compose version >/dev/null 2>&1 || die "Docker installed, but 'docker compose' is still missing — check the installation."
    info "Docker installed. (Not root? Log out/in so your user joins the 'docker' group, then re-run this.)"
  else
    die "Docker + Compose v2 are required. See https://docs.docker.com/engine/install/"
  fi
fi

# --- Config: a fresh run asks; an existing .env is reused -------------------
if [ -f .env ]; then
  say "An .env already exists — keeping it (delete it to reconfigure from scratch)."
  USE_CADDY="$(grep -E '^USE_CADDY=' .env | cut -d= -f2 || true)"; USE_CADDY="${USE_CADDY:-1}"
else
  say "A few questions (press Enter to accept defaults):"
  BASE_DOMAIN="$(ask 'Your base domain (e.g. example.com)' 'example.com')"
  ACME_EMAIL="$(ask 'Email for Let'\''s Encrypt (TLS certs)' "admin@${BASE_DOMAIN}")"
  SUPERADMIN="$(ask 'Super-admin username (the account granted full access)' 'admin')"

  info "Domain mode: subdomains (voice/api/presence/lk/media/ntfy.${BASE_DOMAIN})."
  info "Single-name mode (everything under one host) is coming — subdomains for now."

  # --- Reverse proxy / TLS: bundled Caddy vs your own proxy ------------------
  say "Reverse proxy / TLS:"
  info "GusVoice needs HTTPS on those subdomains. It can bundle Caddy (automatic Let's"
  info "Encrypt on ports 80/443), OR stay behind a reverse proxy you already run"
  info "(Nginx Proxy Manager / nginx / Traefik) so nothing fights over 80/443."
  if yes_no 'Do you ALREADY run your own reverse proxy on 80/443 (NPM/nginx/Traefik)?' 'N'; then
    USE_CADDY=0
    if yes_no 'Is that proxy on a DIFFERENT host than this one?' 'N'; then BIND_ADDR_VAL=0.0.0.0; else BIND_ADDR_VAL=127.0.0.1; fi
  else
    USE_CADDY=1; BIND_ADDR_VAL=127.0.0.1
  fi

  SMTP_HOST=""; SMTP_USER=""; SMTP_PASS=""; MAIL_FROM="GusVoice <noreply@${BASE_DOMAIN}>"
  if yes_no 'Configure SMTP for email verification?' 'N'; then
    SMTP_HOST="$(ask 'SMTP host' '')"
    SMTP_USER="$(ask 'SMTP username' "noreply@${BASE_DOMAIN}")"
    SMTP_PASS="$(ask 'SMTP password' '')"
  fi

  # --- Generated secrets ----------------------------------------------------
  say "Generating secrets…"
  JWT_SECRET="$(gen_secret)"
  LIVEKIT_API_SECRET="$(gen_secret)"
  POSTGRES_PASSWORD="$(gen_secret)"
  MINIO_ACCESS_KEY="gusvoice"
  MINIO_SECRET_KEY="$(gen_secret)"

  # --- Public IP (for LiveKit ICE) ------------------------------------------
  PUBLIC_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo '')"
  [ -n "$PUBLIC_IP" ] && info "Detected public IP: $PUBLIC_IP (LiveKit will advertise it via STUN)."

  # --- Write .env -----------------------------------------------------------
  say "Writing .env…"
  cat > .env <<EOF
# Generated by install.sh — DO NOT COMMIT. Regenerate by deleting this file and re-running.
BASE_DOMAIN=${BASE_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}

POSTGRES_USER=gusvoice
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=gusvoice

JWT_SECRET=${JWT_SECRET}
SUPERADMIN_USERNAME=${SUPERADMIN}
ADMIN_EMAIL=

MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
MINIO_BUCKET=gusvoice
MINIO_PUBLIC_URL=https://media.${BASE_DOMAIN}

SMTP_HOST=${SMTP_HOST}
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
MAIL_FROM=${MAIL_FROM}

# Filled after the ntfy container is up (see below).
NTFY_BASE_URL=https://ntfy.${BASE_DOMAIN}
NTFY_TOKEN=

LIVEKIT_API_KEY=gusvoice
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}
LIVEKIT_URL_EXTERNAL=wss://lk.${BASE_DOMAIN}

VITE_API_URL=https://api.${BASE_DOMAIN}
VITE_PRESENCE_WS=wss://presence.${BASE_DOMAIN}
VITE_PUSH_GATEWAY=https://ntfy.${BASE_DOMAIN}
CLIENT_ORIGIN=https://voice.${BASE_DOMAIN}

REGISTRY=${REGISTRY_DEFAULT}
TAG=${TAG_DEFAULT}
# TLS mode: USE_CADDY=1 bundles Caddy (grabs 80/443); 0 = your own reverse proxy.
# BIND_ADDR = interface the proxied services listen on (127.0.0.1 = this host only;
# 0.0.0.0 = reachable by a proxy on another host). LiveKit media 7881/7882 stay public.
USE_CADDY=${USE_CADDY}
BIND_ADDR=${BIND_ADDR_VAL}
EOF
  chmod 600 .env
fi

# --- Bring the stack up -----------------------------------------------------
if [ "${USE_CADDY:-1}" = "1" ]; then
  PROFILES=(--profile caddy --profile storage --profile push)
else
  PROFILES=(--profile storage --profile push)   # no bundled Caddy — your proxy fronts it
fi
say "Pulling images…"
docker compose "${PROFILES[@]}" pull --quiet || info "(pull skipped — building locally or images not published yet)"
say "Starting the stack…"
docker compose "${PROFILES[@]}" up -d

# --- Create the ntfy publish token (once) -----------------------------------
# The backend needs a write token to publish wake payloads. anon stays read-only.
# TODO(P8): verify these ntfy CLI calls against the pinned ntfy version.
if ! grep -q '^NTFY_TOKEN=..' .env; then
  say "Provisioning the ntfy publish token…"
  sleep 5
  if docker compose "${PROFILES[@]}" exec -T ntfy ntfy user list 2>/dev/null | grep -q gusvoice; then
    info "ntfy user already exists."
  else
    NTFY_PW="$(gen_secret)"
    NTFY_PASSWORD="$NTFY_PW" docker compose "${PROFILES[@]}" exec -T -e NTFY_PASSWORD="$NTFY_PW" ntfy \
      ntfy user add --role=user gusvoice >/dev/null 2>&1 || info "(ntfy user add failed — provision the token manually)"
    docker compose "${PROFILES[@]}" exec -T ntfy ntfy access gusvoice 'up*' write >/dev/null 2>&1 || true
  fi
  TOKEN="$(docker compose "${PROFILES[@]}" exec -T ntfy ntfy token add gusvoice 2>/dev/null | grep -oE 'tk_[A-Za-z0-9]+' | head -n1 || true)"
  if [ -n "$TOKEN" ]; then
    # Portable in-place edit (BSD/GNU sed differ) — rewrite the line.
    grep -v '^NTFY_TOKEN=' .env > .env.tmp && echo "NTFY_TOKEN=${TOKEN}" >> .env.tmp && mv .env.tmp .env
    chmod 600 .env
    docker compose "${PROFILES[@]}" up -d backend
    info "ntfy token stored; backend restarted with push enabled."
  else
    info "Could not auto-create the ntfy token — push is off until you set NTFY_TOKEN in .env."
  fi
fi

# --- Done -------------------------------------------------------------------
BASE_DOMAIN="$(grep '^BASE_DOMAIN=' .env | cut -d= -f2)"
BIND_ADDR="$(grep '^BIND_ADDR=' .env | cut -d= -f2 || echo 127.0.0.1)"; BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
SUPERADMIN="$(grep '^SUPERADMIN_USERNAME=' .env | cut -d= -f2 || echo admin)"
PUBLIC_IP="${PUBLIC_IP:-<your-server-public-IP>}"
say "GusVoice is up."
if [ "${USE_CADDY:-1}" = "1" ]; then
  cat <<EOF

  Bundled Caddy is handling TLS. Two manual steps remain:

  1) DNS — point these at your server (a wildcard A-record *.${BASE_DOMAIN} covers them all):
       voice.${BASE_DOMAIN}   api.${BASE_DOMAIN}   presence.${BASE_DOMAIN}
       lk.${BASE_DOMAIN}      media.${BASE_DOMAIN}   ntfy.${BASE_DOMAIN}
     -> ${PUBLIC_IP}

  2) Ports — open on your firewall:
       80/tcp, 443/tcp     (web + HTTPS, Caddy)
       7881/tcp, 7882/udp  (LiveKit media — direct, NOT proxied)
EOF
else
  cat <<EOF

  Behind YOUR reverse proxy — no Caddy was started. Add these proxy hosts (upstream host ${BIND_ADDR}):
       voice.${BASE_DOMAIN}     ->  ${BIND_ADDR}:8080
       api.${BASE_DOMAIN}       ->  ${BIND_ADDR}:4000
       presence.${BASE_DOMAIN}  ->  ${BIND_ADDR}:4001    (enable WebSockets)
       lk.${BASE_DOMAIN}        ->  ${BIND_ADDR}:7880    (enable WebSockets)
       media.${BASE_DOMAIN}     ->  ${BIND_ADDR}:9000
       ntfy.${BASE_DOMAIN}      ->  ${BIND_ADDR}:8082
  Give each host an HTTPS cert in your proxy. Then:

  1) DNS — point voice/api/presence/lk/media/ntfy.${BASE_DOMAIN} (or *.${BASE_DOMAIN}) at your proxy.
  2) Ports — open 7881/tcp + 7882/udp on THIS host (LiveKit media — direct, NOT proxied).
EOF
fi
cat <<EOF

  Then open  https://voice.${BASE_DOMAIN}  and register the "${SUPERADMIN:-admin}" account.
  Desktop/Android clients: download from the project's Releases, then enter  voice.${BASE_DOMAIN}  at login.

EOF
