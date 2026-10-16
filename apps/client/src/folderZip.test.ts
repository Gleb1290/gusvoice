import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import ts from 'typescript';
import * as rules from './folderZipRules';
import * as attachRules from './attachRules';

type Api = typeof import('./folderZip');
type Notice = { id: string; type: string; title: string; subtitle?: string; sticky?: boolean };
const source = readFileSync(new URL('./folderZip.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source, compression: typeof CompressionStream | undefined = undefined) {
  const notices: Notice[] = [], updates: { id: string; subtitle: string }[] = [];
  let serial = 0;
  const dismiss = (id: string) => { const at = notices.findIndex(t => t.id === id); if (at >= 0) notices.splice(at, 1); };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, Blob, File, Response, TransformStream, CompressionStream: compression, Date,
    require(id: string) {
      if (id === './folderZipRules') return rules;
      if (id === './attachRules') return attachRules;
      if (id === './toast') return {
        toast(type: string, title: string, subtitle?: string, opts?: { sticky?: boolean }) {
          const id = `toast-${++serial}`; notices.push({ id, type, title, subtitle, sticky: opts?.sticky }); return id;
        },
        updateToast(id: string, patch: { subtitle: string }) { updates.push({ id, subtitle: patch.subtitle }); Object.assign(notices.find(t => t.id === id) ?? {}, patch); },
        useToasts: { getState: () => ({ toasts: notices, dismiss }) },
      };
      throw new Error(`unexpected dependency: ${id}`);
    },
  });
  return { api: module.exports as Api, notices, updates, dismiss };
}
type Runtime = ReturnType<typeof load>;
const modified = new Date(2020, 1, 3, 4, 5, 7).getTime();
function zipFile(path: string, body: BlobPart[]): rules.ZipEntry<File> {
  const file = new File(body, path.slice(path.lastIndexOf('/') + 1), { lastModified: modified });
  return { path, dir: false, size: file.size, modified, source: file };
}
const zipDir = (path: string): rules.ZipEntry<File> => ({ path, dir: true, size: 0, modified, source: null });

// Независимый читатель ZIP32: оглавление направляет к локальным записям, тела распаковывает node:zlib.
// Ни заголовки, ни CRC не пересчитываются производственными folderZipRules.
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
async function readZip(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer()), end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'ZIP завершается EOCD');
  assert.equal(bytes.readUInt16LE(end + 4), 0); assert.equal(bytes.readUInt16LE(end + 6), 0);
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count); assert.equal(bytes.readUInt16LE(end + 20), 0);
  assert.equal(centralStart + centralSize, end);
  const result: { path: string; method: number; size: number; packed: number; dir: boolean; body: Buffer }[] = [];
  let at = centralStart, localEnd = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const method = bytes.readUInt16LE(at + 10), hash = bytes.readUInt32LE(at + 16), packed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24);
    const length = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + length), path = name.toString('utf8');
    assert.equal(offset, localEnd, 'локальные записи идут подряд и смещения не теряются');
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    assert.equal(bytes.readUInt16LE(at + 8), 0x800); assert.equal(bytes.readUInt16LE(offset + 6), 0x800);
    assert.equal(bytes.readUInt16LE(offset + 8), method); assert.equal(bytes.readUInt32LE(offset + 14), hash);
    assert.equal(bytes.readUInt32LE(offset + 18), packed); assert.equal(bytes.readUInt32LE(offset + 22), size);
    assert.equal(bytes.readUInt16LE(offset + 26), length);
    assert.deepEqual(bytes.subarray(offset + 30, offset + 30 + length), name);
    const start = offset + 30 + length + bytes.readUInt16LE(offset + 28), packedBody = bytes.subarray(start, start + packed);
    assert.equal(method === 0 || method === 8, true);
    const body = method === 8 ? inflateRawSync(packedBody) : packedBody;
    assert.equal(body.length, size, 'распакованное тело имеет обещанный размер');
    assert.equal(hash, crc(body), 'CRC оглавления совпадает с независимым читателем');
    const dir = path.endsWith('/'); assert.equal(bytes.readUInt32LE(at + 38), dir ? 0x10 : 0);
    result.push({ path, method, size, packed, dir, body }); localEnd = start + packed; at += 46 + length + extra + comment;
  }
  assert.equal(at, end); assert.equal(localEnd, centralStart);
  return result;
}
const LIMIT = 1_000_000;
async function stored(runtime: Runtime) {
  const entries = [zipDir('корень/'), zipDir('корень/a/'), zipFile('корень/a/я🪶.PNG', ['123456789']), zipFile('корень/.x', ['hidden']), zipFile('корень/zero', [])];
  const progress: number[] = [], zip = await runtime.api.buildZip(entries, LIMIT, fraction => progress.push(fraction), () => false);
  assert.equal(zip.type, 'application/zip'); assert.equal(zip.size, rules.storedZipSize(entries));
  const contents = await readZip(zip);
  assert.deepEqual(contents.map(e => e.path), entries.map(e => e.path));
  assert.deepEqual(contents.map(e => e.method), [0, 0, 0, 0, 0]);
  assert.deepEqual(contents.map(e => e.body.toString()), ['', '', '123456789', 'hidden', '']);
  assert.equal(progress.at(-1), 1, 'успешная упаковка завершается 100 процентами');
  assert.equal(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1]!)), true);
  assert.equal(progress.some(p => p > 0 && p < 1), true);
}
it('R211 настоящий buildZip без CompressionStream создаёт читаемый ZIP с UTF8, папками, скрытым и пустым файлами', () => stored(load()));
it('R211 buildZip пустого набора создаёт EOCD и сообщает завершение даже без чтения тел', async () => {
  const runtime = load(), progress: number[] = [];
  const zip = await runtime.api.buildZip([], LIMIT, f => progress.push(f), () => false);
  assert.equal(zip.size, 22); assert.deepEqual(await readZip(zip), []); assert.deepEqual(progress, [1]);
});
// IO-адаптер к настоящему raw-deflate: buildZip, выбор метода, CRC и заголовки остаются производственными.
// Node 20 может не иметь CompressionStream('deflate-raw'), но все проверки сжатия выполняются и там.
const DeflateIO = class extends TransformStream<BufferSource, Uint8Array<ArrayBuffer>> {
  constructor(format: CompressionFormat) {
    assert.equal(format, 'deflate-raw', 'сборщик запрашивает именно raw-deflate без zlib-обёртки');
    const chunks: Uint8Array[] = [];
    super({
      transform(chunk) { chunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); },
      flush(controller) { controller.enqueue(new Uint8Array(deflateRawSync(Buffer.concat(chunks)))); },
    });
  }
} as typeof CompressionStream;
let rawDeflate = false;
try { new CompressionStream('deflate-raw'); rawDeflate = true; } catch { /* Есть обязательный DeflateIO выше. */ }
async function compression(runtime: Runtime) {
  const repeated = 'Гусь!'.repeat(3000), entries = [zipDir('r/'), zipFile('r/a.txt', [repeated]), zipFile('r/a.PNG', [repeated]), zipFile('r/small.txt', ['x']), zipFile('r/zero.txt', [])];
  const zip = await runtime.api.buildZip(entries, LIMIT, () => {}, () => false), contents = await readZip(zip);
  assert.equal(contents[1]!.method, 8, 'текст с выигрышем сжимается deflate'); assert.equal(contents[1]!.body.toString(), repeated);
  assert.equal(contents[2]!.method, 0, 'PNG не сжимается повторно'); assert.equal(contents[2]!.body.toString(), repeated);
  assert.equal(contents[3]!.method, 0, 'без выигрыша остаётся исходное тело'); assert.equal(contents[3]!.body.toString(), 'x');
  assert.equal(contents[4]!.method, 0); assert.equal(contents[4]!.size, 0);
  assert.equal(zip.size < rules.storedZipSize(entries), true);
}
it('R211 настоящий raw-deflate сжимает текст, PNG оставляет store, маленький файл без выигрыша тоже store', async () => {
  await compression(load(source, DeflateIO));
  if (rawDeflate) await compression(load(source, CompressionStream));
});
async function sizeBoundary(runtime: Runtime) {
  const entries = [zipDir('r/'), zipFile('r/a.PNG', ['123456789'])], limit = rules.storedZipSize(entries);
  let outcome = 'ok', size = 0;
  try { size = (await runtime.api.buildZip(entries, limit, () => {}, () => false)).size; }
  catch (e) { if (e instanceof rules.FolderZipError) outcome = e.code; else throw e; }
  assert.equal(outcome, 'ok', 'реальный ZIP ровно в предел допустим'); assert.equal(size, limit);
  let failure = 'none';
  try { await runtime.api.buildZip(entries, limit - 1, () => {}, () => false); }
  catch (e) { if (e instanceof rules.FolderZipError) { failure = e.code; assert.equal(e.bytes, limit); } else throw e; }
  assert.equal(failure, 'tooLarge', 'оглавление и EOCD тоже входят в предел');
}
it('R211 размер готового store ZIP принимает точный предел, но EOCD на байт больше предела отказывает', () => sizeBoundary(load()));
it('R211 превышение после тела файла сообщает уже записанные байты и не читает следующий файл', async () => {
  let secondRead = 0;
  const second = zipFile('r/later.PNG', ['later']);
  class CountedFile extends File { override stream() { secondRead++; return super.stream(); } }
  second.source = new CountedFile(['later'], 'later.PNG');
  const first = zipFile('r/first.PNG', ['x'.repeat(1000)]), firstWritten = 30 + Buffer.byteLength(first.path) + first.size;
  await assert.rejects(load().api.buildZip([first, second], 100, () => {}, () => false), e => e instanceof rules.FolderZipError && e.code === 'tooLarge' && e.bytes === firstWritten);
  assert.equal(secondRead, 0);
});
async function cancel(runtime: Runtime) {
  let outcome = 'resolved', progress = 0;
  try { await runtime.api.buildZip([zipFile('a.PNG', ['data'])], LIMIT, () => progress++, () => true); }
  catch (e) { if (e instanceof rules.FolderZipError) outcome = e.code; else throw e; }
  assert.equal(outcome, 'cancelled', 'отменённый архив не собирается'); assert.equal(progress, 0);
}
it('R211 отмена до чтения не собирает архив, отмена после первого файла останавливает следующий', async () => {
  const runtime = load(); await cancel(runtime);
  let cancelled = false; const fractions: number[] = [];
  await assert.rejects(runtime.api.buildZip([zipFile('a.PNG', ['a']), zipFile('b.PNG', ['bb'])], LIMIT, f => { fractions.push(f); cancelled = true; }, () => cancelled),
    e => e instanceof rules.FolderZipError && e.code === 'cancelled');
  assert.deepEqual(fractions, [1 / 3]);
});
it('R211 ошибка потока файла становится failed, читаемый файл проходит тем же путём', async () => {
  class BrokenFile extends File { override stream() { return new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.error(new Error('unreadable')); } }); } }
  const entry = zipFile('broken.PNG', ['data']); entry.source = new BrokenFile(['data'], 'broken.PNG');
  await assert.rejects(load().api.buildZip([entry], LIMIT, () => {}, () => false), e => e instanceof rules.FolderZipError && e.code === 'failed');
  assert.equal((await readZip(await load().api.buildZip([zipFile('ok.PNG', ['data'])], LIMIT, () => {}, () => false)))[0]!.body.toString(), 'data');
});

function fsFile(name: string, body = 'data', onRead = () => {}) {
  return { name, isDirectory: false, isFile: true, file(ok: (file: File) => void) { onRead(); ok(new File([body], name, { lastModified: modified })); } } as unknown as FileSystemFileEntry;
}
function fsDir(name: string, children: FileSystemEntry[], onBatch = () => {}, batchSize = 100) {
  return { name, isDirectory: true, isFile: false, createReader() {
    let cursor = 0;
    return { readEntries(ok: (entries: FileSystemEntry[]) => void) { onBatch(); const batch = children.slice(cursor, cursor + batchSize); cursor += batchSize; ok(batch); } };
  } } as unknown as FileSystemDirectoryEntry;
}
function transfer(files: File[], entries: (FileSystemEntry | null)[] = [], extra: unknown[] = []): DataTransfer {
  return { files, items: [...entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })), ...extra] } as unknown as DataTransfer;
}
it('R211 collectDrop возвращает обычные файлы синхронно, включая браузер без webkitGetAsEntry', () => {
  const runtime = load(), file = new File(['x'], 'normal.txt'), dt = transfer([file], [], [{ kind: 'file' }, { kind: 'string', webkitGetAsEntry() { throw new Error('not a file'); } }]);
  const result = runtime.api.collectDrop(dt);
  assert.equal(Array.isArray(result), true); assert.equal(result instanceof Promise, false);
  assert.equal((result as File[])[0], file); assert.equal(runtime.notices.length, 0);
  assert.deepEqual(Array.from(runtime.api.collectDrop(transfer([])) as File[]), []);
});
it('R211 collectDrop отказывает папке вместе с файлом и нескольким папкам до чтения ФС', () => {
  for (const mixed of [false, true]) {
    const runtime = load(); let reads = 0;
    const entries = mixed ? [fsDir('root', [], () => reads++), fsFile('a')] : [fsDir('one', [], () => reads++), fsDir('two', [], () => reads++)];
    const got = runtime.api.collectDrop(transfer([], entries));
    assert.equal(Array.isArray(got), true); assert.deepEqual(Array.from(got as File[]), []); assert.equal(reads, 0);
    assert.deepEqual(runtime.notices.map(t => [t.type, t.title]), [['info', rules.FOLDER_REFUSE_TEXT]]);
  }
});
it('R211 collectDrop немедленно забирает DataTransfer, пакует порции и обновляет один sticky-тост до готового File', async () => {
  const runtime = load(); let batches = 0, infos = 0;
  const root = fsDir('a/b', [fsFile('.x', 'hidden', () => infos++), fsDir('sub', [fsFile('a.PNG', '123456789', () => infos++)])], () => batches++, 1);
  const dt = transfer([], [root]), promise = runtime.api.collectDrop(dt, LIMIT);
  assert.equal(Array.isArray(promise), false); assert.equal(runtime.notices.length, 1);
  assert.equal(runtime.notices[0]!.sticky, true); assert.equal(runtime.notices[0]!.title, 'Упаковываю «a/b»…');
  // Браузер закрывает доступ к DataTransfer после drop: последующая упаковка не должна обращаться туда вновь.
  Object.defineProperties(dt, { files: { get() { throw new Error('DataTransfer files expired'); } }, items: { get() { throw new Error('DataTransfer items expired'); } } });
  const files = await promise;
  assert.equal(files.length, 1); assert.equal(files[0]!.name, 'a_b.zip'); assert.equal(files[0]!.type, 'application/zip');
  assert.deepEqual((await readZip(files[0]!)).map(e => e.path), ['a_b/', 'a_b/.x', 'a_b/sub/', 'a_b/sub/a.PNG']);
  assert.equal(batches, 3); assert.equal(infos, 2); assert.equal(runtime.notices.length, 0);
  assert.equal(runtime.updates.at(-1)?.subtitle, '100%');
  assert.equal(new Set(runtime.updates.map(t => t.id)).size, 1); assert.equal(new Set(runtime.updates.map(t => t.subtitle)).size, runtime.updates.length);
});
it('R211 закрытие тоста отменяет упаковку молча и не возвращает готовый файл', async () => {
  const runtime = load(), promise = runtime.api.collectDrop(transfer([], [fsDir('r', [fsFile('a')])]));
  runtime.dismiss(runtime.notices[0]!.id);
  const got = await promise;
  assert.equal(got.length, 0); assert.equal(runtime.notices.length, 0, 'отмена не показывает ошибку');
});
it('R211 empty, readEntries/file failure и tooLarge удаляют sticky-тост и показывают один отказ с именем', async () => {
  const badDir = { name: 'bad', isDirectory: true, createReader: () => ({ readEntries(_ok: unknown, no: (e: Error) => void) { no(new Error('denied')); } }) } as unknown as FileSystemDirectoryEntry;
  const badFile = { name: 'bad', isDirectory: false, file(_ok: unknown, no: (e: Error) => void) { no(new Error('missing')); } } as unknown as FileSystemFileEntry;
  for (const [root, limit, expected] of [
    [fsDir('empty', []), LIMIT, 'В папке «empty» нет файлов — отправлять нечего'],
    [badDir, LIMIT, 'Не удалось создать архив из папки «bad»'],
    [fsDir('files', [badFile]), LIMIT, 'Не удалось создать архив из папки «files»'],
    [fsDir('large', [fsFile('a', 'x'.repeat(attachRules.ATTACH_MAX_BYTES + 1))]), undefined, 'Папка «large» весит 25,0 МБ — больше предела 25 МБ на вложение'],
  ] as const) {
    const runtime = load(), got = await runtime.api.collectDrop(transfer([], [root]), limit);
    assert.equal(got.length, 0); assert.deepEqual(runtime.notices.map(t => [t.type, t.title, t.sticky]), [['error', expected, undefined]]);
  }
});

function change(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь whole-module мутанта сборки ZIP');
  return source.replace(anchor, replacement);
}
async function killed(anchor: string, replacement: string, scenario: (runtime: Runtime) => Promise<unknown>, prefix: string, actual: unknown, expected: unknown,
  compressionStream: typeof CompressionStream | undefined = undefined) {
  await scenario(load(source, compressionStream));
  const runtime = load(change(anchor, replacement), compressionStream);
  await assert.rejects(async () => { await scenario(runtime); }, e => e instanceof assert.AssertionError && e.message.startsWith(prefix)
    && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
}
it('R211 контрфакт подменяет CRC файла нулём и независимый читатель это обнаруживает', () => killed('crc: r.crc, packed:', 'crc: 0, packed:', stored,
  'CRC оглавления совпадает с независимым читателем', 0, 0xcbf43926));
it('R211 контрфакт не учитывает оглавление и конец архива в окончательном пределе', () => killed('if (offset > limit) throw new FolderZipError(\'tooLarge\', offset);\n  onProgress(1);', 'onProgress(1);', sizeBoundary,
  'оглавление и EOCD тоже входят в предел', 'none', 'tooLarge'));
it('R211 контрфакт теряет проверку отмены перед чтением файла', () => killed("if (isCancelled()) throw new FolderZipError('cancelled');\n      const base", 'const base', async runtime => {
  // Убиваем именно исчезнувшую раннюю проверку: папка не имеет потока, который мог бы независимо поймать отмену.
  let outcome = 'resolved';
  try { await runtime.api.buildZip([zipDir('r/')], LIMIT, () => {}, () => true); }
  catch (e) { if (e instanceof rules.FolderZipError) outcome = e.code; else throw e; }
  assert.equal(outcome, 'cancelled', 'отмена перед записью папки не игнорируется');
}, 'отмена перед записью папки не игнорируется', 'resolved', 'cancelled'));
it('R211 контрфакт повторно сжимает PNG несмотря на формат', () => killed('&& !isStoredName(e.path)', '', compression,
  'PNG не сжимается повторно', 8, 0, DeflateIO));
it('R211 контрфакт считает проигравший deflate удачным и меняет способ маленького файла', () => killed('r.packed !== null && r.packed.size < e.size', 'r.packed !== null', compression,
  'без выигрыша остаётся исходное тело', 8, 0, DeflateIO));
it('R211 контрфакт показывает ошибку при закрытии тоста отмены', () => killed("if (e.code !== 'cancelled') toast", 'if (true) toast', async runtime => {
  const promise = runtime.api.collectDrop(transfer([], [fsDir('r', [fsFile('a')])])); runtime.dismiss(runtime.notices[0]!.id);
  assert.equal((await promise).length, 0); assert.equal(runtime.notices.length, 0, 'отмена не показывает ошибку');
}, 'отмена не показывает ошибку', 1, 0));
