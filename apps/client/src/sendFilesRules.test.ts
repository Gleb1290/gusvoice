import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './sendFilesRules';
import * as attach from './attachRules';

const file = (type: string, name = type): File => new File(['x'], name, { type });
const photo = () => file('image/png');
const video = () => file('video/mp4');
const doc = () => file('application/pdf');
function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./sendFilesRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: () => attach });
  return module.exports as typeof rules;
}

it('группировка зависит от совместимых соседей, не просто от двух файлов', () => {
  // Ловит показ альбомного режима для пары видео/документ и потерю фото/видео-альбома.
  const check = (api: typeof rules) => {
    for (const fs of [[], [photo()], [video(), doc()], [doc(), video()]]) assert.equal(api.hasGroupOption(fs), false);
    for (const fs of [[photo(), photo()], [video(), video()], [doc(), doc()], [photo(), video()], [photo(), doc()], [doc(), photo()]])
      assert.equal(api.hasGroupOption(fs), true);
  };
  check(rules);
  assert.throws(() => check(mutant('if (files.length < 2) return false;', 'return files.length >= 2;')), assert.AssertionError);
  assert.throws(() => check(mutant("if (f.type.startsWith('video/')) return 'video';", "if (f.type.startsWith('video/')) return 'file';")), assert.AssertionError);
});

it('медиа идут первыми, подпись единственная, исходный список не переставляется', () => {
  // Ловит повтор подписи и попадание документа в альбом.
  const fs = [doc(), photo(), video(), doc()];
  const plan = rules.planSend(fs, 'подпись', rules.DEFAULT_WAY);
  assert.deepEqual(plan.map((p) => p.files), [[fs[1], fs[2]], [fs[0], fs[3]]]);
  assert.deepEqual(plan.map((p) => p.content), ['подпись', '']);
  assert.equal(fs[0]?.type, 'application/pdf');
  assert.deepEqual(rules.planSend([], 'подпись', rules.DEFAULT_WAY), []);
});

it('10 файлов остаются вместе, 11-й открывает следующее сообщение без подписи', () => {
  // Ловит превышение серверного лимита и потерю хвоста пакета.
  for (const asFile of [false, true]) for (const n of [10, 11, 21]) {
    const fs = Array.from({ length: n }, (_, i) => file('image/png', String(i)));
    const plan = rules.planSend(fs, 'x', { group: true, asFile });
    assert.deepEqual(plan.flatMap((p) => p.files), fs);
    assert.deepEqual(plan.map((p) => p.files.length), n === 10 ? [10] : n === 11 ? [10, 1] : [10, 10, 1]);
    assert.equal(plan[0]?.content, 'x');
    assert.ok(plan.slice(1).every((p) => p.content === ''));
  }
});

it('как файлы объединяет разные виды, снятая группировка отправляет по одному', () => {
  // Ловит игнорирование выбора человека в окне отправки.
  const fs = [doc(), photo(), video()];
  assert.deepEqual(rules.planSend(fs, 'x', { group: true, asFile: true }), [{ files: fs, content: 'x' }]);
  for (const asFile of [false, true]) assert.deepEqual(rules.planSend(fs, 'x', { group: false, asFile }),
    fs.map((f, i) => ({ files: [f], content: i ? '' : 'x' })));
});

it('заголовок и наличие режимов различают фото, видео, смесь и пустой список', () => {
  // Ловит неверный обещанный вид отправки и лишние переключатели.
  assert.equal(rules.boxTitle([photo(), photo()]), 'Выбрано изображений: 2');
  assert.equal(rules.boxTitle([photo(), video()]), 'Выбрано файлов: 2');
  for (const [fs, title] of [[[photo()], 'Отправить изображение'], [[video()], 'Отправить видео'], [[doc()], 'Отправить файл'], [[], 'Отправить файл']] as const)
    assert.equal(rules.boxTitle(fs), title);
  assert.equal(rules.hasAsFileOption([doc()]), false);
  assert.equal(rules.hasAsFileOption([video()]), true);
  assert.equal(rules.hasAsFileOption([]), false);
});

it('повреждённый выбор не ломает окно, запоминание видно только при изменении', () => {
  // Ловит принятие строковых boolean из кеша и скрытый изменённый выбор.
  for (const raw of [null, '', '{', 'null', '7', '[]', '{"group":"false","asFile":1}']) assert.deepEqual(rules.parseWay(raw), rules.DEFAULT_WAY);
  assert.deepEqual(rules.parseWay('{"group":false,"asFile":true,"other":7}'), { group: false, asFile: true });
  assert.deepEqual(rules.parseWay('{"group":false}'), { group: false, asFile: false });
  assert.equal(rules.rememberVisible(rules.DEFAULT_WAY, { ...rules.DEFAULT_WAY }), false);
  assert.equal(rules.rememberVisible(rules.DEFAULT_WAY, { group: false, asFile: false }), true);
  assert.equal(rules.rememberVisible(rules.DEFAULT_WAY, { group: true, asFile: true }), true);
});

it('перестановка соблюдает оба края и сохраняет оригинал', () => {
  // Ловит splice с отрицательным индексом, незаметно вытаскивающий последний файл.
  const xs = ['a', 'b', 'c'];
  assert.deepEqual(rules.moveFile(xs, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(rules.moveFile(xs, 2, 0), ['c', 'a', 'b']);
  for (const [from, to] of [[-1, 0], [0, -1], [3, 0], [0, 3], [1, 1]]) assert.deepEqual(rules.moveFile(xs, from!, to!), xs);
  assert.deepEqual(xs, ['a', 'b', 'c']);
  assert.deepEqual(rules.moveFile([], 0, 0), []);
});

it('зоны броска разделяются ровно посередине, документы не получают вторую зону', () => {
  // Ловит неверный режим сжатия из-за offset контейнера и пограничного указателя.
  for (const [types, kind] of [[['image/png'], 'images'], [['image/png', 'video/mp4'], 'media'], [['video/mp4', 'application/pdf'], 'media'], [['application/pdf'], 'files'], [[], 'files']] as const)
    assert.equal(rules.dropKind(types), kind);
  assert.deepEqual(rules.dropTexts('images'), { top: { title: 'Отпустите изображения', hint: 'чтобы отправить их без сжатия' }, bottom: { title: 'Отпустите фото', hint: 'чтобы отправить их быстро' } });
  assert.deepEqual(rules.dropTexts('media'), { top: { title: 'Отпустите файлы', hint: 'чтобы отправить их как документы' }, bottom: { title: 'Отпустите фото и видео', hint: 'чтобы отправить их как медиафайлы' } });
  assert.deepEqual(rules.dropTexts('files'), { top: { title: 'Отпустите файлы', hint: 'чтобы отправить их как документы' }, bottom: null });
  assert.equal(rules.zoneAt(149, 100, 100, true), 'top');
  assert.equal(rules.zoneAt(150, 100, 100, true), 'bottom');
  assert.equal(rules.zoneAt(200, 100, 100, false), 'top');
  assert.equal(rules.zoneAt(200, 100, 0, true), 'top');
  assert.deepEqual(rules.wayForZone('top'), { asFile: true });
  assert.deepEqual(rules.wayForZone('bottom'), { asFile: false });
});

it('вставленный текст продолжает подпись одним пробелом, пустой буфер её не стирает', () => {
  // Ловит склеивание слов и потерю уже введённого текста при вставке картинки.
  assert.equal(rules.captionAfterPaste('текст  ', '  ещё\n'), 'текст ещё');
  assert.equal(rules.captionAfterPaste('  ', ' новый '), 'новый');
  assert.equal(rules.captionAfterPaste('текст  ', ' \n'), 'текст  ');
});
