import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// R227/R229: запускается вся библиотека/весь update.sh, не извлечённые функции.
// Никакая .env рабочей копии не читается: все входы создаются в отдельной synthetic-коробке.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const library = readFileSync(join(root, 'deploy/maps/maps-install.sh'), 'utf8').replaceAll('\r\n', '\n');
const updater = readFileSync(join(root, 'update.sh'), 'utf8').replaceAll('\r\n', '\n');
const regions = join(root, 'deploy/maps/regions');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';
const unix = (path: string) => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
  : path;

// Заглушка использует только конкретные пути fixture: неизвестный URL — ошибка, а не настоящая сеть.
const curlStub = String.raw`#!/usr/bin/env bash
set -eu
trap 'echo "curl-fixture-error:$?" >> "$FIXTURE_ERRORS"' ERR
printf 'curl %s\n' "$*" >> "$FIXTURE_CALLS"
out=''; url=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; --connect-timeout|--max-time) shift ;; -*) ;; *) url="$1" ;; esac
  shift
done
if [ "${'${'}STUB_BUILDS_FAIL:-0}" = 1 ] && [ "$url" = "$GV_MAPS_BUILDS_URL" ]; then exit 22; fi
case "$url" in
  "$GV_MAPS_BUILDS_URL") cat "$FIXTURE_BUILDS" ;;
  https://github.com/protomaps/go-pmtiles/releases/download/*)
    [ -n "$out" ] && [ -f "$FIXTURE_TOOL_ARCHIVE" ] || { echo tool-archive-missing >> "$FIXTURE_ERRORS"; exit 98; }
    cp "$FIXTURE_TOOL_ARCHIVE" "$out" ;;
  https://github.com/Gleb1290/gusvoice/archive/refs/heads/main.tar.gz)
    [ -f "$FIXTURE_UPDATE_ARCHIVE" ] || { echo update-archive-missing >> "$FIXTURE_ERRORS"; exit 98; }
    cat "$FIXTURE_UPDATE_ARCHIVE" ;;
  *) echo "unexpected-curl:$url" >> "$FIXTURE_ERRORS"; exit 98 ;;
esac
`;

// Основан на прочитанных t/bin/pmtiles; дополнительный show-fail проверяет защиту от испорченного архива.
const pmtilesStub = String.raw`#!/usr/bin/env bash
set -eu
trap 'echo "pmtiles-fixture-error:$?" >> "$FIXTURE_ERRORS"' ERR
printf '%s\n' "$*" >> "$STUB_LOG"
cmd="$1"; shift
case "$cmd" in
  extract)
    url="$1"; out="$2"; shift 2; dry=0; z=0; main=0
    for arg in "$@"; do case "$arg" in --dry-run) dry=1 ;; --region=*.main.geojson) main=1 ;; --maxzoom=*) z="${'${'}arg#--maxzoom=}" ;; esac; done
    if [ "${'${'}STUB_FAIL:-0}" = 1 ]; then printf partial > "$out"; echo 'tls: synthetic failure' >&2; exit 1; fi
    if [ "$dry" = 1 ]; then
      if [ "$z" = 14 ]; then size="${'${'}STUB_S14:-6.8 GB}"; else size="${'${'}STUB_S15:-13 GB}"; fi
      if [ "$main" = 1 ]; then
        if [ "$z" = 14 ]; then size="${'${'}STUB_S14M:-1.5 GB}"; else size="${'${'}STUB_S15M:-3.1 GB}"; fi
      fi
      printf 'Extract transferred 9.7 GB for an archive size of %s\n' "$size" >&2
    else
      if [ "${'${'}STUB_FAIL_ONCE:-0}" = 1 ] && [ ! -f "$FIXTURE_ONCE" ]; then
        : > "$FIXTURE_ONCE"; printf partial > "$out"; exit 1
      fi
      printf 'PMTILES-stub zoom=%s\n' "$z" > "$out"
    fi ;;
  show) if [ "${'${'}STUB_SHOW_FAIL:-0}" = 1 ]; then exit 1; fi ;;
  *) echo "unexpected-pmtiles:$cmd" >> "$FIXTURE_ERRORS"; exit 98 ;;
esac
`;

const dockerStub = String.raw`#!/usr/bin/env bash
set -eu
trap 'echo "docker-fixture-error:$?" >> "$FIXTURE_ERRORS"' ERR
printf 'docker %s\n' "$*" >> "$FIXTURE_CALLS"
case "$1" in
  compose)
    shift
    while [ "${'${'}1:-}" = --profile ]; do shift 2; done
    case "$1" in
      version|pull|up|restart|logs) ;;
      ps) case "$*" in *backend*) printf 'synthetic-backend\n' ;; esac ;;
      *) echo "unexpected-compose:$*" >> "$FIXTURE_ERRORS"; exit 98 ;;
    esac ;;
  inspect)
    case "$*" in *Config.Env*) printf 'GV_VERSION=v0.9.0\n' ;; *Health*) printf 'healthy\n' ;; *) printf '0\n' ;; esac ;;
  *) echo "unexpected-docker:$*" >> "$FIXTURE_ERRORS"; exit 98 ;;
esac
`;

interface Options {
  source?: string;
  updateSource?: string;
  input?: string;
  env?: Record<string, string>;
  files?: Record<string, string>;
  args?: string[];
  update?: boolean;
  archive?: boolean;
  toolArchive?: boolean;
  noMain?: boolean;
}
interface Observation {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  values: Record<string, string>;
  calls: string[];
  pmtiles: string[];
  files: Record<string, string>;
  toolArchiveDigest?: string;
}

function run(body: string, opts: Options = {}): Observation {
  const dir = mkdtempSync(join(root, '.maps-shell-test-'));
  // Весь cleanup ограничен точным созданным каталогом, никогда корнем workspace.
  assert.ok(resolve(dir).startsWith(resolve(root) + sep));
  const put = (name: string, content: string, executable = false) => {
    const path = resolve(dir, name);
    assert.ok(path.startsWith(resolve(dir) + sep), `fixture outside task directory: ${name}`);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content);
    if (executable) chmodSync(path, 0o755);
  };
  try {
    put('deploy/maps/maps-install.sh', opts.source ?? library);
    put('update.sh', opts.updateSource ?? updater);
    put('docker-compose.yml', '# synthetic compose; docker is stubbed\n');
    put('.env', 'FOO=1\nBAR=a b\nMINIO_ACCESS_KEY=synthetic\nUSE_CADDY=0\nTAG=latest\n');
    put('builds.json', '[{"key":"20261012.pmtiles"},{"key":"20261014.pmtiles"},{"key":"20261013.pmtiles"}]');
    put('bin/curl', curlStub, true);
    put('bin/pmtiles', pmtilesStub, true);
    put('bin/docker', dockerStub, true);
    for (const command of ['git', 'wget', 'ssh', 'scp', 'pg_dump', 'psql', 'systemctl']) {
      put(`bin/${command}`, '#!/usr/bin/env bash\nprintf "forbidden-command:%s\\n" "$0" >> "$FIXTURE_ERRORS"\nexit 98\n', true);
    }
    put('bin/uname', '#!/usr/bin/env bash\nprintf "%s\\n" "${STUB_ARCH:-x86_64}"\n', true);
    put('bin/date', String.raw`#!/usr/bin/env bash
set -eu
case "$*" in '-u -d yesterday +%Y%m%d'|'-u -v-1d +%Y%m%d') printf '20261013\n' ;; *) /usr/bin/date "$@" ;; esac
`, true);
    // R243: короткий bash может закрыть stdin раньше записи Node в pipe и дать EPIPE.
    // Отдельный файл сохраняет непустой не-TTY stdin, а ответы пользователя по-прежнему идут через fd9.
    put('stdin-sentinel', 'stdin-sentinel\n');
    if (opts.input !== undefined) put('input', opts.input);
    for (const [name, content] of Object.entries(opts.files ?? {})) put(name, content);
    if (opts.noMain) {
      put('regions/index.tsv', readFileSync(join(regions, 'index.tsv'), 'utf8'));
      put('regions/FRA.geojson', readFileSync(join(regions, 'FRA.geojson'), 'utf8'));
    }
    if (opts.archive) {
      put('archive/gusvoice-synthetic/deploy/maps/maps-install.sh', opts.source ?? library);
      put('archive/gusvoice-synthetic/deploy/maps/copied.txt', 'synthetic-deploy\n');
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(GV_|MAPS_|STUB_|FIXTURE_)/.test(key)) delete env[key];
    Object.assign(env, {
      GV_MAPS_REGIONS_DIR: unix(opts.noMain ? join(dir, 'regions') : regions),
      GV_PMTILES_BIN: unix(join(dir, 'bin/pmtiles')),
      GV_MAPS_BUILDS_URL: `file://${unix(join(dir, 'builds.json'))}`,
      GV_MAPS_BUILD_BASE: 'https://example.invalid/',
      GV_MAPS_FREE_BYTES: '100000000000', GV_MAPS_RETRY_SLEEP: '0', GV_MAPS_TODAY: '20261014',
      FIXTURE_BUILDS: unix(join(dir, 'builds.json')), FIXTURE_CALLS: unix(join(dir, 'calls')),
      FIXTURE_ERRORS: unix(join(dir, 'fixture-errors')), FIXTURE_ONCE: unix(join(dir, 'once')),
      FIXTURE_TOOL_ARCHIVE: unix(join(dir, 'tool.tar.gz')), FIXTURE_UPDATE_ARCHIVE: unix(join(dir, 'update.tar.gz')),
      STUB_LOG: unix(join(dir, 'pmtiles-calls')),
      TMPDIR: unix(join(dir, 'tmp')),
      ...opts.env,
    });
    if (opts.input !== undefined) env.GV_MAPS_INPUT = unix(join(dir, 'input'));
    mkdirSync(join(dir, 'tmp'));
    const prelude = String.raw`set -u
exec < "$PWD/stdin-sentinel" || exit 97
export PATH="$PWD/bin:$PATH"
emit() { printf '\n__MAPS_RESULT__%s=%s\n' "$1" "$2"; }
` + (opts.archive ? 'tar -czf "$FIXTURE_UPDATE_ARCHIVE" -C archive gusvoice-synthetic || exit 97\n' : '')
      + (opts.toolArchive ? 'tar -czf "$FIXTURE_TOOL_ARCHIVE" -C bin pmtiles || exit 97\n' : '');
    const command = opts.update
      ? `${prelude}bash ./update.sh "$@"\nrc=$?; emit updater_rc "$rc"; exit "$rc"`
      : `${prelude}. ./deploy/maps/maps-install.sh || exit 97\n${body}\nemit completed yes`;
    const result = spawnSync(bash, ['-c', command, 'maps-test', ...(opts.args ?? [])], {
      cwd: dir, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, `shell signal: ${result.signal}\n${result.stderr}`);
    assert.equal(result.status, 0, `Bash/runner could not complete (status ${result.status}): ${result.stderr}\n${result.stdout}`);
    const files: Record<string, string> = {};
    for (const name of ['.env', 'maps/map.pmtiles', 'maps/map.pmtiles.part', 'maps/map.meta', 'maps/.declined',
      'maps/.dry.pmtiles', 'maps/.bin/pmtiles.version', 'maps/.bin/pmtiles', 'deploy/maps/copied.txt', 'fixture-errors']) {
      if (existsSync(join(dir, name))) files[name] = readFileSync(join(dir, name), 'utf8');
    }
    assert.equal(files['fixture-errors'], undefined, `IO fixture failed: ${files['fixture-errors']}`);
    assert.doesNotMatch(result.stderr, /(?:command not found|unbound variable|syntax error|No such file|Permission denied)/,
      `shell fixture failed: ${result.stderr}`);
    const values = Object.fromEntries([...result.stdout.matchAll(/__MAPS_RESULT__(\w+)=(.*)/g)].map((m) => [m[1]!, m[2]!]));
    if (!opts.update) assert.equal(values.completed, 'yes', result.stderr || result.stdout);
    else {
      assert.equal(values.updater_rc, '0', `updater must complete: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.status, 0, `updater failed: ${result.stderr}\n${result.stdout}`);
    }
    const lines = (name: string) => existsSync(join(dir, name))
      ? readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean) : [];
    const stdout = result.stdout.replace(/\x1b\[[\d;]*m/g, '');
    const stderr = result.stderr.replace(/\x1b\[[\d;]*m/g, '');
    return { status: result.status, stdout, stderr, output: stdout + stderr, values,
      files, calls: lines('calls'), pmtiles: lines('pmtiles-calls'),
      toolArchiveDigest: opts.toolArchive ? createHash('sha256').update(readFileSync(join(dir, 'tool.tar.gz'))).digest('hex') : undefined };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mutate(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `mutation anchor must be unique: ${anchor}`);
  return source.replace(anchor, replacement);
}
function counterfactual(anchor: string, replacement: string, body: string, options: Options,
  check: (o: Observation) => void, message: string, failure: { actual: unknown; expected: unknown }, source = library): void {
  check(run(body, { ...options, ...(options.update ? { updateSource: source } : { source }) }));
  const changed = mutate(source, anchor, replacement);
  const observation = run(body, { ...options, ...(options.update ? { updateSource: changed } : { source: changed }) });
  assert.throws(() => check(observation), (error: unknown) => error instanceof assert.AssertionError
    && error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual' && error.message.startsWith(message)
    && Object.is(error.actual, failure.actual) && Object.is(error.expected, failure.expected),
  `контрфакт должен падать именно на ${message}`);
}
const eq = (actual: unknown, expected: unknown, message: string) => assert.strictEqual(actual, expected, message);
const meta = (o: Observation) => Object.fromEntries((o.files['maps/map.meta'] ?? '').trim().split('\n').filter(Boolean)
  .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const dry = (o: Observation) => o.pmtiles.filter((line) => line.includes('--dry-run'));
const downloaded = (o: Observation) => o.pmtiles.filter((line) => line.startsWith('extract ') && !line.includes('--dry-run'));
const prepared = String.raw`maps_install_prepare; emit prepare_rc "$?"
emit plan "$MAPS_PLAN_READY:$MAPS_ZOOM:$MAPS_REGION_ISO3:$MAPS_BUILD:$MAPS_PART"
emit flag "$MAPS_REGION_FLAG"
`;
const applied = `${prepared}maps_apply; emit apply_rc "$?"; emit changed "$MAPS_ENV_CHANGED:$MAPS_REPLACED"`;
const boxPlan = String.raw`MAPS_BIN="$GV_PMTILES_BIN"; MAPS_PLAN_READY=1; MAPS_REGION_FLAG='--bbox=1,2,3,4'
MAPS_REGION_ISO3=custom; MAPS_REGION_NAME=rectangle; MAPS_ZOOM=14; MAPS_BUILD=20261014
mkdir -p maps
maps_apply; emit apply_rc "$?"; emit replaced "$MAPS_REPLACED"
`;
const oldMap = (build: string, part = '', country = 'DEU'): Record<string, string> => ({
  'maps/map.pmtiles': 'old-map\n',
  'maps/map.meta': `COUNTRY=${country}\nNAME=synthetic map\nZOOM=14\nBUILD=${build}\n${part ? `PART=${part}\n` : ''}`,
});

describe('R227 — настоящий maps-install.sh в изолированной коробке', { concurrency: 1 }, () => {
  it('десятичные единицы, CR и последняя строка размера разбираются точно', () => {
    // Двоичные kB и путаница MB/GB дают человеку неверную оценку диска.
    const cases = [['6.8 GB', '6800000000'], ['950 MB', '950000000'], ['1.2 kB', '1200'],
      ['13 GB', '13000000000'], ['2 TB', '2000000000000'], ['42 B', '42']];
    for (const [size, expected] of cases) {
      const o = run(`emit parsed "$(printf 'noise\\r\\narchive size of ${size}\\r\\n' | maps_parse_size)"`);
      eq(o.values.parsed, expected, `size:${size}`);
    }
    eq(run(`emit parsed "$(printf 'archive size of 1 GB\\nnoise\\narchive size of 2 GB\\n' | maps_parse_size)"`).values.parsed,
      '2000000000', 'size:last');
    eq(run(`emit parsed "$(printf 'nothing\\n' | maps_parse_size)"`).values.parsed, '', 'size:none');
  });

  it('резерв минимум 2 ГБ и 10 процентов проверяется с обеих сторон границы', () => {
    // Ровно достаточно должно пройти; на байт меньше — не занимать последний резерв сервера.
    for (const [size, need] of [[70_000_000, 2_070_000_000], [6_800_000_000, 8_800_000_000],
      [20_000_000_000, 22_000_000_000], [30_000_000_000, 33_000_000_000]]) {
      const o = run(`emit need "$(maps_need_bytes ${size})"; maps_fits ${size} ${need}; emit fit "$?";
maps_fits ${size} ${need - 1}; emit short "$?"`);
      eq(o.values.need, String(need), 'reserve:need'); eq(o.values.fit, '0', 'reserve:exact'); eq(o.values.short, '1', 'reserve:minus-one');
    }
  });

  it('живой индекс отдаёт ISO и точные имена прежде подстрок; каждому ISO3 есть контур', () => {
    // Oman/Romania и Niger/Nigeria — реальные коллизии, не выдуманный индекс.
    for (const [query, expected] of [['россия', 'RUS'], ['Россия', 'RUS'], ['ru', 'RUS'], ['RUS', 'RUS'],
      ['germany', 'DEU'], ['Oman', 'OMN'], ['oman', 'OMN'], ['Niger', 'NER'], ['xk', 'KOS'], ['zzzzz', '']]) {
      const o = run(`emit found "$(maps_find_country '${query}' "$GV_MAPS_REGIONS_DIR/index.tsv" | cut -f1 | paste -sd, -)"`);
      eq(o.values.found, expected, `country:${query}`);
    }
    const o = run('emit found "$(maps_find_country land "$GV_MAPS_REGIONS_DIR/index.tsv" | wc -l | tr -d \' \')"');
    assert.ok(Number(o.values.found) > 5);
    for (const line of readFileSync(join(regions, 'index.tsv'), 'utf8').trim().split('\n')) {
      const iso3 = line.split('\t')[1]!;
      assert.ok(existsSync(join(regions, `${iso3}.geojson`)), `outline:${iso3}`);
    }
  });

  it('четыре ответа с fd9 создают план и карту, а повтор не дублирует env и не спрашивает', () => {
    // Разные строки ответов ловят повторное открытие GV_MAPS_INPUT в каждой подстановке $(…).
    // Файловый stdin остаётся не-TTY и не расходуется диалогом: ответы читаются из отдельного fd9.
    const o = run(`${applied}\nmaps_install_prepare; emit second "$MAPS_ENV_CHANGED"\nif [ -t 0 ]; then emit stdin_tty yes; else emit stdin_tty no; fi\nIFS= read -r remainder; emit stdin "$remainder"`,
      { input: 'y\nроссия\ny\n14\n' });
    eq(o.values.plan, '1:14:RUS:20261014:', 'install:plan');
    eq(o.values.apply_rc, '0', 'install:apply'); eq(o.values.changed, '1:0', 'install:env-changed');
    eq(o.values.stdin_tty, 'no', 'install:stdin-not-tty');
    eq(o.values.stdin, 'stdin-sentinel', 'install:stdin-not-drained');
    eq(o.files['maps/map.pmtiles'], 'PMTILES-stub zoom=14\n', 'install:file');
    eq(o.files['maps/map.pmtiles.part'], undefined, 'install:no-part');
    eq(o.files['.env'], 'FOO=1\nBAR=a b\nMINIO_ACCESS_KEY=synthetic\nUSE_CADDY=0\nTAG=latest\nMAP_PMTILES_PATH=/maps/map.pmtiles\n', 'install:env');
    assert.deepEqual({ ...meta(o), INSTALLED: '<date>' }, { COUNTRY: 'RUS', NAME: 'Russia', ZOOM: '14', BUILD: '20261014', INSTALLED: '<date>' });
    assert.match(meta(o).INSTALLED!, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(o.output, /zoom 15\): 13 GB/); assert.match(o.output, /zoom 14\): 6\.8 GB/);
    eq((o.output.match(/Add the map\?/g) ?? []).length, 1, 'install:only-first-question');
    eq(dry(o).length, 2, 'install:two-dry-runs'); eq(downloaded(o).length, 1, 'install:one-download');
    assert.match(downloaded(o)[0]!, /https:\/\/example\.invalid\/20261014\.pmtiles .*map\.pmtiles\.part --region=.*RUS\.geojson --maxzoom=14$/);
    eq(o.pmtiles.filter((line) => line.startsWith('show ')).length, 1, 'install:checked-before-publish');
  });

  it('явный отказ сохраняется, пустой выбор масштаба тоже, но EOF не запускает скачивание', () => {
    // Без явного 14/15 даже согласие на диалог не разрешает многогигабайтную загрузку.
    for (const input of ['n\n', 'y\nDE\ny\n\n']) {
      const o = run(applied, { input });
      assert.ok(o.files['maps/.declined']); eq(downloaded(o).length, 0, 'decline:no-download');
      eq(o.values.plan?.split(':')[0], '0', 'decline:no-plan');
    }
    const eof = run(applied, { input: 'y\nDE\ny\n' });
    eq(downloaded(eof).length, 0, 'eof:no-download'); eq(eof.values.plan?.split(':')[0], '0', 'eof:no-plan');
    eq(eof.files['maps/.declined'], undefined, 'eof:not-explicit-decline');
  });

  it('при нехватке места только 14 доступен, а без места даже для 14 плана нет', () => {
    // Проверяем предложения в настоящем prompt, а не только вычисленные флаги FIT.
    const options = { input: 'y\nDE\ny\n\n', env: { STUB_S14: '2.7 GB', STUB_S15: '5.6 GB', GV_MAPS_FREE_BYTES: '6000000000' } };
    const o = run(prepared, options);
    assert.match(o.stderr, /14 = without/); assert.doesNotMatch(o.stderr, /15 = with/);
    assert.match(o.output, /does not fit/); eq(o.values.plan?.split(':')[0], '0', 'space:no-choice-no-plan');
    const none = run(prepared, { ...options, env: { ...options.env, GV_MAPS_FREE_BYTES: '3000000000' } });
    assert.match(none.output, /Not enough disk space/); eq(dry(none).length, 1, 'space:no-useless-z15');
    eq(none.values.plan?.split(':')[0], '0', 'space:none-no-plan');
  });

  it('ошибка замера повторяется ровно трижды, установка продолжается без фиктивного отказа', () => {
    // Сетевой сбой не является решением пользователя «нет» и не должен подавлять будущий вопрос.
    const o = run(prepared, { input: 'y\nDE\ny\n', env: { STUB_FAIL: '1' } });
    eq(o.status, 0, 'network:installer-continues'); eq(dry(o).length, 3, 'network:three-tries');
    eq(o.values.prepare_rc, '0', 'network:prepare-continues');
    eq(o.values.plan?.split(':')[0], '0', 'network:no-plan'); eq(o.files['maps/.declined'], undefined, 'network:no-decline');
    eq(o.files['maps/.dry.pmtiles'], undefined, 'network:no-dry-file');
    assert.match(o.output, /Could not measure the map/);
  });

  it('прерванная загрузка повторяется, но карта публикуется лишь после show; старую карту сбой сохраняет', () => {
    // Положительный retry и отрицательный publish важны одинаково: иначе исправная карта исчезает при обновлении.
    const retry = run(boxPlan, { env: { STUB_FAIL_ONCE: '1' } });
    eq(retry.values.apply_rc, '0', 'apply:retry-success'); eq(downloaded(retry).length, 2, 'apply:two-tries');
    eq(retry.files['maps/map.pmtiles'], 'PMTILES-stub zoom=14\n', 'apply:complete');
    eq(meta(retry).BBOX, '1,2,3,4', 'apply:bbox-meta'); eq(retry.files['maps/map.pmtiles.part'], undefined, 'apply:no-part');
    const failures: Record<string, string>[] = [{ STUB_FAIL: '1' }, { STUB_SHOW_FAIL: '1' }];
    for (const env of failures) {
      const failed = run(boxPlan, { env, files: oldMap('20260101') });
      eq(failed.values.apply_rc, '1', 'apply:failed'); eq(downloaded(failed).length, 3, 'apply:three-tries');
      eq(failed.files['maps/map.pmtiles'], 'old-map\n', 'apply:old-survives');
      eq(failed.files['maps/map.meta'], oldMap('20260101')['maps/map.meta'], 'apply:old-meta');
      eq(failed.files['maps/map.pmtiles.part'], undefined, 'apply:failed-part-removed');
      eq(failed.values.replaced, '0', 'apply:not-replaced');
    }
    const fresh = run(boxPlan, { env: { STUB_FAIL: '1' } });
    eq(fresh.values.apply_rc, '1', 'apply:fresh-failed'); eq(downloaded(fresh).length, 3, 'apply:fresh-three-tries');
    eq(fresh.files['maps/map.pmtiles'], undefined, 'apply:fresh-no-map');
    eq(fresh.files['maps/map.pmtiles.part'], undefined, 'apply:fresh-no-part');
    eq(fresh.files['maps/map.meta'], undefined, 'apply:fresh-no-meta');
    assert.doesNotMatch(fresh.files['.env']!, /^MAP_PMTILES_PATH=/m);
  });

  it('последняя дата builds выигрывает порядок JSON; отказ списка использует вчерашнюю дату', () => {
    // Fallback проверяется с deterministic date-заглушкой, а не сравнением двух одинаково ошибочных функций.
    const newest = run('maps_latest_build; emit build "$MAPS_BUILD"'); eq(newest.values.build, '20261014', 'build:newest');
    const fallback = run('maps_latest_build; emit build "$MAPS_BUILD"', { env: { STUB_BUILDS_FAIL: '1' } });
    eq(fallback.values.build, '20261013', 'build:yesterday');
    eq(fallback.calls.filter((line) => line.startsWith('curl ')).length, 3, 'build:three-tries');
    assert.match(fallback.output, /using yesterday's build \(20261013\)/);
  });

  it('неинтерактивный вход даёт ровно одну подсказку без pmtiles; отказ и ручная карта молчат', () => {
    // Отсутствие терминала не должно означать согласие на скачивание.
    const hint = run('maps_update_entry 0 0');
    eq((hint.output.match(/Own map for location sharing is available/g) ?? []).length, 1, 'entry:one-hint');
    eq(hint.pmtiles.length, 0, 'entry:no-tool'); eq(hint.calls.length, 0, 'entry:no-network');
    for (const interactive of [0, 1]) {
      const decline = run(`maps_update_entry ${interactive} 0`, { files: { 'maps/.declined': '2026-10-01\n' } });
      eq(decline.output.trim(), '__MAPS_RESULT__completed=yes', 'entry:declined-silent'); eq(decline.pmtiles.length, 0, 'entry:declined-no-tool');
    }
    const manual = run('maps_update_entry 1 0', { files: { 'maps/map.pmtiles': 'manual-synthetic-map' } });
    eq(manual.output.trim(), '__MAPS_RESULT__completed=yes', 'entry:manual-silent'); eq(manual.pmtiles.length, 0, 'entry:manual-no-tool');
    const stale = run('maps_update_entry 0 0', { files: oldMap('20260101') });
    eq((stale.output.match(/Refresh it from a terminal/g) ?? []).length, 1, 'entry:stale-one-hint');
    eq(stale.pmtiles.length, 0, 'entry:stale-no-tool');
    const forced = run('maps_update_entry 1 1; emit plan "$MAPS_PLAN_READY"', { input: 'y\nDE\ny\n14\n', files: { 'maps/.declined': 'old' } });
    eq(forced.values.plan, '1', 'entry:forced-decline-reopens');
  });

  it('возраст считает календарные дни, 30 включает вопрос, 90 включает согласие по умолчанию', () => {
    // Обе границы проверяются рядом, отдельно от давних примеров 10/50/105 дней.
    const dates = [['20261004', 10, false, '0'], ['20260915', 29, false, '0'], ['20260914', 30, true, '0'],
      ['20260825', 50, true, '0'], ['20260717', 89, true, '0'], ['20260716', 90, true, '1'], ['20260701', 105, true, '1']] as const;
    for (const [build, age, asked, plan] of dates) {
      const o = run(`emit age "$(maps_age_days ${build} 20261014)"; maps_update_entry 1 0; emit plan "$MAPS_PLAN_READY"`,
        { input: '\n', files: oldMap(build) });
      eq(o.values.age, String(age), 'age:calendar'); eq(o.output.includes('Update it?'), asked, `age:asked:${age}`);
      eq(o.values.plan, plan, `age:default:${age}`); eq(dry(o).length, asked ? 1 : 0, `age:dry:${age}`);
      if (asked) assert.match(o.stderr, age >= 90 ? /\[Y\]/ : /\[N\]/);
    }
    eq(run('emit age "$(maps_age_days 20260131 20260301)"').values.age, '29', 'age:month');
    eq(run('emit age "$(maps_age_days 20240228 20240301)"').values.age, '2', 'age:leap');
    const same = run('maps_update_entry 1 1; emit plan "$MAPS_PLAN_READY"', { input: 'y\n', files: oldMap('20261014') });
    eq(same.values.plan, '0', 'age:same-build-no-plan'); eq(dry(same).length, 0, 'age:same-build-no-dry');
    assert.doesNotMatch(same.output, /Update it\?/);
  });

  it('инструмент закреплён на 1.31.2 с обоими опубликованными хешами', () => {
    // Статическая проверка не даёт заменить release на latest или перепутать архитектуры без пересмотра pins.
    for (const [key, expected] of [
      ['MAPS_PMTILES_VERSION', '1.31.2'],
      ['MAPS_PMTILES_SHA256_X86_64', '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f'],
      ['MAPS_PMTILES_SHA256_ARM64', 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1'],
    ]) {
      const assignments = [...library.matchAll(new RegExp(`^${key}="([^"\\n]+)"$`, 'gm'))];
      eq(assignments.length, 1, `tool:unique:${key}`); eq(assignments[0]![1], expected, `tool:pin:${key}`);
    }
    assert.match(library, /releases\/download\/v\$\{MAPS_PMTILES_VERSION\}\/go-pmtiles_\$\{MAPS_PMTILES_VERSION\}_Linux_\$\{arch\}\.tar\.gz/);
  });

  it('несовпавший sha256 запрещает инструмент, совпавший synthetic-архив устанавливается и кешируется', () => {
    // Парный успех показывает, что отказ вызван digest, а не неисправной tar/curl fixture.
    for (const arch of ['x86_64', 'arm64']) {
      const rejected = run('unset GV_PMTILES_BIN; maps_get_pmtiles; emit rc "$?"', { toolArchive: true, env: { STUB_ARCH: arch } });
      eq(rejected.values.rc, '1', 'tool:mismatch-rc'); eq(rejected.files['maps/.bin/pmtiles'], undefined, 'tool:mismatch-no-binary');
      assert.match(rejected.output, /does NOT match its pinned sha256/);
      assert.match(rejected.calls[0]!, new RegExp(`v1\\.31\\.2/go-pmtiles_1\\.31\\.2_Linux_${arch}\\.tar\\.gz`));
      const accepted = run(String.raw`unset GV_PMTILES_BIN
digest="$(maps_sha256 "$FIXTURE_TOOL_ARCHIVE")"
emit digest "$digest"
MAPS_PMTILES_SHA256_X86_64="$digest"; MAPS_PMTILES_SHA256_ARM64="$digest"
maps_get_pmtiles; emit rc "$?"; emit bin "$MAPS_BIN"
maps_get_pmtiles; emit cached_rc "$?"`, { toolArchive: true, env: { STUB_ARCH: arch } });
      eq(accepted.values.rc, '0', 'tool:matched-rc'); eq(accepted.values.cached_rc, '0', 'tool:cache-rc');
      // Независимый Node hash не позволяет отсутствующему/сломанному shell hash выдать успех через два одинаковых пустых digest.
      assert.match(accepted.values.digest!, /^[a-f0-9]{64}$/);
      eq(accepted.values.digest, accepted.toolArchiveDigest, 'tool:independent-digest');
      eq(accepted.files['maps/.bin/pmtiles'], pmtilesStub, 'tool:matched-binary');
      eq(accepted.files['maps/.bin/pmtiles.version'], '1.31.2\n', 'tool:version');
      eq(accepted.calls.length, 1, 'tool:cache-no-download');
    }
  });

  it('update.sh целиком не спрашивает без терминала, при -y, --from-panel и --no-map', () => {
    // GV_MAPS_INPUT явно предоставляет терминал: -y/panel должны подавить его независимо от stdin.
    const variants: Options[] = [
      { args: ['--images-only', '--no-db-backup'] },
      { args: ['--images-only', '--no-db-backup', '-y'], input: 'y\nDE\ny\n14\n' },
      { args: ['--images-only', '--no-db-backup', '--no-map'], input: 'y\nDE\ny\n14\n' },
      { args: ['--images-only', '--no-db-backup', '--from-panel'], input: 'y\nDE\ny\n14\n',
        files: { 'run/request/update': 'v0.9.0\n', 'run/status/fixture': 'synthetic' } },
    ];
    for (const options of variants) {
      const o = run('', { ...options, update: true });
      eq(o.status, 0, 'updater:exit'); assert.doesNotMatch(o.output, /Add the map\?|Download:|Part:/);
      eq(o.pmtiles.length, 0, 'updater:no-tool'); eq(o.files['maps/map.pmtiles'], undefined, 'updater:no-download');
      assert.ok(o.calls.some((line) => line.includes(' pull')), 'stub docker must really be called');
      assert.ok(o.calls.some((line) => line.includes(' up -d --remove-orphans')), 'stub docker must apply update');
    }
  });

  it('update.sh --map переоткрывает отказ и после карты поднимает backend, --no-map выигрывает', () => {
    // Проверяется реальный разбор аргументов и перезапуск после нового MAP_PMTILES_PATH, не текстовый якорь.
    const opts: Options = { update: true, input: 'y\nDE\ny\n14\n', args: ['--images-only', '--no-db-backup', '--map'], files: { 'maps/.declined': 'synthetic-old-decline' } };
    const o = run('', opts);
    eq(o.status, 0, 'updater:map-exit'); eq(o.files['maps/map.pmtiles'], 'PMTILES-stub zoom=14\n', 'updater:map-created');
    eq(o.files['maps/.declined'], undefined, 'updater:decline-cleared');
    assert.ok(o.calls.some((line) => line.endsWith(' up -d backend')), 'backend must pick up changed env');
    const off = run('', { ...opts, args: [...opts.args!, '--no-map'] });
    eq(off.status, 0, 'updater:no-map-exit'); eq(off.pmtiles.length, 0, 'updater:no-map-tool');
    eq(off.files['maps/.declined'], 'synthetic-old-decline', 'updater:no-map-preserves');
  });

  it('полное обновление файлов копирует deploy из synthetic-архива и оставляет env', () => {
    // Если deploy забыть, свежая копия update.sh не сможет предложить карту на следующем запуске.
    const o = run('', { update: true, archive: true, args: ['--no-db-backup', '--no-map'] });
    eq(o.status, 0, 'updater:refresh-exit'); eq(o.files['deploy/maps/copied.txt'], 'synthetic-deploy\n', 'updater:deploy-copied');
    eq(o.files['.env'], 'FOO=1\nBAR=a b\nMINIO_ACCESS_KEY=synthetic\nUSE_CADDY=0\nTAG=latest\n', 'updater:env-preserved');
    assert.match(o.output, /stack files refreshed/);
  });
});

describe('R229 — выбор территории и сохранение варианта', { concurrency: 1 }, () => {
  it('большая разница FRA показывает оба размера и main скачивает именно основной контур', () => {
    // Простой флаг PART не достаточен: проверяются выбранный файл, фактический extract и metadata.
    const o = run(applied, { input: 'y\nFR\ny\n1\n14\n' });
    eq(o.values.plan, '1:14:FRA:20261014:main', 'part:main-plan');
    eq(meta(o).PART, 'main', 'part:main-meta'); eq(meta(o).NAME, 'France (main part only)', 'part:main-name');
    assert.match(o.values.flag!, /FRA\.main\.geojson$/); assert.match(downloaded(o)[0]!, /FRA\.main\.geojson --maxzoom=14$/);
    assert.match(o.output, /1 = main part only:.*3\.1 GB.*1\.5 GB/);
    assert.match(o.output, /2 = with all territories:.*13 GB.*6\.8 GB/);
    assert.match(o.stderr, /Part:/); eq(dry(o).length, 4, 'part:four-dry-runs');
  });

  it('выбор all берёт весь FRA и записывает PART=all', () => {
    // Парный вариант защищает от перепутанных обработчиков 1 и 2.
    const o = run(applied, { input: 'y\nFrance\ny\n2\n15\n' });
    eq(o.values.plan, '1:15:FRA:20261014:all', 'part:all-plan'); eq(meta(o).PART, 'all', 'part:all-meta');
    eq(meta(o).NAME, 'France', 'part:all-name'); assert.match(downloaded(o)[0]!, /FRA\.geojson --maxzoom=15$/);
    assert.doesNotMatch(downloaded(o)[0]!, /main\.geojson/);
  });

  it('непоместившийся all отвергается, main остаётся доступен; без main-fit не меряется all', () => {
    // Ввод скрытого пункта 2 не должен обойти проверку диска через ручной ответ.
    const o = run(applied, { input: 'y\nFR\ny\n2\n1\n14\n', env: { GV_MAPS_FREE_BYTES: '8000000000' } });
    assert.match(o.output, /That choice is not available/); assert.doesNotMatch(o.stderr, /Part:.*2 = with/);
    eq(o.values.plan, '1:14:FRA:20261014:main', 'part:unfit-all-refused');
    assert.match(downloaded(o)[0]!, /FRA\.main\.geojson/);
    const none = run(prepared, { input: 'y\nFR\ny\n\n', env: { GV_MAPS_FREE_BYTES: '3000000000' } });
    eq(dry(none).length, 1, 'part:none-one-dry-run'); assert.doesNotMatch(none.stderr, /Part:/);
    assert.match(none.output, /Not enough disk space/); eq(none.values.plan?.split(':')[0], '0', 'part:none-no-plan');
  });

  it('обновление сохраняет main/all, старые metadata означают all, пропавший main не подменяется', () => {
    // Сохранение контуров предотвращает неожиданную загрузку заморских территорий при очередном update.
    for (const part of ['main', 'all', '']) {
      const o = run('maps_update_entry 1 0; emit part "$MAPS_PART"; maps_apply; emit apply_rc "$?"', {
        input: '\n', files: oldMap('20260101', part, 'FRA'),
      });
      eq(o.values.part, part, `refresh:part:${part}`); eq(o.values.apply_rc, '0', 'refresh:apply');
      eq(meta(o).PART, part || undefined, 'refresh:metadata');
      for (const call of o.pmtiles.filter((line) => line.startsWith('extract '))) {
        assert.match(call, part === 'main' ? /FRA\.main\.geojson/ : /FRA\.geojson/);
      }
    }
    const missing = run('maps_update_entry 1 0; emit plan "$MAPS_PLAN_READY"', {
      input: '\n', files: oldMap('20260101', 'main', 'FRA'), noMain: true,
    });
    eq(missing.values.plan, '0', 'refresh:missing-no-plan'); eq(missing.pmtiles.length, 0, 'refresh:missing-no-tool');
    assert.match(missing.output, /outline for FRA not found/); eq(missing.files['maps/map.pmtiles'], 'old-map\n', 'refresh:missing-old-map');
  });

  it('страна без main, пропавший main и custom rectangle не задают Part и не пишут PART', () => {
    // Вопрос о территориях не должен вмешиваться в прежнюю цепочку выбора страны/прямоугольника.
    const variants: Options[] = [{ input: 'y\nDE\ny\n14\n' }, { input: 'y\nFR\ny\n14\n', noMain: true },
      { input: 'y\nbox\n1,2,3,4\n14\n' }];
    for (const options of variants) {
      const o = run(applied, options); assert.doesNotMatch(o.stderr, /Part:/);
      eq(meta(o).PART, undefined, 'part:absent-meta'); eq(dry(o).length, 2, 'part:absent-two-dry');
      eq(o.values.plan?.split(':')[0], '1', 'part:absent-plan'); eq(downloaded(o).length, 1, 'part:absent-download');
    }
  });

  it('малый довесок территорий выбирает all без PART, c меняет страну, пустой Part запоминает отказ', () => {
    // Малый extra — не скрытый ответ 2: PART не должен появиться ни в плане, ни в metadata.
    const o = run(applied, { input: 'y\nFR\ny\n14\n', env: { STUB_S14M: '2.6 GB', STUB_S15M: '5.5 GB', STUB_S14: '2.6 GB', STUB_S15: '5.6 GB' } });
    assert.doesNotMatch(o.stderr, /Part:/); assert.match(o.output, /Distant territories add only 100 MB/);
    eq(o.values.plan, '1:14:FRA:20261014:', 'part:small-no-part-plan'); eq(meta(o).PART, undefined, 'part:small-no-part-meta');
    assert.match(downloaded(o)[0]!, /FRA\.geojson --maxzoom=14$/); eq(dry(o).length, 4, 'part:small-measured-both');
    const other = run(applied, { input: 'y\nFR\ny\nc\nDE\ny\n14\n' });
    eq(other.values.plan, '1:14:DEU:20261014:', 'part:c-other-country'); eq(meta(other).PART, undefined, 'part:c-no-leak');
    const empty = run(applied, { input: 'y\nFR\ny\n\n' });
    eq(empty.values.plan?.split(':')[0], '0', 'part:empty-no-plan'); assert.ok(empty.files['maps/.declined']);
    eq(downloaded(empty).length, 0, 'part:empty-no-download');
  });

  it('порог max(10 процентов all15, 1 ГБ) строгий: равенство спрашивает, байт меньше не спрашивает', () => {
    // Для 12 GB именно all15 задаёт 1.2 GB; вторая пара активирует нижний предел 1 GB.
    const cases = [
      { all: '12 GB', main: '10.8 GB', ask: true }, { all: '12 GB', main: '10.800000001 GB', ask: false },
      { all: '5.6 GB', main: '4.6 GB', ask: true }, { all: '5.6 GB', main: '4.600000001 GB', ask: false },
    ];
    for (const { all, main, ask } of cases) {
      const o = run(applied, { input: ask ? 'y\nFR\ny\n1\n14\n' : 'y\nFR\ny\n14\n',
        env: { STUB_S14M: '2 GB', STUB_S14: '2.5 GB', STUB_S15: all, STUB_S15M: main } });
      eq(o.stderr.includes('Part:'), ask, 'part:threshold-prompt');
      eq(meta(o).PART, ask ? 'main' : undefined, 'part:threshold-meta');
      eq(o.values.plan?.split(':')[0], '1', 'part:threshold-plan');
    }
  });
});

describe('R227/R229 — original-first контрфакты полного shell-кода', { concurrency: 1 }, () => {
  it('двоичные kB обнаруживаются точным числом байтов', () => {
    // Контрфакт не должен пройти лишь потому, что вывод всё ещё похож на число.
    counterfactual('m = 1e3', 'm = 1024', `emit parsed "$(printf 'archive size of 1.2 kB\\n' | maps_parse_size)"`, {},
      (o) => eq(o.values.parsed, '1200', 'mutant:kB'), 'mutant:kB', { actual: '1229', expected: '1200' });
  });
  it('потеря последней строки и MB=GB обнаруживаются самим разбором', () => {
    // Две независимо заданные ошибки одной функции имеют отдельные original-first прогоны.
    counterfactual('tail -n 1 | awk', 'head -n 1 | awk', `emit parsed "$(printf 'archive size of 1 GB\\narchive size of 2 GB\\n' | maps_parse_size)"`, {},
      (o) => eq(o.values.parsed, '2000000000', 'mutant:last-size'), 'mutant:last-size', { actual: '1000000000', expected: '2000000000' });
    counterfactual('u == "MB") m = 1e6', 'u == "MB") m = 1e9', `emit parsed "$(printf 'archive size of 950 MB\\n' | maps_parse_size)"`, {},
      (o) => eq(o.values.parsed, '950000000', 'mutant:MB'), 'mutant:MB', { actual: '950000000000', expected: '950000000' });
  });
  it('убранные 2 ГБ и сниженные 10 процентов обнаруживаются границей резерва', () => {
    // Маленький и большой архив активируют разные стороны max, не один дублированный сценарий.
    counterfactual('if (r < 2e9) r = 2e9;', '', 'maps_fits 70000000 2069999999; emit fit "$?"', {},
      (o) => eq(o.values.fit, '1', 'mutant:reserve-floor'), 'mutant:reserve-floor', { actual: '0', expected: '1' });
    counterfactual('r = b / 10;', 'r = b / 100;', 'maps_fits 30000000000 32999999999; emit fit "$?"', {},
      (o) => eq(o.values.fit, '1', 'mutant:reserve-percent'), 'mutant:reserve-percent', { actual: '0', expected: '1' });
  });
  it('снятый приоритет точного имени и снятый ISO выявляются на настоящем индексе', () => {
    // Побочный список Romania не считается допустимым результатом точного запроса Oman.
    counterfactual('else if (ne) {', 'else if (0) {', 'emit found "$(maps_find_country oman "$GV_MAPS_REGIONS_DIR/index.tsv" | cut -f1 | paste -sd, -)"', {},
      (o) => eq(o.values.found, 'OMN', 'mutant:exact-country'), 'mutant:exact-country', { actual: 'ROU', expected: 'OMN' });
    counterfactual('iso && (($1', '0 && (($1', 'emit found "$(maps_find_country xk "$GV_MAPS_REGIONS_DIR/index.tsv" | cut -f1 | paste -sd, -)"', {},
      (o) => eq(o.values.found, 'KOS', 'mutant:iso-country'), 'mutant:iso-country', { actual: '', expected: 'KOS' });
  });
  it('повторное открытие fd9 возвращает первый ответ вместо второго', () => {
    // Ограниченные два настоящих maps_ask дают точный sink, а не бесконечный цикл выбора страны при регрессе fd9.
    counterfactual('[ "${MAPS_INPUT_OPEN:-0}" = 1 ] && return 0', ':',
      'maps_open_input; first="$(maps_ask First \'\')"; second="$(maps_ask Second \'\')"; emit answers "$first:$second"',
      { input: 'y\nроссия\n' }, (o) => eq(o.values.answers, 'y:россия', 'mutant:fd9'), 'mutant:fd9', { actual: 'y:y', expected: 'y:россия' });
  });
  it('уменьшение числа попыток и публикация без show ловятся фактическими вызовами и старой картой', () => {
    // В первом сценарии второй сетевой сбой не должен выключить третий шанс; во втором show запрещает corrupt-файл.
    counterfactual('if [ "$n" -ge 3 ]; then\n      maps_warn "The map download', 'if [ "$n" -ge 2 ]; then\n      maps_warn "The map download', boxPlan,
      { env: { STUB_FAIL: '1' } }, (o) => eq(downloaded(o).length, 3, 'mutant:download-retries'), 'mutant:download-retries', { actual: 2, expected: 3 });
    counterfactual('&& "$MAPS_BIN" show "$part" </dev/null >/dev/null 2>&1', '&& true', boxPlan,
      { env: { STUB_SHOW_FAIL: '1' }, files: oldMap('20260101') },
      (o) => eq(o.files['maps/map.pmtiles'], 'old-map\n', 'mutant:show-before-publish'), 'mutant:show-before-publish', { actual: 'PMTILES-stub zoom=14\n', expected: 'old-map\n' });
  });
  it('подмена границ 30 и 90 дней обнаруживается точным возрастом на границе', () => {
    // Проверки на 10/105 дней не ловят ошибки <→<= и >=→>.
    counterfactual('"$age" -lt "$MAPS_ASK_AFTER_DAYS"', '"$age" -le "$MAPS_ASK_AFTER_DAYS"', 'maps_update_entry 1 0',
      { input: '\n', files: oldMap('20260914') }, (o) => eq(o.output.includes('Update it?'), true, 'mutant:age30'), 'mutant:age30', { actual: false, expected: true });
    counterfactual('[ "$age" -ge "$MAPS_STALE_DAYS" ] && def=Y', '[ "$age" -gt "$MAPS_STALE_DAYS" ] && def=Y', 'maps_update_entry 1 0; emit plan "$MAPS_PLAN_READY"',
      { input: '\n', files: oldMap('20260716') }, (o) => eq(o.values.plan, '1', 'mutant:age90'), 'mutant:age90', { actual: '0', expected: '1' });
  });
  it('снятая проверка digest обнаруживается появлением запрещённого бинарника', () => {
    // Hash mismatch-путь проходит тот же настоящий tar, что успешная установка synthetic-архива.
    counterfactual('if [ "$(maps_sha256 "$tmp/pmtiles.tar.gz" 2>/dev/null)" != "$want" ]; then', 'if false; then',
      'unset GV_PMTILES_BIN; maps_get_pmtiles; emit rc "$?"', { toolArchive: true },
      (o) => eq(o.files['maps/.bin/pmtiles'], undefined, 'mutant:sha256'), 'mutant:sha256', { actual: pmtilesStub, expected: undefined });
  });
  it('опрос при -y и --from-panel обнаруживается полным update.sh', () => {
    // Оба контрфакта дают доступный GV_MAPS_INPUT, чтобы отсутствие реального tty не маскировало дефект.
    const body = '[ "$ASSUME_YES" = "0" ] && [ "$FROM_PANEL" = "0" ] && maps_can_ask';
    const check = (o: Observation) => eq(o.output.includes('Add the map?'), false, 'mutant:updater-no-ask');
    counterfactual(body, '[ "$FROM_PANEL" = "0" ] && maps_can_ask', '',
      { update: true, input: 'y\nDE\ny\n14\n', args: ['--images-only', '--no-db-backup', '-y'] }, check, 'mutant:updater-no-ask', { actual: true, expected: false }, updater);
    counterfactual(body, 'maps_can_ask', '', { update: true, input: 'y\nDE\ny\n14\n', args: ['--images-only', '--no-db-backup', '--from-panel'],
      files: { 'run/request/update': 'v0.9.0\n', 'run/status/fixture': 'synthetic' } }, check, 'mutant:updater-no-ask', { actual: true, expected: false }, updater);
  });
  it('забытый deploy выявляется отсутствующим файлом после настоящего обновления', () => {
    // Статический grep cp не доказывает, что deploy попал в установленную коробку.
    const anchor = '[ -d "$new/deploy" ] && { mkdir -p deploy; cp -Rf "$new/deploy/." deploy/ 2>/dev/null || true; }';
    counterfactual(anchor, ':', '', { update: true, archive: true, args: ['--no-db-backup', '--no-map'] },
      (o) => eq(o.files['deploy/maps/copied.txt'], 'synthetic-deploy\n', 'mutant:deploy-copy'), 'mutant:deploy-copy', { actual: undefined, expected: 'synthetic-deploy\n' }, updater);
  });
  it('перепутанные файлы main/all ловятся выполненным extract, а не именем PART', () => {
    // Замена оставляет подпись и PART правильными, ошибается только реальный контур.
    counterfactual('1) MAPS_REGION_FLAG="$main_flag"; MAPS_PART=main;', '1) MAPS_REGION_FLAG="$all_flag"; MAPS_PART=main;', applied,
      { input: 'y\nFR\ny\n1\n14\n' }, (o) => eq(/FRA\.main\.geojson/.test(downloaded(o)[0] ?? ''), true, 'mutant:main-outline'), 'mutant:main-outline', { actual: false, expected: true });
    counterfactual('MAPS_REGION_FLAG="$all_flag"; MAPS_PART=all', 'MAPS_REGION_FLAG="$main_flag"; MAPS_PART=all', applied,
      { input: 'y\nFR\ny\n2\n14\n' }, (o) => eq(/FRA\.geojson/.test(downloaded(o)[0] ?? ''), true, 'mutant:all-outline'), 'mutant:all-outline', { actual: false, expected: true });
  });
  it('потеря PART и игнорирование main при refresh выявляются metadata и вызовом pmtiles', () => {
    // Стирание PART в новом файле незаметно в первичном выборе, но ломает следующие обновления.
    counterfactual('case "$MAPS_PART" in main|all) printf \'PART=%s\\n\' "$MAPS_PART" ;; esac', ':', applied,
      { input: 'y\nFR\ny\n1\n14\n' }, (o) => eq(meta(o).PART, 'main', 'mutant:PART-meta'), 'mutant:PART-meta', { actual: undefined, expected: 'main' });
    counterfactual('MAPS_PART=main  # the variant chosen at install time', 'MAPS_PART=main; MAPS_REGION_FLAG="--region=$(maps_regions_dir)/$iso3.geojson"  # mutant',
      'maps_update_entry 1 0; maps_apply', { input: '\n', files: oldMap('20260101', 'main', 'FRA') },
      (o) => eq(/FRA\.main\.geojson/.test(downloaded(o)[0] ?? ''), true, 'mutant:PART-refresh'), 'mutant:PART-refresh', { actual: false, expected: true });
  });
  it('нестрогий порог и снятый минимум 1 ГБ обнаруживаются двумя независимыми границами', () => {
    // Ровно 10 % должен спрашиваться; 0.8 GB при 5.6 GB должен пройти без вопроса из-за нижнего 1 GB.
    counterfactual('if [ "$extra" -lt "$floor" ]; then', 'if [ "$extra" -le "$floor" ]; then', prepared,
      { input: 'y\nFR\ny\n1\n14\n', env: { STUB_S14M: '5 GB', STUB_S14: '6 GB', STUB_S15M: '10.8 GB', STUB_S15: '12 GB' } },
      (o) => eq(o.stderr.includes('Part:'), true, 'mutant:territory-equality'), 'mutant:territory-equality', { actual: false, expected: true });
    counterfactual('[ "$floor" -lt 1000000000 ] && floor=1000000000', ':', prepared,
      { input: 'y\nFR\ny\n14\n', env: { STUB_S14M: '2 GB', STUB_S14: '2.5 GB', STUB_S15M: '4.8 GB', STUB_S15: '5.6 GB' } },
      (o) => eq(o.stderr.includes('Part:'), false, 'mutant:territory-floor'), 'mutant:territory-floor', { actual: true, expected: false });
  });
});
