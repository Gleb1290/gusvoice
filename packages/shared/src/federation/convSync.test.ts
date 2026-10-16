import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { fedId } from './fieldRules';
import {
  parseConvChangesPage,
  parsePersonRef,
  serializeConvChangesPage,
  serializePersonRef,
} from './convWire';
import {
  FED_DM_LATE_MS,
  parseConvChangedPayload,
  parseConvPinWire,
  parseConvReadsWire,
  parseConvReactionsWire,
  serializeConvPinWire,
  serializeConvReadsWire,
  serializeConvReactionsWire,
  type FedConvPinWire,
  type FedConvReadsWire,
  type FedConvReactionsWire,
} from './convSync';

const USER = { instanceId: 'home-instance', userId: 'person-1' };
const USER_WIRE = serializePersonRef(USER);
const MESSAGE = 'message-1';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

function loadConvSync(source: string) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require: (id: string) => {
      if (id === './fieldRules') return { fedId };
      if (id === './convWire') return { parsePersonRef, serializePersonRef };
      throw new Error(`неожиданный импорт convSync: ${id}`);
    },
  });
  return mod.exports as typeof import('./convSync');
}

function mutatedConvSync(from: string, to: string) {
  const source = readFileSync(new URL('./convSync.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const occurrences = source.split(from).length - 1;
  assert.equal(occurrences, 1, `реальный convSync.ts содержит ровно один якорь мутации: ${from}`);
  return loadConvSync(source.replace(from, to));
}

describe('провод синхронизации ЛС между инстансами', () => {
  it('историческая страница Э2 разбирается и сериализуется обратно без потери реакций, чтения и закрепов', () => {
    // Класс ошибки: корректная запись нового вида может быть потеряна при совместимости со старым конвертом.
    const raw = fixture('conv-changes-page-e2.json');
    const page = parseConvChangesPage(raw);
    assert.ok(page && !('reset' in page));
    assert.deepEqual(serializeConvChangesPage(page), raw);
    assert.deepEqual(page.items.map((item) => item.kind), ['react', 'read', 'pin', 'pin']);
  });

  it('неизвестные поля страницы, события и записей не меняют известную часть провода', () => {
    // Класс ошибки: новая версия соседа расширяет JSON, а старый читатель начинает отбрасывать всю страницу.
    const rawPage = fixture('conv-changes-page-e2.json');
    const pageWithUnknown = {
      ...rawPage,
      unknown_top: { nested: true },
      items: (rawPage.items as Record<string, unknown>[]).map((item) => ({ ...item, unknown_item: ['future'] })),
    };
    assert.deepEqual(parseConvChangesPage(pageWithUnknown), parseConvChangesPage(rawPage));

    const event = fixture('event-conv-changed.json');
    const events = event.events as Record<string, unknown>[];
    const payload = events[0]!.payload as Record<string, unknown>;
    assert.deepEqual(parseConvChangedPayload({ ...payload, future: { nested: 1 } }), parseConvChangedPayload(payload));

    assert.deepEqual(parseConvReactionsWire({
      message_id: MESSAGE, future: true,
      reactions: [{ user: { ...USER_WIRE, future_person_field: true }, emoji: '👍', future_reaction_field: true }],
    }), { messageId: MESSAGE, reactions: [{ user: USER, emoji: '👍' }] });
    assert.deepEqual(parseConvReadsWire({
      future: true,
      reads: [{ user: { ...USER_WIRE, future_person_field: true }, message_id: MESSAGE, future_read_field: true }],
    }), { reads: [{ user: USER, messageId: MESSAGE }] });
    assert.deepEqual(parseConvPinWire({
      message_id: MESSAGE, pinned: true,
      by: { ...USER_WIRE, future_person_field: true }, future: true,
    }), {
      messageId: MESSAGE, pinned: true, by: USER,
    });
    assert.deepEqual(parseConvPinWire({ message_id: MESSAGE, pinned: false, by: null, future: true }), {
      messageId: MESSAGE, pinned: false, by: null,
    });
  });

  it('битая запись реакции или чтения пропускается отдельно, соседняя корректная запись остаётся', () => {
    // Класс ошибки: один испорченный элемент не должен стирать валидное состояние всей беседы.
    const reaction = (user: unknown, emoji: unknown) => ({ user, emoji });
    const reactions = parseConvReactionsWire({
      message_id: MESSAGE,
      reactions: [
        null,
        reaction({ instance_id: 'home-instance', user_id: 'person-1' }, ''),
        reaction({ instance_id: 'home-instance', user_id: 'bad/user' }, '👍'),
        reaction({ instance_id: 'home-instance', user_id: 'person-1' }, '👍'),
      ],
    });
    assert.deepEqual(reactions, { messageId: MESSAGE, reactions: [{ user: USER, emoji: '👍' }] });

    const reads = parseConvReadsWire({ reads: [null, { user: USER_WIRE, message_id: '' }, { user: { instance_id: 'x/y', user_id: 'u' }, message_id: MESSAGE }, { user: USER_WIRE, message_id: MESSAGE }] });
    assert.deepEqual(reads, { reads: [{ user: USER, messageId: MESSAGE }] });

    const page = fixture('conv-changes-page-e2.json');
    const first = (page.items as Record<string, unknown>[])[0]!;
    const badEntry = { ...first, seq: 'bad' };
    const parsedPage = parseConvChangesPage({ ...page, items: [badEntry, first] });
    assert.ok(parsedPage && !('reset' in parsedPage));
    assert.equal(parsedPage.items.length, 1);
  });

  it('плохой конверт даёт null, а пустая нагрузка закрепа остаётся допустимым снятием', () => {
    // Класс ошибки: повреждённый внешний объект не должен притворяться пустым успешным обновлением.
    assert.equal(parseConvReactionsWire(null), null);
    assert.equal(parseConvReactionsWire({ message_id: MESSAGE, reactions: {} }), null);
    assert.equal(parseConvReadsWire({ reads: null }), null);
    assert.equal(parseConvPinWire({ message_id: MESSAGE, pinned: 'false', by: null }), null);
    assert.equal(parseConvChangedPayload(null), null);
    assert.equal(parseConvChangedPayload({ seq: '7' }), null);
    assert.equal(parseConvChangesPage({ instance_id: 'home-instance', seq: 1, items: null }), null);
    assert.deepEqual(parseConvPinWire({ message_id: MESSAGE, pinned: false, by: null }), { messageId: MESSAGE, pinned: false, by: null });
  });

  it('реакция длиной 64 символа принимается, а 65 пропускается без потери других реакций', () => {
    // Класс ошибки: разная длина граничного эмодзи должна менять только этот элемент, не всю пачку.
    const longOk = '😀'.repeat(32);
    const longBad = 'x'.repeat(65);
    const result = parseConvReactionsWire({
      message_id: MESSAGE,
      reactions: [
        { user: USER_WIRE, emoji: longOk },
        { user: { instance_id: 'home-instance', user_id: 'person-2' }, emoji: longBad },
        { user: { instance_id: 'home-instance', user_id: 'person-3' }, emoji: '🔥' },
      ],
    });
    assert.deepEqual(result?.reactions.map((item) => item.emoji), [longOk, '🔥']);
  });

  it('списки ровно по 200 элементов принимаются, элемент 201 обрезается у реакции и чтения', () => {
    // Класс ошибки: лимит соседа обязан ограничить работу, не потеряв ровно допустимую последнюю запись.
    const reactions = Array.from({ length: 201 }, (_, i) => ({ user: { instance_id: 'home-instance', user_id: `u${i}` }, emoji: '👍' }));
    const reads = Array.from({ length: 201 }, (_, i) => ({ user: { instance_id: 'home-instance', user_id: `u${i}` }, message_id: `m${i}` }));
    assert.equal(parseConvReactionsWire({ message_id: MESSAGE, reactions: reactions.slice(0, 200) })?.reactions.length, 200);
    assert.equal(parseConvReactionsWire({ message_id: MESSAGE, reactions })?.reactions.length, 200);
    assert.equal(parseConvReadsWire({ reads: reads.slice(0, 200) })?.reads.length, 200);
    assert.equal(parseConvReadsWire({ reads })?.reads.length, 200);
  });

  it('реакции, прочитанное до и закреп проходят serialize→parse с сохранением идентичности людей', () => {
    // Класс ошибки: разные сериализаторы расходятся в именах полей и незаметно меняют глобального автора.
    const values: [FedConvReactionsWire, FedConvReadsWire, FedConvPinWire] = [
      { messageId: MESSAGE, reactions: [{ user: USER, emoji: '👍' }] },
      { reads: [{ user: USER, messageId: MESSAGE }] },
      { messageId: MESSAGE, pinned: true, by: USER },
    ];
    assert.deepEqual(parseConvReactionsWire(serializeConvReactionsWire(values[0])), values[0]);
    assert.deepEqual(parseConvReadsWire(serializeConvReadsWire(values[1])), values[1]);
    assert.deepEqual(parseConvPinWire(serializeConvPinWire(values[2])), values[2]);
    assert.deepEqual(parseConvPinWire(serializeConvPinWire({ messageId: MESSAGE, pinned: false, by: null })), {
      messageId: MESSAGE, pinned: false, by: null,
    });
  });

  it('conv.changed принимает ноль и целые номера, но отклоняет отрицательные, дробные и нечисловые', () => {
    // Класс ошибки: отрицательный или дробный курсор может перескочить либо повторно запросить журнал.
    const rawEvent = fixture('event-conv-changed.json');
    const event = (rawEvent.events as Record<string, unknown>[])[0]!;
    assert.equal((parseConvChangedPayload(event.payload)?.seq), 24);
    assert.deepEqual(parseConvChangedPayload({ seq: 0 }), { seq: 0 });
    assert.deepEqual(parseConvChangedPayload({ seq: Number.MAX_SAFE_INTEGER }), { seq: Number.MAX_SAFE_INTEGER });
    for (const seq of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '24', null]) assert.equal(parseConvChangedPayload({ seq }), null);
    assert.equal(parseConvChangesPage({ instance_id: 'home-instance', seq: -1, items: [] }), null);
    assert.deepEqual(parseConvChangesPage({ instance_id: 'home-instance', seq: 0, more: false, items: [] }), {
      instanceId: 'home-instance', seq: 0, more: false, items: [],
    });
  });

  it('опоздание строго больше пяти минут; часы автора вперёд и нечисловое время не помечаются', () => {
    // Класс ошибки: граничная доставка или расходящиеся часы ошибочно показывают «доставлено позже».
    const check = (api: typeof import('./convSync')) => {
      assert.equal(api.deliveredLate(10_000, 10_000 - 1), false, 'часы автора вперёд не означают позднюю доставку');
      assert.equal(api.deliveredLate(10_000, 10_000 + 5 * 60_000 - 1), false, '5 минут − 1 мс ещё не поздняя доставка');
      assert.equal(api.deliveredLate(10_000, 10_000 + 5 * 60_000), false, 'ровно 5 минут ещё не поздняя доставка');
      assert.equal(api.deliveredLate(10_000, 10_000 + 5 * 60_000 + 1), true, '5 минут + 1 мс уже поздняя доставка');
      assert.equal(api.deliveredLate(Number.NaN, 10_000 + 5 * 60_000 + 1), false, 'нечисловое время отправки не сравнивается');
      assert.equal(api.deliveredLate(10_000, Number.POSITIVE_INFINITY), false, 'бесконечное время прихода не считается доставкой');
    };
    assert.equal(FED_DM_LATE_MS, 5 * 60_000);
    const original = loadConvSync(readFileSync(new URL('./convSync.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
    check(original);
    const mutant = mutatedConvSync('export const FED_DM_LATE_MS = 5 * 60_000;', 'export const FED_DM_LATE_MS = 2 * 60_000;');
    assert.throws(
      () => check(mutant),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes('5 минут − 1 мс'),
      'мутант с порогом две минуты должен провалить именно границу 5 минут − 1 мс',
    );
  });
});
