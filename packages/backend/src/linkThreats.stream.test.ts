import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './linkThreatsRules.js';

const original = readFileSync(new URL('./linkThreats.ts', import.meta.url), 'utf8');
const sourceKey = 'https://lists.example/threats.txt';
const smallLimit = 64;
function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, `единственный якорь ${from}`);
  return source.replace(from, to);
}
function load(fetch: () => Promise<Response>, source = original, observedText?: (text: string) => void) {
  // Модуль целиком, уменьшен только размер данных; фиксируем настоящий предел отдельно.
  source = replaceOnce(source, 'const MAX_BYTES = 64 * 1024 * 1024;', `const MAX_BYTES = ${smallLimit};`);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, URL, Buffer, AbortSignal, Date, fetch,
    console: { log() {}, warn() {} },
    require(spec: string) {
      if (spec === './env.js') return { env: { linkThreats: { enabled: true, files: [], urls: [sourceKey] } } };
      if (spec === './linkThreatsRules.js') return { ...rules, parseThreatList(text: string) {
        observedText?.(text);
        return rules.parseThreatList(text);
      } };
      if (spec === 'node:fs/promises') return { readFile() { assert.fail('HTTP-источник не читает локальный файл'); } };
      assert.fail(`неожиданный импорт ${spec}`);
    },
  });
  return module.exports as typeof import('./linkThreats.js');
}
function stream(chunks: Uint8Array[], contentLength?: number) {
  let supplied = 0;
  let cancelled = 0;
  let completed = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (supplied === chunks.length) { completed = true; controller.close(); }
      else controller.enqueue(chunks[supplied++]);
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }); // Не допускаем предварительной выдачи куска без reader.read().
  const response = new Response(body, { headers: contentLength === undefined ? {} : { 'content-length': String(contentLength) } });
  return { response, get supplied() { return supplied; }, get cancelled() { return cancelled; }, get completed() { return completed; } };
}
function exactBody() {
  return Buffer.from('new.example\n#'.padEnd(smallLimit, ' '));
}
async function overLimit(source = original) {
  const probe = stream([exactBody(), Buffer.from('!'), Buffer.from('unread.example\n')]);
  const threats = load(async () => probe.response, source);
  threats.setThreatListsForTest({ [sourceKey]: ['kept.example'] });
  assert.equal(await threats.refreshLinkThreats(), false, 'превышение не заменяет источник');
  assert.equal(threats.isThreatHostNow('kept.example'), true, 'прежний список сохранён');
  assert.equal(threats.isThreatHostNow('new.example'), false, 'часть нового списка не опубликована');
  assert.equal(probe.supplied, 2, 'после превышения следующий кусок не читается');
  assert.equal(probe.completed, false, 'поток не дочитан до EOF');
  assert.equal(probe.cancelled, 1, 'поток отменён на превышении');
}
async function atLimit(source = original) {
  const probe = stream([exactBody().subarray(0, 10), exactBody().subarray(10)]);
  const threats = load(async () => probe.response, source);
  assert.equal(await threats.refreshLinkThreats(), true, 'ровно предел принимается');
  assert.equal(threats.isThreatHostNow('new.example'), true);
  assert.equal(probe.supplied, 2);
  assert.equal(probe.completed, true);
  assert.equal(probe.cancelled, 0);
}

it('R149 настоящий предел остаётся 64 МиБ, тестовые данные ограничены 64 байтами', () => {
  assert.equal(original.split('const MAX_BYTES = 64 * 1024 * 1024;').length - 1, 1);
  assert.equal(exactBody().byteLength, smallLimit);
});
it('R149 поток без Content-Length останавливается на первом лишнем байте и сохраняет старый источник', async () => {
  // Ловит проверку после загрузки: третий кусок не должен попасть в память вообще.
  await overLimit();
});
it('R149 ровно предел принимается, без отмены и потери последнего куска', async () => {
  // Парная граница защищает корректные списки от ошибки >=.
  await atLimit();
});
it('R149 куски соединяются до декодирования UTF-8, русский комментарий не ломает два хоста', async () => {
  const bytes = Buffer.from('evil.example\n# Привет\nbad.test\n');
  const split = bytes.indexOf(Buffer.from('П')) + 1;
  assert.ok(split > 0 && split < bytes.length);
  const probe = stream([bytes.subarray(0, split), bytes.subarray(split)]);
  let parsedText: string | undefined;
  const threats = load(async () => probe.response, original, text => { parsedText = text; });
  assert.equal(await threats.refreshLinkThreats(), true);
  assert.equal(parsedText, bytes.toString('utf8'), 'разбор получает целую строку без символов замены на стыке UTF-8');
  assert.equal(threats.isThreatHostNow('evil.example'), true);
  assert.equal(threats.isThreatHostNow('bad.test'), true);
  assert.equal(threats.linkThreatsStatus().hosts, 2, 'комментарий не стал третьим хостом');
});
it('R149 завышенный Content-Length отклоняется до первого чтения тела', async () => {
  // Ловит потерю раннего отказа: даже первый кусок опасно большого тела не запрашивается.
  const probe = stream([Buffer.from('new.example')], smallLimit + 1);
  const threats = load(async () => probe.response);
  threats.setThreatListsForTest({ [sourceKey]: ['kept.example'] });
  assert.equal(await threats.refreshLinkThreats(), false);
  assert.equal(probe.supplied, 0);
  assert.equal(probe.completed, false);
  assert.equal(threats.isThreatHostNow('kept.example'), true);
});
it('R149 ответ с body null не стирает прежний список', async () => {
  // Пустое тело HTTP-ответа не равно успешному пустому списку.
  const threats = load(async () => new Response(null));
  threats.setThreatListsForTest({ [sourceKey]: ['kept.example'] });
  assert.equal(await threats.refreshLinkThreats(), false);
  assert.equal(threats.isThreatHostNow('kept.example'), true);
});
it('R149 контрфакт проверки после цикла дочитывает лишние куски', async () => {
  await overLimit();
  const block = "    if (total > MAX_BYTES) {\n      await reader.cancel().catch(() => {});\n      throw new Error(`слишком большой ответ: больше ${MAX_BYTES} байт`);\n    }\n";
  let mutant = replaceOnce(original.replace(/\r\n/g, '\n'), block, '');
  mutant = replaceOnce(mutant, "  return Buffer.concat(chunks, total).toString('utf8');", `${block}  return Buffer.concat(chunks, total).toString('utf8');`);
  await assert.rejects(overLimit(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('следующий кусок'));
});
it('R149 контрфакт >= отбрасывает список ровно на разрешённом пределе', async () => {
  await atLimit();
  const mutant = replaceOnce(original, 'if (total > MAX_BYTES)', 'if (total >= MAX_BYTES)');
  await assert.rejects(atLimit(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('ровно предел'));
});
it('R149 контрфакт без cancel оставляет поток неотменённым после отказа', async () => {
  await overLimit();
  const mutant = replaceOnce(original, 'await reader.cancel().catch(() => {});', '/* mutant: cancel потерян */');
  await assert.rejects(overLimit(mutant), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('поток отменён'));
});
