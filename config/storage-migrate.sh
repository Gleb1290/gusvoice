#!/usr/bin/env bash
# =============================================================================
# GusVoice — one-time move of uploaded media from the OLD bundled MinIO into versitygw.
#
# Runs as the `storage-migrate` compose service (profile "storage"); the backend waits until it
# has finished successfully. Boxes installed before the switch kept media in MinIO, which is now
# archived (its images are gone from Docker Hub). MinIO stores objects in its own on-disk format
# that versitygw can't read, so the files are COPIED out while a MinIO server can still serve them.
#
# Why this lives in compose and not in update.sh: the first update of an existing box is run by
# that box's OLD update.sh, which only pulls the new compose file and does `up -d --remove-orphans`.
# Only something inside the compose file itself is guaranteed to run on that update.
#
#   * already moved before (marker in the new volume)  -> exits at once
#   * no MinIO data in the old volume (fresh install)   -> exits at once
#   * otherwise: check free disk -> start the MinIO the box used to ship on the old volume, reachable
#     only from inside this container -> copy every bucket with its headers (Content-Type,
#     Content-Disposition, …) and its anonymous-access policy -> verify that EVERY old object is in
#     the new storage with the same size, headers and content -> write the marker.
#
# Safety:
#   * objects in the old volume are only read (MinIO refreshes its own .minio.sys folder, as on any
#     start). The old volume is never deleted automatically — you remove it once you're satisfied.
#   * nothing in the new storage is overwritten; a run that stopped half-way can simply run again —
#     files already copied are skipped, files uploaded in the meantime are kept.
#   * any problem -> exit 1 with the reason. The backend waits for this service, but compose treats it
#     as an optional dependency (the profile may be off), so on failure the stack still starts: chat
#     and voice work, old files stay unavailable until the move is re-run. update.sh reports it.
# =============================================================================
set -uo pipefail

# Compose sets none of the MIGRATE_* / NEW_ENDPOINT variables — the defaults are the real box. They exist so a
# test can point the script at temporary folders; commands (minio, mc, curl, du, df) are faked through PATH.
OLD="${MIGRATE_OLD_DIR:-/old}"     # the old `miniodata` volume (MinIO's format)
NEW="${MIGRATE_NEW_DIR:-/new}"     # the new `s3data` volume (versitygw serves $NEW/s3)
MARK="$NEW/.migrated-from-minio"
OLD_VOLUME=gusvoice_miniodata      # compose project is always named "gusvoice"
NEW_ENDPOINT="${NEW_ENDPOINT:-http://storage:9000}"
OLD_ADDRESS="${MIGRATE_OLD_ADDRESS:-127.0.0.1:9100}"   # the old MinIO listens here, inside this container only
OLD_ENDPOINT="http://$OLD_ADDRESS"
WORK="${MIGRATE_WORK_DIR:-/tmp/storage-migrate}"

export LC_ALL=C MC_CONFIG_DIR="$WORK/mc"
mkdir -p "$WORK"

say() { printf '[storage-migrate] %s\n' "$*"; }
fail() {
  printf '[storage-migrate] ERROR: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '[storage-migrate]   %s\n' "$line" >&2; done
  printf '[storage-migrate] Your media is still safe in the Docker volume %s — nothing was deleted.\n' "$OLD_VOLUME" >&2
  printf '[storage-migrate] Fix the cause above, then run:  ./update.sh --images-only\n' >&2
  exit 1
}
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || printf '%s bytes' "$1"; }
unjson() { local s=$1; s=${s//\\\"/\"}; printf '%b' "$s"; }   # JSON-escaped key -> real key

[ -n "${S3_ACCESS_KEY:-}" ] && [ -n "${S3_SECRET_KEY:-}" ] \
  || fail "S3_ACCESS_KEY / S3_SECRET_KEY are empty (compose passes MINIO_ACCESS_KEY / MINIO_SECRET_KEY from .env)."

if [ -f "$MARK" ]; then
  say "media was moved to the new storage earlier — nothing to do."
  exit 0
fi
if [ ! -f "$OLD/.minio.sys/format.json" ]; then
  say "no media from the old MinIO storage — nothing to move."
  exit 0
fi

say "Found media from the old MinIO storage — moving it into the new storage (happens once)."

# --- 1) Free disk: the copy needs about as much space again as the media takes ---------------
old_bytes="$(du -sb --exclude=.minio.sys "$OLD" | cut -f1)"
copied_bytes="$(du -sb "$NEW/s3" 2>/dev/null | cut -f1)"; copied_bytes="${copied_bytes:-0}"
free_bytes="$(df -B1 --output=avail "$NEW" | tail -n 1 | tr -d ' ')"
left_bytes=$(( old_bytes > copied_bytes ? old_bytes - copied_bytes : 0 ))
spare_bytes=$(( old_bytes / 10 + 512 * 1024 * 1024 ))
say "media: $(human "$old_bytes"), still to copy: $(human "$left_bytes"), free disk: $(human "$free_bytes")."
if [ $(( left_bytes + spare_bytes )) -gt "$free_bytes" ]; then
  fail "not enough free disk space to copy the media." \
    "Needed: $(human "$left_bytes") + $(human "$spare_bytes") spare; free: $(human "$free_bytes")." \
    "Free up space on this server (see: docker system df)."
fi

# --- 2) The old MinIO, listening on this container's loopback only --------------------------
export MINIO_ROOT_USER="$S3_ACCESS_KEY" MINIO_ROOT_PASSWORD="$S3_SECRET_KEY" MINIO_BROWSER=off
minio server "$OLD" --address "$OLD_ADDRESS" --quiet >"$WORK/minio.log" 2>&1 &
minio_pid=$!
trap 'kill "$minio_pid" 2>/dev/null; wait "$minio_pid" 2>/dev/null' EXIT
ready=0
for _ in $(seq 1 120); do
  if curl -sf "$OLD_ENDPOINT/minio/health/ready" >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$minio_pid" 2>/dev/null || break
  sleep 1
done
[ "$ready" = 1 ] || fail "the old MinIO could not start on the old volume." "$(tail -n 5 "$WORK/minio.log")"

mc alias set old "$OLD_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1 \
  || fail "the old MinIO rejected the keys from .env (MINIO_ACCESS_KEY / MINIO_SECRET_KEY)."
mc alias set new "$NEW_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1 \
  || fail "cannot sign in to the new storage at $NEW_ENDPOINT."

# --- 3) Inventory: one sorted line per object -------------------------------------------------
# <key> TAB <size> TAB <headers>   and   <key> TAB <etag>
# Headers are compared as mc prints them (same client on both sides); the storage-class header is
# dropped because only versitygw reports it. Keys stay JSON-escaped — equal on both sides too.
re_ok='^\{"status":"success"'
re_name='"name":"(([^"\\]|\\.)*)"'
re_size='"size":([0-9]+)'
re_etag='"etag":"([^"]*)"'
re_meta='"metadata":\{([^}]*)\}'
inventory() { # $1 = alias/bucket, $2 = output file prefix
  local src="$1" out="$2" bucket="${1#*/}" line name size etag meta
  : >"$out.meta"; : >"$out.etag"
  # `mc stat -r` fails on an empty bucket — list first.
  mc ls -r --json "$src" >"$out.ls" 2>&1 || return 1
  [ -s "$out.ls" ] || return 0
  mc stat -r --json "$src" >"$out.raw" 2>&1 || return 1
  while IFS= read -r line; do
    [[ $line =~ $re_ok ]] || { printf '%s\n' "$line" >"$out.err"; return 1; }
    [[ $line =~ $re_name ]] || return 1; name="${BASH_REMATCH[1]}"; name="${name#"$bucket"/}"
    [[ $line =~ $re_size ]] || return 1; size="${BASH_REMATCH[1]}"
    etag=''; [[ $line =~ $re_etag ]] && etag="${BASH_REMATCH[1]}"
    meta=''; [[ $line =~ $re_meta ]] && meta="${BASH_REMATCH[1]}"
    meta="${meta//\"X-Amz-Storage-Class\":\"STANDARD\"/}"; meta="${meta//,,/,}"; meta="${meta#,}"; meta="${meta%,}"
    printf '%s\t%s\t%s\n' "$name" "$size" "$meta" >>"$out.meta"
    printf '%s\t%s\n' "$name" "${etag:--}" >>"$out.etag"   # never empty: `read` merges adjacent tabs
  done <"$out.raw"
  sort -o "$out.meta" "$out.meta"
  sort -t "$(printf '\t')" -k1,1 -o "$out.etag" "$out.etag"
}

mc ls --json old >"$WORK/buckets.json" 2>&1 || fail "cannot list buckets in the old MinIO." "$(tail -n 2 "$WORK/buckets.json")"
re_bucket='"key":"([^"/]+)/"'
buckets=()
while IFS= read -r line; do
  [[ $line =~ $re_bucket ]] && buckets+=("${BASH_REMATCH[1]}")
done <"$WORK/buckets.json"

files=0
for b in "${buckets[@]}"; do
  say "bucket \"$b\": copying…"
  mc mb --ignore-existing "new/$b" >/dev/null 2>&1 || fail "cannot create the bucket \"$b\" in the new storage."
  # No --overwrite: an object already in the new storage is never replaced; a different one = error.
  mc --json mirror "old/$b" "new/$b" >"$WORK/mirror.json" 2>&1 \
    || fail "copying the bucket \"$b\" failed." "$(tail -n 3 "$WORK/mirror.json")"

  # Anonymous access exactly as it was. The backend sets its public-read policy on every start, but an
  # update does not always restart it (same image) — without this, every avatar would answer 403.
  if mc anonymous get-json "old/$b" >"$WORK/policy.json" 2>/dev/null \
     && [ -n "$(tr -d ' \t\r\n{}' <"$WORK/policy.json")" ]; then
    mc anonymous set-json "$WORK/policy.json" "new/$b" >/dev/null 2>&1 \
      || fail "cannot copy the access policy of the bucket \"$b\"."
  fi

  say "bucket \"$b\": checking every file…"
  inventory "old/$b" "$WORK/old" || fail "cannot read the list of files in the old \"$b\"." "$(tail -n 2 "$WORK/old.raw" "$WORK/old.err" 2>/dev/null)"
  inventory "new/$b" "$WORK/new" || fail "cannot read the list of files in the new \"$b\"." "$(tail -n 2 "$WORK/new.raw" "$WORK/new.err" 2>/dev/null)"
  # Every OLD file must be in the new storage with the same size and headers. Extra files in the new
  # storage are fine: a backend that kept running during the update may already have saved new uploads.
  mismatch="$(comm -23 "$WORK/old.meta" "$WORK/new.meta" | head -n 5)"
  [ -z "$mismatch" ] || fail "after copying, these files of \"$b\" are missing or differ (name, size or headers):" "$mismatch"

  # Same ETag = same content (MD5 of the object or of its parts). A different ETag can legitimately
  # come from a different multipart split — then compare the bytes themselves.
  while IFS="$(printf '\t')" read -r key etag_old etag_new; do
    [ "$etag_old" = "$etag_new" ] && continue
    path="$(unjson "$key")"
    h_old="$(mc cat "old/$b/$path" </dev/null | sha256sum)"; h_new="$(mc cat "new/$b/$path" </dev/null | sha256sum)"
    [ "$h_old" = "$h_new" ] || fail "the content of \"$b/$path\" differs after copying."
  done < <(join -t "$(printf '\t')" "$WORK/old.etag" "$WORK/new.etag")

  n="$(wc -l <"$WORK/old.meta" | tr -d ' ')"
  files=$(( files + n ))
  say "bucket \"$b\": $n files — all match."
done

printf 'moved %s files (%s) from %s on %s\n' "$files" "$(human "$old_bytes")" "$OLD_VOLUME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$MARK" \
  || fail "cannot write the marker file $MARK."

say "✅ Done: $files files moved into the new storage and checked one by one."
say "The old volume is KEPT as it was: $OLD_VOLUME."
say "Once avatars and attachments open fine, free its disk space with:"
say "    docker volume rm $OLD_VOLUME"
