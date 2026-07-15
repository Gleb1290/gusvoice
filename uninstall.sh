#!/usr/bin/env bash
# =============================================================================
# GusVoice — uninstaller.
#
#   cd gusvoice && ./uninstall.sh            # stop & remove containers — KEEPS your data
#   cd gusvoice && ./uninstall.sh --purge    # ALSO delete all data + secrets (irreversible)
#
# Default (safe): stops and removes the GusVoice containers and their network. Your
# DATA — the Postgres database, uploaded media, push config, TLS certificates — stays
# in named Docker volumes, and your .env keeps your secrets, so a later ./install.sh
# (or ./update.sh) picks up exactly where you left off.
#
# --purge (destructive): additionally DELETES the data volumes and your .env. This is
# PERMANENT — every account, message, upload and secret is gone. You'll be asked to
# type "yes" to confirm (skip the prompt with --yes).
#
# Flags:
#   --purge      also delete data volumes + .env (IRREVERSIBLE)
#   -y, --yes    don't ask for confirmation (dangerous with --purge)
#   -h, --help   show this help
# =============================================================================
set -euo pipefail

PURGE=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge)   PURGE=1 ;;
    -y|--yes)  ASSUME_YES=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
info() { printf '  \033[0;90m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '  \033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Locate the install dir (mirror install.sh) ------------------------------
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then cd "$(dirname "$src")"; fi
if [ ! -f docker-compose.yml ]; then
  if [ -f gusvoice/docker-compose.yml ]; then cd gusvoice
  else die "No docker-compose.yml here. Run this from your GusVoice directory."; fi
fi

command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
  || die "Docker + Compose v2 are required to remove the stack."

# --- Reconstruct the same compose profiles so ALL services are targeted ------
USE_CADDY=1
[ -f .env ] && { USE_CADDY="$(grep -E '^USE_CADDY=' .env | cut -d= -f2 || true)"; USE_CADDY="${USE_CADDY:-1}"; }
if [ "$USE_CADDY" = "1" ]; then PROFILES=(--profile caddy --profile storage --profile push)
else PROFILES=(--profile storage --profile push); fi

if [ "$PURGE" = "1" ]; then
  say "⚠  FULL UNINSTALL (--purge)  ·  $(pwd)"
  warn "This DELETES ALL GusVoice data — PERMANENTLY:"
  info "  • Postgres database  (accounts, servers, channels, messages)"
  info "  • uploaded media     (avatars, attachments, sounds, icons)"
  info "  • push + TLS state   (ntfy config, Caddy certificates)"
  info "  • your .env          (every generated secret)"
  if [ "$ASSUME_YES" != "1" ]; then
    printf '\n  Type \033[1;31myes\033[0m to confirm total deletion: '
    read -r ans </dev/tty || ans=""
    [ "$ans" = "yes" ] || { info "Aborted — nothing was deleted."; exit 0; }
  fi
  say "Removing containers, network and DATA volumes…"
  docker compose "${PROFILES[@]}" down -v --remove-orphans
  rm -f .env
  ok "containers + data volumes + .env removed"
  say "✅  GusVoice fully removed."
  info "The install folder ($(pwd)) can now be deleted:  cd .. && rm -rf \"$(basename "$(pwd)")\""
  info "Downloaded desktop/Android apps (if any) are separate — uninstall them the usual way."
else
  say "Uninstalling GusVoice (keeping your data)  ·  $(pwd)"
  say "Stopping and removing containers…"
  docker compose "${PROFILES[@]}" down --remove-orphans
  ok "containers + network removed"
  say "✅  GusVoice stopped."
  info "Your data is PRESERVED in Docker volumes and .env still holds your secrets."
  info "Bring it back anytime:   ./install.sh     (or ./update.sh)"
  info "To ALSO erase all data + secrets permanently:   ./uninstall.sh --purge"
fi
printf '\n'
