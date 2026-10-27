import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { it } from 'node:test';

const directory = new URL('../../../examples/bots/', import.meta.url);
const readme = readFileSync(new URL('README.md', directory), 'utf8');
function inventory(base = directory, prefix = ''): string[] {
  return readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    // Кэш Python — результат локальной проверки, не распространяемый пример.
    if (entry.name === '__pycache__' || entry.name === 'README.md') return [];
    const rel = prefix + entry.name;
    return entry.isDirectory() ? inventory(new URL(`${entry.name}/`, base), `${rel}/`) : [rel];
  }).sort();
}
function documented(files: string[], text: string) {
  for (const file of files) assert.equal(text.includes(`\`${file}\``), true, 'R307 каждый пример описан в README');
}
function safeExample(body: string) {
  // Значение при отказе не печатается: в настоящем промахе это мог бы быть случайно вставленный токен.
  assert.equal(/gvb_[A-Za-z0-9]{10,}/.test(body), false, 'R307 в примере нет зашитого токена');
  const hosts = [...body.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map(match => match[1]);
  assert.equal(hosts.every(host => /(^|\.)example\.(com|org|net)$/.test(host) || host.endsWith('.invalid')), true, 'R307 notify не привязан к конкретному инстансу');
}
it('R307 README перечисляет каждый распространяемый файл примеров, включая Docker/systemd', () => documented(inventory(), readme));
for (const name of ['notify.sh', 'notify.py']) it(`R307 ${name}: токен и адрес только из окружения, не зашиты`, () => {
  const text = readFileSync(new URL(name, directory), 'utf8'); safeExample(text);
  assert.equal(text.includes('GUSVOICE_BOT_TOKEN'), true); assert.equal(text.includes('GUSVOICE_API'), true);
});
it('R307 контрфакт: новый пример без строки в README замечается, исходный каталог проходит первым', () => {
  const files = inventory(); documented(files, readme);
  assert.throws(() => documented([...files, 'forgotten-example.ts'], readme), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.actual === false && e.expected === true && e.message.split('\n', 1)[0] === 'R307 каждый пример описан в README');
});
for (const [name, addition, marker] of [
  ['токен в тексте', `\n# gvb_${'X'.repeat(16)}\n`, 'R307 в примере нет зашитого токена'],
  ['зашитый инстанс', '\n# https://private-instance.test/api\n', 'R307 notify не привязан к конкретному инстансу'],
] as const) it(`R307 контрфакт: ${name}, исходный notify проходит первым`, () => {
  const text = readFileSync(new URL('notify.sh', directory), 'utf8'); safeExample(text);
  assert.throws(() => safeExample(text + addition), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual' && e.message.split('\n', 1)[0] === marker);
});

const build = 'node -e "require(\'fs\').rmSync(\'dist\',{recursive:true,force:true})" && tsc -p tsconfig.build.json';
const devTools = { typescript: '5.9.3', '@types/node': '20.19.43', tsx: '4.22.4' };
const releases = [
  { dir: 'bot-sdk', name: '@gusvoice/bot', dependencies: {}, devDependencies: devTools,
    peerDependencies: { '@gusvoice/bot-voice': '0.1.0' }, peerDependenciesMeta: { '@gusvoice/bot-voice': { optional: true } } },
  { dir: 'bot-voice', name: '@gusvoice/bot-voice', dependencies: { '@livekit/rtc-node': '1.1.0' },
    devDependencies: { '@gusvoice/bot': 'workspace:*', ...devTools }, peerDependencies: { '@gusvoice/bot': '0.1.0' }, peerDependenciesMeta: {} },
] as const;
type Release = typeof releases[number];
function readRelease(pkg: Release) {
  const base = new URL(`../../${pkg.dir}/`, import.meta.url);
  return { manifest: JSON.parse(readFileSync(new URL('package.json', base), 'utf8')) as Record<string, unknown>,
    readme: readFileSync(new URL('README.md', base), 'utf8'),
    tests: inventory(new URL('src/', base)).filter(file => file.endsWith('.test.ts')).map(file => `src/${file}`) };
}
function publicRelease(pkg: Release, input: ReturnType<typeof readRelease>) {
  const { manifest, readme, tests } = input;
  assert.equal(Object.hasOwn(manifest, 'private'), false, 'R314 публичный пакет не содержит private');
  assert.equal(manifest.name, pkg.name, 'R314 имя пакета не изменилось при публикации');
  assert.equal(manifest.version, '0.1.0', 'R314 снятие private не меняет версию');
  assert.equal(manifest.license, 'MIT', 'R314 оба SDK остаются MIT');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta'] as const) {
    assert.deepEqual(manifest[field] ?? {}, pkg[field], `R314 ${pkg.name}: ${field} не изменились`);
  }
  assert.deepEqual(manifest.optionalDependencies ?? {}, {}, 'R314 публикация не добавляет обязательному SDK скрытые зависимости');
  const { test, ...scripts } = manifest.scripts as Record<string, string>;
  assert.deepEqual(scripts, { build, prepack: build, typecheck: 'tsc -p tsconfig.json --noEmit' }, 'R314 сборка и типы используют прежние скрипты');
  const command = test.trim().split(/\s+/);
  assert.deepEqual(command.slice(0, 3), ['tsx', '--test', '--test-concurrency=4'], 'R314 прежний раннер и предел параллелизма сохранены');
  // Не заводим второй ручной перечень: добавление нового теста не должно ломать релизный страж.
  // Здесь проверяем состав/дубли аргументов, а не несущественный порядок файлов в test-строке.
  assert.deepEqual(command.slice(3).sort(), tests.sort(), 'R314 test по-прежнему запускает каждый файл ровно один раз');
  assert.equal(/Not published to npm yet/i.test(readme), false, 'R314 README больше не объявляет пакет неопубликованным');
}
it('R314 оба рабочих SDK публичны, без старых баннеров; имена, версия, MIT, зависимости и скрипты сохранены', () => {
  for (const pkg of releases) publicRelease(pkg, readRelease(pkg));
});
for (const pkg of releases) {
  it(`R314 ${pkg.name}: возврат private true замечается, публичный оригинал проходит первым`, () => {
    const original = readRelease(pkg); publicRelease(pkg, original);
    assert.throws(() => publicRelease(pkg, { ...original, manifest: { ...original.manifest, private: true } }), error => error instanceof assert.AssertionError
      && error.message.startsWith('R314 публичный пакет не содержит private') && error.operator === 'strictEqual'
      && error.actual === true && error.expected === false);
  });
  it(`R314 ${pkg.name}: возврат баннера замечается, README без баннера проходит первым`, () => {
    const original = readRelease(pkg); publicRelease(pkg, original);
    assert.throws(() => publicRelease(pkg, { ...original, readme: `${original.readme}\n> Not published to npm yet.\n` }), error => error instanceof assert.AssertionError
      && error.message.startsWith('R314 README больше не объявляет пакет неопубликованным') && error.operator === 'strictEqual'
      && error.actual === true && error.expected === false);
  });
}
