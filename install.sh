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

# From a file (git clone / download) → work in the script's own dir. Piped (`curl | bash`)
# → BASH_SOURCE is unset under `set -u`, so stay in the current directory (the self-fetch
# below pulls the repo into ./gusvoice).
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then cd "$(dirname "$src")"; fi

# Public prebuilt images (GHCR). Override the registry/tag with the REGISTRY / TAG env vars.
REGISTRY_DEFAULT="${REGISTRY:-ghcr.io/gleb1290/gusvoice}"
TAG_DEFAULT="${TAG:-latest}"

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
info() { printf '  \033[0;90m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Colours for the final "point X at Y" summary — each kind of value gets its own so the dense block
# is scannable: IP addresses (cyan), the service ports a reverse proxy targets (yellow), and the ports
# you forward/open DIRECTLY at the router/firewall for LiveKit media + TLS (magenta).
C_IP=$'\033[1;36m'; C_PORT=$'\033[1;33m'; C_FWD=$'\033[1;35m'; C_OFF=$'\033[0m'

gen_secret() { # 32 random bytes as hex — openssl if present, else /dev/urandom (no openssl dep)
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# --- Network topology helpers (so we advise the RIGHT address behind NAT) ----
priv_ip()  { # RFC1918 / link-local — a private (non-internet-routable) address
  case "$1" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|169.254.*) return 0 ;; *) return 1 ;; esac
}
cgnat_ip() { # 100.64.0.0/10 — carrier-grade NAT (no inbound; needs a tunnel)
  case "$1" in 100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;; *) return 1 ;; esac
}
local_ip() { # this machine's own LAN address = the source IP for outbound traffic
  local ip; ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')"
  [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "$ip"
}

ask() { # ask "Prompt" "default" -> echoes the answer. Reads /dev/tty so a piped
        # `curl … | bash` (where stdin IS the script text) still prompts the real terminal.
  local prompt="$1" def="${2:-}" ans
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " ans </dev/tty || ans=""; echo "${ans:-$def}"
  else read -r -p "$prompt: " ans </dev/tty || ans=""; echo "$ans"; fi
}
yes_no() { # yes_no "Prompt" "Y|N default" -> 0 for yes, 1 for no
  local ans; ans="$(ask "$1" "${2:-N}")"; case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
ask_secret() { # ask_secret "Prompt" -> echoes a min-6 secret, entered twice (silent). Prompts to /dev/tty.
  local prompt="$1" a b
  while :; do
    printf '  %s: ' "$prompt" >/dev/tty; read -rs a </dev/tty; printf '\n' >/dev/tty
    printf '  repeat: '        >/dev/tty; read -rs b </dev/tty; printf '\n' >/dev/tty
    [ "$a" = "$b" ] || { printf '  ✗ they do not match — try again\n' >/dev/tty; continue; }
    [ "${#a}" -ge 6 ] || { printf '  ✗ min 6 characters — try again\n' >/dev/tty; continue; }
    printf '%s' "$a"; return 0
  done
}

# --- Self-bootstrap: fetch the repo if the stack files aren't here ----------
# Run via `curl … | bash`, ONLY this script exists — docker-compose.yml + config/ do
# not. Download the repo tarball (curl + tar — NO git needed) and continue from inside
# it, so one piped command really installs everything. (./install.sh from a checkout
# already has the files and skips this.)
if [ ! -f docker-compose.yml ]; then
  TARGET="${GUSVOICE_DIR:-gusvoice}"
  if [ -f "$TARGET/docker-compose.yml" ]; then
    say "Using existing ./$TARGET"; cd "$TARGET"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to fetch GusVoice."
    command -v tar  >/dev/null 2>&1 || die "tar is required to fetch GusVoice."
    say "Fetching GusVoice…"
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/Gleb1290/gusvoice/archive/refs/heads/main.tar.gz" | tar -xz -C "$tmp" || die "download failed — check the network."
    rm -rf "$TARGET"; mv "$tmp"/gusvoice-* "$TARGET"; rm -rf "$tmp"
    cd "$TARGET"
  fi
  # Re-run FROM THE FILE. Under `curl | bash` the script is read from stdin, and the docker/compose
  # commands below ALSO read stdin — they'd consume the rest of the script and silently drop the
  # final summary. Re-exec'ing from disk makes bash read the script off the file instead. (The
  # compose file now exists, so this self-fetch block is skipped on the re-run — no loop.)
  exec bash install.sh
fi

# --- Prerequisites (bootstrap Docker if missing) ----------------------------
say "GusVoice installer"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  info "Docker (Engine + Compose v2) was not found on this machine."
  command -v curl >/dev/null 2>&1 || die "curl is needed to install Docker (apt install -y curl) — or install Docker yourself: https://docs.docker.com/engine/install/"
  if yes_no 'Install Docker now via the official get.docker.com script?' 'Y'; then
    say "Installing Docker…"
    curl -fsSL https://get.docker.com | sh || die "Docker install failed — install it manually: https://docs.docker.com/engine/install/"
    docker compose version >/dev/null 2>&1 || die "Docker installed, but 'docker compose' is still missing — check the installation."
    info "Docker installed."
  else
    die "Docker + Compose v2 are required. See https://docs.docker.com/engine/install/"
  fi
fi

# --- Docker daemon reachability (the turnkey gotcha) ------------------------
# `docker compose version` above is a CLIENT-only check — it passes even when we can't talk to the
# daemon socket. And get.docker.com does NOT add you to the 'docker' group, so a non-root user used
# to sail past every check and only fail at the first `docker compose pull`. Probe the daemon FOR
# REAL now, and fix / explain BEFORE asking any questions or writing anything.
if ! docker info >/dev/null 2>&1; then
  docker_err="$(docker info 2>&1 >/dev/null || true)"
  me="$(id -un)"
  if [ "$(id -u)" -ne 0 ] && printf '%s' "$docker_err" | grep -qi 'permission denied'; then
    # A socket permission error means the 'docker' group. Join it (get.docker.com never does), so
    # that a NEXT login actually works — before this, re-logging in never helped because nothing had
    # added the user to the group at all.
    if ! id -nG "$me" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      if command -v sudo >/dev/null 2>&1; then
        say "Adding '$me' to the 'docker' group (the Docker installer doesn't do this)…"
        sudo usermod -aG docker "$me" || info "(couldn't add automatically — run:  sudo usermod -aG docker $me)"
      else
        info "You're not in the 'docker' group and sudo isn't available. As root run:  usermod -aG docker $me"
      fi
    fi
    # Group membership only applies to a NEW session, so THIS shell still can't continue. Stop
    # cleanly (exit 0 — nothing is broken / half-written) instead of failing at the image pull later.
    cat >&2 <<EOF

${C_PORT}Docker is installed, but this shell can't reach it yet.${C_OFF}
'$me' is now in the 'docker' group — that only takes effect in a NEW session.

  Do ONE of these, then re-run this installer:
     • log out and back in        (fresh SSH session), or
     • run:  newgrp docker        (activate the group in this shell), or
     • run:  sudo ./install.sh    (run the installer as root instead)

EOF
    exit 0
  fi
  die "Can't reach the Docker daemon.
  ${docker_err:-unknown error}
  Is it running?  Start it with:  sudo systemctl start docker"
fi

# --- Config: a fresh run asks; an existing .env is reused -------------------
if [ -f .env ]; then
  say "An .env already exists — keeping it (delete it to reconfigure from scratch)."
  USE_CADDY="$(grep -E '^USE_CADDY=' .env | cut -d= -f2 || true)"; USE_CADDY="${USE_CADDY:-1}"
else
  say "A few questions (press Enter to accept defaults):"
  BASE_DOMAIN="$(ask 'Your base domain (e.g. example.com)' 'example.com')"
  info "Domain mode: subdomains (voice/api/presence/lk/media/ntfy.${BASE_DOMAIN})."
  info "Single-name mode (everything under one host) is coming — subdomains for now."

  # --- Reverse proxy / TLS: bundled Caddy vs your own proxy ------------------
  # Asked BEFORE the ACME e-mail on purpose: that e-mail is only for the bundled Caddy's
  # Let's Encrypt. With your own proxy it's never used, so we don't even ask for it.
  say "Reverse proxy / TLS:"
  info "GusVoice needs HTTPS on those subdomains. It can bundle Caddy (automatic Let's"
  info "Encrypt on ports 80/443), OR stay behind a reverse proxy you already run"
  info "(Nginx Proxy Manager / nginx / Traefik) so nothing fights over 80/443."
  if yes_no 'Do you ALREADY run your own reverse proxy on 80/443 (NPM/nginx/Traefik)?' 'N'; then
    USE_CADDY=0; ACME_EMAIL=""   # your proxy issues the certs — no Let's Encrypt e-mail needed here
    if yes_no 'Is that proxy on a DIFFERENT host than this one?' 'N'; then BIND_ADDR_VAL=0.0.0.0; else BIND_ADDR_VAL=127.0.0.1; fi
  else
    USE_CADDY=1; BIND_ADDR_VAL=127.0.0.1
    ACME_EMAIL="$(ask 'Email for Let'\''s Encrypt (bundled Caddy TLS)' "admin@${BASE_DOMAIN}")"
  fi

  say "Super-admin account — created for you at first boot; you'll just log in with it (no signup):"
  SUPERADMIN="$(ask '  Super-admin login (username)' 'admin')"
  SUPERADMIN_EMAIL="$(ask '  Super-admin email' "admin@${BASE_DOMAIN}")"
  SUPERADMIN_PASSWORD="$(ask_secret 'Super-admin password (min 6)')"

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
  MINIO_ACCESS_KEY="$(gen_secret)"
  MINIO_SECRET_KEY="$(gen_secret)"

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
# Super-admin: the backend seeds this PRE-VERIFIED account on first boot (see packages/backend seed).
# You log in with USERNAME + PASSWORD. Safe to remove SUPERADMIN_PASSWORD after the first login.
SUPERADMIN_USERNAME=${SUPERADMIN}
SUPERADMIN_EMAIL=${SUPERADMIN_EMAIL}
SUPERADMIN_PASSWORD=${SUPERADMIN_PASSWORD}
# Where operational alerts (brute-force lockouts) are e-mailed — defaults to the super-admin's address.
ADMIN_EMAIL=${SUPERADMIN_EMAIL}

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
set +e   # the final instructions must ALWAYS print — never let a stray non-zero swallow them
BASE_DOMAIN="$(grep '^BASE_DOMAIN=' .env | cut -d= -f2)"
BIND_ADDR="$(grep '^BIND_ADDR=' .env | cut -d= -f2)";            BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
SUPERADMIN="$(grep '^SUPERADMIN_USERNAME=' .env | cut -d= -f2)"; SUPERADMIN="${SUPERADMIN:-admin}"
SMTP_HOST="$(grep '^SMTP_HOST=' .env | cut -d= -f2)"

# Network topology — advise the RIGHT address. A VPS in a DC has its public IP on the interface
# (LAN==WAN); a home box behind a router has a private LAN IP + a separate WAN IP → the upstream a
# proxy should target differs (LAN IP if the proxy is on the same network, public IP + a router
# port-forward if it's outside), and LiveKit media must be forwarded from the router either way.
LOCAL_IP="$(local_ip)"
PUBLIC_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo '')"
BEHIND_NAT=0; { [ -n "$LOCAL_IP" ]  && priv_ip  "$LOCAL_IP";  } && BEHIND_NAT=1
CGNAT=0;      { [ -n "$PUBLIC_IP" ] && cgnat_ip "$PUBLIC_IP"; } && CGNAT=1
PUB="${PUBLIC_IP:-<this-server-public-IP>}"
LAN="${LOCAL_IP:-<this-machine-LAN-IP>}"

upstreams() { # $1 = address — print the 6 reverse-proxy hosts pointing at it
  cat <<EOF
       voice.${BASE_DOMAIN}     ->  ${C_IP}${1}${C_OFF}:${C_PORT}8080${C_OFF}
       api.${BASE_DOMAIN}       ->  ${C_IP}${1}${C_OFF}:${C_PORT}4000${C_OFF}    (enable WebSockets)
       presence.${BASE_DOMAIN}  ->  ${C_IP}${1}${C_OFF}:${C_PORT}4001${C_OFF}    (enable WebSockets)
       lk.${BASE_DOMAIN}        ->  ${C_IP}${1}${C_OFF}:${C_PORT}7880${C_OFF}    (enable WebSockets)
       media.${BASE_DOMAIN}     ->  ${C_IP}${1}${C_OFF}:${C_PORT}9000${C_OFF}
       ntfy.${BASE_DOMAIN}      ->  ${C_IP}${1}${C_OFF}:${C_PORT}8082${C_OFF}
EOF
}

printf '\n\033[1;32m═════════════════════════════════════════════════════════\033[0m\n'
printf   '\033[1;32m  ✅  GusVoice is UP — a few manual steps to finish:\033[0m\n'
printf   '\033[1;32m═════════════════════════════════════════════════════════\033[0m\n'

if [ "${USE_CADDY:-1}" = "1" ]; then
  cat <<EOF

  TLS: the bundled Caddy handles it (automatic Let's Encrypt).

  1) DNS — point these at this server (a wildcard *.${BASE_DOMAIN} covers them all):
       voice.${BASE_DOMAIN}   api.${BASE_DOMAIN}   presence.${BASE_DOMAIN}
       lk.${BASE_DOMAIN}      media.${BASE_DOMAIN}   ntfy.${BASE_DOMAIN}
     ->  ${C_IP}${PUB}${C_OFF}
  2) Firewall — open  ${C_FWD}80/tcp${C_OFF}, ${C_FWD}443/tcp${C_OFF}  +  ${C_FWD}7881/tcp${C_OFF}, ${C_FWD}7882/udp${C_OFF}  (LiveKit media, direct).
EOF
  if [ "$BEHIND_NAT" = "1" ]; then
    cat <<EOF
     ⚠ This box is behind NAT (LAN ${C_IP}${LAN}${C_OFF}, WAN ${C_IP}${PUB}${C_OFF}). On your ROUTER, forward
       ${C_FWD}80/tcp${C_OFF} ${C_FWD}443/tcp${C_OFF} ${C_FWD}7881/tcp${C_OFF} ${C_FWD}7882/udp${C_OFF}  ->  ${C_IP}${LAN}${C_OFF}  — otherwise nothing is reachable from outside.
EOF
  fi
elif [ "$BIND_ADDR" = "0.0.0.0" ] && [ "$BEHIND_NAT" = "1" ]; then
  # own proxy on ANOTHER host AND this box is behind NAT — upstream depends on WHERE the proxy runs
  cat <<EOF

  TLS: your OWN reverse proxy (no Caddy). This box is behind NAT (LAN ${C_IP}${LAN}${C_OFF}, WAN ${C_IP}${PUB}${C_OFF}), so the
  upstream address depends on where your proxy runs:
       • proxy in the SAME LAN            ->  use  ${C_IP}${LAN}${C_OFF}      (this box's LAN IP)
       • proxy OUTSIDE (other host / DC)  ->  use  ${C_IP}${PUB}${C_OFF}   (+ forward that TCP port on your router)
  Map each host to <that-IP>:port —
       voice :${C_PORT}8080${C_OFF}    api :${C_PORT}4000${C_OFF} (WS)    presence :${C_PORT}4001${C_OFF} (WS)
       lk :${C_PORT}7880${C_OFF} (WS)  media :${C_PORT}9000${C_OFF}       ntfy :${C_PORT}8082${C_OFF}
  1) DNS — point the 6 names at your proxy.
  2) LiveKit media — forward  ${C_FWD}7881/tcp${C_OFF} + ${C_FWD}7882/udp${C_OFF}  from the router (WAN ${C_IP}${PUB}${C_OFF}) to ${C_IP}${LAN}${C_OFF}
     (clients reach media DIRECTLY from the internet, not through the proxy).
EOF
else
  # own proxy: same host (127.0.0.1), or a VPS with a direct public IP (no NAT)
  if [ "$BIND_ADDR" = "0.0.0.0" ]; then UPSTREAM="$PUB"; else UPSTREAM="127.0.0.1"; fi
  cat <<EOF

  TLS: your OWN reverse proxy (no Caddy). Add these hosts — each with an HTTPS cert,
  upstream = this server:
EOF
  upstreams "$UPSTREAM"
  cat <<EOF
  1) DNS — point those 6 names at your proxy.
  2) Firewall — open the ports above to your proxy  +  ${C_FWD}7881/tcp${C_OFF}, ${C_FWD}7882/udp${C_OFF}  (LiveKit media, direct).
EOF
fi

if [ "$CGNAT" = "1" ]; then
  cat <<EOF

  ⚠ CGNAT DETECTED — your public IP ${C_IP}${PUB}${C_OFF} is in the 100.64.0.0/10 carrier-grade-NAT range.
    Inbound connections from the internet can't reach this box directly (port-forwarding won't help).
    Use an outbound tunnel instead — e.g. Cloudflare Tunnel or Tailscale Funnel.
EOF
fi

cat <<EOF

  Then open  https://voice.${BASE_DOMAIN}  and LOG IN as  "${SUPERADMIN}"  — the account is already
  created (use the password you set). No signup, no e-mail code.
EOF
if [ -z "$SMTP_HOST" ]; then
  cat <<EOF
  (No SMTP set: any ADDITIONAL users who sign up won't get an e-mail code — read theirs from the logs,
   in $(pwd):   docker compose logs backend | grep -i "verification code")
EOF
fi
cat <<EOF
  Clients: download desktop/Android from the project's Releases, then enter  voice.${BASE_DOMAIN}  at login.

EOF
