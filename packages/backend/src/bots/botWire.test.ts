import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import type { ConvMessage } from '@gusvoice/shared';
import { z } from 'zod';
import * as wire from './botWire.js';

// Исторические образцы v1, 2026-10-26. НЕ обновлять вслед за сериализатором: новые поля — новые образцы.
// Как check-protocol: фиксированные байты + отдельные отпечатки + настоящий разбор.
// example.invalid и условные id — публичные синтетические данные, не адреса пользователей/стенда.
const frozen = {
  getMe: '{"ok":true,"result":{"id":"bot-1","username":"helperbot","display_name":"Помощник","bot":true,"description":"Описание","about":"О боте","public":false}}',
  getUpdates: '{"ok":true,"result":[{"update_id":101,"message":{"message_id":"m-1","chat":{"id":"chat-1","type":"dm"},"from":{"id":"person-1","username":"tester","display_name":"Испытатель","bot":false},"date":1700000000,"text":"/start"}},{"update_id":102,"edited_message":{"message_id":"m-1","chat":{"id":"chat-1","type":"dm"},"from":{"id":"person-1","username":"tester","display_name":"Испытатель","bot":false},"date":1700000000,"edit_date":1700000001,"text":"изменено","reply_to_message_id":"m-0","attachments":[{"url":"https://example.invalid/file","file_name":"note.txt","mime_type":"text/plain","file_size":4}],"embeds":[{"title":"Карточка","description":"Детали"}]}},{"update_id":103,"message_deleted":{"message_id":"m-1","chat":{"id":"chat-1","type":"dm"},"date":1700000002}},{"update_id":104,"my_chat_member":{"chat":{"id":"chat-1","type":"dm"},"from":{"id":"person-1","username":"tester","display_name":"Испытатель","bot":false},"date":1700000003,"old_status":"left","new_status":"member"}}]}',
  sendMessage: '{"ok":true,"result":{"message_id":"m-2","chat":{"id":"chat-1","type":"dm"},"from":{"id":"bot-1","username":"helperbot","display_name":"Помощник","bot":true},"date":1700000000,"edit_date":1700000001,"text":"Ответ","reply_to_message_id":"m-0","attachments":[{"url":"https://example.invalid/file","file_name":"note.txt","mime_type":"text/plain","file_size":4}],"embeds":[{"title":"Карточка","description":"Детали"}]}}',
  getWebhookInfoEmpty: '{"ok":true,"result":{"url":"","pending_update_count":0,"failures":0}}',
  getWebhookInfo: '{"ok":true,"result":{"url":"https://example.invalid/hook","pending_update_count":3,"failures":10,"last_error_date":1700000001,"last_error_message":"ответ 500","disabled_date":1700000002}}',
  error: '{"ok":false,"error_code":401,"description":"Unauthorized"}',
  rateError: '{"ok":false,"error_code":429,"description":"Too Many Requests","retry_after":5}',
} as const;

// SHA-256 исходных UTF-8 строк, вычисленные независимо (.NET), не сериализатором приложения.
const hashes: Record<keyof typeof frozen, string> = {
  getMe: '42050fc438bf583beaa648daead3fb54d5c421cbf7e85e28c1d1f0a21f4e6285',
  getUpdates: '2917152b1c5231a017071f8d28c3cbb2eb156e6880467eeddeb44a13dc0b3af9',
  sendMessage: '9d9d9722af310ca5ca4557dd924873f71518cdd1c6f99b0c835be4edef0f9a8b',
  getWebhookInfoEmpty: '11b282ff40a6a9193192200ef5e76fd7d3818bc162036cf983aa0d6ffd410be8',
  getWebhookInfo: '7f0d08e3549b25c16a388e94064874ef0a9bdc895c6b3fc439fb04eb954eee13',
  error: '5b8cd38cfdf83e8d0a46af7c34ecb2962621aa69f6eb8458e7c86ac7a66a2948',
  rateError: '6b1b3481d778a85a0acc745ab711792863bb5a8861155b96a13c76a33f3bf52b',
};

const schemas: Record<keyof typeof frozen, z.ZodType> = {
  getMe: wire.wireOk.extend({ result: wire.wireBot }),
  getUpdates: wire.wireOk.extend({ result: z.array(wire.wireUpdate) }),
  sendMessage: wire.wireOk.extend({ result: wire.wireMessage }),
  getWebhookInfoEmpty: wire.wireOk.extend({ result: wire.wireWebhookInfo }),
  getWebhookInfo: wire.wireOk.extend({ result: wire.wireWebhookInfo }),
  error: wire.wireError,
  rateError: wire.wireError,
};

/** Проверяем старые поля рекурсивно, но разрешаем новые: exact deepEqual целого ответа запретил бы эволюцию v1. */
function knownFields(actual: unknown, expected: unknown, path = '$'): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} остаётся массивом`);
    assert.equal(actual.length, expected.length, `${path} не теряет исторические элементы`);
    expected.forEach((v, i) => knownFields(actual[i], v, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${path} остаётся объектом`);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), `${path}.${key} не исчезло`);
      knownFields((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
  } else assert.strictEqual(actual, expected, `${path} сохраняет значение и тип`);
}

function richMessage(): ConvMessage {
  return {
    id: 'm-2', channelId: '', conversationId: 'chat-1', sortKey: 1, clientId: null,
    author: { id: 'bot-1', username: 'helperbot', displayName: 'Помощник', avatarUrl: null, bot: true },
    content: 'Ответ', createdAt: '2023-11-14T22:13:20.999Z', editedAt: '2023-11-14T22:13:21.999Z', reactions: [],
    replyTo: { id: 'm-0', content: 'Вопрос', authorName: 'Испытатель' },
    attachments: [{ url: 'https://example.invalid/file', name: 'note.txt', contentType: 'text/plain', size: 4 }],
    embeds: [{ title: 'Карточка', description: 'Детали' }],
  };
}

describe('Bot API v1: неизменяемые исторические ответы', () => {
  for (const name of Object.keys(frozen) as (keyof typeof frozen)[]) it(`${name}: байты заморожены, настоящая схема сохраняет все известные поля`, () => {
    assert.equal(createHash('sha256').update(frozen[name], 'utf8').digest('hex'), hashes[name], 'исторический образец нельзя переписывать');
    const raw: unknown = JSON.parse(frozen[name]);
    knownFields(schemas[name].parse(raw), raw);
  });

  it('новые поля разрешены, но старые не теряются при разборе', () => {
    const raw = JSON.parse(frozen.sendMessage);
    const withAdditions = { ...raw, future_envelope: true, result: { ...raw.result, future_message: 1, from: { ...raw.result.from, future_user: 'x' } } };
    knownFields(schemas.sendMessage.parse(withAdditions), raw);
    knownFields({ ...raw, future_envelope: true }, raw);
  });

  it('getMe сохраняет обязательные типы бота, а не просто непустой объект', () => {
    const raw = JSON.parse(frozen.getMe);
    for (const key of ['id', 'username', 'display_name', 'bot', 'description', 'about', 'public']) {
      const result = { ...raw.result }; delete result[key];
      assert.equal(schemas.getMe.safeParse({ ...raw, result }).success, false, `без ${key}`);
      assert.equal(schemas.getMe.safeParse({ ...raw, result: { ...raw.result, [key]: key === 'bot' || key === 'public' ? 'true' : 123 } }).success, false, `тип ${key}`);
    }
  });

  it('четыре вида события проверяют вложенный груз, строки id и числа времени', () => {
    const raw = JSON.parse(frozen.getUpdates);
    assert.deepEqual(raw.result.map((u: Record<string, unknown>) => Object.keys(u).filter(k => k !== 'update_id')[0]),
      ['message', 'edited_message', 'message_deleted', 'my_chat_member']);
    for (const update of raw.result) {
      const key = Object.keys(update).find(k => k !== 'update_id')!;
      assert.equal(wire.wireUpdate.safeParse({ ...update, update_id: '101' }).success, false);
      assert.equal(wire.wireUpdate.safeParse({ ...update, [key]: { ...update[key], date: '1700000000' } }).success, false);
      assert.equal(wire.wireUpdate.safeParse({ ...update, [key]: { ...update[key], chat: { id: 123, type: 'dm' } } }).success, false);
      for (const type of ['channel', 'server']) assert.equal(wire.wireUpdate.safeParse({ ...update, [key]: { ...update[key], chat: { id: 'chat-1', type } } }).success, true);
      assert.equal(wire.wireUpdate.safeParse({ ...update, [key]: { ...update[key], chat: { id: 'chat-1', type: 'unknown' } } }).success, false);
    }
    assert.equal(wire.wireUpdate.safeParse({ message: raw.result[0].message }).success, false, 'update_id обязателен');
    const edited = raw.result[1].edited_message;
    for (const [key, bad] of [['message_id', 1], ['text', null], ['edit_date', '1700000001'], ['reply_to_message_id', 1], ['attachments', {}]]) {
      assert.equal(wire.wireMessage.safeParse({ ...edited, [key as string]: bad }).success, false, String(key));
    }
    for (const key of ['message_id', 'chat', 'from', 'date', 'text']) {
      const missing = { ...edited }; delete missing[key];
      assert.equal(wire.wireMessage.safeParse(missing).success, false, `${key} обязателен`);
    }
    for (const key of ['url', 'file_name', 'mime_type', 'file_size']) {
      const bad = { ...edited.attachments[0], [key]: key === 'file_size' ? '4' : 4 };
      assert.equal(wire.wireMessage.safeParse({ ...edited, attachments: [bad] }).success, false, key);
      delete bad[key];
      assert.equal(wire.wireAttachment.safeParse(bad).success, false, `${key} обязателен`);
    }
    for (const key of ['old_status', 'new_status']) assert.equal(wire.wireChatMember.safeParse({ ...raw.result[3].my_chat_member, [key]: 'unknown' }).success, false);
  });

  it('webhookInfo и ошибки не принимают смену типа известных полей', () => {
    const info = JSON.parse(frozen.getWebhookInfo).result;
    for (const key of ['url', 'pending_update_count', 'failures', 'last_error_date', 'last_error_message', 'disabled_date']) {
      assert.equal(wire.wireWebhookInfo.safeParse({ ...info, [key]: typeof info[key] === 'number' ? '1' : 1 }).success, false, key);
    }
    for (const key of ['url', 'pending_update_count', 'failures']) {
      const missing = { ...info }; delete missing[key];
      assert.equal(wire.wireWebhookInfo.safeParse(missing).success, false, `${key} обязателен`);
    }
    const error = JSON.parse(frozen.rateError);
    for (const [key, bad] of [['ok', true], ['error_code', '429'], ['description', 1], ['retry_after', '5']]) {
      assert.equal(wire.wireError.safeParse({ ...error, [key as string]: bad }).success, false, String(key));
    }
    for (const key of ['ok', 'error_code', 'description']) {
      const missing = { ...error }; delete missing[key];
      assert.equal(wire.wireError.safeParse(missing).success, false, `${key} обязателен`);
    }
  });
});

describe('Bot API v1: настоящие чистые сериализаторы против исторического провода', () => {
  it('sendMessage сохраняет snake_case, секунды, ответ, вложение и карточку', () => {
    const actual = wire.okBody(wire.toWireMessage(richMessage()));
    knownFields(actual, JSON.parse(frozen.sendMessage));
    assert.equal(schemas.sendMessage.safeParse(actual).success, true);
  });

  it('входящее message и edited_message используют тот же провод и времена, что исторические события', () => {
    const message = richMessage();
    message.id = 'm-1'; message.author = { id: 'person-1', username: 'tester', displayName: 'Испытатель', avatarUrl: null };
    message.content = '/start'; message.editedAt = null; message.replyTo = null; message.attachments = []; delete message.embeds;
    const expected = JSON.parse(frozen.getUpdates).result;
    knownFields(wire.toWireMessage(message), expected[0].message);
    const edited = { ...richMessage(), id: 'm-1', author: message.author, content: 'изменено' };
    knownFields(wire.toWireMessage(edited), expected[1].edited_message);
  });

  it('у простого сообщения нет пустых optional-полей, fallback карточек не становится текстом бота', () => {
    const simple = { ...richMessage(), editedAt: null, replyTo: null, attachments: [], embeds: [] };
    const actual = wire.toWireMessage(simple);
    for (const key of ['edit_date', 'reply_to_message_id', 'attachments', 'embeds']) assert.equal(Object.hasOwn(actual, key), false, key);
    assert.equal(wire.toWireMessage({ ...simple, embedsFallback: true }).text, '');
    assert.equal(actual.text, 'Ответ');
  });

  it('имя пользователя подставляется только вместо null, bot true требует явного флага', () => {
    knownFields(wire.toWireUser({ id: 'u', username: 'tester', displayName: null }), { id: 'u', username: 'tester', display_name: 'tester', bot: false });
    assert.equal(wire.toWireUser({ id: 'u', username: 'tester', displayName: '' }).display_name, '');
    for (const bot of [false, null, undefined]) assert.equal(wire.toWireUser({ id: 'u', username: 'tester', displayName: null, bot }).bot, false);
    assert.equal(wire.toWireUser({ id: 'u', username: 'tester', displayName: null, bot: true }).bot, true);
  });

  it('сериализатор ошибок сохраняет исторический конверт и retry_after только при ненулевой задержке', () => {
    knownFields(wire.errorBody(401, 'Unauthorized'), JSON.parse(frozen.error));
    knownFields(wire.errorBody(429, 'Too Many Requests', 5), JSON.parse(frozen.rateError));
    assert.equal(Object.hasOwn(wire.errorBody(429, 'Too Many Requests', 0), 'retry_after'), false);
  });
});
