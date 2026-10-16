#!/usr/bin/env bash
# =============================================================================
# GusVoice — own map for location sharing: ask, measure, download (install.sh / update.sh).
#
# SOURCED by install.sh and update.sh (`. deploy/maps/maps-install.sh`); only defines functions, nothing runs on load.
# Never calls `exit`/`die`: the map is optional, a failure here must not stop an install or an update (callers add `|| true`).
# Every external command gets `</dev/null`: under `curl | bash` stdin IS the rest of the calling script and would be drained.
# Docs: docs/maps.md ("In the installer and on update"). The map is ONE PMTiles file ./maps/map.pmtiles (OpenStreetMap data,
# ODbL) read by the backend (MAP_PMTILES_PATH=/maps/map.pmtiles, feature `osmmap1`); this server serves tiles itself.
#
# Files in ./maps (override the directory with GV_MAPS_DIR; tests also use GV_MAPS_REGIONS_DIR, GV_PMTILES_BIN,
# GV_MAPS_BUILDS_URL, GV_MAPS_BUILD_BASE, GV_MAPS_FREE_BYTES, GV_MAPS_RETRY_SLEEP, GV_MAPS_INPUT, GV_MAPS_TODAY):
#   map.pmtiles   the map          map.meta   KEY=VALUE: COUNTRY NAME ZOOM BUILD INSTALLED [BBOX] [PART=main|all]   (read with grep|cut, never sourced)
#                                  PART only for countries that have <ISO3>.main.geojson: the answer to "main part only / with all territories"
#   .declined     the question was answered "no" — do not ask again on update (./update.sh --map asks anyway)
#   .bin/pmtiles  go-pmtiles, pinned version, sha256-checked   map.pmtiles.part  an unfinished download (never becomes the map)
# Switches: GV_MAPS=off disables everything; update.sh --map / --no-map.
# =============================================================================

# go-pmtiles — PINNED. Bumping = new version AND both hashes from the release page (never "latest").
MAPS_PMTILES_VERSION="1.31.2"
MAPS_PMTILES_SHA256_X86_64="3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f"
MAPS_PMTILES_SHA256_ARM64="f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1"
MAPS_STALE_DAYS=90      # older than this: the refresh question defaults to "yes"
MAPS_ASK_AFTER_DAYS=30  # younger than this: do not even measure/ask on update
MAPS_PLAN_READY=0; MAPS_REPLACED=0; MAPS_ENV_CHANGED=0
MAPS_REGION_FLAG=""; MAPS_REGION_ISO3=""; MAPS_REGION_NAME=""; MAPS_ZOOM=""; MAPS_BUILD=""; MAPS_BIN=""; MAPS_PART=""

maps_say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
maps_info() { printf '  \033[0;90m%s\033[0m\n' "$*"; }
maps_warn() { printf '  \033[1;33m%s\033[0m\n' "$*"; }
maps_dir()         { printf '%s' "${GV_MAPS_DIR:-./maps}"; }
maps_regions_dir() { printf '%s' "${GV_MAPS_REGIONS_DIR:-./deploy/maps/regions}"; }
maps_today()       { if [ -n "${GV_MAPS_TODAY:-}" ]; then printf '%s' "$GV_MAPS_TODAY"; else date -u +%Y%m%d; fi; }

# --- Pure helpers (no network, no prompts — shell tests source this file and call them) --------------------------------

# go-pmtiles prints `… for an archive size of 6.8 GB` (decimal units, humanize.Bytes). stdin: the log → stdout: bytes (nothing if no line).
maps_parse_size() {
  tr '\r' '\n' | sed -n 's/.*archive size of \([0-9][0-9.]*\) *\([A-Za-z]*\).*/\1 \2/p' | tail -n 1 | awk '
    { u = $2; m = -1
      if (u == "B" || u == "") m = 1; else if (u == "kB" || u == "KB") m = 1e3; else if (u == "MB") m = 1e6
      else if (u == "GB") m = 1e9; else if (u == "TB") m = 1e12
      if (m < 0) exit 1
      printf "%.0f\n", $1 * m }'
}

maps_fmt_size() { # bytes -> "950 MB" / "6.8 GB" / "13 GB"
  awk -v b="${1:-0}" 'BEGIN {
    if (b >= 1e12) printf "%.1f TB", b / 1e12
    else if (b >= 1e10) printf "%.0f GB", b / 1e9
    else if (b >= 1e9) printf "%.1f GB", b / 1e9
    else printf "%.0f MB", b / 1e6 }'
}

maps_need_bytes() { # size -> size plus a reserve: 10 % but not less than 2 GB (the server must keep breathing room)
  awk -v b="${1:-0}" 'BEGIN { r = b / 10; if (r < 2e9) r = 2e9; printf "%.0f", b + r }'
}
maps_fits() { # maps_fits <size> <free> -> 0 when size + reserve fits into free
  awk -v need="$(maps_need_bytes "$1")" -v free="${2:-0}" 'BEGIN { exit !(free + 0 >= need + 0) }'
}

maps_free_bytes() { # free bytes on the disk holding ./maps
  if [ -n "${GV_MAPS_FREE_BYTES:-}" ]; then printf '%s' "$GV_MAPS_FREE_BYTES"; return 0; fi
  df -Pk "$(maps_dir)" 2>/dev/null </dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }'
}

maps_age_days() { # maps_age_days <YYYYMMDD from> <YYYYMMDD to> -> whole days (awk, no GNU date)
  awk -v a="$1" -v b="$2" '
    function jd(s,   y, m, d) { y = substr(s, 1, 4) + 0; m = substr(s, 5, 2) + 0; d = substr(s, 7, 2) + 0
      if (m <= 2) { y--; m += 12 }
      return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d - 1524 }
    BEGIN { print jd(b) - jd(a) }'
}

maps_yesterday() { date -u -d yesterday +%Y%m%d 2>/dev/null || date -u -v-1d +%Y%m%d 2>/dev/null || true; }

maps_bbox_ok() { # "west,south,east,north" in degrees, west < east, south < north
  case "$1" in *[!0-9.,-]*|'') return 1 ;; esac
  printf '%s' "$1" | awk -F, 'NF != 4 { exit 1 }
    { for (i = 1; i <= 4; i++) if ($i !~ /^-?[0-9]+(\.[0-9]+)?$/) exit 1
      if ($1 < -180 || $3 > 180 || $2 < -85 || $4 > 85 || $1 >= $3 || $2 >= $4) exit 1 }'
}

# Search the country index (deploy/maps/regions/index.tsv: ISO2 ISO3 name-en name-ru search-variants). A query that is an ISO
# code (2–3 ASCII letters), or equals a name exactly, wins over substrings ("Oman" must not offer "Romania").
# stdout: lines `ISO3<TAB>name-en<TAB>name-ru`.
maps_find_country() { # maps_find_country <query> <index.tsv>
  local q="$1" uq
  uq="$(printf '%s' "$q" | tr 'a-z' 'A-Z')"
  MAPS_Q="$q" MAPS_UQ="$uq" awk -F'\t' '
    BEGIN { q = ENVIRON["MAPS_Q"]; uq = ENVIRON["MAPS_UQ"]; iso = (q ~ /^[A-Za-z][A-Za-z][A-Za-z]?$/) }
    { line = $2 "\t" $3 "\t" $4
      if (iso && (($1 != "" && $1 == uq) || $2 == uq)) { codes[++nc] = line; next }
      n = split($5, v, "|"); ex = 0
      for (i = 1; i <= n; i++) if (v[i] == q) { ex = 1; break }
      if (ex) names[++ne] = line
      else if (index($5, q) > 0) subs[++ns] = line }
    END { if (nc) { for (i = 1; i <= nc; i++) print codes[i] }
          else if (ne) { for (i = 1; i <= ne; i++) print names[i] }
          else { for (i = 1; i <= ns; i++) print subs[i] } }' "$2"
}

maps_arch() { # -> x86_64 | arm64 (what go-pmtiles names its Linux builds); empty = unsupported
  case "$(uname -m 2>/dev/null)" in x86_64|amd64) echo x86_64 ;; aarch64|arm64) echo arm64 ;; esac
}

maps_sha256() { # file -> hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" </dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" </dev/null | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" </dev/null | sed 's/^.*= *//'
  else return 1; fi
}

maps_meta_get() { # key -> value from ./maps/map.meta
  local f; f="$(maps_dir)/map.meta"; [ -f "$f" ] || return 0
  grep -E "^$1=" "$f" 2>/dev/null | head -n 1 | cut -d= -f2- | tr -d '\r' || true
}

maps_retry() { # run a command up to 3 times, a pause between attempts
  local n=1
  while :; do
    "$@" && return 0
    [ "$n" -ge 3 ] && return 1
    n=$((n + 1)); sleep "${GV_MAPS_RETRY_SLEEP:-3}"
  done
}

# --- Network pieces ----------------------------------------------------------------------------------------------------

maps_get_pmtiles() { # puts the pinned, hash-checked go-pmtiles into ./maps/.bin; sets MAPS_BIN
  if [ -n "${GV_PMTILES_BIN:-}" ]; then MAPS_BIN="$GV_PMTILES_BIN"; return 0; fi
  local bin; bin="$(maps_dir)/.bin/pmtiles"
  if [ -x "$bin" ] && [ "$(cat "$(maps_dir)/.bin/pmtiles.version" 2>/dev/null </dev/null)" = "$MAPS_PMTILES_VERSION" ]; then MAPS_BIN="$bin"; return 0; fi
  local arch want tmp url
  arch="$(maps_arch)"
  case "$arch" in
    x86_64) want="$MAPS_PMTILES_SHA256_X86_64" ;;
    arm64)  want="$MAPS_PMTILES_SHA256_ARM64" ;;
    *) maps_warn "The map tool (go-pmtiles) has no build for this CPU ($(uname -m 2>/dev/null)) — continuing without a map."; return 1 ;;
  esac
  command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 || { maps_warn "curl and tar are needed to fetch the map tool — continuing without a map."; return 1; }
  mkdir -p "$(maps_dir)/.bin" || return 1
  tmp="$(mktemp -d "$(maps_dir)/.bin/dl.XXXXXX")" || return 1
  url="https://github.com/protomaps/go-pmtiles/releases/download/v${MAPS_PMTILES_VERSION}/go-pmtiles_${MAPS_PMTILES_VERSION}_Linux_${arch}.tar.gz"
  maps_info "Fetching the map tool go-pmtiles v${MAPS_PMTILES_VERSION} (${arch})…"
  if ! maps_retry curl -fsSL --connect-timeout 15 --max-time 300 -o "$tmp/pmtiles.tar.gz" "$url" </dev/null; then
    maps_warn "Could not download the map tool (network?) — continuing without a map."; rm -rf "$tmp"; return 1
  fi
  if [ "$(maps_sha256 "$tmp/pmtiles.tar.gz" 2>/dev/null)" != "$want" ]; then
    maps_warn "The downloaded map tool does NOT match its pinned sha256 — refusing to use it. Continuing without a map."; rm -rf "$tmp"; return 1
  fi
  if ! { mkdir "$tmp/x" && tar -xzf "$tmp/pmtiles.tar.gz" -C "$tmp/x" </dev/null 2>/dev/null; } || [ ! -f "$tmp/x/pmtiles" ]; then
    maps_warn "Unexpected map tool archive layout — continuing without a map."; rm -rf "$tmp"; return 1
  fi
  chmod 755 "$tmp/x/pmtiles" && mv -f "$tmp/x/pmtiles" "$bin" && printf '%s\n' "$MAPS_PMTILES_VERSION" > "$(maps_dir)/.bin/pmtiles.version"
  rm -rf "$tmp"
  MAPS_BIN="$bin"
}

maps_latest_build() { # sets MAPS_BUILD (YYYYMMDD): newest key of builds.json, else yesterday's date
  local json key url="${GV_MAPS_BUILDS_URL:-https://build-metadata.protomaps.dev/builds.json}"
  # builds.json is one line of objects; no jq here — keys look like "key":"20261013.pmtiles"
  json="$(maps_retry curl -fsSL --connect-timeout 15 --max-time 60 "$url" </dev/null 2>/dev/null || true)"
  key="$(printf '%s' "$json" | grep -o '"key" *: *"[0-9]\{8\}\.pmtiles"' | sed 's/[^0-9]//g' | sort | tail -n 1)"
  if [ -z "$key" ]; then
    key="$(maps_yesterday)"
    maps_info "Could not read the build list — using yesterday's build ($key)."
  fi
  case "$key" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) MAPS_BUILD="$key" ;; *) return 1 ;; esac
}

maps_build_url() { printf '%s%s.pmtiles' "${GV_MAPS_BUILD_BASE:-https://build.protomaps.com/}" "$MAPS_BUILD"; }

maps_dry_size() { # maps_dry_size <region flag> <maxzoom> -> bytes on stdout; reads only metadata, downloads nothing
  local n=1 log size dry; dry="$(maps_dir)/.dry.pmtiles"
  while :; do
    log="$("$MAPS_BIN" extract "$(maps_build_url)" "$dry" "$1" --maxzoom="$2" --dry-run </dev/null 2>&1 || true)"
    rm -f "$dry"
    size="$(printf '%s\n' "$log" | maps_parse_size || true)"
    if [ -n "$size" ]; then printf '%s\n' "$size"; return 0; fi
    if [ "$n" -ge 3 ]; then printf '%s\n' "$log" | tr '\r' '\n' | grep -v '^$' | tail -n 2 | sed 's/^/      /' >&2; return 1; fi
    n=$((n + 1)); sleep "${GV_MAPS_RETRY_SLEEP:-3}"
  done
}

# --- Questions -------------------------------------------------------------------------------------------------------

maps_can_ask() { # a person is there to answer: a real terminal (or GV_MAPS_INPUT for tests)
  [ "${GV_MAPS:-}" = off ] && return 1
  [ -n "${GV_MAPS_INPUT:-}" ] && return 0
  if [ "${MAPS_ASK_MODE:-stdin}" = tty ]; then ( : </dev/tty ) 2>/dev/null; else [ -t 0 ] && ( : </dev/tty ) 2>/dev/null; fi
}

# Answers come on fd 9 (the terminal, even under `curl | bash`). 🔴 Must be called in the MAIN shell before the first prompt: maps_ask runs inside
# $(…), and a descriptor opened there is lost with the subshell — a file input would then restart from its first line on every question.
maps_open_input() {
  [ "${MAPS_INPUT_OPEN:-0}" = 1 ] && return 0
  local f="${GV_MAPS_INPUT:-/dev/tty}"
  ( : <"$f" ) 2>/dev/null || return 1
  exec 9<"$f"; MAPS_INPUT_OPEN=1
}

maps_ask() { # maps_ask "Prompt" "default" -> answer on stdout; status 1 = no input (EOF)
  local prompt="$1" def="${2:-}" ans
  maps_open_input || return 1
  if [ -n "$def" ]; then printf '  %s [%s]: ' "$prompt" "$def" >&2; else printf '  %s: ' "$prompt" >&2; fi
  IFS= read -r -u 9 ans || { printf '\n' >&2; return 1; }
  ans="${ans%$'\r'}"; ans="${ans#"${ans%%[![:space:]]*}"}"; ans="${ans%"${ans##*[![:space:]]}"}"
  printf '%s\n' "${ans:-$def}"
}

maps_yes_no() { # maps_yes_no "Prompt" Y|N -> 0 yes, 1 no, 2 no input
  local a; a="$(maps_ask "$1" "${2:-N}")" || return 2
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

maps_choose_bbox() {
  local b
  while :; do
    b="$(maps_ask 'Rectangle west,south,east,north in degrees (e.g. 36.4,55.1,38.9,56.3; empty = back)' '')" || return 1
    [ -n "$b" ] || return 1
    if maps_bbox_ok "$b"; then MAPS_REGION_FLAG="--bbox=$b"; MAPS_REGION_ISO3="custom"; MAPS_REGION_NAME="rectangle $b"; return 0; fi
    maps_warn "That is not a valid rectangle (west < east, south < north, degrees)."
  done
}

maps_choose_country() { # sets MAPS_REGION_*; status 1 = skip
  local idx q found n i pick line c_iso c_en c_ru
  idx="$(maps_regions_dir)/index.tsv"
  [ -f "$idx" ] || { maps_warn "The country list is missing ($idx) — continuing without a map."; return 1; }
  while :; do
    q="$(maps_ask 'Country: name (English or Russian), ISO code (DE, DEU), or "box" for your own rectangle; empty = no map' '')" || return 1
    [ -n "$q" ] || return 1
    case "$q" in box|BOX|Box) maps_choose_bbox && return 0; continue ;; esac
    if printf '%s' "$q" | grep -Eq '^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$'; then
      if maps_bbox_ok "$q"; then MAPS_REGION_FLAG="--bbox=$q"; MAPS_REGION_ISO3="custom"; MAPS_REGION_NAME="rectangle $q"; return 0; fi
      maps_warn "That is not a valid rectangle (west < east, south < north, degrees)."; continue
    fi
    found="$(maps_find_country "$q" "$idx")"
    n="$(printf '%s\n' "$found" | grep -c . || true)"
    if [ "$n" -eq 0 ]; then maps_warn "Nothing found for \"$q\" — try another spelling."; continue; fi
    if [ "$n" -gt 12 ]; then maps_warn "$n countries match \"$q\" — be more specific."; continue; fi
    if [ "$n" -eq 1 ]; then
      line="$found"
    else
      i=0; while IFS=$'\t' read -r c_iso c_en c_ru; do i=$((i + 1)); printf '    %2d) %s (%s) [%s]\n' "$i" "$c_en" "$c_ru" "$c_iso" >&2; done <<EOF
$found
EOF
      pick="$(maps_ask 'Number (empty = search again)' '')" || return 1
      case "$pick" in ''|*[!0-9]*) continue ;; esac
      line="$(printf '%s\n' "$found" | sed -n "${pick}p")"
      [ -n "$line" ] || continue
    fi
    IFS=$'\t' read -r c_iso c_en c_ru <<EOF
$line
EOF
    if [ ! -f "$(maps_regions_dir)/$c_iso.geojson" ]; then maps_warn "No outline for $c_en ($c_iso) in this copy — pick another."; continue; fi
    maps_yes_no "$c_en ($c_ru) — right?" Y
    case $? in 0) ;; 2) return 1 ;; *) continue ;; esac
    MAPS_REGION_FLAG="--region=$(maps_regions_dir)/$c_iso.geojson"; MAPS_REGION_ISO3="$c_iso"; MAPS_REGION_NAME="$c_en"
    return 0
  done
}

# --- The two flows -----------------------------------------------------------------------------------------------------

maps_remember_decline() { mkdir -p "$(maps_dir)" 2>/dev/null && date -u +%Y-%m-%d > "$(maps_dir)/.declined" 2>/dev/null || true; }

# Sizes of one region at zoom 14 and (when 14 fits) 15 → MAPS_S14 MAPS_S15 MAPS_FIT14 MAPS_FIT15. Status 1 = the network failed (message printed).
maps_measure() { # maps_measure <region flag> <free bytes>
  MAPS_S14=""; MAPS_S15=""; MAPS_FIT14=0; MAPS_FIT15=0
  MAPS_S14="$(maps_dry_size "$1" 14)" || { maps_warn "Could not measure the map (network?) — continuing without a map. Retry later: ./update.sh --map"; return 1; }
  if maps_fits "$MAPS_S14" "$2"; then
    MAPS_FIT14=1
    MAPS_S15="$(maps_dry_size "$1" 15)" || { maps_warn "Could not measure zoom 15 (network?) — continuing without a map. Retry later: ./update.sh --map"; return 1; }
    maps_fits "$MAPS_S15" "$2" && MAPS_FIT15=1
  fi
  return 0
}

# One line with the sizes of a measured region (uses MAPS_S14/S15/FIT*).
maps_size_line() { # maps_size_line <label>
  if [ "$MAPS_FIT14" = 0 ]; then
    printf '%s: even the smaller map is %s (+ reserve)' "$1" "$(maps_fmt_size "$MAPS_S14")"
  else
    printf '%s: with buildings (zoom 15) %s%s  ·  streets, no buildings up close (zoom 14) %s' "$1" "$(maps_fmt_size "$MAPS_S15")" "$([ "$MAPS_FIT15" = 1 ] || printf ' (does not fit)')" "$(maps_fmt_size "$MAPS_S14")"
  fi
}

# The country has a "main part" outline (France: Europe + Corsica without Guiana, Réunion…; the USA without Hawaii and Alaska…):
# measure both and ask which one. Sets MAPS_REGION_FLAG / NAME / PART and MAPS_S14… of the choice; status 1 = stop, 2 = ask the country again.
maps_choose_part() { # maps_choose_part <free bytes>
  local free="$1" all_flag="$MAPS_REGION_FLAG" main_flag pick all14 all15 allf14 allf15
  main_flag="--region=$(maps_regions_dir)/$MAPS_REGION_ISO3.main.geojson"
  MAPS_PART=""
  maps_measure "$main_flag" "$free" || return 1
  all14="" all15="" allf14=0 allf15=0
  local m14="$MAPS_S14" m15="$MAPS_S15" mf14="$MAPS_FIT14" mf15="$MAPS_FIT15"
  if [ "$mf14" = 1 ]; then # does not even the main part fit — the whole country cannot either
    maps_measure "$all_flag" "$free" || return 1
    all14="$MAPS_S14"; all15="$MAPS_S15"; allf14="$MAPS_FIT14"; allf15="$MAPS_FIT15"
  fi
  # Территории весят мало (замер 14.10: Франция 5,5 → 5,6 ГБ, Нидерланды 1,3 → 1,3, США 16 → 17) — решение владельца: спрашивать,
  # только если вся страна заметно больше основной части: больше max(10 %, 1 ГБ) на масштабе 15. Иначе молча вся страна, без PART.
  if [ "$allf14" = 1 ] && [ -n "$all15" ] && [ -n "$m15" ]; then
    local extra=$(( all15 - m15 )) floor=$(( all15 / 10 ))
    [ "$floor" -lt 1000000000 ] && floor=1000000000
    if [ "$extra" -lt "$floor" ]; then
      MAPS_S14="$all14"; MAPS_S15="$all15"; MAPS_FIT14="$allf14"; MAPS_FIT15="$allf15"
      maps_info "Distant territories add only $(maps_fmt_size "$extra") — taking the whole country."
      return 0
    fi
  fi
  MAPS_S14="$m14"; MAPS_S15="$m15"; MAPS_FIT14="$mf14"; MAPS_FIT15="$mf15"
  if [ "$mf14" = 0 ]; then MAPS_REGION_FLAG="$main_flag"; MAPS_PART=main; MAPS_REGION_NAME="$MAPS_REGION_NAME (main part only)"; return 0; fi
  printf '\n' >&2
  maps_info "$MAPS_REGION_NAME has distant territories (overseas departments, far islands). Which map?"
  maps_info "$(maps_size_line '1 = main part only')"
  MAPS_S14="$all14"; MAPS_S15="$all15"; MAPS_FIT14="$allf14"; MAPS_FIT15="$allf15"
  maps_info "$(maps_size_line '2 = with all territories')  ·  free on disk: $(maps_fmt_size "$free")"
  while :; do
    pick="$(maps_ask "Part: 1 = main part only, $([ "$allf14" = 1 ] && printf '2 = with all territories, ')c = other country; empty = no map" '')" || return 1
    case "$pick" in
      1) MAPS_REGION_FLAG="$main_flag"; MAPS_PART=main; MAPS_REGION_NAME="$MAPS_REGION_NAME (main part only)"
         MAPS_S14="$m14"; MAPS_S15="$m15"; MAPS_FIT14="$mf14"; MAPS_FIT15="$mf15"; return 0 ;;
      2) if [ "$allf14" = 1 ]; then
           MAPS_REGION_FLAG="$all_flag"; MAPS_PART=all
           MAPS_S14="$all14"; MAPS_S15="$all15"; MAPS_FIT14="$allf14"; MAPS_FIT15="$allf15"; return 0
         fi
         maps_warn "That choice is not available." ;;
      c|C) return 2 ;;
      *) maps_remember_decline; maps_info "OK, no map. Change your mind later: ./update.sh --map"; return 1 ;;
    esac
  done
}

# First time: question → tool → build → country → (part) → sizes → choice. Sets MAPS_PLAN_READY=1 only when a download was chosen.
maps_plan_new() {
  MAPS_PLAN_READY=0
  maps_open_input || return 1
  maps_say "Map for location sharing in direct messages"
  maps_info "A live map is shown in the location card. It is stored ON THIS SERVER (OpenStreetMap data); nobody's servers get asked for tiles."
  maps_info "It is a one-time download of your country's map (hundreds of MB to tens of GB). Optional — you can add it later with ./update.sh --map."
  maps_yes_no "Add the map?" Y
  case $? in 0) ;; 2) return 1 ;; *) maps_remember_decline; maps_info "OK, no map. Change your mind later: ./update.sh --map"; return 1 ;; esac
  mkdir -p "$(maps_dir)" || return 1
  maps_get_pmtiles || return 1
  maps_latest_build || { maps_warn "Could not determine the map build — continuing without a map."; return 1; }
  local free pick st
  free="$(maps_free_bytes)"
  while :; do
    maps_choose_country || { maps_remember_decline; maps_info "OK, no map. Change your mind later: ./update.sh --map"; return 1; }
    maps_info "Measuring (reads only the index of the $MAPS_BUILD build, downloads nothing; large countries take a minute or two)…"
    MAPS_PART=""
    if [ "$MAPS_REGION_ISO3" != custom ] && [ -f "$(maps_regions_dir)/$MAPS_REGION_ISO3.main.geojson" ]; then
      maps_choose_part "$free"; st=$?
      case $st in 0) ;; 2) continue ;; *) return 1 ;; esac
    else
      maps_measure "$MAPS_REGION_FLAG" "$free" || return 1
    fi
    printf '\n' >&2
    if [ "$MAPS_FIT14" = 0 ]; then
      maps_warn "Not enough disk space for $MAPS_REGION_NAME: even the smaller map is $(maps_fmt_size "$MAPS_S14") (+ reserve), free: $(maps_fmt_size "$free")."
    else
      maps_info "$MAPS_REGION_NAME — with buildings (zoom 15): $(maps_fmt_size "$MAPS_S15")$([ "$MAPS_FIT15" = 1 ] || printf ' (does not fit)')  ·  streets, no buildings up close (zoom 14): $(maps_fmt_size "$MAPS_S14")  ·  free on disk: $(maps_fmt_size "$free")"
    fi
    pick="$(maps_ask "Download: $([ "$MAPS_FIT15" = 1 ] && printf '15 = with buildings, ')$([ "$MAPS_FIT14" = 1 ] && printf '14 = without; ')c = other country; empty = no map" '')" || return 1
    case "$pick" in
      15) if [ "$MAPS_FIT15" = 1 ]; then MAPS_ZOOM=15; MAPS_PLAN_READY=1; return 0; fi ;;
      14) if [ "$MAPS_FIT14" = 1 ]; then MAPS_ZOOM=14; MAPS_PLAN_READY=1; return 0; fi ;;
      c|C) continue ;;
      *) maps_remember_decline; maps_info "OK, no map. Change your mind later: ./update.sh --map"; return 1 ;;
    esac
    maps_warn "That choice is not available."
  done
}

# Existing map from the installer (has map.meta): age check, size of the new build, question. Sets MAPS_PLAN_READY=1 on "yes".
maps_plan_refresh() { # maps_plan_refresh <force 0|1>
  MAPS_PLAN_READY=0; MAPS_PART=""
  local build age iso3 bbox name zoom size free def a part
  maps_open_input || return 0
  build="$(maps_meta_get BUILD)"; iso3="$(maps_meta_get COUNTRY)"; name="$(maps_meta_get NAME)"; zoom="$(maps_meta_get ZOOM)"; bbox="$(maps_meta_get BBOX)"; part="$(maps_meta_get PART)"
  case "$build" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) return 0 ;; esac
  age="$(maps_age_days "$build" "$(maps_today)")"
  if [ "$age" -lt "$MAPS_ASK_AFTER_DAYS" ] && [ "${1:-0}" != 1 ]; then
    maps_info "Map: ${name:-$iso3}, zoom ${zoom}, build ${build} ($age days old) — fresh enough."; return 0
  fi
  if [ "$iso3" = custom ]; then MAPS_REGION_FLAG="--bbox=$bbox"
  elif [ "$part" = main ] && [ -f "$(maps_regions_dir)/$iso3.main.geojson" ]; then MAPS_REGION_FLAG="--region=$(maps_regions_dir)/$iso3.main.geojson"; MAPS_PART=main  # the variant chosen at install time
  elif [ "$part" != main ] && [ -f "$(maps_regions_dir)/$iso3.geojson" ]; then MAPS_REGION_FLAG="--region=$(maps_regions_dir)/$iso3.geojson"; MAPS_PART=""; [ "$part" = all ] && MAPS_PART=all
  else maps_info "Map: outline for $iso3 not found in this copy — not refreshing."; return 0; fi
  MAPS_REGION_ISO3="$iso3"; MAPS_REGION_NAME="${name:-$iso3}"; MAPS_ZOOM="$zoom"
  maps_get_pmtiles || return 0
  maps_latest_build || return 0
  if [ "$MAPS_BUILD" = "$build" ]; then maps_info "Map is already the newest build ($build)."; return 0; fi
  size="$(maps_dry_size "$MAPS_REGION_FLAG" "$zoom")" || { maps_warn "Could not measure the new map (network?) — keeping the current one."; return 0; }
  free="$(maps_free_bytes)"
  if ! maps_fits "$size" "$free"; then
    maps_warn "A newer map build exists but there is not enough disk for it ($(maps_fmt_size "$size") + reserve, free $(maps_fmt_size "$free")); the old map stays until the new one is fully downloaded."; return 0
  fi
  def=N; [ "$age" -ge "$MAPS_STALE_DAYS" ] && def=Y
  maps_yes_no "Your map is $age days old (build $build, ${name:-$iso3}, zoom $zoom). Update it? It downloads about $(maps_fmt_size "$size"), free: $(maps_fmt_size "$free")" "$def"
  case $? in 0) MAPS_PLAN_READY=1 ;; *) maps_info "Keeping the current map." ;; esac
  return 0
}

# Download the planned map. Returns 0 only when ./maps/map.pmtiles is complete and .env points at it.
maps_apply() {
  [ "$MAPS_PLAN_READY" = 1 ] || return 0
  local dir out part n=1 had=0
  dir="$(maps_dir)"; out="$dir/map.pmtiles"; part="$out.part"
  [ -f "$out" ] && had=1
  rm -f "$part"
  maps_say "Downloading the map: $MAPS_REGION_NAME, zoom $MAPS_ZOOM, build $MAPS_BUILD (a pause or a network drop restarts it, up to 3 tries)"
  while :; do
    if "$MAPS_BIN" extract "$(maps_build_url)" "$part" "$MAPS_REGION_FLAG" --maxzoom="$MAPS_ZOOM" </dev/null && [ -s "$part" ] \
       && "$MAPS_BIN" show "$part" </dev/null >/dev/null 2>&1; then break; fi
    rm -f "$part"
    if [ "$n" -ge 3 ]; then
      maps_warn "The map download failed 3 times (network? disk?) — continuing without it. Try again later: ./update.sh --map"; return 1
    fi
    n=$((n + 1)); maps_warn "Download interrupted — trying again ($n/3)…"; sleep "${GV_MAPS_RETRY_SLEEP:-3}"
  done
  chmod 644 "$part" 2>/dev/null || true
  chmod 755 "$dir" 2>/dev/null || true
  mv -f "$part" "$out" || { rm -f "$part"; maps_warn "Could not put the map in place."; return 1; }
  { printf 'COUNTRY=%s\nNAME=%s\nZOOM=%s\nBUILD=%s\nINSTALLED=%s\n' "$MAPS_REGION_ISO3" "$MAPS_REGION_NAME" "$MAPS_ZOOM" "$MAPS_BUILD" "$(date -u +%Y-%m-%d)"
    case "$MAPS_REGION_FLAG" in --bbox=*) printf 'BBOX=%s\n' "${MAPS_REGION_FLAG#--bbox=}" ;; esac
    case "$MAPS_PART" in main|all) printf 'PART=%s\n' "$MAPS_PART" ;; esac
  } > "$dir/map.meta"
  rm -f "$dir/.declined"
  [ "$had" = 1 ] && MAPS_REPLACED=1
  maps_env_ensure
  maps_info "Map ready: $(maps_fmt_size "$(wc -c < "$out" | tr -d ' ')") in $out"
  MAPS_PLAN_READY=0
}

# .env: MAP_PMTILES_PATH=/maps/map.pmtiles — added or filled in, the rest of the file untouched. Sets MAPS_ENV_CHANGED=1 when it wrote.
maps_env_ensure() {
  local env="${GV_ENV_FILE:-.env}" tmp
  [ -f "$env" ] || return 0
  if grep -Eq '^MAP_PMTILES_PATH=.+' "$env"; then return 0; fi
  tmp="$env.maps.tmp"
  ( umask 077; grep -v '^MAP_PMTILES_PATH=' "$env" > "$tmp" || true; printf 'MAP_PMTILES_PATH=/maps/map.pmtiles\n' >> "$tmp" ) \
    && chmod 600 "$tmp" && mv -f "$tmp" "$env" && MAPS_ENV_CHANGED=1
}

# --- Entry points ------------------------------------------------------------------------------------------------------

# install.sh, after .env exists. Asks and measures (no big download yet); maps_apply runs after the stack is up.
maps_install_prepare() {
  [ "${GV_MAPS:-}" = off ] && return 0
  if [ -f "$(maps_dir)/map.pmtiles" ]; then maps_env_ensure; maps_info "A map is already in $(maps_dir) — keeping it."; return 0; fi
  if ! maps_can_ask; then maps_info "Own map for location sharing: skipped (no terminal to ask). Add it later: ./update.sh --map"; return 0; fi
  maps_plan_new || true
  return 0
}

# update.sh. interactive=1 only for a person at a terminal (not -y, not the panel button, not --install-updater).
maps_update_entry() { # maps_update_entry <interactive 0|1> <force 0|1>
  local interactive="${1:-0}" force="${2:-0}" age build
  [ "${GV_MAPS:-}" = off ] && return 0
  MAPS_PLAN_READY=0
  if [ -f "$(maps_dir)/map.pmtiles" ]; then
    if [ ! -f "$(maps_dir)/map.meta" ]; then return 0; fi  # put there by hand (scripts/maps-extract.sh) — not ours to touch
    maps_env_ensure
    if [ "$interactive" = 1 ]; then
      maps_plan_refresh "$force"
    else
      build="$(maps_meta_get BUILD)"
      case "$build" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9])
        age="$(maps_age_days "$build" "$(maps_today)")"
        [ "$age" -ge "$MAPS_STALE_DAYS" ] && maps_info "Map is $age days old (build $build). Refresh it from a terminal: ./update.sh --map" ;;
      esac
    fi
    return 0
  fi
  if [ -f "$(maps_dir)/.declined" ] && [ "$force" != 1 ]; then return 0; fi
  if [ "$interactive" = 1 ]; then maps_plan_new || true
  else maps_info "Own map for location sharing is available — run ./update.sh in a terminal to set it up (or ./update.sh --map)."; fi
  return 0
}
