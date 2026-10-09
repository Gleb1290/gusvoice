import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
import { parseIncomingShare, sharedText, shareSkippedText, shareWhat, type IncomingShare } from './shareInbox';
import { shareChannels, shareDoneText, shareHead } from './shareInbox';
import { Permission, type ServerBootstrap } from '@gusvoice/shared';

function shareBoot(id: string, allowed = true): ServerBootstrap {
  return { server: { id, name: `Сервер ${id}`, iconUrl: null }, permissions: allowed ? String(Permission.SEND_MESSAGES) : '0',
    categories: [{ id: 'late', position: 2 }, { id: 'early', position: 1 }],
    channels: [
      { id: `${id}-late`, name: 'Поздний', type: 'text', categoryId: 'late', position: 0 },
      { id: `${id}-early-b`, name: 'Второй', type: 'text', categoryId: 'early', position: 2 },
      { id: `${id}-root`, name: 'Без категории', type: 'text', categoryId: null, position: 9 },
      { id: `${id}-early-a`, name: 'Первый', type: 'text', categoryId: 'early', position: 1 },
      { id: `${id}-voice`, name: 'Голос', type: 'voice', categoryId: null, position: 0, canSend: true },
    ] } as unknown as ServerBootstrap;
}
it('R128 каналы share идут по серверам, затем вне категории и позициям категорий/каналов', () => {
  const boots = [shareBoot('one'), shareBoot('two')];
  const original = JSON.stringify(boots);
  const channels = shareChannels(boots);
  assert.deepEqual(channels.map(c => c.id), ['one-root', 'one-early-a', 'one-early-b', 'one-late', 'two-root', 'two-early-a', 'two-early-b', 'two-late']);
  assert.equal(channels[0].serverName, 'Сервер one'); assert.equal(channels[0].serverIconUrl, null);
  assert.equal(JSON.stringify(boots), original, 'исходный bootstrap не сортируется на месте');
});
it('R128 право конкретного канала сильнее серверного, fallback применяется только при undefined', () => {
  const allowed = shareBoot('yes'), denied = shareBoot('no', false);
  allowed.channels[0].canSend = false; denied.channels[0].canSend = true;
  assert.deepEqual(shareChannels([allowed]).map(c => c.id), ['yes-root', 'yes-early-a', 'yes-early-b']);
  assert.deepEqual(shareChannels([denied]).map(c => c.id), ['no-late']);
  assert.deepEqual(shareChannels([]), []);
});
it('R128 итог share называет один-два адресата и правильно склоняет три и больше бесед', () => {
  assert.equal(shareDoneText(['Чат']), 'Отправлено: Чат');
  assert.equal(shareDoneText(['Чат', '#канал']), 'Отправлено: Чат и #канал');
  for (const [n, word] of [[3, 'беседы'], [5, 'бесед'], [21, 'беседу']] as const)
    assert.equal(shareDoneText(Array(n).fill('Имя')), `Отправлено в ${n} ${word}`);
  const s: IncomingShare = { token: 'token', text: 'Текст', files: [], dropped: 0 };
  assert.equal(shareHead(s), 'Текст'); assert.equal(shareWhat(s), 'Текст · встанут в поле выбранной беседы');
});
it('R128 страж фильтра типа, приоритета canSend и порядка категорий ловит контрфакты', () => {
  // Чистые оригинальные функции выше выполняются напрямую; здесь AST проверяет обязательные решения без eval.
  const raw = readFileSync(new URL('./shareInbox.ts', import.meta.url), 'utf8');
  const verify = (text: string) => {
    const ast = ts.createSourceFile('shareInbox.ts', text, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'shareChannels');
    assert.ok(fn?.body); const body = fn.body.getText(ast).replace(/\s+/g, '');
    assert.ok(body.includes("c.type==='text'&&(c.canSend??serverCan)"));
    assert.ok(body.includes('rank(a)-rank(c)||a.position-c.position'));
  };
  verify(raw);
  for (const [from, to] of [["c.type === 'text' && ", ''], ['c.canSend ?? serverCan', 'serverCan'], ['rank(a) - rank(c)', 'rank(c) - rank(a)']]) {
    assert.ok(raw.includes(from)); assert.throws(() => verify(raw.replace(from, to)), assert.AssertionError);
  }
});

it('R118 обычный текст не получает лишнюю тему, пробелы по краям снимаются', () => {
  // Тема браузера нужна ссылке, но не должна удваивать произвольный текст.
  assert.equal(sharedText('  заметка\nпродолжение  ', ' заголовок '), 'заметка\nпродолжение');
  assert.equal(sharedText('ftp://example.test/file', 'тема'), 'ftp://example.test/file');
  assert.equal(sharedText('https://example.test', 'https://example.test'), 'https://example.test');
});

it('R118 ссылка с отдельной темой сохраняет обе строки и регистр схемы', () => {
  for (const url of ['https://example.test/a', 'http://example.test/b', 'HTTPS://example.test/c']) {
    assert.equal(sharedText(` ${url} `, ' Заголовок '), `Заголовок\n${url}`);
    assert.equal(sharedText(url, ' '), url);
  }
});

it('R118 только тема становится текстом, пустые текст и тема остаются пустыми', () => {
  assert.equal(sharedText(' \n ', ' Только тема '), 'Только тема');
  assert.equal(sharedText('', ''), '');
  assert.equal(sharedText('\t', ' \n '), '');
});

it('R118 share без токена или содержимого отклоняется, текст с токеном принимается', () => {
  for (const input of [null, undefined, false, 42, 'json', {}, { token: '' }, { token: 7, text: 'текст' },
    { text: 'текст' }, { token: 'empty', text: ' ', subject: '\n', files: [], dropped: 0 },
    { token: 'empty', files: 'не массив' }]) {
    assert.equal(parseIncomingShare(input), null);
  }
  assert.deepEqual(parseIncomingShare({ token: 'text', text: ' https://example.test ', subject: ' Тема ' }),
    { token: 'text', text: 'Тема\nhttps://example.test', files: [], dropped: 0 });
});

it('R118 мусорные элементы файлов отбрасываются, допустимые поля и причины skip сохраняются', () => {
  // Один плохой элемент не должен лишать человека остальных вложений.
  const result = parseIncomingShare({ token: 'files', files: [null, false, 3, 'file',
    { name: 'ok.png', mime: 'image/png', size: '12' },
    { name: '', mime: 3, size: -2, skip: 'too-big' },
    { name: 'bad.pdf', size: 'не число', skip: 'unreadable' },
    { name: 'unknown.bin', size: 0, skip: 'unknown' }] });
  assert.deepEqual(result, { token: 'files', text: '', dropped: 0, files: [
    { name: 'ok.png', mime: 'image/png', size: 12 },
    { name: 'файл', mime: '', size: 0, skip: 'too-big' },
    { name: 'bad.pdf', mime: '', size: 0, skip: 'unreadable' },
    { name: 'unknown.bin', mime: '', size: 0 },
  ] });
  assert.equal(parseIncomingShare({ token: 'garbage', files: [null, 'file', 3] }), null);
});

it('R118 skip и dropped не теряются: окно сможет объяснить, почему файлы не приняты', () => {
  // Одни skip/dropped — не пустое событие: его отвергает UI с объяснением, не молча парсер.
  const skipped = parseIncomingShare({ token: 'skipped', files: [{ name: 'big.bin', skip: 'too-big' }] });
  assert.equal(skipped?.files[0]?.skip, 'too-big');
  assert.deepEqual(parseIncomingShare({ token: 'dropped', dropped: 2.9 }),
    { token: 'dropped', text: '', files: [], dropped: 2 });
  for (const dropped of [0, -1, 'не число', 0.9]) assert.equal(parseIncomingShare({ token: 'empty', dropped }), null);
});

it('R118 подпись считает только пригодные файлы и склоняет число без потери текста', () => {
  const share = (n: number, text = ''): IncomingShare => ({ token: 'caption', text, dropped: 2,
    files: [...Array.from({ length: n }, (_, i) => ({ name: `${i}.png`, mime: 'image/png', size: 1 })),
      { name: 'skip.bin', mime: '', size: 1, skip: 'too-big' }] });
  const suffix = ' · встанут в поле выбранной беседы';
  for (const [n, word] of [[1, 'файл'], [2, 'файла'], [5, 'файлов'], [11, 'файлов'], [21, 'файл']] as const) {
    assert.equal(shareWhat(share(n)), `${n} ${word}${suffix}`);
    assert.equal(shareWhat(share(n, 'текст')), `${n} ${word} и текст${suffix}`);
  }
  assert.equal(shareWhat(share(0, 'текст')), `Текст${suffix}`);
  assert.equal(shareWhat(share(0)), `Нечего отправить${suffix}`);
});

it('R118 причины пропуска группируются и показывают реальный предел и имена', () => {
  assert.equal(shareSkippedText([], 0, 25 * 1024 ** 2, 10), '');
  assert.equal(shareSkippedText([
    { name: 'a.mp4', reason: 'too-big' }, { name: 'b.pdf', reason: 'unreadable' },
    { name: 'c.mp4', reason: 'too-big' },
  ], 3, 25 * 1024 ** 2, 10),
  'Больше 25 МБ — не прикрепить: a.mp4, c.mp4. Не удалось прочитать: b.pdf. Не больше 10 файлов — ещё 3 не добавлены');
});

it('R118 dropped сам по себе даёт объяснение, на границе одного файла склоняется верно', () => {
  for (const [n, word] of [[1, 'добавлен'], [2, 'добавлены'], [11, 'добавлены'], [21, 'добавлен']] as const) {
    assert.equal(shareSkippedText([], n, 1024, 4), `Не больше 4 файлов — ещё ${n} не ${word}`);
  }
  assert.equal(shareSkippedText([], -1, 1024, 4), '');
});

it('R118 страж правил ловит потерю темы, приём пустого события и игнорирование dropped', () => {
  // Контрфакты исходника, не eval/VM: runtime-результаты оригинала проверены выше.
  const raw = readFileSync(new URL('./shareInbox.ts', import.meta.url), 'utf8');
  const check = (source: string) => {
    const ast = ts.createSourceFile('shareInbox.ts', source, ts.ScriptTarget.Latest, true);
    const functions = new Map<string, string>();
    for (const node of ast.statements) if (ts.isFunctionDeclaration(node) && node.name && node.body)
      functions.set(node.name.text, node.body.getText(ast));
    assert.match(functions.get('sharedText') ?? '', /`\$\{s\}\\n\$\{t\}`/, 'ссылка не теряет тему');
    assert.match(functions.get('parseIncomingShare') ?? '', /if\s*\(files\.length\s*===\s*0\s*&&\s*!text\s*&&\s*dropped\s*===\s*0\)\s*return null/, 'пустое событие не принимается');
    assert.match(functions.get('shareSkippedText') ?? '', /if\s*\(dropped\s*>\s*0\)\s*parts\.push\(/, 'dropped получает объяснение');
  };
  check(raw);
  for (const [from, to] of [
    ['`${s}\\n${t}`', 't'],
    ['if (files.length === 0 && !text && dropped === 0) return null;', ''],
    ['if (dropped > 0) parts.push(', 'if (false) parts.push('],
  ]) {
    assert.ok(raw.includes(from!), 'якорь контрфакта существует');
    const mutant = raw.replace(from!, to!);
    assert.throws(() => check(mutant), assert.AssertionError);
  }
});
