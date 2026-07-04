#!/usr/bin/env bash
# =============================================================================
# GusVoice — updater. Pulls the latest server images and refreshes the stack.
#
#   cd gusvoice && ./update.sh
#   # or one-liner:  curl -fsSL https://raw.githubusercontent.com/Gleb1290/gusvoice/main/update.sh | bash
#
# What it does (in order):
#   1. Refreshes the stack files (docker-compose.yml, config/, the scripts, README)
#      from the latest release — your OLD ones are backed up first, and your .env is
#      NEVER touched. Skip this with --images-only.
#   2. Pulls the newest container images (postgres · redis · livekit · backend ·
#      presence · client · minio · ntfy · caddy).
#   3. Recreates only the containers that changed and leaves the rest running.
#
# Your DATA (Postgres database, uploaded media, push config) lives in named Docker
# volumes and is left completely alone. Database migrations run automatically the
# moment the new backend boots — there is no manual migration step.
#
# Flags:
#   --images-only   only pull images + recreate; do NOT refresh the stack files
#   --prune         remove old dangling images afterwards to reclaim disk
#   -y, --yes       don't ask anything, just do it
#   -h, --help      show this help
# =============================================================================
set -euo pipefail

REFRESH_FILES=1; PRUNE=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --images-only) REFRESH_FILES=0 ;;
    --prune)       PRUNE=1 ;;
    -y|--yes)      ASSUME_YES=1 ;;
    -h|--help)     sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
info() { printf '  \033[0;90m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '  \033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Locate the install dir (mirror install.sh) ------------------------------
# From a file → work in the script's own dir. Piped (curl | bash) → look for ./gusvoice.
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then cd "$(dirname "$src")"; fi
if [ ! -f docker-compose.yml ]; then
  if [ -f gusvoice/docker-compose.yml ]; then cd gusvoice
  else die "No docker-compose.yml here. Run this from your GusVoice directory (the one with docker-compose.yml + .env)."; fi
fi
[ -f .env ] || die ".env not found — this doesn't look like a GusVoice install. Run ./install.sh first."

command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
  || die "Docker + Compose v2 are required. See https://docs.docker.com/engine/install/"

# --- Reconstruct the same compose profiles the install used ------------------
USE_CADDY="$(grep -E '^USE_CADDY=' .env | cut -d= -f2 || true)"; USE_CADDY="${USE_CADDY:-1}"
TAG="$(grep -E '^TAG=' .env | cut -d= -f2 || true)"; TAG="${TAG:-latest}"
if [ "$USE_CADDY" = "1" ]; then PROFILES=(--profile caddy --profile storage --profile push)
else PROFILES=(--profile storage --profile push); fi

say "GusVoice updater  ·  $(pwd)  ·  images tag: ${TAG}"

# --- 1) Refresh the stack files (unless --images-only) -----------------------
if [ "$REFRESH_FILES" = "1" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required to refresh files (or run with --images-only)."
  command -v tar  >/dev/null 2>&1 || die "tar is required to refresh files (or run with --images-only)."

  bak=".gusvoice-backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$bak"
  cp -R docker-compose.yml "$bak/" 2>/dev/null || true
  [ -d config ] && cp -R config "$bak/" 2>/dev/null || true
  ok "backed up docker-compose.yml + config/ → $bak"

  say "Downloading the latest release files…"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/Gleb1290/gusvoice/archive/refs/heads/main.tar.gz" | tar -xz -C "$tmp" \
    || die "download failed — check the network, or re-run with --images-only."
  new="$(echo "$tmp"/gusvoice-*)"
  [ -d "$new" ] || die "unexpected archive layout — aborting file refresh."

  # Regular files: replace atomically via rename so overwriting THIS running script is safe
  # (the running bash keeps the old inode open; the new file takes a fresh inode).
  for f in docker-compose.yml install.sh update.sh uninstall.sh README.md .gitattributes .dockerignore; do
    if [ -f "$new/$f" ]; then cp "$new/$f" "$f.gv.new" && mv -f "$f.gv.new" "$f"; fi
  done
  # Template dirs (safe to overwrite in place — nothing is executing from them). Your .env drives them.
  [ -d "$new/config" ] && cp -Rf "$new/config/." config/ 2>/dev/null || true
  [ -d "$new/docs" ]   && { mkdir -p docs; cp -Rf "$new/docs/." docs/ 2>/dev/null || true; }
  chmod +x install.sh update.sh uninstall.sh 2>/dev/null || true
  rm -rf "$tmp"; trap - EXIT
  ok "stack files refreshed (.env left untouched)"
else
  info "--images-only: keeping your current docker-compose.yml + config/ as-is."
fi

# --- 2) Pull the newest images ----------------------------------------------
say "Pulling images…"
docker compose "${PROFILES[@]}" pull

# --- 3) Recreate changed containers -----------------------------------------
say "Applying update (recreating changed containers)…"
docker compose "${PROFILES[@]}" up -d --remove-orphans

# --- 4) Optional cleanup -----------------------------------------------------
if [ "$PRUNE" = "1" ]; then
  say "Pruning old images…"
  docker image prune -f >/dev/null 2>&1 || true
  ok "reclaimed disk from dangling images"
fi

# --- Done -------------------------------------------------------------------
set +e
say "Current status:"
docker compose "${PROFILES[@]}" ps

printf '\n\033[1;32m✅  GusVoice updated.\033[0m\n'
info "Your database, media and push config were untouched; the backend ran any"
info "pending migrations automatically on boot."
if [ "$REFRESH_FILES" = "1" ]; then
  info "Old stack files were backed up under ./.gusvoice-backups/ (safe to delete once happy)."
fi
info "Desktop/Android apps update themselves — nothing to do there."
printf '\n'
