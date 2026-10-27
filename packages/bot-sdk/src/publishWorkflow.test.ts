import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const source = readFileSync(new URL('../../../.gitea/workflows/publish-bots.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const npmStep = 'Выкладка npm', pypiStep = 'Выкладка PyPI', preflightStep = 'Версии свободны, пакеты не private';

// Статический контракт именно этого workflow, не YAML/bash-интерпретатор и не запуск публикации.
// Границы по отступам не дают принять одноимённое поле из description, комментария или run другого шага.
function block(raw: string, indent: number, key: string): string {
  const lines = raw.split('\n'), header = `${' '.repeat(indent)}${key}:`;
  const starts = lines.flatMap((line, i) => line === header ? [i] : []);
  if (starts.length !== 1) return '';
  let end = starts[0] + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].trimStart().startsWith('#') || lines[end].search(/\S/) > indent)) end++;
  return lines.slice(starts[0] + 1, end).filter(line => !line.trimStart().startsWith('#')).join('\n');
}
function keys(raw: string, indent: number): string[] {
  return [...raw.matchAll(new RegExp(`^ {${indent}}(\\S[^:\\n]*):(?:\\s|$)`, 'gm'))].map(m => m[1]);
}
function scalar(raw: string, indent: number, key: string): string {
  const matches = [...raw.matchAll(new RegExp(`^ {${indent}}${key}:\\s*([^\\n]+)$`, 'gm'))];
  return matches.length === 1 ? matches[0][1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}
function steps(raw: string) {
  const starts = [...raw.matchAll(/^ {6}- name: ([^\n]+)$/gm)];
  return starts.map((match, index) => {
    const text = raw.slice(match.index!, starts[index + 1]?.index ?? raw.length);
    const run = /^ {8}run: (.*)$/m.exec(text);
    const script = run?.[1] === '|'
      ? text.slice(run.index + run[0].length).split('\n').filter(line => line.startsWith('          ') && !line.trimStart().startsWith('#')).map(line => line.slice(10)).join('\n')
      : run?.[1] ?? '';
    return { name: match[1], text, script, index: match.index! };
  });
}
function step(raw: string, name: string) {
  const found = steps(raw).filter(s => s.name.startsWith(name));
  return found.length === 1 ? found[0] : undefined;
}
const script = (raw: string, name: string) => step(raw, name)?.script ?? '';

// Только статическое выделение простых команд: разделители внутри строк не означают новую команду.
// Это ловит `set -eu; set -x` и `if ...; then echo ...`, не принимая echo "npm publish ..." за publish.
function commands(line: string): string[] {
  const parts: string[] = []; let quote = '', start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) { parts.push(line.slice(start, i)); return parts; }
    if (/[;|&]/.test(c)) { parts.push(line.slice(start, i)); start = i + 1; }
  }
  parts.push(line.slice(start)); return parts;
}
function command(part: string) {
  const plain = part.trim().replace(/^(?:(?:then|do)\s+|\(\s*)+/, '').replace(/^env\s+(?:[A-Za-z_]\w*=[^\s]+\s+)*/, '');
  const match = /^([A-Za-z_][\w-]*)\s+(.*)$/.exec(plain);
  return match ? { name: match[1], args: match[2] } : undefined;
}
const publishes = (raw: string) => raw.split('\n').flatMap(commands).flatMap(part => {
  const c = command(part); return c?.name === 'npm' && /^publish\s/.test(c.args) ? [`npm ${c.args}`] : [];
});

// В одинарных кавычках ${NPM_TOKEN} — литерал для npmrc, а не значение секрета.
// Ошибки с названием отсутствующего секрета тоже разрешены. Подстановки в echo/printf — нет.
function expansions(line: string): string {
  let quote = '', out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") { if (c === "'") quote = ''; out += ' '; continue; }
    if (c === '\\') { out += '  '; i++; continue; }
    if (c === '"') { quote = quote === '"' ? '' : '"'; out += c; continue; }
    if (c === "'" && !quote) { quote = c; out += ' '; continue; }
    if (c === '#' && !quote && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out;
}

const guards = {
  dispatch: {
    marker: 'R311 ручной запуск: on содержит только workflow_dispatch',
    valid: (raw: string) => JSON.stringify(keys(block(raw, 0, 'on'), 2)) === '["workflow_dispatch"]',
  },
  inputs: {
    marker: 'R311 входы: target и dry_run объявлены внутри workflow_dispatch',
    valid: (raw: string) => {
      const inputs = block(block(block(raw, 0, 'on'), 2, 'workflow_dispatch'), 4, 'inputs');
      return JSON.stringify(keys(inputs, 6).sort()) === '["dry_run","target"]'
        && scalar(block(inputs, 6, 'target'), 8, 'type') === 'choice'
        && scalar(block(inputs, 6, 'target'), 8, 'options') === '[npm, pypi, both]'
        && scalar(block(inputs, 6, 'dry_run'), 8, 'type') === 'boolean';
    },
  },
  defaultDry: {
    marker: 'R311 безопасный default: dry_run по умолчанию true',
    valid: (raw: string) => scalar(block(block(block(block(raw, 0, 'on'), 2, 'workflow_dispatch'), 4, 'inputs'), 6, 'dry_run'), 8, 'default') === 'true',
  },
  tracing: {
    marker: 'R311 без трассировки: исполняемые set не включают xtrace',
    valid: (raw: string) => steps(raw).every(s => s.script.split('\n').flatMap(commands).every(part => {
      const c = command(part);
      return c?.name !== 'set' || !/(?:^|\s)(?:-[a-zA-Z]*x[a-zA-Z]*\b|-o\s+xtrace\b)/.test(c.args.replace(/['"]/g, ''));
    })),
  },
  tokens: {
    marker: 'R311 секреты: echo и printf не раскрывают NPM_TOKEN или PYPI_TOKEN',
    valid: (raw: string) => steps(raw).every(s => s.script.split('\n').flatMap(commands).every(part => {
      const c = command(part);
      if (!c || !['echo', 'printf'].includes(c.name)) return true;
      // Gitea раскрывает secrets ДО shell: одинарные кавычки защищают $TOKEN, но не ${{ secrets.TOKEN }}.
      return !/\$\{\{\s*secrets\.(?:NPM_TOKEN|PYPI_TOKEN)\b/.test(c.args)
        && !/\$(?:\{(?:NPM_TOKEN|PYPI_TOKEN)\b|(?:NPM_TOKEN|PYPI_TOKEN)\b)/.test(expansions(c.args));
    })),
  },
  versions: {
    marker: 'R311 версии: инструменты и Node закреплены без latest и caret',
    valid: (raw: string) => {
      const env = block(raw, 0, 'env'), node = step(raw, 'Setup Node');
      return ['PY_BUILD_VERSION', 'PY_TWINE_VERSION'].every(name => /^\d+\.\d+\.\d+$/.test(scalar(env, 2, name)))
        && /^\d+\.\d+\.\d+$/.test(scalar(node?.text ?? '', 10, 'node-version'))
        && steps(raw).every(s => !/^ {8}uses:\s*[^\n]*@(?:latest|\^)/m.test(s.text));
    },
  },
  pythonPins: {
    marker: 'R311 PyPI зависимости: pip устанавливает build и twine только через ==',
    valid: (raw: string) => {
      const installs = script(raw, pypiStep).split('\n').filter(line => / -m pip install /.test(line));
      return installs.length === 1 && /"build==\$PY_BUILD_VERSION"\s+"twine==\$PY_TWINE_VERSION"\s*$/.test(installs[0]);
    },
  },
  publicAccess: {
    marker: 'R311 npm доступ: обе настоящие команды publish имеют --access public',
    valid: (raw: string) => {
      const all = steps(raw).flatMap(s => publishes(s.script));
      return all.length === 2 && all.every(command => / --access public(?:\s|$)/.test(command));
    },
  },
  npmDry: {
    marker: 'R311 npm dry_run: только false публикует, else содержит настоящий --dry-run',
    valid: (raw: string) => {
      const s = step(raw, npmStep), branch = /^\s*if \[ "\$DRY" = "false" \]; then\n([\s\S]*?)^\s*else\n([\s\S]*?)^\s*fi\s*$/m.exec(s?.script ?? '');
      const live = publishes(branch?.[1] ?? ''), dry = publishes(branch?.[2] ?? '');
      const publishing = steps(raw).filter(s => publishes(s.script).length > 0);
      return scalar(s?.text ?? '', 10, 'DRY') === '${{ github.event.inputs.dry_run }}'
        && publishing.length === 1 && publishing[0].index === s?.index
        && live.length === 1 && !/ --dry-run(?:\s|$)/.test(live[0])
        && dry.length === 1 && / --dry-run(?:\s|$)/.test(dry[0]);
    },
  },
  pypiDry: {
    marker: 'R311 PyPI dry_run: ранний exit 0 расположен до twine upload',
    valid: (raw: string) => {
      const s = step(raw, pypiStep), body = s?.script ?? '';
      const dry = /^if \[ "\$DRY" != "false" \]; then\n((?:[ \t]+[^\n]*\n)*)fi$/m.exec(body);
      const upload = /^TWINE_USERNAME=[^\n]*"\$WORK\/venv\/bin\/twine" upload /m.exec(body);
      return scalar(s?.text ?? '', 10, 'DRY') === '${{ github.event.inputs.dry_run }}'
        && !!dry && /^\s+exit 0$/m.test(dry[1]) && !!upload && dry.index < upload.index;
    },
  },
  packageOrder: {
    marker: 'R311 порядок npm: bot-sdk идёт перед bot-voice в цикле настоящей публикации',
    valid: (raw: string) => {
      const loops = [...script(raw, npmStep).matchAll(/^for DIR in ([^\n;]+); do\n([\s\S]*?)^done$/gm)];
      const publishing = loops.filter(loop => publishes(loop[2]).length > 0);
      return publishing.length === 1 && publishing[0][1] === 'packages/bot-sdk packages/bot-voice';
    },
  },
  preflight: {
    marker: 'R311 предполёт: завершает шаг с FAIL до обеих выкладок',
    valid: (raw: string) => {
      const check = step(raw, preflightStep), npm = step(raw, npmStep), pypi = step(raw, pypiStep);
      const firstPublish = steps(raw).find(s => publishes(s.script).length > 0 || /^TWINE_USERNAME=.*\btwine" upload /m.test(s.script));
      return !!check && !!npm && !!pypi && !!firstPublish && check.index < firstPublish.index
        && check.index < npm.index && check.index < pypi.index
        && /^FAIL=0$/m.test(check.script) && /\nexit "\$FAIL"\s*$/.test(check.script)
        && scalar(check.text, 10, 'TARGET') === '${{ github.event.inputs.target }}';
    },
  },
  private: {
    marker: 'R311 private: проверяются оба пакета, отказ ставит FAIL и пропускает пакет',
    valid: (raw: string) => {
      const body = script(raw, preflightStep);
      return /^\s*for DIR in packages\/bot-sdk packages\/bot-voice; do$/m.test(body)
        && /^\s*PRIV=\$\(node -p "String\(require\('\.\/\$DIR\/package.json'\)\.private === true\)"\)$/m.test(body)
        && /^\s*if \[ "\$PRIV" = "true" \]; then\n(?:[^\n]*\n)*?\s*FAIL=1\n\s*continue\n\s*fi$/m.test(body);
    },
  },
  npmExisting: {
    marker: 'R311 версия npm: занятая версия и ошибка реестра не считаются свободной',
    valid: (raw: string) => {
      const body = script(raw, preflightStep);
      return /^\s*OUT=\$\(npm view "\$NAME@\$VER" version --registry "\$NPM_REGISTRY_URL" 2>&1\) && RC=0 \|\| RC=\$\?$/m.test(body)
        && /^\s*if \[ "\$RC" -eq 0 \] && \[ -n "\$OUT" \]; then\n[^\n]*\n\s*FAIL=1\n\s*elif \[ "\$RC" -eq 0 \] \|\| echo "\$OUT" \| grep -q "E404"; then\n[^\n]*\n\s*else\n[^\n]*\n\s*FAIL=1\n\s*fi$/m.test(body);
    },
  },
  pypiExisting: {
    marker: 'R311 версия PyPI: 200 занят, только 404 свободен, прочие ошибки останавливают',
    valid: (raw: string) => {
      const body = script(raw, preflightStep);
      return /^\s*CODE=\$\(curl [^\n]*"https:\/\/pypi.org\/pypi\/gusvoice-bot\/\$PYVER\/json" \|\| echo 000\)$/m.test(body)
        && /^\s*if \[ "\$CODE" = "200" \]; then\n[^\n]*\n\s*FAIL=1\n\s*elif \[ "\$CODE" = "404" \]; then\n[^\n]*\n\s*else\n[^\n]*\n\s*FAIL=1\n\s*fi$/m.test(body);
    },
  },
  twineUser: {
    marker: 'R311 PyPI вход: настоящая команда upload использует TWINE_USERNAME=__token__',
    valid: (raw: string) => /^TWINE_USERNAME=__token__ TWINE_PASSWORD="\$PYPI_TOKEN" "\$WORK\/venv\/bin\/twine" upload --non-interactive /m.test(script(raw, pypiStep)),
  },
};
type Guard = keyof typeof guards;
function check(name: Guard, raw: string) { assert.equal(guards[name].valid(raw), true, guards[name].marker); }
function replace(raw: string, from: string, to: string): string {
  assert.equal(raw.split(from).length - 1, 1, 'R311 контрфакт: единственный точный якорь');
  return raw.replace(from, to);
}
function inStep(raw: string, name: string, from: string, to: string): string {
  const s = step(raw, name); assert.ok(s, 'R311 контрфакт: выбран настоящий шаг');
  return replace(raw, s.text, replace(s.text, from, to));
}
const change = (from: string, to: string) => (raw: string) => replace(raw, from, to);
const changeStep = (name: string, from: string, to: string) => (raw: string) => inStep(raw, name, from, to);
const loop = 'for DIR in packages/bot-sdk packages/bot-voice; do';
const livePublish = 'npm publish "$TGZ" --access public --userconfig "$WORK/npmrc" --registry "$NPM_REGISTRY_URL"';
const dryPublish = 'npm publish "$TGZ" --access public --dry-run --userconfig "$WORK/npmrc" --registry "$NPM_REGISTRY_URL"';
const buildVersion = scalar(block(source, 0, 'env'), 2, 'PY_BUILD_VERSION');
const twineVersion = scalar(block(source, 0, 'env'), 2, 'PY_TWINE_VERSION');
const nodeVersion = scalar(step(source, 'Setup Node')?.text ?? '', 10, 'node-version');
const cases: { name: string; guard: Guard; mutate: (raw: string) => string }[] = [
  { name: 'push не превращает ручную выкладку в автоматическую', guard: 'dispatch', mutate: change('on:\n', 'on:\n  push:\n') },
  { name: 'отсутствие workflow_dispatch не заменяется упоминанием в комментарии', guard: 'dispatch', mutate: change('  workflow_dispatch:\n', '  pull_request:\n') },
  { name: 'потеря target не скрывается одноимённым env шага', guard: 'inputs', mutate: change('      target:\n', '      destination:\n') },
  { name: 'потеря dry_run не скрывается description и run-name', guard: 'inputs', mutate: change('      dry_run:\n', '      preview:\n') },
  { name: 'default false не отправляет пакеты по неосторожному клику', guard: 'defaultDry', mutate: change('        default: true\n', '        default: false\n') },
  { name: 'set -x раскрывает команды вместе с секретами', guard: 'tracing', mutate: changeStep(npmStep, '          set -eu\n', '          set -eux\n') },
  { name: 'set -o xtrace не обходит запрет короткого флага', guard: 'tracing', mutate: changeStep(pypiStep, '          set -eu\n', '          set -eu\n          set -o xtrace\n') },
  { name: 'отдельный аргумент -x не скрывается после -e', guard: 'tracing', mutate: changeStep(npmStep, '          set -eu\n', '          set -e -x\n') },
  { name: 'вторая команда set на строке тоже не включает трассировку', guard: 'tracing', mutate: changeStep(npmStep, '          set -eu\n', '          set -eu; set -x\n') },
  { name: 'echo с раскрытием npm-токена отклоняется', guard: 'tokens', mutate: changeStep(npmStep, '          chmod 600', '          echo "$NPM_TOKEN"\n          chmod 600') },
  { name: 'printf с раскрытием PyPI-токена отклоняется', guard: 'tokens', mutate: changeStep(pypiStep, '          WORK=$(mktemp -d)', '          printf "%s\\n" "${PYPI_TOKEN}"\n          WORK=$(mktemp -d)') },
  { name: 'одинарные кавычки не защищают от ранней подстановки секрета Gitea', guard: 'tokens', mutate: changeStep(npmStep, '          chmod 600', "          echo '${{ secrets.NPM_TOKEN }}'\n          chmod 600") },
  { name: 'echo после then тоже не раскрывает токен', guard: 'tokens', mutate: changeStep(npmStep, '          chmod 600', '          if true; then echo "$NPM_TOKEN"; fi\n          chmod 600') },
  { name: 'env перед printf не скрывает вывод токена', guard: 'tokens', mutate: changeStep(pypiStep, '          WORK=$(mktemp -d)', '          env CHECK=1 printf "%s" "$PYPI_TOKEN"\n          WORK=$(mktemp -d)') },
  { name: 'двойные кавычки вместо литерала npmrc больше не безопасны', guard: 'tokens', mutate: change("'//registry.npmjs.org/:_authToken=${NPM_TOKEN}'", '"//registry.npmjs.org/:_authToken=${NPM_TOKEN}"') },
  { name: 'latest не подменяет точную версию build', guard: 'versions', mutate: change(`PY_BUILD_VERSION: '${buildVersion}'`, "PY_BUILD_VERSION: 'latest'") },
  { name: 'caret не подменяет точную версию twine', guard: 'versions', mutate: change(`PY_TWINE_VERSION: '${twineVersion}'`, `PY_TWINE_VERSION: '^${twineVersion}'`) },
  { name: 'Node latest не меняет окружение без явного обновления', guard: 'versions', mutate: change(`node-version: ${nodeVersion}`, 'node-version: latest') },
  { name: 'actions latest не меняет исполняемый шаг незаметно', guard: 'versions', mutate: change('uses: actions/checkout@v4', 'uses: actions/checkout@latest') },
  { name: 'build >= не выдаётся за точное закрепление', guard: 'pythonPins', mutate: change('build==$PY_BUILD_VERSION', 'build>=$PY_BUILD_VERSION') },
  { name: 'twine >= не выдаётся за точное закрепление', guard: 'pythonPins', mutate: change('twine==$PY_TWINE_VERSION', 'twine>=$PY_TWINE_VERSION') },
  { name: 'боевой npm publish не теряет публичный доступ', guard: 'publicAccess', mutate: change(livePublish, livePublish.replace(' --access public', '')) },
  { name: 'пробный npm publish проверяет тот же публичный доступ', guard: 'publicAccess', mutate: change(dryPublish, dryPublish.replace(' --access public', '')) },
  { name: 'удаление настоящего --dry-run не маскируется оставшимся echo', guard: 'npmDry', mutate: change(dryPublish, dryPublish.replace(' --dry-run', '')) },
  { name: 'перевёрнутое условие не делает dry_run боевым', guard: 'npmDry', mutate: changeStep(npmStep, 'if [ "$DRY" = "false" ]; then', 'if [ "$DRY" != "false" ]; then') },
  { name: 'лишний publish в другом шаге не обходит единый dry_run', guard: 'npmDry', mutate: raw => `${raw}\n      - name: Лишняя выкладка\n        run: npm publish extra.tgz --access public\n` },
  { name: 'лишний publish в другом шаге не обходит --access public', guard: 'publicAccess', mutate: raw => `${raw}\n      - name: Лишняя выкладка\n        run: npm publish extra.tgz\n` },
  { name: 'PyPI dry_run останавливается, даже если upload ниже существует', guard: 'pypiDry', mutate: changeStep(pypiStep, '            exit 0\n', '            :\n') },
  { name: 'порядок настоящего цикла публикации не подменяется правильным циклом упаковки', guard: 'packageOrder', mutate: changeStep(npmStep, `${loop}\n            TGZ=`, 'for DIR in packages/bot-voice packages/bot-sdk; do\n            TGZ=') },
  { name: 'удалённый предполёт не заменяется его описанием', guard: 'preflight', mutate: raw => { const s = step(raw, preflightStep); assert.ok(s); return replace(raw, s.text, ''); } },
  { name: 'предполёт после npm publish уже не предотвращает половинную выкладку', guard: 'preflight', mutate: raw => { const s = step(raw, preflightStep); assert.ok(s); return `${replace(raw, s.text, '')}\n${s.text}`; } },
  { name: 'проверка private без отказа не защищает пакет', guard: 'private', mutate: changeStep(preflightStep, '              if [ "$PRIV" = "true" ]; then', '              if [ "$PRIV" = "false" ]; then') },
  { name: 'прочитанный, но не проверенный private не считается предполётом', guard: 'private', mutate: raw => {
    const s = step(raw, preflightStep); assert.ok(s);
    const privateBlock = /^              if \[ "\$PRIV" = "true" \]; then\n[\s\S]*?^              fi\n/m.exec(s.text); assert.ok(privateBlock);
    return inStep(raw, preflightStep, privateBlock[0], '');
  } },
  { name: 'найденная версия npm должна остановить выкладку', guard: 'npmExisting', mutate: changeStep(preflightStep, '              if [ "$RC" -eq 0 ] && [ -n "$OUT" ]; then', '              if [ "$RC" -eq 1 ] && [ -n "$OUT" ]; then') },
  { name: 'найденная версия PyPI должна остановить выкладку', guard: 'pypiExisting', mutate: changeStep(preflightStep, '              if [ "$CODE" = "200" ]; then', '              if [ "$CODE" = "201" ]; then') },
  { name: 'exit 0 не глотает накопленный FAIL предполёта', guard: 'preflight', mutate: changeStep(preflightStep, '          exit "$FAIL"', '          exit 0') },
  { name: 'имя аккаунта вместо __token__ не подходит токену PyPI', guard: 'twineUser', mutate: change('TWINE_USERNAME=__token__', 'TWINE_USERNAME=publisher') },
];
for (const c of cases) it(`R311 ${c.name}; исходный workflow проходит первым`, () => {
  check(c.guard, source);
  const mutant = c.mutate(source);
  assert.throws(() => check(c.guard, mutant), error => error instanceof assert.AssertionError
    && error.message.startsWith(guards[c.guard].marker) && error.operator === 'strictEqual' && error.actual === false && error.expected === true,
  'R311 изменённый контракт падает адресно, не на разборе или якоре');
});

it('R311 комментарии с опасными примерами не исполняются; буквальный npmrc и названия секретов разрешены', () => {
  const commented = source.replace(/          set -eu\n/g, '          # set -x; echo "$NPM_TOKEN"; printf "%s" "$PYPI_TOKEN"\n          set -eu\n');
  for (const name of Object.keys(guards) as Guard[]) check(name, commented);
});
it('R311 явное обновление точных версий не требует ослаблять страж', () => {
  const next = (version: string) => version.replace(/\d+$/, patch => String(Number(patch) + 1));
  const updated = replace(replace(source, `PY_BUILD_VERSION: '${buildVersion}'`, `PY_BUILD_VERSION: '${next(buildVersion)}'`),
    `PY_TWINE_VERSION: '${twineVersion}'`, `PY_TWINE_VERSION: '${next(twineVersion)}'`);
  for (const name of Object.keys(guards) as Guard[]) check(name, updated);
});
