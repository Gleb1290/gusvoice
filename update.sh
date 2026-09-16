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
#      presence · client · storage · ntfy · caddy).
#   3. Recreates only the containers that changed and leaves the rest running.
#
# Your DATA (Postgres database, uploaded media, push config) lives in named Docker
# volumes and is left completely alone. Database migrations run automatically the
# moment the new backend boots — there is no manual migration step.
# Boxes installed before the switch from MinIO to versitygw get their media copied
# into the new storage once, automatically (the `storage-migrate` service); the old
# volume is kept until you remove it.
#
# Before recreating containers it saves a copy of the database into .gusvoice-backups/
# (the 5 newest are kept) — skip with --no-db-backup.
#
# Flags:
#   --images-only       only pull images + recreate; do NOT refresh the stack files
#   --prune             remove old dangling images afterwards to reclaim disk
#   --no-db-backup      don't copy the database before recreating containers
#   --install-updater   (root) enable the "Update" button in the admin panel: installs a
#                       small systemd watcher that runs this script when the panel asks
#   -y, --yes           don't ask anything, just do it
#   -h, --help          show this help
# =============================================================================

# What happened to the one-time media move (storage-migrate) during `docker compose up`. Pure — no docker
# calls — so a test can source just this part:  GV_UPDATE_LIB_ONLY=1 . ./update.sh
#   $1  exit code of `docker compose up`
#   $2  exit code of the storage-migrate container ('' = there is no such container)
#   $3  its log from THIS run
# Prints one word: up-failed | failed | moved | none
migrate_outcome() {
  if [ "$1" != "0" ]; then echo up-failed; return 0; fi
  if [ -n "$2" ] && [ "$2" != "0" ]; then echo failed; return 0; fi
  case "$3" in *'✅ Done'*) echo moved ;; *) echo none ;; esac
}

# --- Update button in the admin panel: pure helpers (same test hook) ---------
# The version line the panel may request: exactly vX.Y.Z. Nothing else from that file is ever used.
panel_version_ok() {
  [[ "${1:-}" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]]
}
# TAG pinned to one release (TAG=v0.7.0 / 0.7.0): pulling again would fetch the same version, and the panel must
# not edit .env — so the panel refuses and says so. Floating tags (latest, master, …) are fine.
# 🔴 Same pattern as `PINNED_TAG_RE` in packages/backend/src/instanceUpdateRules.ts — the panel decides whether to show
# the button by ITS copy, so a difference here promises an update this script then refuses. Change both together.
tag_is_pinned() {
  [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]
}
# One JSON field value for run/status/*.json. Values come from this script (fixed words, dates, validated versions,
# file names) — anything with other characters is dropped rather than escaped, so a surprise can't break the JSON.
json_str() {
  if [ -z "${1:-}" ] || ! [[ "$1" =~ ^[A-Za-z0-9._:/+-]{1,120}$ ]]; then printf 'null'; else printf '"%s"' "$1"; fi
}
# status_json <state> <step> <requested> <version> <startedAt> <finishedAt> <error> <backup>
status_json() {
  printf '{"state":%s,"step":%s,"requested":%s,"version":%s,"startedAt":%s,"finishedAt":%s,"error":%s,"backup":%s}\n' \
    "$(json_str "$1")" "$(json_str "$2")" "$(json_str "$3")" "$(json_str "$4")" \
    "$(json_str "$5")" "$(json_str "$6")" "$(json_str "$7")" "$(json_str "$8")"
}
# backups_to_prune <keep> <file…> (oldest first) → prints the files beyond the newest <keep>.
backups_to_prune() {
  local keep="$1" n i=0 f; shift; n=$#
  for f in "$@"; do i=$((i + 1)); if [ $((n - i)) -ge "$keep" ]; then printf '%s\n' "$f"; fi; done
}
if [ "${GV_UPDATE_LIB_ONLY:-}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

set -euo pipefail

REFRESH_FILES=1; PRUNE=0; ASSUME_YES=0; DB_BACKUP=1; FROM_PANEL=0; INSTALL_UPDATER=0
for arg in "$@"; do
  case "$arg" in
    --images-only) REFRESH_FILES=0 ;;
    --prune)       PRUNE=1 ;;
    --no-db-backup) DB_BACKUP=0 ;;
    --install-updater) INSTALL_UPDATER=1 ;;
    --from-panel)  FROM_PANEL=1; ASSUME_YES=1 ;;   # run by the systemd watcher, not by hand
    -y|--yes)      ASSUME_YES=1 ;;
    -h|--help)     sed -n '3,/^# =====/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
info() { printf '  \033[0;90m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '  \033[1;33m%s\033[0m\n' "$*"; }
die()  { panel_fail; printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Progress for the admin panel (only with --from-panel) -------------------
# run/status is the ONE place this script writes for the panel, and the backend container can only READ it (see
# docker-compose.yml): a file the container could replace with a symlink would let it aim our writes anywhere.
# Each write goes to a temp file first and is renamed over status.json, so the panel never reads half a file.
STATUS_DIR=run/status
PANEL_STEP=''; PANEL_REQUESTED=''; PANEL_STARTED=''; PANEL_DONE=''; PANEL_ERROR=''; DB_BACKUP_FILE=''
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
panel_status() { # <state> [error] [new version]
  [ "$FROM_PANEL" = "1" ] || return 0
  local finished='' tmp="$STATUS_DIR/.status.$$"
  [ "$1" = running ] || finished="$(now_utc)"
  if status_json "$1" "$PANEL_STEP" "$PANEL_REQUESTED" "${3:-}" "$PANEL_STARTED" "$finished" "${2:-}" "$DB_BACKUP_FILE" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$STATUS_DIR/status.json" 2>/dev/null || rm -f "$tmp"
  fi
}
panel_step() { PANEL_STEP="$1"; PANEL_ERROR="$1"; panel_status running; }
panel_fail() { # error code: an explicit PANEL_ERROR, else the step that was running
  if [ "$FROM_PANEL" != "1" ] || [ -n "$PANEL_DONE" ]; then return 0; fi
  PANEL_DONE=1
  panel_status failed "${PANEL_ERROR:-interrupted}"
}
TMP_DIR=''
on_exit() {
  local rc=$?
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
  if [ "$rc" -ne 0 ]; then panel_fail; fi   # a command failed under `set -e` somewhere between the steps
  exit "$rc"
}
trap on_exit EXIT

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

# --- --install-updater: the "Update" button in the admin panel ---------------
# Two systemd units: a .path watcher that fires when the backend drops run/request/update, and a one-shot .service
# that runs `update.sh --from-panel` here. The backend container never gets the Docker socket (a bug in it would be
# root on this machine). The service runs as the owner of this directory if that user can use Docker, else as root.
write_updater_marker() {
  local tmp="$STATUS_DIR/.updater.$$"
  printf '{"schema":1,"tag":%s,"installedAt":%s}\n' "$(json_str "$TAG")" "$(json_str "$(now_utc)")" >"$tmp" \
    && mv -f "$tmp" "$STATUS_DIR/updater.json"
}
if [ "$INSTALL_UPDATER" = "1" ]; then
  [ -d /run/systemd/system ] || die "systemd isn't running on this machine, so the panel button can't be enabled here. Update with ./update.sh instead."
  [ "$(id -u)" -eq 0 ] || die "this needs root:  sudo ./update.sh --install-updater"
  dir="$(pwd -P)"
  # The path goes into unit files verbatim — refuse what systemd would parse specially (spaces, %, quotes…).
  [[ "$dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "the install path '$dir' has characters systemd units can't hold — move GusVoice to a plain path."
  owner="$(stat -c %U docker-compose.yml)"
  run_as=root
  if [ "$owner" != root ] && id -nG "$owner" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then run_as="$owner"; fi
  mkdir -p run/request run/status
  # Re-running this is also the repair: whatever is stuck in the request slot (see --from-panel) goes, as root.
  rm -rf run/request/update
  chown "$run_as": run run/request run/status
  chmod 755 run run/request run/status
  cat >/etc/systemd/system/gusvoice-update.path <<EOF
# GusVoice: the admin panel asked for an update (written by $dir/update.sh --install-updater)
[Unit]
Description=GusVoice update request from the admin panel ($dir)

[Path]
PathExists=$dir/run/request/update
Unit=gusvoice-update.service

[Install]
WantedBy=multi-user.target
EOF
  cat >/etc/systemd/system/gusvoice-update.service <<EOF
# GusVoice: runs the update the admin panel asked for (written by $dir/update.sh --install-updater)
[Unit]
Description=GusVoice update from the admin panel ($dir)
After=docker.service

[Service]
Type=oneshot
User=$run_as
WorkingDirectory=$dir
ExecStart=$dir/update.sh --from-panel
TimeoutStartSec=50min
EOF
  systemctl daemon-reload
  systemctl reset-failed gusvoice-update.path gusvoice-update.service >/dev/null 2>&1 || true
  systemctl enable gusvoice-update.path >/dev/null 2>&1
  systemctl restart gusvoice-update.path
  write_updater_marker
  chown "$run_as": "$STATUS_DIR/updater.json"
  ok "The \"Update\" button in the admin panel is enabled (systemd: gusvoice-update.path, runs as $run_as)."
  info "Its log:  journalctl -u gusvoice-update"
  exit 0
fi

# --- --from-panel: pick up the request the backend left ----------------------
if [ "$FROM_PANEL" = "1" ]; then
  [ -d "$STATUS_DIR" ] && [ -w "$STATUS_DIR" ] || die "$STATUS_DIR is missing or not writable — re-run: sudo ./update.sh --install-updater"
  if [ ! -e run/request/update ] && [ ! -L run/request/update ]; then
    info "No update request waiting — nothing to do."; FROM_PANEL=0; exit 0
  fi
  PANEL_STARTED="$(now_utc)"
  # "running" goes out BEFORE the request disappears: a panel poll landing in between must never see "no request"
  # next to the status of the PREVIOUS update and report that one as the result.
  panel_status running
  # Move the request INTO run/status first: a rename never follows a symlink, and once the file sits where the
  # container can't write, nothing can swap it between the checks below and the read.
  req="$STATUS_DIR/.request.$$"
  if ! mv -f run/request/update "$req" 2>/dev/null; then
    PANEL_ERROR=bad-request
    # Not a plain file we may move — e.g. a directory created by root inside the container. We can't remove it as this
    # user; systemd stops re-running us after a few tries (start limit), and --install-updater cleans it up as root.
    die "run/request/update isn't a request this script can pick up (a directory?). Clean up and restart the watcher:  sudo ./update.sh --install-updater"
  fi
  line=''
  if [ ! -L "$req" ] && [ -f "$req" ]; then line="$(head -c 64 "$req" | head -n 1 | tr -d '\r')"; fi
  rm -rf "$req"
  if panel_version_ok "$line"; then PANEL_REQUESTED="$line"; fi
  [ -n "$PANEL_REQUESTED" ] || { PANEL_ERROR=bad-request; die "the update request from the panel is malformed — ignored."; }
  write_updater_marker 2>/dev/null || true   # keep the tag the panel shows in step with .env
  if tag_is_pinned "$TAG"; then
    PANEL_ERROR=pinned-tag
    die "TAG=$TAG in .env pins one release, so pulling would fetch the same version. Change TAG (e.g. latest) and run ./update.sh."
  fi
  panel_status running   # now with the requested version
fi

# --- One update at a time ----------------------------------------------------
# The panel run and a manual ./update.sh take the same lock. Skipped (with no harm) where run/status isn't ours.
if [ -d "$STATUS_DIR" ] && [ -w "$STATUS_DIR" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$STATUS_DIR/.update.lock"
  if ! flock -n 9; then PANEL_ERROR=locked; die "another update is already running."; fi
fi

say "GusVoice updater  ·  $(pwd)  ·  images tag: ${TAG}"

# --- 1) Refresh the stack files (unless --images-only) -----------------------
if [ "$REFRESH_FILES" = "1" ]; then
  panel_step files
  command -v curl >/dev/null 2>&1 || die "curl is required to refresh files (or run with --images-only)."
  command -v tar  >/dev/null 2>&1 || die "tar is required to refresh files (or run with --images-only)."

  bak=".gusvoice-backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$bak"
  cp -R docker-compose.yml "$bak/" 2>/dev/null || true
  [ -d config ] && cp -R config "$bak/" 2>/dev/null || true
  ok "backed up docker-compose.yml + config/ → $bak"

  say "Downloading the latest release files…"
  TMP_DIR="$(mktemp -d)"; tmp="$TMP_DIR"   # removed by on_exit
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
  rm -rf "$tmp"; TMP_DIR=''
  ok "stack files refreshed (.env left untouched)"
else
  info "--images-only: keeping your current docker-compose.yml + config/ as-is."
fi

# --- 1.5) Back-compat: keep MINIO_ACCESS_KEY in .env -------------------------
# The current compose fail-closes on MINIO_ACCESS_KEY (no weak default — a known key is the first thing
# scanners try). Installs from before that relied on the compose default and never wrote it to .env, so
# the freshly-pulled compose would abort this very update. Backfill the exact legacy value their MinIO
# volume was created with, so the update just works — no data touched. New installs already carry a
# random key from install.sh and are left alone (this only fires when the line is genuinely absent).
if ! grep -q '^MINIO_ACCESS_KEY=' .env; then
  echo 'MINIO_ACCESS_KEY=gusvoice' >> .env
  warn "backfilled MINIO_ACCESS_KEY into .env (legacy default your MinIO already uses; the hardened compose now requires it explicitly)"
fi

# --- 2) Pull the newest images ----------------------------------------------
panel_step pull
say "Pulling images…"
docker compose "${PROFILES[@]}" pull </dev/null

# --- 2.5) Copy the database before new code runs its migrations -------------
# pg_dump inside the running postgres container → .gusvoice-backups/db-<time>.sql.gz (owner-only). Restoring needs no
# Postgres knowledge: see docs/SELF-HOSTING.md. The 5 newest copies are kept.
backup_db() {
  local pg_id size free out
  pg_id="$(docker compose "${PROFILES[@]}" ps -q postgres 2>/dev/null || true)"
  if [ -z "$pg_id" ] || [ "$(docker inspect -f '{{.State.Running}}' "$pg_id" 2>/dev/null || true)" != "true" ]; then
    info "Postgres isn't running — no database copy to make."
    return 0
  fi
  mkdir -p .gusvoice-backups
  size="$(docker compose "${PROFILES[@]}" exec -T postgres sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select pg_database_size(current_database())"' </dev/null 2>/dev/null | tr -dc '0-9' || true)"
  free="$(df -Pk .gusvoice-backups 2>/dev/null | awk 'NR==2 {print $4 * 1024}' || true)"
  # The compressed dump is far smaller than the live database — demanding that much free space is a safe margin.
  if [ -n "$size" ] && [ -n "$free" ] && [ "$free" -lt "$size" ]; then
    PANEL_ERROR=backup-space
    die "not enough free disk for a database copy (need about $((size / 1048576)) MB). Free some space, or run with --no-db-backup."
  fi
  out=".gusvoice-backups/db-$(date +%Y%m%d-%H%M%S).sql.gz"
  if ( umask 077; docker compose "${PROFILES[@]}" exec -T postgres sh -c \
        'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' </dev/null | gzip >"$out.part" ); then
    mv -f "$out.part" "$out"
  else
    rm -f "$out.part"
    die "copying the database failed — nothing was changed. Run with --no-db-backup to update without a copy."
  fi
  DB_BACKUP_FILE="$out"
  ok "database copied → $out ($(du -h "$out" | cut -f1))"
  local old
  # shellcheck disable=SC2046 # names are db-YYYYmmdd-HHMMSS.sql.gz — no spaces; the glob sorts oldest first
  for old in $(backups_to_prune 5 .gusvoice-backups/db-*.sql.gz); do rm -f "$old"; done
}
if [ "$DB_BACKUP" = "1" ]; then
  panel_step backup
  say "Copying the database…"
  backup_db
else
  info "--no-db-backup: skipping the database copy."
fi

# --- 3) Recreate changed containers -----------------------------------------
panel_step restart
say "Applying update (recreating changed containers)…"
# The one-shot storage-migrate container is reused between runs and its log accumulates — read only
# what THIS update wrote.
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
up_rc=0
docker compose "${PROFILES[@]}" up -d --remove-orphans || up_rc=$?
log="$(docker compose "${PROFILES[@]}" logs --no-log-prefix --since "$started" storage-migrate 2>/dev/null || true)"
migrate_rc=''
migrate_id="$(docker compose "${PROFILES[@]}" ps -a -q storage-migrate 2>/dev/null || true)"
if [ -n "$migrate_id" ]; then
  migrate_rc="$(docker inspect -f '{{.State.ExitCode}}' "$migrate_id" 2>/dev/null || echo 0)"
fi
# A failed move does NOT fail `up` (optional dependency — see docker-compose.yml): the stack runs, but old
# avatars/attachments stay unavailable — reported loudly at the end, with a non-zero exit.
MIGRATE_OUTCOME="$(migrate_outcome "$up_rc" "$migrate_rc" "$log")"
case "$MIGRATE_OUTCOME" in
  up-failed)
    # The usual suspect on the first update after MinIO → versitygw: the one-time media move stopped
    # (e.g. not enough disk). Its own log says why and what to do — show it instead of a bare error.
    if [ -n "$log" ]; then
      warn "Moving media into the new storage reported:"
      printf '%s\n' "$log" | tail -n 12 | sed 's/^/    /'
    fi
    die "the update did not finish. Your data is untouched; see the messages above (full log: docker compose logs storage-migrate backend)." ;;
  moved) say "Media moved into the new storage:"; printf '%s\n' "$log" | tail -n 5 | sed 's/^\[storage-migrate\] /    /' ;;
esac

# --- 3.5) Panel run: wait until the new backend is healthy -------------------
# The panel page is waiting on this very backend; "done" before it answers would be a lie. Migrations run at boot,
# so a big database can take a while — 5 minutes.
NEW_VERSION=''
if [ "$FROM_PANEL" = "1" ]; then
  panel_step health
  say "Waiting for the backend to come up…"
  healthy=0
  for _ in $(seq 1 60); do
    backend_id="$(docker compose "${PROFILES[@]}" ps -q backend 2>/dev/null || true)"
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$backend_id" 2>/dev/null || true)"
    if [ "$state" = healthy ]; then healthy=1; break; fi
    sleep 5
  done
  [ "$healthy" = "1" ] || die "the backend didn't become healthy within 5 minutes. See: docker compose logs backend"
  NEW_VERSION="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$backend_id" 2>/dev/null | sed -n 's/^GV_VERSION=//p' | head -n 1 || true)"
  ok "backend is up${NEW_VERSION:+ ($NEW_VERSION)}"
fi

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

if [ "$MIGRATE_OUTCOME" = "failed" ]; then
  PANEL_ERROR=storage-migrate; panel_fail
  printf '\n\033[1;33m⚠  GusVoice is updated and running — but moving your OLD media into the new storage FAILED:\033[0m\n'
  printf '%s\n' "$log" | tail -n 8 | sed 's/^/    /'
  warn "Chat and voice work. Old avatars and attachments stay hidden until the move succeeds — nothing is"
  warn "lost, they are still in the old volume. Fix the cause above, then run:  ./update.sh --images-only"
  printf '\n'
  exit 1
fi

PANEL_DONE=1; panel_status done '' "$NEW_VERSION"
printf '\n\033[1;32m✅  GusVoice updated.\033[0m\n'
info "Your database, media and push config were untouched; the backend ran any"
info "pending migrations automatically on boot."
if [ -n "$DB_BACKUP_FILE" ]; then
  info "A copy of the database from just before the update: ./$DB_BACKUP_FILE"
fi
if [ "$REFRESH_FILES" = "1" ]; then
  info "Old stack files were backed up under ./.gusvoice-backups/ (safe to delete once happy)."
fi
info "Desktop/Android apps update themselves — nothing to do there."
printf '\n'
