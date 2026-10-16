import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { fedHash, fedHttpUrl, fedId } from './fieldRules.js';
import * as importConvWire from './convWire.js';
import * as convSync from './convSync.js';
import {
  fedDirectKey,
  pairDirectKey,
  parseConvChangesPage,
  parseConvMessageWire,
  parseConvWire,
  serializeConvChangesPage,
  serializeConvMessageWire,
  serializeConvWire,
} from './convWire.js';
import { parseConvListenWire, serializeConvListenWire } from './convSync.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), 'utf8'));

function loadConvWire(source: string): typeof import('./convWire.js') {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === './fieldRules') return { fedHash, fedHttpUrl, fedId };
      throw new Error(`неожиданный импорт convWire: ${name}`);
    },
  });
  return module.exports as typeof import('./convWire.js');
}

function loadConvSync(source: string): typeof import('./convSync.js') {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === './fieldRules') return { fedId };
      if (name === './convWire') return importConvWire;
      throw new Error(`неожиданный импорт convSync: ${name}`);
    },
  });
  return module.exports as typeof import('./convSync.js');
}

function pairKeyContract(makeKey: typeof pairDirectKey): void {
  const local = { id: 'user-z', homeInstanceId: null, homeUserId: null };
  const guest = { id: 'shadow-local-id', homeInstanceId: 'home-a', homeUserId: 'user-a' };
  const expected = 'home-a:user-a|home-z:user-z';
  const forward = makeKey(local, guest, 'home-z');
  assert.equal(forward, expected, 'смешанный ключ пары должен иметь общий канонический порядок');
  assert.equal(makeKey(guest, local, 'home-z'), forward, 'обе стороны пары должны получить один ключ');
}

describe('провод личных бесед между инстансами', () => {
  it('исторические conv-* примеры разбираются и сохраняют смысл после сериализации', () => {
    // Ловит переименование или удаление поля, которое незаметно сломало бы соседей на прошлой версии.
    const message = parseConvMessageWire(fixture('conv-message.json'));
    assert.ok(message);
    assert.deepEqual(parseConvMessageWire(serializeConvMessageWire(message)), message);

    const conv = parseConvWire(fixture('conv-conversation.json'));
    assert.ok(conv);
    assert.deepEqual(parseConvWire(serializeConvWire(conv)), conv);

    const page = parseConvChangesPage(fixture('conv-changes-page.json'));
    assert.ok(page);
    assert.deepEqual(parseConvChangesPage(serializeConvChangesPage(page)), page);

    const reset = parseConvChangesPage(fixture('conv-changes-reset.json'));
    assert.ok(reset);
    assert.deepEqual(parseConvChangesPage(serializeConvChangesPage(reset)), reset);
  });

  it('старый читатель принимает сообщение нового отправителя с незнакомыми добавочными полями', () => {
    // Ловит строгую схему, которая разрывает федерацию при безопасном добавлении полей в пределах v1.
    const raw = fixture('conv-message.json') as Record<string, unknown>;
    const parsed = parseConvMessageWire({ ...raw, future_sender_field: { feature: 'newer-peer' } });
    assert.deepEqual(parsed, parseConvMessageWire(raw));

    const conv = fixture('conv-conversation.json') as Record<string, unknown>;
    assert.deepEqual(parseConvWire({ ...conv, future_sender_field: { feature: 'newer-peer' } }), parseConvWire(conv));

    const page = fixture('conv-changes-page.json') as Record<string, unknown>;
    const items = page.items as Record<string, unknown>[];
    assert.deepEqual(parseConvChangesPage({
      ...page,
      future_sender_field: { feature: 'newer-peer' },
      items: items.map((item) => ({ ...item, future_sender_field: true })),
    }), parseConvChangesPage(page));

    const reset = fixture('conv-changes-reset.json') as Record<string, unknown>;
    assert.deepEqual(parseConvChangesPage({ ...reset, future_sender_field: { feature: 'newer-peer' } }), parseConvChangesPage(reset));
  });

  it('негодное вложение пропускается отдельно, а соседние корректные вложения остаются', () => {
    // Ловит отказ от всего сообщения из-за одной плохой записи среди валидных вложений.
    const raw = fixture('conv-message.json') as Record<string, unknown>;
    const message = parseConvMessageWire({ ...raw, attachments: [{ id: '', size: -1 }, ...(raw.attachments as unknown[])] });
    assert.ok(message);
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0]?.id, '0199d2a1-aaaa-7d4e-8f5a-6b7c8d9e0f1a');
  });

  it('негодная строка журнала пропускается отдельно, не скрывая корректные изменения', () => {
    // Ловит потерю всей страницы догонки из-за одной повреждённой строки очереди.
    const raw = fixture('conv-changes-page.json') as Record<string, unknown>;
    const items = raw.items as unknown[];
    const page = parseConvChangesPage({ ...raw, items: [{ seq: 'bad', kind: 'msg' }, ...items] });
    const originalPage = parseConvChangesPage(raw);
    assert.ok(page && !('reset' in page));
    assert.ok(originalPage && !('reset' in originalPage));
    assert.equal(page.items.length, items.length);
    assert.deepEqual(page.items, originalPage.items);
  });

  it('негодный участник беседы пропускается поштучно', () => {
    // Ловит потерю всех участников и отказ от беседы из-за одной испорченной записи списка.
    const raw = fixture('conv-conversation.json') as Record<string, unknown>;
    const members = raw.members as unknown[];
    const conv = parseConvWire({ ...raw, members: [{ instance_id: '', user_id: 'broken' }, ...members] });
    assert.ok(conv);
    assert.equal(conv.members.length, members.length);
    assert.deepEqual(conv.members, parseConvWire(raw)?.members);
  });

  it('негодный конверт сообщения целиком даёт null', () => {
    // Ловит частичное принятие сообщения без обязательной идентичности или автора.
    assert.equal(parseConvMessageWire({ id: 'm', content: 'text' }), null);
  });

  it('негодный конверт беседы целиком даёт null', () => {
    // Ловит создание неполной беседы без участников или происхождения.
    assert.equal(parseConvWire({ id: 'c', kind: 'direct', members: [] }), null);
  });

  it('негодный конверт страницы журнала целиком даёт null', () => {
    // Ловит принятие страницы без инстанса-владельца журнала или с невозможным курсором.
    assert.equal(parseConvChangesPage({ seq: 1, items: [] }), null);
    assert.equal(parseConvChangesPage({ instance_id: 'i', seq: -1, items: [] }), null);
  });

  it('ключи пары симметричны, местный формат сохранён, смешанная пара глобальна', () => {
    // Ловит две беседы для одной пары, если стороны по-разному упорядочат локального и теневого участника.
    const first = { instanceId: 'home-z', userId: 'user-z' };
    const second = { instanceId: 'home-a', userId: 'user-a' };
    assert.equal(fedDirectKey(first, second), fedDirectKey(second, first));
    assert.equal(fedDirectKey(first, second), 'home-a:user-a|home-z:user-z');

    const localA = { id: 'user-z', homeInstanceId: null, homeUserId: null };
    const localB = { id: 'user-a', homeInstanceId: null, homeUserId: null };
    assert.equal(pairDirectKey(localA, localB, 'home-z'), 'user-a:user-z');
    assert.equal(pairDirectKey(localB, localA, 'home-z'), 'user-a:user-z');
    assert.equal(pairDirectKey(localA, localB, null), 'user-a:user-z');

    const guest = { id: 'shadow-local-id', homeInstanceId: 'home-a', homeUserId: 'user-a' };
    assert.equal(pairDirectKey(localA, guest, 'home-z'), 'home-a:user-a|home-z:user-z');
    assert.equal(pairDirectKey(guest, localA, 'home-z'), 'home-a:user-a|home-z:user-z');
    assert.equal(pairDirectKey(localA, guest, null), 'shadow-local-id:user-z');
  });

  it('контрфакт: целый модуль отвергает pairDirectKey без сортировки глобальных участников', () => {
    // Ловит регрессию в реальном модуле, а не в отдельно переписанном фрагменте функции.
    const source = readFileSync(new URL('./convWire.ts', import.meta.url), 'utf8');
    pairKeyContract(loadConvWire(source).pairDirectKey);

    const anchor = '  return fedDirectKey(ref(one), ref(two));';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь сортировки pairDirectKey должен быть уникальным');
    const unsorted =
      '  const first = ref(one);\n' +
      '  const second = ref(two);\n' +
      '  return `${first.instanceId}:${first.userId}|${second.instanceId}:${second.userId}`;';
    assert.throws(
      () => pairKeyContract(loadConvWire(source.replace(anchor, unsorted)).pairDirectKey),
      (error) => error instanceof assert.AssertionError && error.message.includes('смешанный ключ пары должен иметь общий канонический порядок'),
      'контракт должен отвергнуть модульный мутант без сортировки',
    );
  });

  it('новый отправитель сохраняет GIF и кружок в настоящем conv-message-e3', () => {
    // Класс ошибки: сосед получает mp4 без типа показа и отображает GIF или кружок как обычное видео.
    const message = parseConvMessageWire(fixture('conv-message-e3.json'));
    assert.ok(message);
    assert.equal(message.attachments.length, 2);
    assert.equal(message.attachments[0]?.round, true);
    assert.equal(message.attachments[0]?.gif, undefined);
    assert.equal(message.attachments[1]?.gif, true);
    assert.equal(message.attachments[1]?.round, undefined);
    const wire = serializeConvMessageWire(message);
    const attachments = wire.attachments as Record<string, unknown>[];
    assert.equal(attachments[0]?.round, true);
    assert.equal(Object.hasOwn(attachments[0]!, 'gif'), false);
    assert.equal(attachments[1]?.gif, true);
    assert.equal(Object.hasOwn(attachments[1]!, 'round'), false);
    assert.deepEqual(parseConvMessageWire(wire), message);
  });

  it('настоящий conv-listen-e3 сохраняет spent, всех слушателей и once у вложения', () => {
    // Класс ошибки: потерянное состояние «один раз» оставляет уже прослушанную копию доступной.
    const rawPage = fixture('conv-listen-e3.json');
    const page = parseConvChangesPage(rawPage);
    assert.ok(page && 'items' in page);
    const messageRow = page.items.find((item) => item.kind === 'msg');
    const listenRow = page.items.find((item) => item.kind === 'listen');
    assert.ok(messageRow?.entity && listenRow?.entity);
    const message = parseConvMessageWire(messageRow.entity);
    assert.ok(message);
    assert.equal(message.attachments[0]?.once, true);
    const messageWire = serializeConvMessageWire(message);
    assert.equal((messageWire.attachments as Record<string, unknown>[])[0]?.once, true);
    assert.deepEqual(parseConvMessageWire(messageWire), message);

    const listen = parseConvListenWire(listenRow.entity);
    assert.ok(listen);
    assert.equal(listen.spent, true);
    assert.equal(listen.listeners.length, 1);
    assert.equal(listen.listeners[0]?.userId, '0193f1a2-5c6d-7e8f-9a0b-1c2d3e4f5a6b');
    const listenWire = serializeConvListenWire(listen);
    assert.equal(listenWire.spent, true);
    assert.deepEqual(parseConvListenWire(listenWire), listen);

    const twoPeople = [
      { instanceId: 'kn2djtbwr4u3rsjkpze2o45obli6aajt', userId: '0193f1a2-5c6d-7e8f-9a0b-1c2d3e4f5a6b' },
      { instanceId: 'home-b', userId: '0193f1a2-5c6d-7e8f-9a0b-1c2d3e4f5a6c' },
    ];
    const withBadListener = parseConvListenWire({
      message_id: listenWire.message_id,
      listeners: [{ instance_id: '', user_id: 'invalid' }, ...twoPeople.map((p) => ({ instance_id: p.instanceId, user_id: p.userId }))],
    });
    assert.ok(withBadListener);
    assert.deepEqual(withBadListener.listeners.map((p) => `${p.instanceId}:${p.userId}`), twoPeople.map((p) => `${p.instanceId}:${p.userId}`));
    const unspent = serializeConvListenWire({ messageId: listen.messageId, listeners: listen.listeners, spent: false });
    assert.equal(Object.hasOwn(unspent, 'spent'), false);
    assert.equal(Object.hasOwn(parseConvListenWire({ ...listenWire, spent: false })!, 'spent'), false);
  });

  it('контрфакт: целый convSync не теряет spent при чтении listen', () => {
    // Класс ошибки: подтверждение прослушивания теряет единственный wire-флаг, который гасит once-копию.
    const raw = fixture('conv-listen-e3.json') as Record<string, unknown>;
    const items = raw.items as Record<string, unknown>[];
    const listen = items.find((item) => item.kind === 'listen')?.entity;
    assert.ok(listen && typeof listen === 'object');
    const check = (api: typeof import('./convSync.js')) => {
      const parsed = api.parseConvListenWire(listen);
      assert.ok(parsed);
      assert.equal(parsed.spent, true, 'разбор должен сохранить spent=true');
    };
    const source = readFileSync(new URL('./convSync.ts', import.meta.url), 'utf8');
    check(loadConvSync(source));
    const anchor = '...(r.spent === true ? { spent: true } : {})';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь разбора spent должен быть уникальным');
    const mutant = source.replace(anchor, '');
    assert.throws(
      () => check(loadConvSync(mutant)),
      (error) => error instanceof assert.AssertionError && error.message.includes('разбор должен сохранить spent=true'),
      'мутант с целым модулем должен потерять spent и быть отвергнут',
    );
  });

  it('контрфакт: сериализатор listen не записывает spent=false', () => {
    // Класс ошибки: старый сосед принимает ложное подтверждение расхода и удаляет одноразовый оригинал.
    const source = readFileSync(new URL('./convSync.ts', import.meta.url), 'utf8');
    const anchor = '...(l.spent ? { spent: true } : {})';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь сериализации spent должен быть уникальным');
    const check = (api: typeof import('./convSync.js')) => {
      const wire = api.serializeConvListenWire({ messageId: '0199d2a1-7b3c-7d4e-8f5a-6b7c8d9e0f1b', listeners: [], spent: false });
      assert.equal(Object.hasOwn(wire, 'spent'), false, 'провод не должен утверждать spent при false');
    };
    check(loadConvSync(source));
    assert.throws(
      () => check(loadConvSync(source.replace(anchor, '...(l.spent === true ? { spent: true } : { spent: false })'))),
      (error) => error instanceof assert.AssertionError && error.message.includes('провод не должен утверждать spent при false'),
      'мутант сериализации должен быть пойман тем же wire oracle',
    );
  });

  it('контрфакт: целый convSync не обрезает валидных слушателей по одному', () => {
    // Класс ошибки: второй слушатель исчезает из состояния соседа и не видит подтверждение прослушивания.
    const raw = {
      message_id: '0199d2a1-7b3c-7d4e-8f5a-6b7c8d9e0f1b',
      listeners: [
        { instance_id: 'kn2djtbwr4u3rsjkpze2o45obli6aajt', user_id: '0193f1a2-5c6d-7e8f-9a0b-1c2d3e4f5a6b' },
        { instance_id: 'home-b', user_id: '0193f1a2-5c6d-7e8f-9a0b-1c2d3e4f5a6c' },
      ],
    };
    const check = (api: typeof import('./convSync.js')) => {
      const parsed = api.parseConvListenWire(raw);
      assert.ok(parsed);
      assert.equal(parsed.listeners.length, 2, 'оба валидных слушателя должны сохраниться');
    };
    const source = readFileSync(new URL('./convSync.ts', import.meta.url), 'utf8');
    check(loadConvSync(source));
    const anchor = 'r.listeners.slice(0, LIST_MAX)';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь списка слушателей должен быть уникальным');
    assert.throws(
      () => check(loadConvSync(source.replace(anchor, 'r.listeners.slice(0, 1)'))),
      (error) => error instanceof assert.AssertionError && error.message.includes('оба валидных слушателя должны сохраниться'),
      'мутант с усечённым списком должен проиграть парному случаю двух слушателей',
    );
  });

  it('контрфакт: целый convWire сериализует once у голосового вложения', () => {
    // Класс ошибки: исчезнувший once превращает одноразовое вложение в обычное, которое можно переслушивать.
    const source = readFileSync(new URL('./convWire.ts', import.meta.url), 'utf8');
    const rawPage = fixture('conv-listen-e3.json') as Record<string, unknown>;
    const msgEntity = (rawPage.items as Record<string, unknown>[]).find((item) => item.kind === 'msg')?.entity;
    assert.ok(msgEntity && typeof msgEntity === 'object');
    const check = (api: typeof import('./convWire.js')) => {
      const parsed = api.parseConvMessageWire(msgEntity);
      assert.ok(parsed);
      const wire = api.serializeConvMessageWire(parsed);
      assert.equal((wire.attachments as Record<string, unknown>[])[0]?.once, true, 'wire должен сохранить once=true');
    };
    check(loadConvWire(source));
    const anchor = '...(a.once ? { once: true } : {}),';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь сериализации once должен быть уникальным');
    assert.throws(
      () => check(loadConvWire(source.replace(anchor, ''))),
      (error) => error instanceof assert.AssertionError && error.message.includes('wire должен сохранить once=true'),
      'мутант целого сериализатора обязан быть обнаружен настоящим once fixture',
    );
  });
});
