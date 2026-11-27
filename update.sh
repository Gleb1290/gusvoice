#!/usr/bin/env bash
# =============================================================================
# GusVoice — updater. Stages and applies a selected release.
#
#   cd gusvoice && ./update.sh
#   # or one-liner:  curl -fsSL https://raw.githubusercontent.com/Gleb1290/gusvoice/main/update.sh | bash
#
# What it does (in order):
#   1. Stages the selected release files (compose, config, scripts, README) and
#      validates the compose before applying it. Skip this with --images-only.
#   2. Pulls the release images and backs up the running database and current stack files.
#   3. Applies the staged files, recreates changed containers, and checks backend health and version.
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
#   --release=vX.Y.Z    manually select a release on a rolling installation
#   --replace-compose   allow replacing a locally edited or unverifiable base compose
#   --install-updater   (root) enable the "Update" button in the admin panel: installs a
#                       small systemd watcher that runs this script when the panel asks
#   --map               ask about the own map for location sharing even if you said no before (needs a terminal)
#   --no-map            don't touch the map at all this time
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
# Compose includes dependency services even when asked to render just one. Pass only the image
# from the named service's own block to the caller.
compose_service_image() {
  awk -v service="$1" '
    /^services:$/ { services = 1; next }
    /^[^ ]/ { services = 0 }
    services && /^  [^ ]/ { selected = ($0 == "  " service ":") }
    services && selected && /^    image: / { print substr($0, 12) }
  '
}
# backups_to_prune <keep> <file…> (oldest first) → prints the files beyond the newest <keep>.
backups_to_prune() {
  local keep="$1" n i=0 f; shift; n=$#
  for f in "$@"; do i=$((i + 1)); if [ $((n - i)) -ge "$keep" ]; then printf '%s\n' "$f"; fi; done
}
if [ "${GV_UPDATE_LIB_ONLY:-}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

set -euo pipefail

REFRESH_FILES=1; PRUNE=0; ASSUME_YES=0; DB_BACKUP=1; FROM_PANEL=0; INSTALL_UPDATER=0; MAP_FORCE=0; NO_MAP=0
MANUAL_RELEASE=''; REPLACE_COMPOSE=0
for arg in "$@"; do
  case "$arg" in
    --images-only) REFRESH_FILES=0 ;;
    --prune)       PRUNE=1 ;;
    --no-db-backup) DB_BACKUP=0 ;;
    --release=*)   MANUAL_RELEASE="${arg#*=}" ;;
    --replace-compose) REPLACE_COMPOSE=1 ;;
    --install-updater) INSTALL_UPDATER=1 ;;
    --from-panel)  FROM_PANEL=1; ASSUME_YES=1 ;;   # run by the systemd watcher, not by hand
    --map)         MAP_FORCE=1 ;;
    --no-map)      NO_MAP=1 ;;
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
now_utc() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
panel_status() { # <state> [error] [new version]
  [ "$FROM_PANEL" = "1" ] && [ -n "$PANEL_STARTED" ] || return 0
  local finished='' tmp
  [ "$1" = running ] || finished="$(now_utc)"
  tmp="$(mktemp "$STATUS_DIR/.status.XXXXXX")" || return 1
  if status_json "$1" "$PANEL_STEP" "$PANEL_REQUESTED" "${3:-}" "$PANEL_STARTED" "$finished" "${2:-}" "$DB_BACKUP_FILE" >"$tmp" \
    && chmod 644 "$tmp" && mv -fT "$tmp" "$STATUS_DIR/status.json"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}
panel_step() { PANEL_STEP="$1"; PANEL_ERROR="$1"; panel_status running; }
panel_fail() { # error code: an explicit PANEL_ERROR, else the step that was running
  if [ "$FROM_PANEL" != "1" ] || [ -n "$PANEL_DONE" ]; then return 0; fi
  PANEL_DONE=1
  panel_status failed "${PANEL_ERROR:-interrupted}" || warn "could not write update status to $STATUS_DIR" >&2
}
TMP_DIR=''; BACKUP_PART=''
on_exit() {
  local rc=$?
  if [ -n "$BACKUP_PART" ]; then rm -f "$BACKUP_PART" || true; fi
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR" || true; fi
  if [ "$rc" -ne 0 ]; then panel_fail; fi   # a command failed under `set -e` somewhere between the steps
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# --- Locate the install dir (mirror install.sh) ------------------------------
# From a file → work in the script's own dir. Piped (curl | bash) → look for ./gusvoice.
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then cd "$(dirname "$src")"; fi
if [ "$FROM_PANEL" = 0 ] && [ ! -f docker-compose.yml ] && [ -f gusvoice/docker-compose.yml ]; then cd gusvoice; fi
# Claim before preparing Compose so a broken .env or unavailable Docker produces a terminal status.
if [ "$FROM_PANEL" = 1 ]; then
  [ -d "$STATUS_DIR" ] && [ -w "$STATUS_DIR" ] || die "$STATUS_DIR is missing or not writable — re-run: sudo ./update.sh --install-updater"
  if [ ! -e run/request/update ] && [ ! -L run/request/update ]; then
    info "No update request waiting — nothing to do."; exit 0
  fi
  PANEL_STARTED="$(now_utc)"
  panel_status running || die "could not write the running update status"
  req="$STATUS_DIR/.request.$$"
  if ! mv -fT run/request/update "$req" 2>/dev/null; then
    PANEL_ERROR=bad-request
    die "could not pick up the request. Repair the watcher: sudo ./update.sh --install-updater"
  fi
  line=''
  if [ ! -L "$req" ] && [ -f "$req" ]; then
    line="$(head -c 17 "$req" | head -n 1)"
    if panel_version_ok "$line" && cmp -s "$req" <(printf '%s\n' "$line"); then PANEL_REQUESTED="$line"; fi
  fi
  rm -rf "$req"
  [ -n "$PANEL_REQUESTED" ] || { PANEL_ERROR=bad-request; die "the update request from the panel is malformed."; }
  [ "$INSTALL_UPDATER/$REFRESH_FILES/$DB_BACKUP/$REPLACE_COMPOSE" = 0/1/1/0 ] && [ -z "$MANUAL_RELEASE" ] \
    || die "panel updates require release files, a database backup and the requested tag"
  panel_status running
fi

[ -f docker-compose.yml ] && [ -f .env ] || die "Run this from your GusVoice directory (docker-compose.yml + .env)."

command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 \
  || die "Docker + Compose v2 are required. See https://docs.docker.com/engine/install/"

# Read the policy with Compose's own dotenv parser and only print the two non-secret values.
# The account running the command cannot override the box's policy with an inherited TAG.
settings="$(env -u TAG -u USE_CADDY docker compose --project-directory "$PWD" --env-file .env -f - config --images <<'YAML'
services:
  policy:
    image: gusvoice-update-policy/${COMPOSE_FILE:+custom/}caddy-${USE_CADDY:-1}:${TAG:-latest}
YAML
)" || die "could not read the update policy from .env"
case "$settings" in
  gusvoice-update-policy/custom/*) die "COMPOSE_FILE selects a custom stack; use the operator-managed compose workflow." ;;
esac
[[ "$settings" =~ ^gusvoice-update-policy/caddy-([01]):([A-Za-z0-9_][A-Za-z0-9._-]{0,63})$ ]] \
  || die "invalid TAG or USE_CADDY in .env"
USE_CADDY="${BASH_REMATCH[1]}"
TAG="${BASH_REMATCH[2]}"
PROFILES=(--profile storage --profile push)
if [ "$USE_CADDY" = 1 ]; then PROFILES+=(--profile caddy); fi

# Always use the box's base compose, even if a higher-priority compose.yaml exists.
# Preserve its conventional local override both for candidate validation and for application.
OVERRIDE=()
for file in compose.override.yml compose.override.yaml docker-compose.override.yml docker-compose.override.yaml; do
  if [ -f "$file" ]; then OVERRIDE=(-f "$file"); break; fi
done
COMPOSE_BASE=docker-compose.yml
IMAGE_TAG="$TAG"
LEGACY_ENV=()
compose() {
  env "TAG=$IMAGE_TAG" "${LEGACY_ENV[@]}" docker compose --project-directory "$PWD" --env-file .env \
    -f "$COMPOSE_BASE" "${OVERRIDE[@]}" "${PROFILES[@]}" "$@" </dev/null
}

# --- --install-updater: the "Update" button in the admin panel ---------------
# Two systemd units: a .path watcher that fires when the backend drops run/request/update, and a one-shot .service
# that runs `update.sh --from-panel` here. The backend container never gets the Docker socket (a bug in it would be
# root on this machine). The service runs as the owner of this directory if that user can use Docker, else as root.
write_updater_marker() {
  local tmp
  tmp="$(mktemp "$STATUS_DIR/.updater.XXXXXX")" || return 1
  if printf '{"schema":2,"tag":%s,"installedAt":%s}\n' "$(json_str "$TAG")" "$(json_str "$(now_utc)")" >"$tmp" \
    && chmod 644 "$tmp" && mv -fT "$tmp" "$STATUS_DIR/updater.json"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}
if [ "$INSTALL_UPDATER" = "1" ]; then
  [ -d /run/systemd/system ] || die "systemd isn't running on this machine, so the panel button can't be enabled here. Update with ./update.sh instead."
  [ "$(id -u)" -eq 0 ] || die "this needs root:  sudo ./update.sh --install-updater"
  command -v flock >/dev/null 2>&1 || die "flock is required for the updater."
  dir="$(pwd -P)"
  # The path goes into unit files verbatim — refuse what systemd would parse specially (spaces, %, quotes…).
  [[ "$dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "the install path '$dir' has characters systemd units can't hold — move GusVoice to a plain path."
  owner="$(stat -c %U docker-compose.yml)"
  run_as=root
  if [ "$owner" != root ] && id -nG "$owner" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then run_as="$owner"; fi
  mkdir -p run/request run/status
  # Re-running this is also the repair: whatever is stuck in the request slot (see --from-panel) goes, as root.
  if systemctl is-active --quiet gusvoice-update.service; then die "an update is already running."; fi
  rm -f "$STATUS_DIR/updater.json"
  rm -rf run/request/update
  touch "$STATUS_DIR/.update.lock"
  chown "$run_as": run run/request run/status "$STATUS_DIR/.update.lock"
  chmod 755 run run/request run/status
  chmod 644 "$STATUS_DIR/.update.lock"
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

if [ -n "$MANUAL_RELEASE" ]; then
  [ "$REFRESH_FILES" = 1 ] && panel_version_ok "$MANUAL_RELEASE" || die "--release requires vX.Y.Z and a file refresh"
  if tag_is_pinned "$TAG" && [ "v${TAG#v}" != "$MANUAL_RELEASE" ]; then die "--release may not override the pinned TAG"; fi
fi
# Run under the same lock as a manual update. A legacy install can be updated before enabling its watcher.
if [ "$FROM_PANEL" = 1 ] || [ -f "$STATUS_DIR/updater.json" ]; then
  [ -w "$STATUS_DIR" ] && command -v flock >/dev/null 2>&1 \
    || die "the updater lock is unavailable; check permissions and install flock"
fi
if [ -w "$STATUS_DIR" ] && command -v flock >/dev/null 2>&1; then
  exec 9>>"$STATUS_DIR/.update.lock"
  if ! flock -n 9; then PANEL_ERROR=locked; die "another update is already running."; fi
fi
if [ "$FROM_PANEL" = 1 ]; then
  write_updater_marker
  if tag_is_pinned "$TAG"; then
    PANEL_ERROR=pinned-tag
    die "TAG=$TAG pins one release. Change TAG to latest and re-run ./update.sh --install-updater."
  fi
fi

STACK_REPO=https://github.com/Gleb1290/gusvoice
RELEASE=''
new=''
backend_version() {
  local ref="$1"; shift
  docker "$@" inspect -f '{{range .Config.Env}}{{if eq (index (split . "=") 0) "GV_VERSION"}}{{println (index (split . "=") 1)}}{{end}}{{end}}' "$ref" </dev/null
}
version_key() {
  local major minor patch
  IFS=. read -r major minor patch <<< "${1#v}"
  printf '%04d%04d%04d' "$((10#$major))" "$((10#$minor))" "$((10#$patch))"
}

# Stage the release outside the active stack. Pull and validate against its compose with the original
# project directory, .env and local override. Only a successful pull + backup can replace active files.
if [ "$REFRESH_FILES" = 1 ]; then
  panel_step files
  current=''
  if [ "$FROM_PANEL" = 1 ] || [ "$REPLACE_COMPOSE" = 0 ]; then
    current_id="$(compose ps -a -q backend)" || die "could not find the current backend"
    if [ -n "$current_id" ]; then
      current="$(backend_version "$current_id")" || die "could not inspect the current backend"
      current="v${current#v}"
    fi
  fi
  if [ "$FROM_PANEL" = 1 ]; then
    RELEASE="$PANEL_REQUESTED"
    if ! panel_version_ok "$current" || [[ "$(version_key "$RELEASE")" < "$(version_key "$current")" ]]; then
      PANEL_ERROR=bad-request
      die "the panel can only update a release to the same or a newer version"
    fi
  elif [ -n "$MANUAL_RELEASE" ]; then
    RELEASE="$MANUAL_RELEASE"
  elif tag_is_pinned "$TAG"; then
    RELEASE="v${TAG#v}"
  elif [ "$TAG" = latest ]; then
    release_url="$(curl --proto '=https' --proto-redir '=https' -fsSL --max-time 30 -o /dev/null \
      -w '%{url_effective}' "$STACK_REPO/releases/latest" </dev/null)" || die "could not resolve the latest release"
    RELEASE="${release_url#"$STACK_REPO/releases/tag/"}"
  else
    die "TAG=$TAG has no release archive. Use --images-only with your own compose."
  fi
  panel_version_ok "$RELEASE" || die "could not resolve a versioned release archive"
  IMAGE_TAG="$RELEASE"
  say "Downloading stack files for $RELEASE…"
  TMP_DIR="$(mktemp -d)"
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 300 \
    "$STACK_REPO/archive/refs/tags/$RELEASE.tar.gz" </dev/null | tar -xz -C "$TMP_DIR" \
    || die "could not download stack files for $RELEASE"
  roots=("$TMP_DIR"/gusvoice-*)
  [ "${#roots[@]}" = 1 ] || die "unexpected archive layout"
  new="${roots[0]}"
  [ -s "$new/docker-compose.yml" ] && [ -d "$new/config" ] && [ -s "$new/update.sh" ] \
    || die "the release archive is missing its compose, config or updater"

  # The base compose may have been edited by the operator or copied from main by a legacy updater.
  # Replace only a known release's base or an identical file. Keep local settings in the override.
  if [ "$REPLACE_COMPOSE" = 0 ] && ! cmp -s docker-compose.yml "$new/docker-compose.yml"; then
    if ! panel_version_ok "$current" || ! curl --proto '=https' --proto-redir '=https' -fsSL --max-time 30 \
      "https://raw.githubusercontent.com/Gleb1290/gusvoice/refs/tags/$current/docker-compose.yml" >"$TMP_DIR/previous-compose.yml" </dev/null \
      || ! cmp -s docker-compose.yml "$TMP_DIR/previous-compose.yml"; then
      die "current compose differs from its release or could not be verified. Check local changes, move them to docker-compose.override.yml and run ./update.sh --release=$RELEASE --replace-compose."
    fi
  fi

  # Supply the old default for the legacy box during preflight without editing .env before the backup.
  # An explicit empty value remains an error for the guarded compose.
  if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?MINIO_ACCESS_KEY[[:space:]]*[=:]' .env; then
    LEGACY_ENV=(MINIO_ACCESS_KEY=gusvoice)
  fi
  COMPOSE_BASE="$new/docker-compose.yml"
  compose config --quiet || die "the release compose is invalid with this installation's settings"
else
  info "--images-only: keeping the current stack files."
fi

panel_step pull
say "Pulling images for $IMAGE_TAG…"
if [ -n "$RELEASE" ]; then
  for service in backend presence client; do
    image="$(compose config "$service" | compose_service_image "$service")" || die "could not resolve the $service image"
    [[ "$image" =~ ^[A-Za-z0-9._:/-]+:[A-Za-z0-9._-]+$ && "${image##*:}" = "$RELEASE" ]] \
      || die "the configured $service image is not tagged $RELEASE"
    if [ "$service" = backend ]; then backend_image="$image"; fi
  done
fi
compose pull
if [ -n "$RELEASE" ]; then
  image_version="$(backend_version "$backend_image" image)" || die "could not inspect the pulled backend image"
  [ "v${image_version#v}" = "$RELEASE" ] || die "the pulled backend image does not match $RELEASE"
fi

# Backup the current database, using the current compose project, before changing any of its files.
if [ "$DB_BACKUP" = 1 ]; then
  panel_step backup
  say "Copying the database…"
  candidate_compose="$COMPOSE_BASE"
  COMPOSE_BASE=docker-compose.yml
  pg_id="$(compose ps -a -q postgres)" || die "could not find PostgreSQL in the current project"
  [ -n "$pg_id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$pg_id" </dev/null)" = true ] \
    || die "PostgreSQL must be running to make a backup. Start it before retrying."
  COMPOSE_BASE="$candidate_compose"
  mkdir -p .gusvoice-backups
  size="$(docker exec "$pg_id" sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select pg_database_size(current_database())"' </dev/null)" \
    || die "could not measure the current database"
  free_kb="$(df -Pk .gusvoice-backups | awk 'NR==2 {print $4}')" || die "could not measure free space for backup"
  [[ "$size" =~ ^[0-9]+$ && "$free_kb" =~ ^[0-9]+$ ]] || die "could not determine the space needed for backup"
  if [ "$free_kb" -lt "$(((size + 1023) / 1024))" ]; then
    PANEL_ERROR=backup-space
    die "not enough free disk for a database copy (need about $((size / 1048576)) MB)"
  fi
  out=".gusvoice-backups/db-$(date -u +%Y%m%d-%H%M%S-%N).sql.gz"
  BACKUP_PART="$(mktemp "$out.part.XXXXXX")"
  if ! docker exec "$pg_id" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' </dev/null |
    gzip >"$BACKUP_PART"; then
    die "copying the database failed — the running stack and its configuration are unchanged"
  fi
  mv -fT "$BACKUP_PART" "$out"
  BACKUP_PART=''
  DB_BACKUP_FILE="$out"
  ok "database copied → $out"
  while IFS= read -r old; do rm -f "$old"; done < <(backups_to_prune 5 .gusvoice-backups/db-*.sql.gz)
else
  info "--no-db-backup: skipping the database copy."
fi

if [ -n "$new" ]; then
  PANEL_ERROR=files
  mkdir -p .gusvoice-backups
  bak="$(mktemp -d ".gusvoice-backups/stack-$(date -u +%Y%m%d-%H%M%S)-XXXXXX")"
  cp -p docker-compose.yml "$bak/"
  if [ -d config ]; then cp -R config "$bak/"; fi

  replace_stack_file() {
    local source="$1" dest="$2" next
    next="$(mktemp "${dest%/*}/.${dest##*/}.gv.XXXXXX")"
    cp -p "$source" "$next"
    case "$dest" in *.sh) chmod +x "$next" ;; esac
    mv -fT "$next" "$dest"
  }

  # Preserve existing operator configs. The migration script is managed with the release compose.
  mkdir -p config
  for file in "$new"/config/*; do
    [ -e "$file" ] || continue
    dest="config/${file##*/}"
    if [ "$dest" != config/storage-migrate.sh ] && [ ! -e "$dest" ] && [ ! -L "$dest" ]; then cp -Rp "$file" "$dest"; fi
  done
  if [ -f "$new/config/storage-migrate.sh" ]; then
    replace_stack_file "$new/config/storage-migrate.sh" config/storage-migrate.sh
  fi
  for dir in docs deploy; do
    if [ -d "$new/$dir" ]; then mkdir -p "$dir"; cp -Rf "$new/$dir/." "$dir/"; fi
  done
  for f in docker-compose.yml install.sh uninstall.sh README.md .gitattributes .dockerignore update.sh; do
    if [ -f "$new/$f" ]; then replace_stack_file "$new/$f" "./$f"; fi
  done
  COMPOSE_BASE=docker-compose.yml
  if [ "${#LEGACY_ENV[@]}" -gt 0 ]; then
    printf '\nMINIO_ACCESS_KEY=gusvoice\n' >> .env
    LEGACY_ENV=()
    warn "recorded the original storage access key for this legacy install"
  fi
  ok "stack files refreshed (previous compose and config → $bak)"
fi

# --- 3) Recreate changed containers -----------------------------------------
panel_step restart
say "Applying update (recreating changed containers)…"
# The one-shot storage-migrate container is reused between runs and its log accumulates — read only
# what THIS update wrote.
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
up_rc=0
compose up -d --remove-orphans --no-build --pull never || up_rc=$?
log="$(compose logs --no-log-prefix --since "$started" storage-migrate 2>/dev/null || true)"
migrate_rc=''
if [ "$up_rc" = 0 ]; then
  services="$(compose config --services)"
  if grep -qx storage-migrate <<< "$services"; then
    migrate_rc=1
    migrate_id="$(compose ps -a -q storage-migrate)" || die "could not find the storage migration container"
    if [ -n "$migrate_id" ] && [ "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$migrate_id" </dev/null)" = exited:0 ]; then
      migrate_rc=0
    fi
  fi
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

# --- 3.5) Wait for a release to become healthy and verify the running version --
# Database migrations run at boot, so wait up to 5 minutes.
NEW_VERSION=''
if [ -n "$RELEASE" ]; then
  panel_step health
  say "Waiting for the backend to come up…"
  healthy=0
  for _ in $(seq 1 60); do
    backend_id="$(compose ps -q backend 2>/dev/null || true)"
    if [ -n "$backend_id" ] && [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$backend_id" </dev/null 2>/dev/null)" = healthy ]; then
      healthy=1; break
    fi
    sleep 5
  done
  [ "$healthy" = "1" ] || die "the backend didn't become healthy within 5 minutes. See: docker compose logs backend"
  NEW_VERSION="$(backend_version "$backend_id")" || die "could not inspect the running backend"
  NEW_VERSION="v${NEW_VERSION#v}"
  [ "$NEW_VERSION" = "$RELEASE" ] || die "the healthy backend is $NEW_VERSION, expected $RELEASE"
  ok "backend is up ($NEW_VERSION)"
fi

# --- 3.9) Own map for location sharing (optional, never fails the update) --------
# Questions and downloads ONLY for a person at a terminal: not with -y, not from the panel button. Otherwise one hint line in the log.
if [ "$NO_MAP" = "0" ] && [ -f deploy/maps/maps-install.sh ]; then
  # shellcheck source=deploy/maps/maps-install.sh
  . deploy/maps/maps-install.sh
  map_interactive=0
  if [ "$ASSUME_YES" = "0" ] && [ "$FROM_PANEL" = "0" ] && maps_can_ask; then map_interactive=1; fi
  maps_update_entry "$map_interactive" "$MAP_FORCE" || true
  if [ "$MAPS_PLAN_READY" = "1" ]; then
    maps_apply || true
    if [ "$MAPS_ENV_CHANGED" = "1" ]; then compose up -d --no-build --pull never backend || true
    elif [ "$MAPS_REPLACED" = "1" ]; then compose restart backend || true; fi
  fi
fi

# --- 4) Optional cleanup -----------------------------------------------------
if [ "$PRUNE" = "1" ]; then
  say "Pruning old images…"
  docker image prune -f >/dev/null 2>&1 || true
  ok "reclaimed disk from dangling images"
fi

# --- Done -------------------------------------------------------------------
say "Current status:"
compose ps || true

if [ "$MIGRATE_OUTCOME" = "failed" ]; then
  PANEL_ERROR=storage-migrate; panel_fail
  printf '\n\033[1;33m⚠  GusVoice is updated and running — but moving your OLD media into the new storage FAILED:\033[0m\n'
  printf '%s\n' "$log" | tail -n 8 | sed 's/^/    /'
  warn "Old avatars and attachments may stay hidden until the move succeeds. Their source volume was kept."
  warn "Fix the cause above, then retry the update."
  printf '\n'
  exit 1
fi

panel_status done '' "$NEW_VERSION"
PANEL_DONE=1
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
