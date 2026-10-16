import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { bigReactionTargets, convPinOrderPlan, convPinOrderStamps, resolveReplyQuote, searchPattern } from './convRules.js';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
describe('перестановка закреплённых бесед', () => {
  it('полный и частичный список ставят названные первыми, прочие сохраняют прежний порядок', () => {
    const current = ['a', 'b', 'c', 'd'];
    assert.deepEqual(convPinOrderPlan(current, ['d', 'c', 'b', 'a']), { kind: 'ok', order: ['d', 'c', 'b', 'a'] });
    assert.deepEqual(convPinOrderPlan(current, ['c']), { kind: 'ok', order: ['c', 'a', 'b', 'd'] });
    assert.deepEqual(current, ['a', 'b', 'c', 'd'], 'план не меняет входной снимок');
    const source = convPinOrderPlan.toString();
    const changed = source.replace(/\.\.\.ids\s*,\s*\.\.\.current\.filter/, '...current.filter').replace(/!seen\.has\(id\)\)\s*\]/, '!seen.has(id)), ...ids]');
    assert.notEqual(changed, source, 'найден якорь переноса неназванных вперёд');
    const mutant = runInNewContext(`(${changed})`, { Set }) as typeof convPinOrderPlan;
    assert.throws(() => assert.equal(JSON.stringify(mutant(current, ['c'])), JSON.stringify({ kind: 'ok', order: ['c', 'a', 'b', 'd'] })), assert.AssertionError);
  });
  it('чужая и незакреплённая беседы не становятся закрепами через перестановку', () => {
    for (const id of ['foreign', 'unpinned']) assert.deepEqual(convPinOrderPlan(['a', 'b'], ['b', id]), { kind: 'bad' });
    assert.deepEqual(convPinOrderPlan(['a', 'b'], ['b']), { kind: 'ok', order: ['b', 'a'] });
  });
  it('повтор id отклоняется, уникальный список принимается', () => {
    assert.deepEqual(convPinOrderPlan(['a', 'b'], ['b', 'b']), { kind: 'bad' });
    assert.deepEqual(convPinOrderPlan(['a', 'b'], ['b', 'a']), { kind: 'ok', order: ['b', 'a'] });
    const source = convPinOrderPlan.toString();
    const changed = source.replace(/seen\.has\(id\)\s*\|\|\s*/, '');
    assert.notEqual(changed, source, 'проверка повтора найдена');
    const mutant = runInNewContext(`(${changed})`, { Set }) as typeof convPinOrderPlan;
    assert.throws(() => assert.equal(JSON.stringify(mutant(['a', 'b'], ['b', 'b'])), JSON.stringify({ kind: 'bad' })), assert.AssertionError);
  });
  it('тот же полный порядок, прежний префикс и пустой запрос не требуют записи', () => {
    for (const ids of [['a', 'b', 'c'], ['a'], []]) assert.deepEqual(convPinOrderPlan(['a', 'b', 'c'], ids), { kind: 'same' });
    assert.deepEqual(convPinOrderPlan([], []), { kind: 'same' });
    assert.deepEqual(convPinOrderPlan([], ['a']), { kind: 'bad' });
  });
  it('отметки строго убывают по миллисекунде, не меняя базовую дату', () => {
    const base = new Date('2026-10-09T12:00:00.000Z');
    const stamps = convPinOrderStamps(base, 5);
    assert.equal(stamps.length, 5);
    stamps.forEach((stamp, i) => assert.equal(stamp.getTime(), base.getTime() - i));
    assert.equal(stamps[1].toISOString(), '2026-10-09T11:59:59.999Z', 'переход секунды сохраняет шаг');
    assert.equal(base.toISOString(), '2026-10-09T12:00:00.000Z');
  });
  it('ноль закрепов не создаёт отметок, один получает ровно базовое время', () => {
    const base = new Date(1000);
    assert.deepEqual(convPinOrderStamps(base, 0), []);
    assert.deepEqual(convPinOrderStamps(base, 1), [base]);
  });
});
it('образец поиска отвергает пробелы и ищет проценты, подчёркивания и слеш буквально', () => {
  // Ловит расширение пользовательского запроса в SQL-шаблон вместо буквальной подстроки.
  assert.equal(searchPattern(' \n\t '), null);
  assert.equal(searchPattern(' a%b_c\\ '), '%a\\%b\\_c\\\\%');
  assert.equal(searchPattern('Привет'), '%Привет%');
  const source = searchPattern.toString(); const changed = source.replace(/q\.replace\(.+\)/, 'q');
  assert.notEqual(changed, source);
  const bad = runInNewContext(`(${changed})`) as typeof searchPattern;
  assert.throws(() => assert.equal(bad('a%b_c\\'), '%a\\%b\\_c\\\\%'), assert.AssertionError);
});

it('цитата сохраняет выбранное смещение, находит текст после неверного offset и соблюдает 1024 UTF-16 знака', () => {
  // Цитата должна быть точной подстрокой исходного сообщения; неверная позиция восстанавливается, но посторонний текст нельзя сохранить.
  const content = 'текст — выбранный фрагмент — и ещё текст';
  assert.deepEqual(resolveReplyQuote(content, { text: 'выбранный фрагмент', offset: 8 }), { text: 'выбранный фрагмент', offset: 8 });
  assert.deepEqual(resolveReplyQuote('абаба', { text: 'аба', offset: 2 }), { text: 'аба', offset: 2 }, 'повторная подстрока уважает позицию клиента');
  assert.deepEqual(resolveReplyQuote('абаба', { text: 'аба', offset: 1 }), { text: 'аба', offset: 0 }, 'несовпавшая позиция берёт первое точное вхождение');
  assert.deepEqual(resolveReplyQuote('x'.repeat(1024), { text: 'x'.repeat(1024) }), { text: 'x'.repeat(1024), offset: 0 });
  assert.equal(resolveReplyQuote('x'.repeat(1025), { text: 'x'.repeat(1025) }), null);
  assert.equal(resolveReplyQuote('есть текст', { text: 'чужой текст' }), null);
  assert.equal(resolveReplyQuote('есть текст', { text: '   ' }), null);

  const source = resolveReplyQuote.toString();
  const mutantSource = source.replace('text.length>REPLY_QUOTE_LIMIT', 'text.length>=REPLY_QUOTE_LIMIT');
  assert.notEqual(mutantSource, source, 'точный предел является реальным условием функции');
  const mutant = runInNewContext(`(${mutantSource})`, { REPLY_QUOTE_LIMIT: 1024 }) as typeof resolveReplyQuote;
  assert.throws(() => assert.deepEqual(mutant('x'.repeat(1024), { text: 'x'.repeat(1024) }), { text: 'x'.repeat(1024), offset: 0 }), assert.AssertionError);
});
import { runInNewContext } from 'node:vm';

it('большой эффект получает только аудитория чужой постановки, не снятие и не повторная запись', () => {
  // Эффект отдельный от строки реакции: повтор удержания играет его снова, но себя и скрытую аудиторию не будит.
  const base = { big: true, op: 'add' as const, actorId: 'actor', audience: ['actor', 'peer'] };
  assert.deepEqual(bigReactionTargets(base), ['peer']);
  assert.deepEqual(bigReactionTargets({ ...base, big: false }), []);
  assert.deepEqual(bigReactionTargets({ ...base, op: 'remove' }), []);
  assert.deepEqual(bigReactionTargets({ ...base, audience: ['actor'] }), []);
  assert.deepEqual(bigReactionTargets({ ...base, audience: ['peer'] }), ['peer']);

  const source = bigReactionTargets.toString();
  const noBigGuardSource = source.replace('if(!input.big||input.op!=="add")return[];', 'if(input.op!=="add")return[];');
  assert.notEqual(noBigGuardSource, source);
  const noBigGuard = runInNewContext(`(${noBigGuardSource})`) as typeof bigReactionTargets;
  assert.throws(() => assert.equal(noBigGuard({ ...base, big: false }).join(','), ''), assert.AssertionError);
  const allowRemoveSource = source.replace('if(!input.big||input.op!=="add")return[];', 'if(!input.big)return[];');
  assert.notEqual(allowRemoveSource, source);
  const allowRemove = runInNewContext(`(${allowRemoveSource})`) as typeof bigReactionTargets;
  assert.throws(() => assert.equal(allowRemove({ ...base, op: 'remove' }).join(','), ''), assert.AssertionError);
  const includeActorSource = source.replace('.filter(id=>id!==input.actorId)', '.filter(()=>true)');
  assert.notEqual(includeActorSource, source);
  const includeActor = runInNewContext(`(${includeActorSource})`) as typeof bigReactionTargets;
  assert.throws(() => assert.equal(includeActor(base).join(','), 'peer'), assert.AssertionError);
});
import {
  attachmentAccess,
  catchupPlan,
  changeAudience,
  countsAsUnread,
  decodeCursor,
  directKey,
  encodeCursor,
  idempotencyDecision,
  isSortKey,
  journalLockOrder,
  messageView,
  nextSortKey,
  normalizeDraft, sameDraft, isDraftDevice, peerReadKey, readAudience,
  payloadHash,
  previewText,
  readKeyMax,
  type JournalEntry,
  lastAttachmentPreview, replyAttachmentPreview, forwardClientId, forwardPayloadHash, forwardReplayDecision, forwardedFromOf, entryPts,
  batchDeleteDecision, FORWARD_ATTACHMENTS_MAX, FORWARD_BYTES_MAX,
  deleteDecision, othersDeletableForBoth,
  pinRowAction, pinAudience, unpinTargets, PINS_MAX,
  convListOrder,
  stickerOf, stickerAwarePreview,
  albumItemDecision, attachmentsForViewer, hiddenAttachmentKey, removedByEdit,
} from './convRules.js';
import { PENDING_MAX_COUNT, PENDING_MAX_BYTES, PENDING_MAX_BYTES_BIGFILE, DM_DAILY_UPLOAD_BYTES } from './attachmentRules.js';

// G56: контрфакты исполняют весь модуль, чтобы сохранить вызовы между настоящими правилами.
type AlbumRules = Pick<typeof import('./convRules.js'), 'albumItemDecision' | 'attachmentsForViewer' | 'removedByEdit'>;
function albumRulesModule(from?: string, to?: string): AlbumRules {
  const raw = readFileSync(new URL('./convRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (from !== undefined) assert.equal(raw.split(from).length - 1, 1, 'единственный якорь контрфакта G56');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(from === undefined ? raw : raw.replace(from, to!), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, Date, Set, Map, Buffer,
    require: (id: string) => { assert.equal(id, 'node:crypto'); return { createHash }; } });
  return module.exports as AlbumRules;
}
const albumList = ['one', 'two', 'three'].map(id => ({ id }));
const albumInput = (p: Partial<Parameters<typeof albumItemDecision>[0]> = {}) => ({
  list: albumList, hidden: [], viewerId: 'a', authorId: 'a', attachmentId: 'one', scope: 'both' as const, ...p,
});
function albumAssertion(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label);
}
function albumFailure(actual: unknown, wrong: unknown, expected: unknown, label: string) {
  assert.throws(() => albumAssertion(actual, expected, label), e => e instanceof assert.AssertionError
    && e.message.startsWith(label) && e.operator === 'deepStrictEqual' && JSON.stringify(e.actual) === JSON.stringify(wrong)
    && JSON.stringify(e.expected) === JSON.stringify(expected));
}

describe('G56 правила одного элемента альбома', () => {
  it('свой элемент у обоих убирается, чужой запрещён, у меня чужой можно спрятать', () => {
    // Право на чужое сообщение целиком в 1:1 не даёт права редактировать его альбом.
    assert.equal(albumItemDecision(albumInput()), 'remove');
    assert.equal(albumItemDecision(albumInput({ authorId: 'b' })), 'forbidden');
    assert.equal(albumItemDecision(albumInput({ authorId: 'b', scope: 'me' })), 'hide');
  });
  it('последний общий или последний видимый мне удаляет сообщение, два ещё оставляют элемент', () => {
    assert.equal(albumItemDecision(albumInput({ list: albumList.slice(0, 1) })), 'whole');
    assert.equal(albumItemDecision(albumInput({ list: albumList.slice(0, 2) })), 'remove');
    assert.equal(albumItemDecision(albumInput({ scope: 'me', hidden: ['a:two', 'a:three'] })), 'whole');
    assert.equal(albumItemDecision(albumInput({ scope: 'me', hidden: ['a:three'] })), 'hide');
    assert.equal(albumItemDecision(albumInput({ hidden: ['a:two', 'a:three'] })), 'remove', 'у обоих считается исходный список');
  });
  it('отсутствующий или уже спрятанный мной id повторяется без изменений, чужая пометка не мешает', () => {
    assert.equal(albumItemDecision(albumInput({ attachmentId: 'missing' })), 'repeat');
    assert.equal(albumItemDecision(albumInput({ hidden: ['a:one'] })), 'repeat');
    assert.equal(albumItemDecision(albumInput({ hidden: ['b:one'] })), 'remove');
    assert.equal(albumItemDecision(albumInput({ list: [{}, { id: null }], attachmentId: 'missing' })), 'repeat');
  });
  it('список смотрящего учитывает точный префикс, оставляет старые элементы без id и не меняет исходник', () => {
    const list = [...albumList, {}, { id: null }], hidden = ['a:one', 'ab:two', 'b:three'];
    assert.equal(hiddenAttachmentKey('a', 'one'), 'a:one');
    albumAssertion(attachmentsForViewer(list, hidden, 'a'), [{ id: 'two' }, { id: 'three' }, {}, { id: null }], 'только свои пометки');
    albumAssertion(attachmentsForViewer(list, hidden, 'b'), [{ id: 'one' }, { id: 'two' }, {}, { id: null }], 'собеседник видит свой список');
    assert.equal(list.length, 5); assert.equal(hidden.length, 3);
    for (const marks of [[], null, undefined, ['ab:one']]) assert.equal(attachmentsForViewer(list, marks, 'a'), list);
    albumAssertion(attachmentsForViewer(albumList, albumList.map(a => `a:${a.id}`), 'a'), [], 'всё спрятанное не видно');
  });
  it('приём сужения находит убранное, пустой провод и полная замена ничего не стирают', () => {
    albumAssertion(removedByEdit(albumList, [{ id: 'one' }, { id: 'three' }]), [{ id: 'two' }], 'убрано только отсутствующее');
    albumAssertion(removedByEdit(albumList, []), [], 'пустой провод сохраняет файлы');
    albumAssertion(removedByEdit(albumList, [{ id: 'new' }]), [], 'все убрано — не сужение');
    albumAssertion(removedByEdit([...albumList, {}], albumList), [], 'старый элемент без id не стирается');
    albumAssertion(removedByEdit([], [{ id: 'new' }]), [], 'пустой исходник');
  });
  it('контрфакт строгой границы одного элемента ловится последним видимым', () => {
    const p = albumInput({ scope: 'me', hidden: ['a:two', 'a:three'] });
    albumAssertion(albumRulesModule().albumItemDecision(p), 'whole', 'последний видимый удаляет сообщение');
    const mutant = albumRulesModule("visible.length <= 1 ? 'whole' : 'hide'", "visible.length < 1 ? 'whole' : 'hide'");
    albumFailure(mutant.albumItemDecision(p), 'hide', 'whole', 'последний видимый удаляет сообщение');
    const q = albumInput({ list: albumList.slice(0, 1) });
    albumAssertion(albumRulesModule().albumItemDecision(q), 'whole', 'последний общий удаляет сообщение');
    const both = albumRulesModule("p.list.length <= 1 ? 'whole' : 'remove'", "p.list.length < 1 ? 'whole' : 'remove'");
    albumFailure(both.albumItemDecision(q), 'remove', 'whole', 'последний общий удаляет сообщение');
  });
  it('контрфакт потери проверки автора ловится разрешением чужой правки', () => {
    const p = albumInput({ authorId: 'b' });
    albumAssertion(albumRulesModule().albumItemDecision(p), 'forbidden', 'чужой альбом не редактируется');
    const mutant = albumRulesModule("if (p.scope === 'both' && p.authorId !== p.viewerId) return 'forbidden';", '');
    albumFailure(mutant.albumItemDecision(p), 'remove', 'forbidden', 'чужой альбом не редактируется');
  });
  it('контрфакт пустого провода ловится сохранением именованных файлов рядом со старым без id', () => {
    // Один безымянный старый элемент делает gone.length < row.length: без guard удалятся все три закрытых файла.
    const list = [...albumList, {}];
    albumAssertion(albumRulesModule().removedByEdit(list, []), [], 'пустой провод не удаляет закрытые файлы');
    const mutant = albumRulesModule('if (wire.length === 0) return [];', '');
    albumFailure(mutant.removedByEdit(list, []), albumList, [], 'пустой провод не удаляет закрытые файлы');
  });
});

it('стикер распознаётся только с URL, превью использует emoji, прежний отпечаток без stickerId не меняется', () => {
  // Введение стикеров не должно ломать replay старого сообщения или принимать мусорный JSON за стикер.
  for (const value of [null, undefined, 'bad', '[]', {}, { url: '' }, { url: 1 }]) assert.equal(stickerOf(value), null);
  assert.deepEqual(stickerOf(JSON.stringify({ url: 'https://media.test/x.webp', emoji: '🪶' })), { emoji: '🪶' });
  assert.deepEqual(stickerOf({ url: 'https://media.test/x.webp' }), { emoji: '' });
  assert.deepEqual(stickerAwarePreview('', { url: 'x', emoji: '🪶' }), { text: '🪶' });
  assert.deepEqual(stickerAwarePreview('подпись', { url: 'x', emoji: '🪶' }), { text: 'подпись' });
  const p = { conversationId: 'c', content: 'x', attachmentRefs: ['a'], replyToId: null };
  const legacy = createHash('sha256').update(JSON.stringify(['p1', 'c', 'x', ['a'], null])).digest('hex');
  assert.equal(payloadHash(p), legacy); assert.equal(payloadHash({ ...p, stickerId: null }), legacy);
  assert.notEqual(payloadHash({ ...p, stickerId: 's' }), legacy);
});

describe('закреп беседы', () => {
  it('при 49 закрепах можно добавить пятидесятый, при 50 и 51 новый уже не проходит', () => {
    // Ловит ошибку на единицу в максимуме и обход лимита выбором области закрепа.
    assert.equal(PINS_MAX, 50);
    assert.equal(pinRowAction(undefined, 'me', PINS_MAX - 1), 'insert');
    assert.equal(pinRowAction(undefined, 'both', PINS_MAX - 1), 'insert');
    assert.equal(pinRowAction(undefined, 'me', PINS_MAX), 'full');
    assert.equal(pinRowAction(undefined, 'both', PINS_MAX + 1), 'full');
  });

  it('повтор не тратит место, а существующий личный закреп становится общим без downgrade', () => {
    // Ловит запрет улучшения при полном списке и случайное понижение общего закрепа до личного.
    assert.equal(pinRowAction({ forBoth: false }, 'both', PINS_MAX), 'share');
    assert.equal(pinRowAction({ forBoth: true }, 'me', PINS_MAX), 'keep');
    assert.equal(pinRowAction({ forBoth: false }, 'me', PINS_MAX), 'keep');
    assert.equal(pinRowAction({ forBoth: true }, 'both', PINS_MAX + 1), 'keep');
  });

  it('«для меня» всегда адресовано актору, «для обоих» учитывает видимость и блокировку', () => {
    // Ловит доставку скрытого/придержанного сообщения или действия тому, кто заблокировал актора.
    const message = { authorId: 'actor', withheld: false, deletedAt: null, hiddenFor: ['hidden'] };
    const input = { message, actorId: 'actor', memberIds: ['actor', 'peer', 'hidden', 'blocked'], blockedActor: new Set(['blocked']) };
    assert.deepEqual(pinAudience({ ...input, scope: 'me' }), ['actor']);
    assert.deepEqual(pinAudience({ ...input, scope: 'both' }), ['actor', 'peer']);
    assert.deepEqual(pinAudience({ ...input, scope: 'both', message: { ...message, authorId: 'withheld', withheld: true }, memberIds: [...input.memberIds, 'withheld'] }), ['actor', 'withheld']);
    assert.deepEqual(pinAudience({ ...input, scope: 'both', message: { ...message, withheld: true } }), ['actor']);
    assert.deepEqual(pinAudience({ ...input, scope: 'both', message: { ...message, deletedAt: new Date() } }), ['actor']);
  });

  it('открепление всегда снимает своё даже при блокировке, но не чужой личный или заблокированный общий', () => {
    // Ловит снятие чужого личного закрепа и нарушение блокировки при обратном действии.
    const rows = [
      { userId: 'actor', forBoth: false }, { userId: 'peer', forBoth: true },
      { userId: 'personal', forBoth: false }, { userId: 'blocked', forBoth: true },
    ];
    const input = { actorId: 'actor', rows, blockedActor: new Set(['actor', 'blocked']) };
    assert.deepEqual(unpinTargets({ ...input, scope: 'me' }), ['actor']);
    assert.deepEqual(unpinTargets({ ...input, scope: 'both' }), ['actor', 'peer']);
    assert.deepEqual(unpinTargets({ ...input, scope: 'both', rows: [] }), []);
    assert.deepEqual(unpinTargets({ ...input, scope: 'both', rows: rows.slice(1) }), ['peer']);
  });
});

describe('снимок пересланного автора', () => {
  it('deleted сохраняется через цепочку пересылок и не появляется у живого автора', () => {
    // Ловит потерю удаления первого автора на повторной пересылке и ложную маркировку живого тёзки.
    const deleted = { userId: 'gone', displayName: 'Удалённый пользователь', at: '2026-10-05T10:00:00.000Z', deleted: true as const };
    assert.deepEqual(forwardedFromOf({ authorId: 'forwarder', authorName: 'Переславший', createdAt: '2026-10-05T11:00:00Z', forwardedFrom: deleted }), deleted);
    assert.deepEqual(forwardedFromOf({ authorId: 'gone', authorName: 'Удалённый пользователь', createdAt: '2026-10-05T10:00:00Z', forwardedFrom: null, authorDeleted: true }), deleted);
    const live = forwardedFromOf({ authorId: 'live', authorName: 'Живой', createdAt: '2026-10-05T10:00:00Z', forwardedFrom: null });
    assert.equal(Object.hasOwn(live, 'deleted'), false);
  });
});

describe('превью вложений сводки', () => {
  it('нет объектов — нет полей, все изображения — фото, аудио без огибающей — файл', () => {
    // Ловит ложные поля DTO и путаницу музыки с голосовым.
    for (const list of [[], [null, 7, 'x', []]]) assert.equal(lastAttachmentPreview(list), null);
    for (const list of [[{ contentType: 'image/png' }], Array(3).fill({ contentType: 'image/gif' }), [{ contentType: 'image/png', waveform: [1] }]]) assert.deepEqual(lastAttachmentPreview(list), { attachmentKind: 'photo' });
    assert.deepEqual(lastAttachmentPreview([{ contentType: 'audio/mpeg' }]), { attachmentKind: 'file' });
    assert.deepEqual(lastAttachmentPreview([{ contentType: 'image/png', name: ' a\n b ' }, { contentType: 'text/plain', name: 'second' }]), { attachmentKind: 'file', attachmentName: 'a b' });
  });
  it('голосовое сохраняет положительную длительность, негодную не передаёт', () => {
    // Ловит NaN в JSON сводки и потерю нормальной длительности.
    const a = { contentType: 'audio/ogg', waveform: [1] };
    assert.deepEqual(lastAttachmentPreview([{ ...a, durationMs: 42000 }]), { attachmentKind: 'voice', attachmentDurationMs: 42000 });
    for (const durationMs of [null, 0, NaN, -1, Infinity]) assert.deepEqual(lastAttachmentPreview([{ ...a, durationMs }]), { attachmentKind: 'voice' });
  });
  it('имя первого файла ограничено 200 кодовыми точками без разрыва эмодзи', () => {
    // Ловит случайный выбор второго имени и переполнение превью.
    assert.deepEqual(lastAttachmentPreview([{ name: '😀'.repeat(201) }, { name: 'second' }]), { attachmentKind: 'file', attachmentName: '😀'.repeat(199) + '…' });
  });
  it('видео получает совместимый file-признак, а цитата добавляет число и сохраняет старую форму без вложений', () => {
    // Ловит потерю видео-маркера у старых сводок и изменение DTO цитаты для текстовых сообщений.
    const video = [{ contentType: 'video/mp4', name: 'clip.mp4', durationMs: 12_000 }];
    assert.deepEqual(lastAttachmentPreview(video), { attachmentKind: 'file', attachmentName: 'clip.mp4', attachmentVideo: true, attachmentDurationMs: 12_000 });
    assert.deepEqual(replyAttachmentPreview(video), { attachments: 1, attachmentKind: 'file', attachmentName: 'clip.mp4', attachmentVideo: true, attachmentDurationMs: 12_000 });
    assert.deepEqual(replyAttachmentPreview([{ contentType: 'image/png' }, { contentType: 'video/mp4' }]), { attachments: 2, attachmentKind: 'file' });
    assert.deepEqual(replyAttachmentPreview([]), {});
    assert.deepEqual(replyAttachmentPreview(video, true), { attachmentKind: 'sticker' });
  });
});

describe('чистые правила пересылки и удаления пачкой', () => {
  it('id пачки детерминирован, нечувствителен к регистру и различает индекс', () => {
    // Ловит дубли после повтора и столкновения соседних сообщений.
    const id = 'ABCDEF12-3456-4789-ABCD-123456789012';
    assert.match(forwardClientId(id, 0), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(forwardClientId(id, 0), forwardClientId(id.toLowerCase(), 0));
    assert.notEqual(forwardClientId(id, 0), forwardClientId(id, 1));
    assert.notEqual(forwardClientId(id, 0), forwardClientId('other', 0));
  });
  it('отпечаток зависит от набора, источника, получателя и индекса, не от порядка', () => {
    // Ловит 409 на безопасном повторе и чужую пачку под прежним id.
    const p = { conversationId: 'ab', fromConversationId: 'ac', messageIds: ['a','b'], index: 0 };
    const h = forwardPayloadHash(p);
    assert.equal(h, forwardPayloadHash({ ...p, messageIds: ['b','a'] }));
    for (const patch of [{ conversationId: 'x' }, { fromConversationId: 'x' }, { messageIds: ['a'] }, { index: 1 }]) assert.notEqual(h, forwardPayloadHash({ ...p, ...patch }));
    assert.notEqual(h, payloadHash({ conversationId: 'ab', content: '', attachmentRefs: [], replyToId: null }));
  });
  it('повтор принимает ровно полную пачку с прежними отпечатками', () => {
    // Ловит частичный успех или чужой payload при идемпотентном повторе.
    const expected = [{ clientId: 'a', hash: 'ha' }, { clientId: 'b', hash: 'hb' }];
    const rows = expected.map(x => ({ clientId: x.clientId, payloadHash: x.hash }));
    assert.equal(forwardReplayDecision([], expected), 'insert');
    assert.equal(forwardReplayDecision([...rows].reverse(), expected), 'replay');
    for (const bad of [rows.slice(0,1), [...rows, rows[0]], [rows[0], { ...rows[1], payloadHash: 'wrong' }], [rows[0], { clientId: null, payloadHash: null }]]) assert.equal(forwardReplayDecision(bad, expected), 'conflict');
  });
  it('цепочка оставляет первого автора и время, Date и ISO одинаковы', () => {
    // Ловит потерю происхождения при повторной пересылке.
    const p = { authorId: 'a', authorName: 'Кот', createdAt: '2026-10-04T12:00:00Z', forwardedFrom: null };
    const original = { userId: 'a', displayName: 'Кот', at: '2026-10-04T12:00:00.000Z' };
    assert.deepEqual(forwardedFromOf(p), original);
    assert.deepEqual(forwardedFromOf({ ...p, createdAt: new Date(p.createdAt) }), original);
    assert.deepEqual(forwardedFromOf({ ...p, authorId: 'b', forwardedFrom: original }), original);
  });
  it('номера журнала идут подряд отдельно для каждого, неизвестный last отвергается', () => {
    // Ловит дырки pts при перемешанной аудитории пачки.
    const entries = ['a','b','a','a','b'].map(userId => ({ userId }));
    assert.deepEqual(entryPts(entries, new Map([['a',12],['b',22]])), [10,21,11,12,22]);
    assert.deepEqual(entryPts([], new Map()), []);
    assert.throws(() => entryPts(entries, new Map([['a',12]])), /нет номера журнала для b/);
  });
  it('удаление учитывает видимость раньше прав и не трогает исчезнувшее', () => {
    // Ловит раскрытие придержанного и удаление чужого у обоих.
    const m = { authorId: 'a', withheld: false, deletedAt: null, hiddenFor: [] as string[] };
    for (const scope of ['me','both'] as const) {
      assert.equal(batchDeleteDecision(undefined,'a',scope), 'not-found');
      assert.equal(batchDeleteDecision({ ...m, authorId: 'b', withheld: true },'a',scope), 'not-found');
    }
    assert.equal(batchDeleteDecision(m,'a','me'), 'hide'); assert.equal(batchDeleteDecision({ ...m, withheld: true },'a','me'), 'hide');
    assert.equal(batchDeleteDecision(m,'a','both'), 'tombstone'); assert.equal(batchDeleteDecision({ ...m, hiddenFor: ['a'] },'a','both'), 'tombstone');
    assert.equal(batchDeleteDecision({ ...m, authorId: 'b' },'a','both'), 'forbidden');
    for (const scope of ['me','both'] as const) for (const authorId of ['a','b']) assert.equal(batchDeleteDecision({ ...m, authorId, deletedAt: new Date() },'a',scope), 'skip');
    for (const scope of ['me','both'] as const) assert.equal(batchDeleteDecision({ ...m, authorId: 'b', hiddenFor: ['a'] },'a',scope), 'skip');
  });
  it('пределы временных копий равны пределам незавершённых загрузок', () => {
    // Ловит расхождение продублированных констант и отказ на разрешённой пачке.
    assert.equal(FORWARD_ATTACHMENTS_MAX, PENDING_MAX_COUNT); assert.equal(FORWARD_BYTES_MAX, PENDING_MAX_BYTES);
    assert.equal(FORWARD_BYTES_MAX, PENDING_MAX_BYTES_BIGFILE);
    assert.equal(FORWARD_BYTES_MAX, 8 * 1024 * 1024 * 1024, 'R142 восемь файлов по 1 ГиБ укладываются в общий предел');
    assert.ok(FORWARD_BYTES_MAX <= DM_DAILY_UPLOAD_BYTES, 'разрешённая пересылка должна помещаться в пустую суточную квоту');
  });
});

describe('нормализация серверного черновика', () => {
  it('ключ прочтения ограничен первым придержанным и не опускается ниже нуля', () => {
    assert.equal(peerReadKey([]), null);
    assert.equal(peerReadKey([{ lastReadKey: 10, firstWithheldKey: null }, { lastReadKey: 20, firstWithheldKey: null }]), 20);
    assert.equal(peerReadKey([{ lastReadKey: 20, firstWithheldKey: 10 }]), 9);
    assert.equal(peerReadKey([{ lastReadKey: 5, firstWithheldKey: 10 }]), 5);
    assert.equal(peerReadKey([{ lastReadKey: 20, firstWithheldKey: 0 }]), 0);
    assert.equal(peerReadKey([{ lastReadKey: 20, firstWithheldKey: 10 }, { lastReadKey: 11, firstWithheldKey: null }]), 11);
  });
  it('читающий всегда первый, заблокированные им не узнают прочтение', () => {
    assert.deepEqual(readAudience({ readerId: 'a', memberIds: ['b', 'a', 'c'], readerBlocked: new Set(['a', 'b']) }), ['a', 'c']);
    assert.deepEqual(readAudience({ readerId: 'a', memberIds: ['b', 'a'], readerBlocked: new Set() }), ['a', 'b']);
    assert.deepEqual(readAudience({ readerId: 'a', memberIds: [], readerBlocked: new Set() }), ['a']);
  });
  it('метка устройства допускает границы 1 и 64, но не пустоту, пробел или 65 символов', () => {
    assert.equal(isDraftDevice('a'), true); assert.equal(isDraftDevice('a'.repeat(64)), true);
    for (const bad of ['', 'a'.repeat(65), 'bad device', 'кириллица']) assert.equal(isDraftDevice(bad), false);
  });
  it('пробелы без ответа очищают, выбранный ответ и исходные пробелы текста сохраняются', () => {
    assert.equal(normalizeDraft(' \n ', null), null);
    assert.deepEqual(normalizeDraft(' \n ', 'm'), { text: ' \n ', replyToId: 'm' });
    assert.deepEqual(normalizeDraft(' x ', null), { text: ' x ', replyToId: null });
    assert.equal(sameDraft(null, null), true); assert.equal(sameDraft(null, { text: 'x', replyToId: null }), false);
    assert.equal(sameDraft({ text: 'x', replyToId: 'a' }, { text: 'x', replyToId: 'b' }), false);
  });
});

describe('доступ к закрытому вложению ЛС', () => {
  const base = {
    viewerId: 'viewer', viewerDeleted: false,
    att: { ownerId: 'owner', conversationId: 'c', state: 'attached' as const, messageId: 'm' },
    member: { leftAt: null },
    message: { conversationId: 'c', authorId: 'owner', withheld: false, deletedAt: null, hiddenFor: [] },
  };

  it('участник читает видимое вложение, посторонний и вышедший — нет', () => {
    // Ловит выдачу файла по одной лишь подписанной ссылке без текущего участия.
    assert.equal(attachmentAccess(base), true);
    assert.equal(attachmentAccess({ ...base, member: null }), false);
    assert.equal(attachmentAccess({ ...base, member: { leftAt: '2026-01-01' } }), false);
    assert.equal(attachmentAccess({ ...base, viewerDeleted: true }), false);
  });

  it('pending видит только загрузивший, а прикреплённый файл следует видимости сообщения', () => {
    // Ловит доступ к незавершённому чужому файлу и к удалённому/спрятанному сообщению.
    assert.equal(attachmentAccess({ ...base, att: { ...base.att, state: 'pending' } }), false);
    assert.equal(attachmentAccess({ ...base, viewerId: 'owner', att: { ...base.att, state: 'pending' } }), true);
    assert.equal(attachmentAccess({ ...base, att: { ...base.att, state: 'deleted' } }), false);
    assert.equal(attachmentAccess({ ...base, message: { ...base.message, hiddenFor: ['viewer'] } }), false);
    assert.equal(attachmentAccess({ ...base, message: { ...base.message, withheld: true } }), false);
    assert.equal(attachmentAccess({ ...base, message: { ...base.message, conversationId: 'other' } }), false);
  });

  it('отложенный файл видит только его автор, но не собеседник и не вышедший участник', () => {
    // У запаркованного файла ещё нет сообщения для проверки видимости: приватность держится на авторе и участии в беседе.
    const parked = { ...base, att: { ...base.att, state: 'scheduled' as const, messageId: null } };
    assert.equal(attachmentAccess({ ...parked, viewerId: 'owner' }), true, 'автор должен видеть свой отложенный файл');
    assert.equal(attachmentAccess(parked), false, 'собеседник не должен угадывать ссылку на отложенный файл');
    assert.equal(attachmentAccess({ ...parked, viewerId: 'owner', member: { leftAt: '2026-10-01' } }), false,
      'после выхода автора ссылка больше не выдаётся');
  });
});

describe('порядок беседы', () => {
  it('часы растут строго даже после отката времени', () => {
    // Ловит одинаковые ключи при двух отправках за одну микросекунду и после отката часов.
    assert.equal(nextSortKey(100, 0), 100);
    assert.equal(nextSortKey(100, 100), 101);
    assert.equal(nextSortKey(50, 100), 101);
    assert.equal(nextSortKey(102, 100), 102);
  });

  it('ключ допускает ноль и последний точный integer, но не округлённые числа', () => {
    // Ловит слипание соседних ключей при JSON-обмене после 2^53.
    for (const v of [0, Number.MAX_SAFE_INTEGER]) assert.equal(isSortKey(v), true);
    for (const v of [-1, 1.5, '5', NaN, 2 ** 53, Number.MAX_SAFE_INTEGER + 1]) assert.equal(isSortKey(v), false);
    const one = 1_800_000_000_000_000;
    assert.notEqual(JSON.stringify(one), JSON.stringify(one + 1));
  });

  it('пара людей имеет один ключ независимо от инициатора', () => {
    // Ловит создание двух личных бесед для одной пары.
    assert.equal(directKey('b', 'a'), 'a:b');
    assert.equal(directKey('a', 'b'), 'a:b');
  });

  it('курсор возвращает точный ключ и id, а мусор отвергается', () => {
    // Ловит потерю страницы или 500 на поддельном курсоре.
    const c = { sortKey: 1_800_000_000_000_001, id: 'abcd-1234' };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
    for (const bad of ['1_', '_x', 'a_b', '12345678901234567_x', `${2 ** 53}_x`, '1_a/b', '1_a b', `1_${'x'.repeat(65)}`]) {
      assert.equal(decodeCursor(bad), null, bad);
    }
    assert.deepEqual(decodeCursor(`0_${'x'.repeat(64)}`), { sortKey: 0, id: 'x'.repeat(64) });
  });

  it('отметка прочтения не откатывается от запоздавшего устройства', () => {
    // Ловит повторно вспыхнувшие непрочитанные после старой вкладки.
    assert.equal(readKeyMax(8, 3), 8);
    assert.equal(readKeyMax(8, 9), 9);
  });
});

describe('повтор отправки и видимость', () => {
  const base = { conversationId: 'c', content: 'текст', attachmentRefs: ['a', 'b'], replyToId: null };

  it('отпечаток не зависит от порядка полей объекта и формы пустой цитаты', () => {
    // Ловит ложный 409 при штатном повторе того же сообщения.
    const hash = payloadHash(base);
    assert.equal(payloadHash({ replyToId: undefined, attachmentRefs: ['a', 'b'], content: 'текст', conversationId: 'c' }), hash);
    assert.equal(hash, createHash('sha256').update(JSON.stringify(['p1', 'c', 'текст', ['a', 'b'], null])).digest('hex'));
  });

  it('другая беседа, текст, порядок файлов или цитата меняют отпечаток', () => {
    // Ловит возврат чужого сообщения или молчаливое принятие изменённого повтора.
    const hash = payloadHash(base);
    assert.notEqual(payloadHash({ ...base, conversationId: 'other' }), hash);
    assert.notEqual(payloadHash({ ...base, content: 'другое' }), hash);
    assert.notEqual(payloadHash({ ...base, attachmentRefs: ['b', 'a'] }), hash);
    assert.notEqual(payloadHash({ ...base, replyToId: 'm' }), hash);
  });

  it('отсутствующая, равная и отличающаяся запись различаются', () => {
    // Ловит дубликат или переиспользование clientId с другим содержимым.
    assert.equal(idempotencyDecision(undefined, 'h'), 'insert');
    assert.equal(idempotencyDecision('h', 'h'), 'replay');
    assert.equal(idempotencyDecision('other', 'h'), 'conflict');
    assert.equal(idempotencyDecision(null, 'h'), 'conflict');
  });

  it('надгробие, спрятанное и чужое придержанное невидимы адресно', () => {
    // Ловит показ удалённого текста или утечку блокировки через чужой экран.
    const msg = { authorId: 'a', withheld: false, deletedAt: null, hiddenFor: [] as string[], sortKey: 10 };
    assert.equal(messageView(msg, 'b'), 'full');
    assert.equal(countsAsUnread(msg, 'b', 9), true);
    assert.equal(countsAsUnread(msg, 'b', 10), false);
    assert.equal(countsAsUnread(msg, 'a', 0), false);
    assert.equal(messageView({ ...msg, deletedAt: new Date() }, 'b'), 'gone');
    assert.equal(messageView({ ...msg, hiddenFor: ['b'] }, 'b'), 'gone');
    assert.equal(messageView({ ...msg, withheld: true }, 'b'), 'gone');
    assert.equal(messageView({ ...msg, withheld: true }, 'a'), 'full');
    assert.equal(countsAsUnread({ ...msg, withheld: true }, 'b', 0), false);
  });
});

describe('журнал и догонка', () => {
  it('замки людей берутся в общем порядке и без дублей', () => {
    // Ловит взаимную блокировку встречных отправок двух участников.
    const entries: JournalEntry[] = ['b', 'a', 'b'].map((userId) => ({ userId, conversationId: 'c', kind: 'msg', messageId: 'm' }));
    assert.deepEqual(journalLockOrder(entries), ['a', 'b']);
  });

  it('адресаты действий не раскрывают придержанное и личное удаление', () => {
    // Ловит лишнюю запись журнала у блокировщика или собеседника.
    const common = { actorId: 'a', memberIds: ['b', 'a'], withheld: false, blockedActor: new Set(['b']) };
    for (const action of ['create', 'edit', 'delete-both'] as const) {
      assert.deepEqual(changeAudience({ ...common, action }), ['a', 'b']);
      assert.deepEqual(changeAudience({ ...common, action, withheld: true }), ['a']);
    }
    assert.deepEqual(changeAudience({ ...common, action: 'delete-me' }), ['a']);
    assert.deepEqual(changeAudience({ ...common, action: 'react' }), ['a']);
    assert.deepEqual(changeAudience({ ...common, action: 'react', blockedActor: new Set() }), ['a', 'b']);
  });

  it('потерянный журнал и клиент впереди сервера требуют нового снимка', () => {
    // Ловит тихую потерю изменений после очистки журнала или восстановления базы.
    assert.deepEqual(catchupPlan(4, { pts: 10, minPts: 5 }, [], 2), { reset: true, pts: 10 });
    assert.deepEqual(catchupPlan(11, { pts: 10, minPts: 5 }, [], 2), { reset: true, pts: 10 });
    assert.deepEqual(catchupPlan(5, { pts: 10, minPts: 5 }, [], 2), { reset: false, pts: 10, more: false, rows: [] });
  });

  it('при неполной странице курсор указывает на последнюю отданную строку', () => {
    // Ловит пропуск хвоста при следующем запросе догонки.
    const rows = [{ pts: 6 }, { pts: 7 }, { pts: 8 }];
    assert.deepEqual(catchupPlan(5, { pts: 9, minPts: 5 }, rows, 2),
      { reset: false, pts: 7, more: true, rows: rows.slice(0, 2) });
    assert.deepEqual(catchupPlan(5, { pts: 9, minPts: 5 }, rows.slice(0, 2), 2),
      { reset: false, pts: 9, more: false, rows: rows.slice(0, 2) });
  });
});

describe('анонс беседы', () => {
  it('200 символов остаются целыми, 201 обрезается с многоточием', () => {
    // Ловит превышение лимита и лишнее многоточие на точной границе.
    assert.equal(previewText('x'.repeat(200)), 'x'.repeat(200));
    assert.equal(previewText('x'.repeat(201)), `${'x'.repeat(199)}…`);
  });

  it('переносы строк схлопываются, а эмодзи не разрываются пополам', () => {
    // Ловит битый Unicode в кратком тексте беседы.
    assert.equal(previewText(' один\n\tдва '), 'один два');
    assert.equal(previewText('🙂🙂🙂', 2), '🙂…');
  });
});

describe('чужое удаление в новой личной беседе', () => {
  it('чужое «у обоих» разрешается только с явным правом в 1:1, а крайние случаи сохраняются', () => {
    // Ловит случайное расширение удаления на группы и старые ручки, а также выдачу скрытого/придержанного текста.
    const peer = { authorId: 'b', withheld: false, deletedAt: null, hiddenFor: [] as string[] };
    assert.equal(othersDeletableForBoth('direct'), true);
    assert.equal(othersDeletableForBoth('group'), false);
    assert.equal(deleteDecision(peer, 'a', 'both'), 'forbidden');
    assert.equal(deleteDecision(peer, 'a', 'both', othersDeletableForBoth('direct')), 'tombstone');
    assert.equal(deleteDecision(peer, 'a', 'both', othersDeletableForBoth('group')), 'forbidden');
    assert.equal(deleteDecision(peer, 'a', 'me', true), 'hide');
    assert.equal(deleteDecision({ ...peer, deletedAt: new Date() }, 'a', 'both', true), 'repeat');
    assert.equal(deleteDecision({ ...peer, hiddenFor: ['a'] }, 'a', 'both', true), 'not-found');
    assert.equal(deleteDecision({ ...peer, withheld: true }, 'a', 'both', true), 'not-found');
    assert.equal(batchDeleteDecision(peer, 'a', 'both', true), 'tombstone');
    assert.equal(batchDeleteDecision({ ...peer, deletedAt: new Date() }, 'a', 'both', true), 'skip');
    assert.equal(deleteDecision({ ...peer, authorId: 'a', withheld: true }, 'a', 'both', true), 'tombstone');
    assert.equal(batchDeleteDecision(peer, 'a', 'both'), 'forbidden');
    assert.equal(batchDeleteDecision({ ...peer, hiddenFor: ['a'] }, 'a', 'both', true), 'skip');
    assert.equal(batchDeleteDecision({ ...peer, withheld: true }, 'a', 'both', true), 'not-found');
  });
});

describe('порядок списка бесед с закрепами', () => {
  it('свежий закреп выше старого, оба выше незакреплённых, внутри групп сохраняется недавность', () => {
    // Ловит инверсию времени закрепа и потерю прежнего порядка по последнему сообщению/созданию.
    const pinnedNew = { pinnedAt: '2026-10-07T12:00:00.000Z', lastMessageAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' };
    const pinnedOld = { pinnedAt: '2026-10-06T12:00:00.000Z', lastMessageAt: '2026-10-07T13:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' };
    const recent = { pinnedAt: null, lastMessageAt: '2026-10-07T15:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' };
    const empty = { lastMessageAt: null, createdAt: '2026-10-05T00:00:00.000Z' };
    assert.ok(convListOrder(pinnedNew, pinnedOld) < 0, 'свежезакреплённая беседа должна идти раньше старой');
    assert.ok(convListOrder(pinnedOld, recent) < 0, 'закреплённая беседа должна опережать недавно обновлённую');
    assert.ok(convListOrder(recent, empty) < 0, 'пустые беседы сравниваются по времени создания');
    assert.ok(convListOrder({ ...pinnedOld, pinnedAt: undefined }, { ...pinnedNew, pinnedAt: null }) < 0, 'без закрепов остаётся сортировка по последнему сообщению');

    // Исполняемые контрфакты ловят оба типичных регресса: обратные даты закрепа и весь закреплённый блок внизу.
    const source = convListOrder.toString();
    const reversePinned = runInNewContext(`(${source.replace('pb.localeCompare(pa)', 'pa.localeCompare(pb)')})`) as typeof convListOrder;
    assert.notEqual(reversePinned(pinnedNew, pinnedOld) < 0, true, 'мутант с обратным сравнением дат ломает порядок закрепов');
    const pinLastSource = source.replace(/if\s*\(pa\s*===\s*null\)\s*return\s*1\s*;/, 'if(pa===null)return -1;').replace(/if\s*\(pb\s*===\s*null\)\s*return\s*-1\s*;/, 'if(pb===null)return 1;');
    assert.notEqual(pinLastSource, source, 'якорь мутанта «закреплённые последними» найден');
    const pinLast = runInNewContext(`(${pinLastSource})`) as typeof convListOrder;
    assert.notEqual(pinLast(pinnedNew, recent) < 0, true, 'мутант с закрепами внизу ставит активную беседу выше закрепа');
  });
});
