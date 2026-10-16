import assert from 'node:assert/strict';
import { Blob, File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as attachRules from './attachRules';

const MiB = 1024 * 1024;
const chunkBytes = 512 * 1024;
const source = readFileSync(new URL('./nativeMedia.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Fold = { size: number; parts: number; previous: number };

async function receive(text: string, bytes = 100 * MiB) {
  const folds: Fold[] = [];
  class CountingBlob extends Blob {
    constructor(parts: ConstructorParameters<typeof Blob>[0] = [], options?: ConstructorParameters<typeof Blob>[1]) {
      super(parts, options);
      folds.push({ size: this.size, parts: parts.length, previous: parts[0] instanceof Blob ? parts[0].size : 0 });
    }
  }
  const requests: { id: string; op: string }[] = [];
  const wire = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: string | ArrayBuffer) {
      assert.equal(typeof message, 'string');
      requests.push(JSON.parse(message as string));
    },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, {
    module, exports: module.exports,
    require(id: string) { assert.equal(id, './attachRules'); return attachRules; },
    window: { GusVoiceMedia: wire }, ArrayBuffer, Uint8Array, Blob: CountingBlob, File,
  });
  const api = module.exports as typeof import('./nativeMedia');
  assert.equal(api.RECEIVE_FOLD_BYTES, 32 * MiB);
  const promise = api.pickDocumentsNative();
  assert.equal(requests[0]?.op, 'docs');
  const id = requests[0]!.id;
  const send = (message: Record<string, unknown>) => wire.onmessage!({ data: JSON.stringify({ id, ...message }) });
  send({ file: 0, name: 'big.mp4', mime: 'video/mp4; codecs=avc1', size: bytes });
  for (let offset = 0, index = 0; offset < bytes; offset += chunkBytes, index++) {
    // Разные части и разные байты внутри части: перестановка, дубль и потеря хвоста не маскируются нулями.
    const part = new Uint8Array(Math.min(chunkBytes, bytes - offset));
    for (let j = 0; j < part.length; j++) part[j] = (index * 37 + j) & 255;
    send({ bin: { file: 0 } });
    wire.onmessage!({ data: part.buffer });
  }
  send({ file: 0, end: true });
  send({ done: true });
  return { result: await promise, folds };
}

async function checkBigFile(text: string) {
  const { result, folds } = await receive(text);
  assert.equal(result.files.length, 1);
  assert.equal(result.skipped.length, 0);
  const file = result.files[0]!;
  assert.equal(file.name, 'big.mp4');
  assert.equal(file.type, 'video/mp4');
  assert.equal(file.size, 100 * MiB, 'последние 4 МиБ после склейки тоже входят в File');
  assert.deepEqual(folds, [
    { size: 32 * MiB, parts: 64, previous: 0 },
    { size: 64 * MiB, parts: 65, previous: 32 * MiB },
    { size: 96 * MiB, parts: 65, previous: 64 * MiB },
  ], 'три склейки, каждая освобождает порцию 32 МиБ; хвост не вызывает лишнюю склейку');
  const actual = new Uint8Array(await file.arrayBuffer());
  // Не разворачиваем 100 МиБ в JS-массив и не создаём вторую полную копию ожидаемого файла.
  for (let offset = 0; offset < actual.length; offset++) {
    const expected = (Math.floor(offset / chunkBytes) * 37 + offset % chunkBytes) & 255;
    if (actual[offset] !== expected) assert.fail(`байт ${offset}: ${actual[offset]} вместо ${expected}`);
  }
}

function replaceOnce(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, 'мутант меняет ровно одну настоящую ветку');
  return source.replace(from, to);
}

describe('R141: большие файлы нативного моста', () => {
  it('100 МиБ по 512 КиБ собираются байт в байт с MIME и тремя склейками', async () => {
    await checkBigFile(source);
  });

  it('склейка начинается ровно на 32 МиБ, а не за байт до порога', async () => {
    const below = await receive(source, 32 * MiB - 1);
    assert.equal(below.folds.length, 0);
    assert.equal(below.result.files[0]!.size, 32 * MiB - 1);
    const exact = await receive(source, 32 * MiB);
    assert.deepEqual(exact.folds, [{ size: 32 * MiB, parts: 64, previous: 0 }]);
    assert.equal(exact.result.files[0]!.size, 32 * MiB);
    const above = await receive(source, 32 * MiB + 1);
    assert.deepEqual(above.folds, [{ size: 32 * MiB, parts: 64, previous: 0 }]);
    assert.equal(above.result.files[0]!.size, 32 * MiB + 1);
    assert.equal(new Uint8Array(await above.result.files[0]!.slice(-1).arrayBuffer())[0], (64 * 37) & 255,
      'один байт после порога сохраняется хвостом, без новой склейки');
  });

  for (const [name, from, to] of [
    ['без foldPart', 'if (p.pending >= RECEIVE_FOLD_BYTES) foldPart(p);', '/* склейка удалена */'],
    ['потерян хвост', 'new File(p.blob ? [p.blob, ...p.chunks] : p.chunks, p.name', 'new File(p.blob ? [p.blob] : p.chunks, p.name'],
    ['pending не обнулён', 'p.pending = 0;', '/* счётчик не сброшен */'],
  ] as const) {
    it(`мутант «${name}» нарушает ту же проверку большого файла после зелёного оригинала`, async () => {
      await checkBigFile(source);
      const mutant = replaceOnce(from, to);
      await assert.rejects(() => checkBigFile(mutant), assert.AssertionError);
    });
  }
});
