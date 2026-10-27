import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import ts from 'typescript';

const source = readFileSync(new URL('../../../scripts/check-bot-sdk-pack.mjs', import.meta.url), 'utf8');
const p = path.posix;
type Package = { dir: string; name: string; manifest: Record<string, any>; entries: Map<string, Buffer> };
function packages(): Package[] {
  return ['bot-sdk', 'bot-voice'].map(dir => {
    const name = dir === 'bot-sdk' ? '@gusvoice/bot' : '@gusvoice/bot-voice';
    const manifest = { name, version: '0.1.0', private: true, license: 'MIT', type: 'module', sideEffects: false,
      publishConfig: { access: 'public' }, repository: { url: 'git+https://example.invalid/sdk.git', directory: `packages/${dir}` },
      engines: { node: '>=18' }, types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      files: ['dist', 'README.md', 'LICENSE'], dependencies: {}, scripts: {} };
    return { dir, name, manifest, entries: new Map([
      ['README.md', Buffer.from('Synthetic package fixture')], ['LICENSE', Buffer.from('MIT')],
      ['dist/index.js', Buffer.from('export {};')], ['dist/index.d.ts', Buffer.from('export {};')],
    ]) };
  });
}
/** Настоящий gzip/ustar: production readTarball и checkTarball разбирают байты, а не готовую модель проверки. */
function tarball(pkg: Package): Buffer {
  const entries = new Map(pkg.entries); entries.set('package.json', Buffer.from(JSON.stringify(pkg.manifest)));
  const blocks: Buffer[] = [];
  for (const [name, body] of entries) {
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100, 'utf8'); header.write('0000644\0', 100, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function run(input = packages()) {
  const files = new Map<string, Buffer>(), writes: string[] = [], commands: { cmd: string; args: string[] }[] = [];
  const diagnostics: string[] = []; let removed = 0;
  const work = '/virtual/tmp/bot-sdk-pack-fixed';
  const within = (file: string) => assert.equal(file === work || file.startsWith(`${work}/`), true, 'R307 pack: запись только в виртуальную временную папку');
  const io = {
    existsSync: (_file: string) => false,
    mkdtempSync: (prefix: string) => { assert.equal(prefix, '/virtual/tmp/bot-sdk-pack-'); return work; },
    mkdirSync: (file: string) => { within(file); },
    writeFileSync: (file: string, data: string) => { within(file); writes.push(p.basename(file)); files.set(file, Buffer.from(data)); },
    readFileSync: (file: string) => { assert.equal(files.has(file), true, `R307 pack: описано чтение ${p.basename(file)}`); return files.get(file)!; },
    statSync: (file: string) => { assert.equal(files.has(file), true); return { size: files.get(file)!.length }; },
    readdirSync: (dir: string) => [...files.keys()].filter(file => p.dirname(file) === dir).map(file => p.basename(file)),
    rmSync: (dir: string, opts: object) => { assert.equal(dir, work); assert.deepEqual(JSON.parse(JSON.stringify(opts)), { recursive: true, force: true }); removed++; },
  };
  const spawnSync = (cmd: string, args: string[], opts: { cwd?: string }) => {
    commands.push({ cmd, args: Array.from(args) });
    if (cmd === 'pnpm' && args.join(' ') === '--version') return { status: 0, stdout: '10.0.0', stderr: '' };
    if (cmd === 'pnpm' && args[0] === 'pack') {
      assert.deepEqual(Array.from(args.slice(0, 2)), ['pack', '--pack-destination']);
      const pkg = input.find(v => opts.cwd === `/virtual/repo/packages/${v.dir}`); assert.ok(pkg, 'R307 pack: известный пакет');
      const dest = args[2]; within(dest); files.set(p.join(dest, `${pkg.dir}.tgz`), tarball(pkg));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'install') {
      assert.equal(opts.cwd, `${work}/proj`);
      for (const flag of ['--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock']) assert.equal(args.includes(flag), true);
      // Это записанная граница процесса: ни registry, ни npm, ни установка в этом тесте не существуют.
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === '/virtual/node' && (args[0] === 'smoke.mjs' || args[0] === '/virtual/typescript/bin/tsc')) {
      assert.equal(opts.cwd, `${work}/proj`); return { status: 0, stdout: 'synthetic smoke', stderr: '' };
    }
    throw new Error(`R307 pack: неописанный процесс ${cmd}`);
  };
  const imports: Record<string, unknown> = {
    'node:child_process': { spawnSync }, 'node:fs': io, 'node:os': { tmpdir: () => '/virtual/tmp' }, 'node:path': p,
    'node:module': { createRequire: (file: string) => { assert.equal(file, '/virtual/repo/packages/bot-sdk/package.json'); return { resolve: (name: string) => { assert.equal(name, 'typescript/bin/tsc'); return '/virtual/typescript/bin/tsc'; } }; } },
    'node:url': { fileURLToPath: (url: string) => new URL(url).pathname }, 'node:zlib': { gunzipSync },
  };
  const exit = {}; let code = 0;
  assert.equal(source.split('import.meta.url').length - 1, 1, 'R307 pack: уникальная граница адреса CLI');
  const executable = source.replace('import.meta.url', JSON.stringify('file:///virtual/repo/scripts/check-bot-sdk-pack.mjs'));
  try {
    runInNewContext(ts.transpileModule(executable, { compilerOptions: { allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: 'check-bot-sdk-pack.js' }).outputText,
      { exports: {}, Buffer, process: { platform: 'linux', execPath: '/virtual/node', env: { GV_PACK_TMP: '/virtual/tmp' }, exit: (status: number) => { code = status; throw exit; } },
        console: { log: () => {}, error: (text: string) => diagnostics.push(text) },
        require: (name: string) => { assert.ok(Object.hasOwn(imports, name), `R307 pack: закрытый импорт ${name}`); return imports[name]; } });
  } catch (error) { if (error !== exit) throw error; }
  assert.equal(removed, 1, 'R307 pack: виртуальная копия убрана даже при отказе');
  return { code, diagnostics: diagnostics.join('\n'), commands, writes };
}
it('R307 pack: полный CLI принимает безопасные локальные архивы и проходит только подменные install/smoke/typecheck', () => {
  const result = run(); assert.equal(result.code, 0); assert.equal(result.diagnostics, '');
  assert.equal(result.commands.filter(c => c.cmd === 'npm').length, 1);
  assert.deepEqual(result.writes, ['package.json', 'smoke.mjs', 'types.ts', 'tsconfig.json']);
});
it('R307 pack: private true и снятый private одинаково допустимы — публикация не обязанность pack', () => {
  const input = packages(); for (const pkg of input) delete pkg.manifest.private;
  assert.equal(run().code, 0); assert.equal(run(input).code, 0);
});
for (const c of [
  { name: 'исходник из files', mutate: (pkg: Package) => { pkg.manifest.files.push('src'); pkg.entries.set('src/leak.ts', Buffer.from('export {};')); }, marker: 'лишний файл в tarball: src/leak.ts' },
  { name: 'тест из files', mutate: (pkg: Package) => { pkg.entries.set('dist/leak.test.js', Buffer.from('export {};')); }, marker: 'лишний файл в tarball: dist/leak.test.js' },
  { name: 'tsconfig из files', mutate: (pkg: Package) => { pkg.entries.set('tsconfig.json', Buffer.from('{}')); }, marker: 'лишний файл в tarball: tsconfig.json' },
  { name: 'потеря деклараций', mutate: (pkg: Package) => { pkg.entries.delete('dist/index.d.ts'); }, marker: 'в tarball нет dist/index.d.ts' },
  { name: 'workspace-зависимость', mutate: (pkg: Package) => { pkg.manifest.dependencies = { sibling: 'workspace:*' }; }, marker: 'dependencies.sibling = workspace:*' },
  { name: 'postinstall у потребителя', mutate: (pkg: Package) => { pkg.manifest.scripts = { postinstall: 'synthetic-command' }; }, marker: 'скрипт postinstall исполнится' },
]) it(`R307 pack контрфакт: ${c.name}; безопасная копия проходит первой`, () => {
  assert.equal(run().code, 0);
  const input = packages(); c.mutate(input[0]); const result = run(input);
  assert.equal(result.code, 1); assert.equal(result.diagnostics.includes(c.marker), true, 'R307 pack отклонил именно изменённый контракт');
  assert.equal(result.commands.some(c => c.cmd === 'npm'), false, 'R307 pack: отказ до установки');
});
