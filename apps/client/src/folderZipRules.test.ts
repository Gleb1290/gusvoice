import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './folderZipRules';

type Api = typeof rules;
type Info = rules.FileInfo;
const source = readFileSync(new URL('./folderZipRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source): Api {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, TextEncoder, Uint8Array, Uint32Array, DataView, Date, Set });
  return module.exports as Api;
}
function change(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь whole-module мутанта ZIP');
  return source.replace(anchor, replacement);
}
async function killed(anchor: string, replacement: string, scenario: (api: Api) => unknown | Promise<unknown>,
  prefix: string, actual: unknown, expected: unknown) {
  await scenario(load()); // Тот же загрузчик и сценарий сначала должны пройти на оригинале.
  const mutant = load(change(anchor, replacement));
  await assert.rejects(async () => { await scenario(mutant); }, e => e instanceof assert.AssertionError
    && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected);
}
function file(name: string, size = 0, lastModified = 1234, onRead = () => {}): rules.FsFileNode<Info> {
  const info = { size, lastModified };
  return { kind: 'file', name, async file() { onRead(); return info; } };
}
function dir(name: string, children: rules.FsNode<Info>[] = [], batchSize = 100, onRead = () => {}): rules.FsDirNode<Info> {
  let cursor = 0;
  return { kind: 'dir', name, async readBatch() { onRead(); const batch = children.slice(cursor, cursor + batchSize); cursor += batchSize; return batch; } };
}
function code(api: Api, expected: rules.FolderZipErrorCode) {
  return (e: unknown) => e instanceof api.FolderZipError && e.code === expected;
}
const LIMIT = Number.MAX_SAFE_INTEGER;

it('R211 бросок без папок остаётся списком файлов, одна папка без соседей становится архивом', () => {
  for (const [dirs, others, plan] of [[0, 0, 'files'], [0, 9, 'files'], [1, 0, 'folder'], [1, 1, 'refuse'], [2, 0, 'refuse'], [2, 3, 'refuse']] as const)
    assert.equal(rules.planDrop(dirs, others), plan);
});
it('R211 имя папки теряет разделители и управляющие символы, но сохраняет кириллицу и пробелы внутри', () => {
  assert.equal(rules.safeName('  a/b\\c\u0000\u001f\u007f  '), 'a_b_c___');
  assert.equal(rules.safeName('  корень с пробелом  '), 'корень с пробелом');
  assert.equal(rules.zipFileName('a/b'), 'a_b.zip');
  for (const name of ['', '   ', '.', '..']) { assert.equal(rules.safeName(name), 'Archive'); assert.equal(rules.zipFileName(name), 'Archive.zip'); }
});
it('R211 имя архива ровно в 150 кодовых точек проходит, длинное усекается без разрыва суррогатной пары', () => {
  assert.equal(rules.zipFileName('a'.repeat(146)), `${'a'.repeat(146)}.zip`);
  assert.equal(rules.zipFileName('a'.repeat(147)), `${'a'.repeat(146)}.zip`);
  const name = rules.zipFileName(`${'я'.repeat(145)}🪶лишнее`);
  assert.equal(name, `${'я'.repeat(145)}🪶.zip`);
  assert.equal(Array.from(name).length, 150);
  assert.equal(rules.zipFileName('🪶'.repeat(147)), `${'🪶'.repeat(146)}.zip`);
});
it('R211 длина UTF8 совпадает с Node на ASCII, кириллице, эмодзи и одиночных суррогатах', () => {
  // Заголовки ZIP считают байты UTF8, не UTF16: ошибка сдвигает всю следующую запись.
  for (const text of ['', 'abc', 'é', 'я', '€', '🪶', '\ud800', '\udc00', '\ud800\udc00\ud800', 'корень/🪶.txt'])
    assert.equal(rules.utf8Length(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
});
it('R211 уже сжатые расширения нечувствительны к регистру и берутся только из последнего сегмента пути', () => {
  for (const name of ['a.PNG', 'a.tar.gz', 'корень/movie.WEBM', 'a.zip', 'dir.zip/readme.png']) assert.equal(rules.isStoredName(name), true, name);
  for (const name of ['.gitignore', '.PNG', 'a', 'a.', 'a.txt', 'dir.zip/readme', 'a.png/readme', 'dir.zip/']) assert.equal(rules.isStoredName(name), false, name);
});
async function batches(api: Api) {
  let reads = 0, infos = 0;
  const kids = Array.from({ length: 250 }, (_, i) => file(`f${String(i).padStart(3, '0')}`, i, i + 1000, () => infos++));
  const result = await api.walkFolder(dir('корень', kids, 100, () => reads++), LIMIT);
  assert.equal(result.files, 250, 'порции обхода дают все 250 файлов');
  assert.equal(reads, 4, 'последний пустой ответ тоже читается');
  assert.equal(infos, 250);
  assert.equal(result.entries.length, 251);
  assert.deepEqual(Array.from(result.entries, e => e.path), ['корень/', ...kids.map(k => `корень/${k.name}`)]);
  assert.equal(result.bytes, api.storedZipSize(result.entries));
}
it('R211 обход читает 100+100+50 файлов и заключительную пустую порцию', () => batches(rules));
async function tree(api: Api) {
  const result = await api.walkFolder(dir('корень', [file('z.txt', 3), dir('a', [dir('b', [file('f.txt', 9, 5678)]), dir('empty')]), file('.x', 1)]), LIMIT);
  const paths = Array.from(result.entries, e => e.path);
  assert.equal(paths[0], 'корень/', 'папка обозначается завершающим слешем');
  assert.equal(paths[1], 'корень/.x', 'дети сортируются по имени перед обходом');
  assert.deepEqual(paths, ['корень/', 'корень/.x', 'корень/a/', 'корень/a/b/', 'корень/a/b/f.txt', 'корень/a/empty/', 'корень/z.txt']);
  assert.equal(result.files, 3, 'скрытый файл входит в архив');
  for (const entry of result.entries.filter(e => e.dir)) { assert.equal(entry.source, null); assert.equal(entry.size, 0); }
  const nested = result.entries.find(e => e.path.endsWith('/f.txt'))!;
  assert.equal(nested.modified, 5678); assert.equal(nested.size, 9); assert.equal(nested.source?.size, 9);
  assert.equal(result.rootName, 'корень');
}
it('R211 папка идёт перед содержимым, дети отсортированы, вложенные и скрытые файлы сохраняют корень', () => tree(rules));
it('R211 нечистые имена каждого сегмента очищаются, ссылки на FileInfo остаются настоящими', async () => {
  const info = { size: 4, lastModified: 99 };
  const child: rules.FsFileNode<Info> = { kind: 'file', name: 'f\\g\u0000.txt', async file() { return info; } };
  const result = await rules.walkFolder(dir(' ../root ', [dir('a/b', [child])]), LIMIT);
  assert.deepEqual(result.entries.map(e => e.path), ['.._root/', '.._root/a_b/', '.._root/a_b/f_g_.txt']);
  assert.equal(result.entries.at(-1)?.source, info);
});
it('R211 пустой корень и дерево только пустых подпапок отклоняются, нулевой файл принимается', async () => {
  for (const root of [dir('root'), dir('root', [dir('a', [dir('b')])])]) await assert.rejects(rules.walkFolder(root, LIMIT), code(rules, 'empty'));
  const zero = await rules.walkFolder(dir('root', [file('zero.txt')]), LIMIT);
  assert.equal(zero.files, 1); assert.equal(zero.entries.at(-1)?.size, 0);
});
async function cap(api: Api) {
  let outcome = 'ok', files = 0;
  try {
    const result = await api.walkFolder(dir('r', Array.from({ length: 65534 }, (_, i) => file(String(i)))), LIMIT);
    files = result.files;
  } catch (e) { if (e instanceof api.FolderZipError) outcome = e.code; else throw e; }
  assert.equal(outcome, 'ok', 'ровно 65535 записей вместе с корнем допустимы');
  assert.equal(files, 65534);
}
it('R211 ZIP32 принимает ровно 65535 записей с корнем, а 65536 отклоняет', async () => {
  assert.equal(rules.ZIP_MAX_ENTRIES, 65535); assert.equal(rules.ZIP_MAX_BYTES, 0xffffffff - 1024 * 1024);
  await cap(rules);
  await assert.rejects(rules.walkFolder(dir('r', Array.from({ length: 65535 }, (_, i) => file(String(i)))), LIMIT), code(rules, 'tooMany'));
});
async function exactSize(api: Api) {
  // Включены оба имени UTF8, два заголовка на запись и EOCD; ровно предел — ещё законный архив.
  const estimate = 22 + 76 + 2 * Buffer.byteLength('я/') + 76 + 2 * Buffer.byteLength('я/a') + 7;
  let outcome = 'ok', bytes = 0;
  try { bytes = (await api.walkFolder(dir('я', [file('a', 7)]), estimate)).bytes; }
  catch (e) { if (e instanceof api.FolderZipError) outcome = e.code; else throw e; }
  assert.equal(outcome, 'ok', 'архив ровно в предел не отклоняется');
  assert.equal(bytes, estimate);
  await assert.rejects(api.walkFolder(dir('я', [file('a', 7)]), estimate - 1), e => e instanceof api.FolderZipError && e.code === 'tooLarge' && e.bytes === estimate);
}
it('R211 оценка несжатого ZIP принимает точный размер и отказывает на один байт ниже', () => exactSize(rules));
it('R211 слишком большой корневой заголовок останавливает обход до первого чтения ФС', async () => {
  let batches = 0, files = 0;
  const rootBytes = 22 + 76 + 2 * Buffer.byteLength('root/');
  await assert.rejects(rules.walkFolder(dir('root', [file('later', 9, 0, () => files++)], 100, () => batches++), rootBytes - 1), code(rules, 'tooLarge'));
  assert.equal(batches, 0); assert.equal(files, 0);
});
it('R211 превышение в первой подпапке не читает следующую, даже если та содержит гигабайты', async () => {
  let lateBatches = 0, lateFiles = 0;
  const root = dir('r', [dir('z', [file('huge', 1e9, 0, () => lateFiles++)], 100, () => lateBatches++), dir('a', [file('first', 1000)])]);
  await assert.rejects(rules.walkFolder(root, 400), code(rules, 'tooLarge'));
  assert.equal(lateBatches, 0); assert.equal(lateFiles, 0);
});
it('R211 отказ чтения порции или файла становится failed, успешный соседний обход не отказывает', async () => {
  const brokenDir: rules.FsDirNode<Info> = { kind: 'dir', name: 'root', async readBatch() { throw new Error('no access'); } };
  const brokenFile: rules.FsFileNode<Info> = { kind: 'file', name: 'a', async file() { throw new Error('disappeared'); } };
  await assert.rejects(rules.walkFolder(brokenDir, LIMIT), code(rules, 'failed'));
  await assert.rejects(rules.walkFolder(dir('root', [brokenFile]), LIMIT), code(rules, 'failed'));
  assert.equal((await rules.walkFolder(dir('root', [file('a')]), LIMIT)).files, 1);
});
it('R211 отмена до чтения и между порциями не читает следующую порцию и файлы', async () => {
  let reads = 0, infos = 0;
  await assert.rejects(rules.walkFolder(dir('root', [file('a')], 100, () => reads++), LIMIT, () => true), code(rules, 'cancelled'));
  assert.equal(reads, 0);
  const root = dir('root', [file('a', 0, 0, () => infos++), file('b', 0, 0, () => infos++)], 1, () => reads++);
  await assert.rejects(rules.walkFolder(root, LIMIT, () => reads >= 1), code(rules, 'cancelled'));
  assert.equal(reads, 1); assert.equal(infos, 0);
});
it('R211 CRC32 совпадает с IEEE-вектором, пустое продолжение ничего не меняет, любые два куска равны целому', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(rules.crc32Update(0, bytes), 0xcbf43926);
  assert.equal(rules.crc32Update(0, new Uint8Array()), 0);
  assert.equal(rules.crc32Update(0xcbf43926, new Uint8Array()), 0xcbf43926);
  for (let split = 0; split <= bytes.length; split++) assert.equal(rules.crc32Update(rules.crc32Update(0, bytes.subarray(0, split)), bytes.subarray(split)), 0xcbf43926);
});
it('R211 DOS-дата ограничивает годы 1980…2107 и округляет секунды вниз до двухсекундных', () => {
  const date = (year: number, seconds: number) => new Date(year, 1, 3, 4, 5, seconds, 999).getTime();
  assert.deepEqual(rules.dosDateTime(date(2020, 7)), { time: 0x20a3, date: 0x5043 });
  assert.deepEqual(rules.dosDateTime(date(2020, 6)), { time: 0x20a3, date: 0x5043 });
  assert.deepEqual(rules.dosDateTime(date(1979, 0)), { time: 0x20a0, date: 0x0043 });
  assert.deepEqual(rules.dosDateTime(date(1980, 0)), { time: 0x20a0, date: 0x0043 });
  assert.deepEqual(rules.dosDateTime(date(2107, 59)), { time: 0x20bd, date: 0xfe43 });
  assert.deepEqual(rules.dosDateTime(date(2150, 59)), { time: 0x20bd, date: 0xfe43 });
});
const rec: rules.ZipRecord = { path: 'я.txt', dir: false, method: 8, crc: 0x89abcdef, packed: 0x11223344, size: 0x55667788, modified: new Date(2020, 1, 3, 4, 5, 7).getTime() };
const hex = (text: string) => Buffer.from(text.replace(/\s/g, ''), 'hex');
it('R211 локальный заголовок побайтно содержит UTF8, DOS-время, CRC, оба размера и имя без extra', () => {
  assert.deepEqual(Buffer.from(rules.localHeader(rec)), hex('504b0304 1400 0008 0800 a320 4350 efcdab89 44332211 88776655 0600 0000 d18f2e747874'));
});
it('R211 оглавление побайтно содержит смещение локальной записи и атрибут папки, файл атрибута не получает', () => {
  assert.deepEqual(Buffer.from(rules.centralHeader(rec, 0x12345678)), hex('504b0102 1400 1400 0008 0800 a320 4350 efcdab89 44332211 88776655 0600 0000 0000 0000 0000 00000000 78563412 d18f2e747874'));
  const folder = { ...rec, path: 'я/', dir: true, method: 0 as const, crc: 0, packed: 0, size: 0 };
  assert.deepEqual(Buffer.from(rules.centralHeader(folder, 0x12345678)), hex('504b0102 1400 1400 0008 0000 a320 4350 00000000 00000000 00000000 0300 0000 0000 0000 0000 10000000 78563412 d18f2f'));
});
it('R211 конец ZIP побайтно содержит два счётчика, размер и начало оглавления, без дисков и комментария', () => {
  assert.deepEqual(Buffer.from(rules.endRecord(0x1234, 0x11223344, 0x55667788)), hex('504b0506 0000 0000 3412 3412 44332211 88776655 0000'));
  assert.deepEqual(Buffer.from(rules.endRecord(0, 0, 0)), hex('504b0506 0000 0000 0000 0000 00000000 00000000 0000'));
});
async function maxName(api: Api) {
  let outcome = 'ok', length = 0;
  try { length = api.localHeader({ ...rec, path: 'a'.repeat(65535) }).length; }
  catch (e) { if (e instanceof api.FolderZipError) outcome = e.code; else throw e; }
  assert.equal(outcome, 'ok', '65535 байт имени ещё влезают в заголовок'); assert.equal(length, 65565);
}
it('R211 имя ровно 65535 байт разрешено, 65536 байт отклоняется в обоих видах заголовка', async () => {
  await maxName(rules);
  assert.equal(rules.centralHeader({ ...rec, path: 'a'.repeat(65535) }, 0).length, 65581);
  // UTF16-длина ниже предела, но имя уже 65536 байт UTF8 — именно байты обязаны ограничиваться.
  const tooLong = `${'я'.repeat(32767)}aa`;
  assert.throws(() => rules.localHeader({ ...rec, path: tooLong }), code(rules, 'failed'));
  assert.throws(() => rules.centralHeader({ ...rec, path: tooLong }, 0), code(rules, 'failed'));
});
it('R211 оценка stored ZIP совпадает с суммой настоящих заголовков и тел, включая пустой ZIP', () => {
  const entries = [{ path: 'корень/', size: 0 }, { path: 'корень/🪶.PNG', size: 19 }, { path: 'корень/empty', size: 0 }];
  let written = 0, central = 0;
  for (const e of entries) {
    const r = { ...rec, ...e, method: 0 as const, packed: e.size, dir: e.path.endsWith('/') };
    central += rules.centralHeader(r, written).length; written += rules.localHeader(r).length + e.size;
  }
  assert.equal(rules.storedZipSize(entries), written + central + rules.endRecord(entries.length, central, written).length);
  assert.equal(rules.storedZipSize([]), 22);
});
it('R211 тексты всех ошибок содержат имя в кавычках и понятные мегабайты с запятой', () => {
  assert.equal(rules.folderZipErrorText(new rules.FolderZipError('empty'), 'Гусь', 0), 'В папке «Гусь» нет файлов — отправлять нечего');
  assert.equal(rules.folderZipErrorText(new rules.FolderZipError('tooLarge', 1.5 * 1024 ** 2), 'Гусь', 25 * 1024 ** 2), 'Папка «Гусь» весит 1,5 МБ — больше предела 25 МБ на вложение');
  assert.equal(rules.folderZipErrorText(new rules.FolderZipError('tooLarge', 26 * 1024 ** 2), 'Гусь', 1.5 * 1024 ** 2), 'Папка «Гусь» весит 26 МБ — больше предела 1,5 МБ на вложение');
  assert.equal(rules.folderZipErrorText(new rules.FolderZipError('tooMany'), 'Гусь', 0), 'В папке «Гусь» больше 65\u00a0535 файлов и папок — архив не собрать');
  for (const c of ['failed', 'cancelled'] as const) assert.equal(rules.folderZipErrorText(new rules.FolderZipError(c), 'Гусь', 0), 'Не удалось создать архив из папки «Гусь»');
  const err = new rules.FolderZipError('tooLarge', 321); assert.equal(err.message, 'folder-zip:tooLarge'); assert.equal(err.bytes, 321);
});

// Контрфакты исполняют целый настоящий модуль, а не отдельно скопированное выражение.
it('R211 контрфакт разрешает папку вместе с файлом', () => killed('dirs === 1 && others === 0', 'dirs === 1', api => {
  assert.equal(api.planDrop(1, 1), 'refuse', 'папка вместе с файлом не принимается');
}, 'папка вместе с файлом не принимается', 'folder', 'refuse'));
it('R211 контрфакт разрешает несколько папок без файлов', () => killed('dirs === 1 && others === 0', 'dirs >= 1 && others === 0', api => {
  assert.equal(api.planDrop(2, 0), 'refuse', 'несколько папок не принимаются');
}, 'несколько папок не принимаются', 'folder', 'refuse'));
// dirs===1 → <=1 эквивалентен на допустимых неотрицательных счётчиках: ноль уже обработан первой веткой.
it('R211 контрфакт читает только первую порцию содержимого папки', () => killed('kids.push(...batch);', 'kids.push(...batch); break;', batches,
  'порции обхода дают все 250 файлов', 100, 250));
it('R211 контрфакт убирает завершающий слеш записи папки', () => killed('path: `${prefix}/`, dir: true', 'path: `${prefix}`, dir: true', tree,
  'папка обозначается завершающим слешем', 'корень', 'корень/'));
it('R211 контрфакт теряет сортировку детей', () => killed('kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));', '', tree,
  'дети сортируются по имени перед обходом', 'корень/z.txt', 'корень/.x'));
it('R211 контрфакт исключает скрытые файлы', () => killed('kids.push(...batch);', "kids.push(...batch.filter(k => !k.name.startsWith('.')));", async api => {
  const result = await api.walkFolder(dir('r', [file('.x'), file('visible')]), LIMIT);
  assert.equal(result.files, 2, 'скрытый файл не должен пропасть');
}, 'скрытый файл не должен пропасть', 1, 2));
it('R211 контрфакт отказывает на точном потолке ZIP32', () => killed('entries.length > ZIP_MAX_ENTRIES', 'entries.length >= ZIP_MAX_ENTRIES', cap,
  'ровно 65535 записей вместе с корнем допустимы', 'tooMany', 'ok'));
it('R211 контрфакт отказывает на точном пределе размера', () => killed('raw > limit', 'raw >= limit', exactSize,
  'архив ровно в предел не отклоняется', 'tooLarge', 'ok'));
it('R211 контрфакт считает PNG в верхнем регистре несжатым форматом для deflate', () => killed('base.slice(dot + 1).toLowerCase()', 'base.slice(dot + 1)', api => {
  assert.equal(api.isStoredName('a.PNG'), true, 'PNG в любом регистре уже сжат');
}, 'PNG в любом регистре уже сжат', false, true));
it('R211 контрфакт считает скрытое имя .PNG расширением', () => killed('if (dot <= 0) return false;', 'if (dot < 0) return false;', api => {
  assert.equal(api.isStoredName('.PNG'), false, 'точка в начале имени не расширение');
}, 'точка в начале имени не расширение', true, false));
it('R211 контрфакт отказывает на точных 65535 байтах имени', () => killed('b.length > 0xffff', 'b.length >= 0xffff', maxName,
  '65535 байт имени ещё влезают в заголовок', 'failed', 'ok'));
it('R211 контрфакт теряет флаг UTF8 в локальном заголовке', () => killed('v.setUint16(6, FLAG_UTF8, true);', 'v.setUint16(6, 0, true);', api => {
  assert.equal(new DataView(api.localHeader(rec).buffer).getUint16(6, true), 0x800, 'имя в UTF8 помечается флагом');
}, 'имя в UTF8 помечается флагом', 0, 0x800));
it('R211 контрфакт теряет DOS-атрибут папки в оглавлении', () => killed('r.dir ? 0x10 : 0', '0', api => {
  assert.equal(new DataView(api.centralHeader({ ...rec, dir: true, path: 'r/' }, 0).buffer).getUint32(38, true), 0x10, 'папка получает DOS-атрибут');
}, 'папка получает DOS-атрибут', 0, 0x10));
it('R211 контрфакт сбрасывает смещение записи оглавления', () => killed('v.setUint32(42, offset, true);', 'v.setUint32(42, 0, true);', api => {
  assert.equal(new DataView(api.centralHeader(rec, 321).buffer).getUint32(42, true), 321, 'оглавление указывает настоящий offset');
}, 'оглавление указывает настоящий offset', 0, 321));
it('R211 контрфакт обнуляет второй счётчик конца архива', () => killed('v.setUint16(10, count, true);', 'v.setUint16(10, 0, true);', api => {
  assert.equal(new DataView(api.endRecord(3, 0, 0).buffer).getUint16(10, true), 3, 'EOCD содержит общий счётчик записей');
}, 'EOCD содержит общий счётчик записей', 0, 3));
