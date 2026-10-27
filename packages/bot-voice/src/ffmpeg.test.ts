import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as pcm from './pcm.js';
import type * as Ffmpeg from './ffmpeg.js';

const source = readFileSync(new URL('./ffmpeg.ts', import.meta.url), 'utf8');
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); return true; }
}
/** Полный модуль; единственный запуск процесса заменён закрытой границей, настоящий spawn недоступен. */
function harness(raw = source, thrown?: Error) {
  const calls: Array<{ path: string; args: string[]; options: { stdio: string[]; windowsHide: boolean; shell?: boolean } }> = [];
  const children: FakeChild[] = [];
  const spawn = (path: string, args: string[], options: typeof calls[number]['options']) => {
    calls.push({ path, args: [...args], options });
    if (thrown) throw thrown;
    const child = new FakeChild(); children.push(child); return child;
  };
  const exports = {};
  const imports: Record<string, unknown> = { 'node:child_process': { spawn }, './pcm.js': pcm };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, Buffer, Error, process: { env: {} }, require: (name: string) => {
      assert.ok(Object.hasOwn(imports, name), `ffmpeg: неописанный импорт ${name}`); return imports[name];
    } });
  return { mod: exports as typeof Ffmpeg, calls, children };
}
const prefix = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,http,https,tcp,tls,pipe'];
const suffix = ['-f', 's16le', '-ac', '2', '-ar', '48000', 'pipe:1'];
const reconnect = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
const loudnorm = 'loudnorm=I=-18:TP=-1.5:LRA=11';
for (const input of ['https://radio.invalid/a.mp3', 'HTTP://radio.invalid/live']) {
  it(`R306 ffmpeg: ${input} получает точные аргументы переподключения перед -i`, () => {
    assert.deepEqual(Array.from(harness().mod.buildFfmpegArgs(input)), [...prefix, ...reconnect, '-i', input, '-vn', ...suffix]);
  });
}
for (const input of ['/music/a b.mp3', 'C:\\music\\a.mp3', '-re.mp3', 'file:music.mp3', 'ftp://radio.invalid/a', 'https-not-url.mp3']) {
  it(`R306 ffmpeg: локальный или не-HTTP вход ${input} без HTTP-повторов`, () => {
    assert.deepEqual(Array.from(harness().mod.buildFfmpegArgs(input)), [...prefix, '-i', input.startsWith('-') ? `file:${input}` : input, '-vn', ...suffix]);
  });
}
it('R306 ffmpeg: stdin → pipe:0, даже исходный HTTPS не включает повторы', () => {
  assert.deepEqual(Array.from(harness().mod.buildFfmpegArgs('https://radio.invalid/a', { stdin: true, normalize: true })),
    [...prefix, '-i', 'pipe:0', '-vn', '-af', loudnorm, ...suffix]);
});
function normalization(raw = source) {
  const { mod } = harness(raw);
  assert.deepEqual(Array.from(mod.buildFfmpegArgs('song', { normalize: true })), [...prefix, '-i', 'song', '-vn', '-af', loudnorm, ...suffix], 'R306 ffmpeg loudnorm включён только явным флагом');
  for (const options of [{}, { normalize: false }]) assert.deepEqual(Array.from(mod.buildFfmpegArgs('song', options)), [...prefix, '-i', 'song', '-vn', ...suffix]);
}
it('R306 ffmpeg: loudnorm −18 LUFS включается флагом, отсутствие и false оставляют сигнал', () => normalization());
it('R306 ffmpeg: путь выбирается опция → FFMPEG_PATH → ffmpeg, пробелы и пустота не подменяют fallback', () => {
  const { mod } = harness();
  assert.equal(mod.resolveFfmpegPath(' C:\\Tools\\ffmpeg.exe ', { FFMPEG_PATH: 'env-ffmpeg' }), 'C:\\Tools\\ffmpeg.exe');
  assert.equal(mod.resolveFfmpegPath('  ', { FFMPEG_PATH: ' env-ffmpeg ' }), 'env-ffmpeg');
  assert.equal(mod.resolveFfmpegPath(undefined, {}), 'ffmpeg');
  assert.equal(mod.resolveFfmpegPath('', { FFMPEG_PATH: '  ' }), 'ffmpeg');
});
it('R306 ffmpeg: TailBuffer держит последние 2048 байт при одном длинном и нескольких коротких кусках', () => {
  const { mod } = harness();
  assert.equal(mod.STDERR_TAIL_BYTES, 2048);
  const single = new mod.TailBuffer();
  single.push(Buffer.alloc(7000, 65));
  assert.equal(single.toString(), 'A'.repeat(2048));
  const tail = new mod.TailBuffer();
  const chunks = [Buffer.alloc(1000, 65), Buffer.alloc(100, 66), Buffer.alloc(1000, 67), Buffer.alloc(2000, 68), Buffer.alloc(300, 69)];
  assert.equal(tail.toString(), '');
  const seen: Buffer[] = [];
  for (const chunk of chunks) {
    seen.push(chunk); tail.push(chunk);
    assert.equal(tail.toString(), Buffer.concat(seen).subarray(-2048).toString());
  }
});
function hugeThenShort(raw = source) {
  const tail = new (harness(raw).mod.TailBuffer)();
  tail.push(Buffer.alloc(7000, 65));
  tail.push(Buffer.alloc(100, 66));
  // Нельзя удалить весь первый чанк: 100 новых байт не заменяют обещанный хвост в 2 КБ.
  assert.equal(tail.toString(), `${'A'.repeat(1948)}${'B'.repeat(100)}`, 'R306 ffmpeg короткий чанк не выбрасывает нужную часть длинного');
}
it('R306 ffmpeg: 7000 A и затем 100 B сохраняют ровно 1948 A и 100 B', () => hugeThenShort());
it('R306 ffmpeg: TailBuffer сохраняет 2047 и ровно 2048 байт, на 2049 отрезает только первый', () => {
  const { mod } = harness();
  for (const size of [2047, 2048, 2049]) {
    const tail = new mod.TailBuffer();
    const bytes = Buffer.concat([Buffer.from('A'), Buffer.alloc(size - 1, 66)]);
    tail.push(bytes);
    assert.equal(tail.toString(), size <= 2048 ? `A${'B'.repeat(size - 1)}` : 'B'.repeat(2048));
  }
});
it('R306 ffmpeg: несколько чанков на границе 2048 удаляются только без потери последних байтов', () => {
  const tail = new (harness().mod.TailBuffer)();
  tail.push(Buffer.alloc(1000, 65)); tail.push(Buffer.alloc(1048, 66));
  assert.equal(tail.toString(), `${'A'.repeat(1000)}${'B'.repeat(1048)}`);
  tail.push(Buffer.from('C'));
  assert.equal(tail.toString(), `${'A'.repeat(999)}${'B'.repeat(1048)}C`);
  // Старые чанки можно убрать целиком лишь когда после них накопилось ровно limit или больше.
  tail.push(Buffer.alloc(2047, 68));
  assert.equal(tail.toString(), `C${'D'.repeat(2047)}`);
  tail.push(Buffer.from('E'));
  assert.equal(tail.toString(), `${'D'.repeat(2047)}E`);
});
it('R306 ffmpeg: TailBuffer копирует вход и соблюдает пользовательский предел', () => {
  const tail = new (harness().mod.TailBuffer)(4);
  const bytes = Buffer.from('abcdef'); tail.push(bytes); bytes.fill(0);
  assert.equal(tail.toString(), 'cdef');
  tail.push(Buffer.from('gh'));
  assert.equal(tail.toString(), 'efgh');
});
it('R306 ffmpeg: checkFfmpeg запускает только -version и принимает код 0', async () => {
  const h = harness(); const checked = h.mod.checkFfmpeg('synthetic-ffmpeg');
  assert.deepEqual(h.calls.map(c => ({ ...c, options: { ...c.options, stdio: Array.from(c.options.stdio) } })),
    [{ path: 'synthetic-ffmpeg', args: ['-version'], options: { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true } }]);
  h.children[0].emit('close', 0); await checked;
});
for (const failure of ['error', 'close', 'throw'] as const) {
  it(`R306 ffmpeg: checkFfmpeg ${failure} даёт FfmpegNotFound, ни один процесс не запускается`, async () => {
    const cause = new Error('synthetic ENOENT');
    const h = harness(source, failure === 'throw' ? cause : undefined);
    const checked = h.mod.checkFfmpeg('missing-synthetic-path');
    const rejected = assert.rejects(checked, (e: unknown) => {
      assert.ok(e instanceof h.mod.FfmpegNotFound);
      assert.match(e.message, /missing-synthetic-path/);
      if (failure !== 'close') assert.equal(e.cause, cause);
      return true;
    });
    if (failure === 'error') { h.children[0].emit('error', cause); h.children[0].emit('close', 0); }
    if (failure === 'close') h.children[0].emit('close', 1);
    await rejected;
  });
}
function spawnBoundary(raw = source) {
  const h = harness(raw);
  const input = '-input;$(synthetic-command).mp3';
  const run = h.mod.spawnFfmpeg('path with spaces/ffmpeg', input, { normalize: true });
  const call = h.calls[0];
  assert.equal(call.path, 'path with spaces/ffmpeg');
  assert.deepEqual(call.args, [...prefix, '-i', `file:${input}`, '-vn', '-af', loudnorm, ...suffix]);
  assert.notEqual(call.options.shell, true, 'R306 ffmpeg запуск не использует оболочку');
  assert.deepEqual(Array.from(call.options.stdio), ['ignore', 'pipe', 'pipe']);
  assert.equal(call.options.windowsHide, true);
  assert.equal(run.stdout, h.children[0].stdout);
  h.children[0].emit('close', 0);
  return run.exited.then(result => assert.equal(result, null));
}
it('R306 ffmpeg: опасные символы — один аргумент, без shell, скрытое окно и правильный stdout', () => spawnBoundary());
it('R306 ffmpeg: неуспешное завершение возвращает ошибку с кодом, сигналом и хвостом stderr, а не rejection', async () => {
  const h = harness(); const run = h.mod.spawnFfmpeg('fake', 'song');
  h.children[0].stderr.write(Buffer.from(`${'x'.repeat(3000)}\nlast failure\n`));
  h.children[0].emit('close', 9, 'SIGTERM');
  const result = await run.exited;
  assert.ok(result instanceof h.mod.FfmpegError);
  assert.equal(result.exitCode, 9); assert.equal(result.signal, 'SIGTERM');
  assert.equal(Buffer.byteLength(result.stderr), 2048);
  assert.ok(result.stderr.endsWith('\nlast failure\n'));
  assert.match(result.message, /signal SIGTERM: last failure$/);
});
it('R306 ffmpeg: ошибка дочернего процесса превращается в результат exited, код и сигнал неизвестны', async () => {
  const h = harness(); const run = h.mod.spawnFfmpeg('fake', 'song');
  h.children[0].stderr.write('diagnostic'); h.children[0].emit('error', new Error('synthetic spawn error'));
  const result = await run.exited;
  assert.ok(result instanceof h.mod.FfmpegError);
  assert.equal(result.exitCode, null); assert.equal(result.signal, null);
  assert.equal(result.stderr, 'synthetic spawn error\ndiagnostic');
});
it('R306 ffmpeg: поток подаётся stdin, kill отключает источник и SIGKILL не считается ошибкой', async () => {
  const h = harness(); const input = new PassThrough();
  const run = h.mod.spawnFfmpeg('fake', input);
  assert.deepEqual(Array.from(h.calls[0].options.stdio), ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(h.calls[0].args, [...prefix, '-i', 'pipe:0', '-vn', ...suffix]);
  input.write('abc');
  assert.equal(h.children[0].stdin.read()?.toString(), 'abc');
  h.children[0].stdin.emit('error', new Error('synthetic EPIPE'));
  run.kill();
  assert.equal(input.destroyed, true);
  assert.deepEqual(h.children[0].signals, ['SIGKILL']);
  h.children[0].emit('close', null, 'SIGKILL');
  assert.equal(await run.exited, null);
});
it('R306 ffmpeg: ошибка входного потока закрывает stdin, а не становится необработанным событием', async () => {
  const h = harness(); const input = new PassThrough(); const run = h.mod.spawnFfmpeg('fake', input);
  input.emit('error', new Error('synthetic input error'));
  assert.equal(h.children[0].stdin.destroyed, true);
  h.children[0].emit('close', 0); assert.equal(await run.exited, null);
});

for (const c of [
  { name: 'shell включён', needle: "{ stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true }", replacement: "{ stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, shell: true }",
    probe: spawnBoundary, message: 'R306 ffmpeg запуск не использует оболочку' },
  { name: 'loudnorm выключен', needle: "if (options.normalize) args.push('-af', LOUDNORM);", replacement: "if (false) args.push('-af', LOUDNORM);",
    probe: async (raw: string) => normalization(raw), message: 'R306 ffmpeg loudnorm включён только явным флагом' },
  { name: 'старое условие выбрасывает длинный чанк целиком',
    needle: 'while (this.chunks.length > 1 && this.size - this.chunks[0].byteLength >= this.limit)',
    replacement: 'while (this.size > this.limit * 2 && this.chunks.length > 1)',
    probe: async (raw: string) => hugeThenShort(raw), message: 'R306 ffmpeg короткий чанк не выбрасывает нужную часть длинного' },
]) it(`R306 ffmpeg контрфакт: ${c.name}, оригинал проходит первым`, async () => {
  await c.probe(source);
  assert.equal(source.split(c.needle).length - 1, 1, 'ffmpeg: точный уникальный якорь');
  await assert.rejects(async () => c.probe(source.replace(c.needle, c.replacement)), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.message.split('\n', 1)[0] === c.message);
});
