import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Script } from 'node:vm';
import type { Attachment, MessageEmbed } from '@gusvoice/shared';
import ts from 'typescript';

type Rules = Pick<typeof import('./MessageEmbeds'), 'attachmentsBesideEmbeds'>;
const source = readFileSync(new URL('./MessageEmbeds.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function load(raw: string): Rules {
  // Весь настоящий TSX-модуль: JSX и linkGuard подменены явно, React/DOM/стор не загружаются.
  const compiled = ts.transpileModule(raw, { reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0,
    'R281 полный TSX компилируется без ошибок');
  const renderForbidden = () => { throw new Error('R281 проверяется чистое правило, а не рендер React'); };
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': { jsx: renderForbidden, jsxs: renderForbidden, Fragment: Symbol('Fragment') },
    '../linkGuard': { MessageLink: renderForbidden },
  };
  const module = { exports: {} };
  new Script(compiled.outputText, { filename: 'MessageEmbeds.test.vm.cjs' }).runInNewContext({
    module, exports: module.exports, require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `R281 незаявленный runtime-импорт: ${id}`);
      return dependencies[id];
    },
  });
  const rules = module.exports as Rules;
  assert.equal(typeof rules.attachmentsBesideEmbeds, 'function', 'R281 настоящее правило экспортировано');
  return rules;
}

const rules = load(source);
const file = (url: string, name = 'hook.png'): Attachment => ({ url, name, contentType: 'image/png', size: 10 });
// Возвращённый VM-массив переводим в realm assert: сравниваются вложения, а не прототипы разных VM.
const beside = (attachments: readonly Attachment[] | undefined, embeds: readonly MessageEmbed[] | undefined) =>
  Array.from(rules.attachmentsBesideEmbeds(attachments, embeds));

test('R281 отсутствующие и пустые вложения не создают отдельного содержимого', () => {
  // Класс ошибки: карточка без приложенных файлов порождает фиктивное вложение или падает на undefined.
  const embeds: MessageEmbed[] = [{ image: { url: '/hook.png' } }];
  for (const attachments of [undefined, []]) assert.deepEqual(beside(attachments, embeds), []);
});

test('R281 без карточек все вложения остаются в исходном порядке', () => {
  // Класс ошибки: защита от дублей начинает скрывать обычные файлы сообщения без карточек.
  const attachments = [file('/second.png'), file('/first.png')];
  for (const embeds of [undefined, []]) assert.deepEqual(beside(attachments, embeds), attachments);
});

test('R281 изображения разных карточек убирают только свои вложения и сохраняют порядок остальных', () => {
  // Класс ошибки: проверяется только первая карточка либо фильтрация переставляет оставшиеся файлы.
  const before = file('/z.png'), first = file('/first.png'), middle = file('/a.png');
  const second = file('/second.png'), after = file('/m.png');
  assert.deepEqual(beside([before, first, middle, second, after], [
    { image: { url: first.url } }, { title: 'Карточка без картинки' }, { image: { url: second.url } },
  ]), [before, middle, after]);
});

const thumbnailMarker = 'R281 thumbnail.url любой карточки скрывает только совпавшее вложение';
function thumbnailContract(api: Rules) {
  const keep = file('/keep.png'), thumbnail = file('/thumbnail.png');
  const actual = api.attachmentsBesideEmbeds([thumbnail, keep], [
    { image: { url: '/unrelated.png' } }, { thumbnail: { url: thumbnail.url } },
  ]);
  assert.ok(actual.length === 1 && actual[0] === keep, thumbnailMarker);
}

test('R281 миниатюра не первой карточки также скрывает совпавшее вложение', () => {
  // Класс ошибки: thumbnail забыли рядом с image, поэтому тот же файл снова виден под карточкой.
  thumbnailContract(rules);
});

test('R281 чужие imageLink и thumbnailLink не скрывают вложения с тем же адресом', () => {
  // Класс ошибки: простая ссылка считается уже показанной картинкой и человек теряет само вложение.
  const image = file('https://external.example/image.png'), thumbnail = file('https://external.example/thumb.png');
  assert.deepEqual(beside([image, thumbnail], [
    { imageLink: image.url }, { thumbnailLink: thumbnail.url },
  ]), [image, thumbnail]);
});

test('R281 совпадение проверяется по точному URL, а не имени файла или адресу без query', () => {
  // Класс ошибки: одинаковые имена разных загрузок или разные подписанные адреса ошибочно склеиваются.
  const exact = file('/uploads/hook.png', 'renamed.png');
  const sameName = file('/other/hook.png', 'renamed.png');
  const differentQuery = file('/uploads/hook.png?download=1', 'renamed.png');
  assert.deepEqual(beside([exact, sameName, differentQuery], [{ image: { url: exact.url } }]), [sameName, differentQuery]);
});

test('R281 если все файлы уже показаны картинкой или миниатюрой, отдельных вложений нет', () => {
  // Класс ошибки: фильтр оставляет первый/последний файл даже при полном покрытии карточками.
  const image = file('/image.png'), thumbnail = file('/thumb.png');
  assert.deepEqual(beside([image, thumbnail], [
    { image: { url: image.url }, thumbnail: { url: thumbnail.url } },
  ]), []);
});

test('R281 фильтрация не изменяет readonly-вложения и readonly-карточки', () => {
  // Класс ошибки: splice/sort или изменение объектов портит общее сообщение при следующем рендере.
  const image = Object.freeze(file('/image.png')), keep = Object.freeze(file('/keep.png'));
  const attachments = Object.freeze([image, keep]);
  const card = Object.freeze({ image: Object.freeze({ url: image.url }), title: 'Исходная карточка' });
  const embeds = Object.freeze([card]);
  assert.deepEqual(beside(attachments, embeds), [keep]);
  assert.deepEqual(attachments, [image, keep]);
  assert.equal(embeds[0], card);
  assert.equal(card.image.url, '/image.png');
  assert.deepEqual(beside(attachments, undefined), [image, keep]);
});

test('R281 потеря учёта thumbnail ловится адресным AssertionError после проверки оригинала', () => {
  // Класс ошибки: контрфакт должен доказать повтор миниатюры, а не сломанный setup/import/синтаксис.
  thumbnailContract(rules);
  const from = 'if (e.thumbnail?.url) inCards.add(e.thumbnail.url);';
  assert.equal(source.split(from).length - 1, 1, 'R281 ровно один исполняемый якорь thumbnail');
  // Загрузка целого изменённого модуля вне assert.throws: ошибка загрузчика не считается пойманной регрессией.
  const mutated = load(source.replace(from, ''));
  assert.throws(() => thumbnailContract(mutated),
    (error: unknown) => error instanceof assert.AssertionError && error.message === thumbnailMarker);
});
