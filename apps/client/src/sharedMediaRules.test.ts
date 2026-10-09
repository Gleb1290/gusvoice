import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { messageLinks, sharedMediaKindOf } from '@gusvoice/shared';
import type { ConvMessage } from '@gusvoice/shared';
import * as rules from './sharedMediaRules';

function message(id: string, content = '', createdAt = '2026-10-08T12:00:00.000Z', attachments: ConvMessage['attachments'] = []): ConvMessage {
  return { id, conversationId: 'dm', content, createdAt, attachments, author: { id: 'u', username: 'u', displayName: 'У', avatarUrl: null },
    editedAt: null, reactions: [], replyTo: null, sortKey: 1, clientId: null, channelId: 'dm' } as ConvMessage;
}

function linksPerUrlMutant(): typeof rules {
  const source = readFileSync(new URL('./sharedMediaRules.ts', import.meta.url), 'utf8');
  const original = 'if (urls.length > 0) out.push({ key: m.id, msg: m, url: urls[0], urls });';
  assert.ok(source.includes(original), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(original,
    'if (urls.length > 0) for (const url of urls) out.push({ key: `${m.id}:${url}`, msg: m, url, urls });'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, require: () => ({ messageLinks, sharedMediaKindOf }) });
  return module.exports as typeof rules;
}

it('счётчики выбирают русское склонение по последним двум цифрам', () => {
  // 11/112 особенно важны: выбор окончания только по последней цифре делает неверную подпись.
  for (const [n, ending] of [[1, 'файл'], [2, 'файла'], [5, 'файлов'], [11, 'файлов'], [21, 'файл'], [112, 'файлов']] as const) {
    assert.equal(rules.sharedMediaCountLabel('file', n), `${n} ${ending}`);
  }
  assert.equal(rules.sharedMediaCountLabel('media', 5), '5 фото и видео');
  assert.equal(rules.sharedMediaCountLabel('voice', 1), '1 голосовое');
});

it('вкладки не показывают пустые, но не закрывают текущую после удаления последнего элемента', () => {
  const counts = { media: 2, file: 0, link: 3, gif: 0, voice: 1 };
  assert.deepEqual(rules.visibleSharedTabs(counts, null), ['media', 'link', 'voice']);
  assert.deepEqual(rules.visibleSharedTabs(counts, 'gif'), ['media', 'link', 'gif', 'voice']);
  assert.deepEqual(rules.visibleSharedTabs(null, 'file'), ['file']);
  assert.deepEqual(rules.visibleSharedTabs(null, null), []);
  assert.equal(rules.hasSharedMedia({ media: 0, file: 0, link: 0, gif: 0, voice: 0 }), false);
  assert.equal(rules.hasSharedMedia({ media: 0, file: 0, link: 0, gif: 0, voice: 1 }), true);
});

it('ссылки считаются строками сообщений, а не числом URL внутри одного текста', () => {
  const rows = [message('multi', 'https://one.example/a и https://two.example/b'), message('single', 'https://three.example')];
  const items = rules.sharedItems(rows, 'link');
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((x) => x.key), ['multi', 'single']);
  assert.deepEqual(items[0]?.urls, ['https://one.example/a', 'https://two.example/b']);
  const mutant = linksPerUrlMutant();
  assert.throws(() => assert.equal(mutant.sharedItems(rows, 'link').length, 2), assert.AssertionError,
    'мутант раздувает число строк и счётчик ссылок для одного сообщения');
});

it('медиа и файлы сохраняют порядок вложений, а просмотрщик разворачивает ленту', () => {
  const attachments = [
    { id: 'p', url: '/p', name: 'p.png', contentType: 'image/png', size: 1 },
    { id: 'f', url: '/f', name: 'report.pdf', contentType: 'application/pdf', size: 2 },
    { id: 'v', url: '/v', name: 'voice.ogg', contentType: 'audio/ogg', size: 3, waveform: [1, 2] },
    { id: 'r', url: '/r', name: 'round.webm', contentType: 'video/webm', size: 4, round: true as const },
  ];
  const row = message('m', '', '2026-10-08T12:00:00Z', attachments);
  assert.deepEqual(rules.sharedItems([row], 'media').map((x) => x.key), ['m:p']);
  assert.deepEqual(rules.sharedItems([row], 'file').map((x) => x.key), ['m:f']);
  assert.deepEqual(rules.sharedItems([row], 'voice').map((x) => x.key), ['m:v', 'm:r'], 'кружок относится к голосовым, а не к медиа или файлам');
  assert.equal(sharedMediaKindOf(attachments[3]!), 'voice', 'категорию кружка задаёт общее правило классификации');
  assert.deepEqual(rules.viewerOrder(['new', 'middle', 'old']), ['old', 'middle', 'new']);
});

it('повтор на границе порций не дублирует уже загруженное сообщение', () => {
  const a = message('a'); const b = message('b');
  assert.deepEqual(rules.mergeSharedPage([a], [a, b]).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(rules.mergeSharedPage([], [a]).map((x) => x.id), ['a']);
});

it('месячные секции объединяют соседние месяцы, сохраняя исходный порядок', () => {
  const rows = [message('a', '', '2026-10-02T12:00:00Z'), message('b', '', '2026-10-01T12:00:00Z'), message('c', '', '2026-09-30T12:00:00Z')];
  const groups = rules.groupByMonth(rows.map((msg) => ({ msg })));
  assert.deepEqual(groups.map((x) => x.items.map((item) => item.msg.id)), [['a', 'b'], ['c']]);
  assert.deepEqual(groups.map((x) => x.label), ['Октябрь 2026', 'Сентябрь 2026']);
  assert.equal(rules.sharedMonthLabel('not-a-date'), '');
});

it('подписи ссылки и файла читаемы даже без карточки или расширения', () => {
  assert.equal(rules.linkDomain('https://www.example.com/path'), 'example.com');
  assert.equal(rules.linkDomain('нет ссылки'), 'нет ссылки');
  assert.equal(rules.fileBadge('report.pdf'), 'PDF');
  assert.equal(rules.fileBadge('archive.abcdefgh'), 'ABCD');
  assert.equal(rules.fileBadge('без расширения'), 'FILE');
});
