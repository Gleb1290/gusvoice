import assert from 'node:assert/strict';
import { it } from 'node:test';
import { cliSource, replaceOnce, withCopy } from './botReference.harness.js';

it('R307 --check совпавшей временной копии даёт 0 и не пишет ни одного файла', () => withCopy(async f => {
  assert.equal(await f.cli(['--check']), 0, f.errors.join('\n')); assert.deepEqual(f.writes, []);
}));
for (const args of [['--check', '--allow-breaking'], ['--accept']]) it(`R307 запрещённые флаги ${args.join(' ')} дают код 2 до генерации`, () => withCopy(async f => {
  assert.equal(await f.cli(args), 2); assert.deepEqual(f.writes, []); assert.deepEqual(f.imports, []);
  assert.match(f.errors.join('\n'), args[0] === '--accept' ? /неизвестный флаг --accept/ : /--check не принимает --allow-breaking/);
}));
it('R307 CRLF во всех файлах копии не считается отличием при --check', () => withCopy(async f => {
  for (const rel of ['docs/bot-api/openapi.json', 'docs/bot-api/text.en.json', 'docs/bot-api/text.ru.json',
    'docs/bots.md', 'docs/bots.ru.md', 'docs/bots-llm.md', 'packages/bot-sdk-py/gusvoice_bot/_generated.py'])
    f.write(rel, f.read(rel).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  assert.equal(await f.cli(['--check']), 0, f.errors.join('\n')); assert.deepEqual(f.writes, []);
}));
async function readonly(raw = cliSource) {
  await withCopy(async f => {
    const doc = JSON.parse(f.read('docs/bot-api/openapi.json')); doc.info.title = 'manual edit';
    const original = `${JSON.stringify(doc, null, 2)}\n`; f.write('docs/bot-api/openapi.json', original);
    const status = await f.cli(['--check'], raw);
    assert.equal(f.writes.length, 0, 'R307_CHECK_READ_ONLY: сверка не перезаписывает старую схему');
    assert.equal(status, 1); assert.equal(f.read('docs/bot-api/openapi.json'), original);
    assert.equal(f.errors.some(e => e.includes('docs/bot-api/openapi.json не совпадает')), true);
  });
}
it('R307 ручная правка OpenAPI возвращает 1 и остаётся нетронутой', () => readonly());
for (const lang of ['en', 'ru'] as const) it(`R307 удаление обязательного ключа ${lang} возвращает 1 и не переписывает доки`, () => withCopy(async f => {
  const rel = `docs/bot-api/text.${lang}.json`, text = JSON.parse(f.read(rel));
  assert.ok(Object.hasOwn(text, 'method.getMe.summary')); delete text['method.getMe.summary']; f.write(rel, JSON.stringify(text));
  const before = f.read('docs/bots.ru.md');
  assert.equal(await f.cli(['--check']), 1); assert.equal(f.read('docs/bots.ru.md'), before); assert.deepEqual(f.writes, []);
  assert.equal(f.errors.some(e => e.includes(`text.${lang}.json:`) && e.includes('method.getMe.summary')), true);
}));
it('R307 лишний ключ справочника возвращает 1, даже если он есть в обоих языках', () => withCopy(async f => {
  for (const lang of ['en', 'ru']) { const rel = `docs/bot-api/text.${lang}.json`, t = JSON.parse(f.read(rel)); t['method.notReal.summary'] = 'unused'; f.write(rel, JSON.stringify(t)); }
  assert.equal(await f.cli(['--check']), 1); assert.deepEqual(f.writes, []);
  assert.equal(f.errors.some(e => e.includes('лишний ключ') && e.includes('method.notReal.summary')), true);
}));
it('R307 правка сгенерированного RU-блока возвращает 1, но страж не исправляет её сам', () => withCopy(async f => {
  const rel = 'docs/bots.ru.md', before = f.read(rel).replace('<!-- gen:bot-reference begin -->', '<!-- gen:bot-reference begin -->\nmanual edit');
  f.write(rel, before); assert.equal(await f.cli(['--check']), 1); assert.equal(f.read(rel), before); assert.deepEqual(f.writes, []);
  assert.equal(f.errors.some(e => e.includes(`${rel} не совпадает`)), true);
}));
it('R307 изменённый Python-реестр входит в тот же --check и не исправляется молча', () => withCopy(async f => {
  const rel = 'packages/bot-sdk-py/gusvoice_bot/_generated.py', before = `${f.read(rel)}\n# manual edit\n`;
  f.write(rel, before); assert.equal(await f.cli(['--check']), 1); assert.equal(f.read(rel), before); assert.deepEqual(f.writes, []);
  assert.equal(f.errors.some(e => e.includes(`${rel} не совпадает`)), true);
}));
it('R307 контрфакт: --check, ставший записью, падает на запрете перезаписи, а не на коде CLI', async () => {
  await readonly();
  await assert.rejects(readonly(replaceOnce(cliSource, 'if (check) {', 'if (false) {')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R307_CHECK_READ_ONLY:') && e.actual === 1 && e.expected === 0);
});
