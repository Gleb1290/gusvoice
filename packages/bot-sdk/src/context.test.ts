import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Api } from './apiClient.js';
import { Context, parseCommand } from './context.js';
import { InlineKeyboard } from './keyboard.js';
import type { BotUser, Message, Update } from './wire.js';

const source = readFileSync(new URL('./context.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
type ContextModule = typeof import('./context.js');

// Исполняется весь production-модуль, не копия регулярки или извлечённая функция.
function load(raw: string): ContextModule {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  return module.exports as ContextModule;
}
function change(from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, 'уникальный якорь контрфакта context');
  return source.replace(from, to);
}
function guardFailure(error: unknown, label: string, actual: unknown, expected: unknown): boolean {
  return error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION'
    && error.message.split(/\r?\n/, 1)[0] === label && error.operator === 'strictEqual'
    && error.actual === actual && error.expected === expected;
}

it('R299 команда без аргументов даёт пустой список и пустой текст', () => {
  assert.deepEqual(parseCommand('/status'), { command: 'status', argsText: '', args: [] });
});

it('R299 регистр команды и ника не важен, крайние и повторные пробелы не создают аргументы', () => {
  assert.deepEqual(parseCommand('/Status@PanelBot  a  b ', 'panelbot'), { command: 'status', argsText: 'a  b', args: ['a', 'b'] });
});

it('R299 команда другому боту отклоняется, своему и без адресата принимается', () => {
  assert.equal(parseCommand('/x@other', 'PanelBot'), null);
  assert.deepEqual(parseCommand('/x@PanelBot', 'PanelBot'), { command: 'x', argsText: '', args: [] });
  assert.deepEqual(parseCommand('/x', 'PanelBot'), { command: 'x', argsText: '', args: [] });
  assert.deepEqual(parseCommand('/x@other'), { command: 'x', argsText: '', args: [] });
});

it('R299 обычный текст, дефис, кириллица и пустое имя не становятся командами', () => {
  for (const text of ['status', '/st-atus', '/статус', '/', '']) assert.equal(parseCommand(text), null, text);
  assert.deepEqual(parseCommand('/st_atus9'), { command: 'st_atus9', argsText: '', args: [] });
});

it('R299 имя ровно 32 знака проходит, 33 уже не проходит', () => {
  const name = 'a'.repeat(32);
  assert.deepEqual(parseCommand(`/${name}`), { command: name, argsText: '', args: [] });
  assert.equal(parseCommand(`/${name}a`), null);
});

it('R299 многострочные аргументы сохраняют текст, но разбиваются по любым пробельным символам', () => {
  assert.deepEqual(parseCommand('  /run\nпервая\n  вторая\tтретья\r\n '), {
    command: 'run', argsText: 'первая\n  вторая\tтретья', args: ['первая', 'вторая', 'третья'],
  });
});

it('R299 контрфакт без проверки адресата передаёт чужую команду нашему боту', () => {
  const scenario = (raw: string) => {
    assert.equal(load(raw).parseCommand('/x@other', 'PanelBot') === null, true, 'R299-command-проверяет-адресата');
  };
  scenario(source);
  const mutant = change('if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;', '/* нет проверки адресата */');
  assert.throws(() => scenario(mutant), error => guardFailure(error, 'R299-command-проверяет-адресата', false, true));
});

it('R299 контрфакт без нижнего регистра теряет обработчик команды Status', () => {
  const scenario = (raw: string) => {
    assert.equal(load(raw).parseCommand('/Status')?.command, 'status', 'R299-command-нижний-регистр');
  };
  scenario(source);
  const mutant = change('command: m[1].toLowerCase()', 'command: m[1]');
  assert.throws(() => scenario(mutant), error => guardFailure(error, 'R299-command-нижний-регистр', 'Status', 'status'));
});

const me: BotUser = { id: 'bot-id', username: 'PanelBot', display_name: 'Панель', bot: true, description: '', about: '', public: true };
const message: Message = { message_id: 'message-id', chat: { id: 'chat-id', type: 'dm' }, from: {
  id: 'user-id', username: 'friend', display_name: 'Друг', bot: false,
}, date: 1_800_000_000, text: '/Status@PanelBot a b' };
function host() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api = new Api('synthetic-test-token', { baseUrl: 'https://sdk.example.invalid', discover: false, fetch: async () => { throw new Error('контекст не должен обращаться в сеть'); } });
  api.sendMessage = async (...args) => { calls.push({ method: 'sendMessage', args }); return message; };
  api.sendChatAction = async (...args) => { calls.push({ method: 'sendChatAction', args }); return true; };
  return { api, me, calls };
}

it('R299 контекст сообщения раскрывает payload, автора, беседу и разобранную команду', () => {
  const h = host();
  const update: Update = { update_id: 1, message };
  const ctx = new Context(h, update, 'message');
  assert.equal(ctx.api, h.api);
  assert.equal(ctx.me, me);
  assert.equal(ctx.update, update);
  assert.equal(ctx.payload, message);
  assert.equal(ctx.message, message);
  assert.equal(ctx.chat, message.chat);
  assert.equal(ctx.from, message.from);
  assert.equal(ctx.text, message.text);
  assert.equal(ctx.command, 'status');
  assert.deepEqual(ctx.args, ['a', 'b']);
  assert.equal(ctx.argsText, 'a b');
});

it('R299 редактирование доступно как сообщение, но не запускает команду заново', () => {
  const ctx = new Context(host(), { update_id: 2, edited_message: message }, 'edited_message');
  assert.equal(ctx.message, message);
  assert.equal(ctx.text, message.text);
  assert.equal(ctx.command, undefined);
  assert.deepEqual(ctx.args, []);
  assert.equal(ctx.argsText, '');
});

it('R299 reply, replyTo и typing адресованы исходной беседе и сохраняют явные настройки ответа', async () => {
  const h = host();
  const ctx = new Context(h, { update_id: 3, message }, 'message');
  assert.equal(await ctx.reply('ответ', { embeds: [{ title: 'Карточка' }] }), message);
  await ctx.replyTo('цитата');
  await ctx.replyTo('другая цитата', { reply_to_message_id: 'explicit-id' });
  assert.equal(await ctx.typing(), true);
  assert.deepEqual(h.calls, [
    { method: 'sendMessage', args: ['chat-id', 'ответ', { embeds: [{ title: 'Карточка' }] }] },
    { method: 'sendMessage', args: ['chat-id', 'цитата', { reply_to_message_id: 'message-id' }] },
    { method: 'sendMessage', args: ['chat-id', 'другая цитата', { reply_to_message_id: 'explicit-id' }] },
    { method: 'sendChatAction', args: ['chat-id', 'typing'] },
  ]);
});

it('R299 событие удаления не выдумывает автора, текст или сообщение для цитаты', async () => {
  const h = host();
  const deleted = { message_id: 'deleted-id', chat: message.chat, date: message.date };
  const ctx = new Context(h, { update_id: 4, message_deleted: deleted }, 'message_deleted');
  assert.equal(ctx.payload, deleted);
  assert.equal(ctx.chat, message.chat);
  assert.equal(ctx.message, undefined);
  assert.equal(ctx.from, undefined);
  assert.equal(ctx.text, '');
  await ctx.replyTo('без цитаты');
  assert.deepEqual(h.calls, [{ method: 'sendMessage', args: ['chat-id', 'без цитаты', {}] }]);
});

const panel: Message = { ...message, message_id: 'panel-id', text: '/restart nginx',
  chat: { id: 'panel-chat', type: 'dm' }, from: me,
  reply_markup: { inline_keyboard: [[{ text: 'Статус', callback_data: 'st' }]] },
};
const callback: NonNullable<Update['callback_query']> = {
  id: 'cbq-panel', from: message.from, message: panel, data: 'st', date: message.date,
};

it('R301 нажатие раскрывает панель, её чат и нажавшего человека, но не превращает текст панели в команду', () => {
  const h = host();
  const update: Update = { update_id: 11, callback_query: callback };
  const ctx = new Context(h, update, 'callback_query');
  assert.equal(ctx.payload, callback);
  assert.equal(ctx.callbackQuery, callback);
  assert.equal(ctx.callbackData, 'st');
  assert.equal(ctx.message, panel);
  assert.equal(ctx.chat, panel.chat);
  assert.equal(ctx.from, message.from);
  assert.notEqual(ctx.from, panel.from, 'нажимает человек, а не автор-бот панели');
  assert.equal(ctx.text, '');
  assert.equal(ctx.command, undefined);
  assert.deepEqual(ctx.args, []);
  assert.equal(ctx.argsText, '');
  assert.equal(ctx.match, undefined);
  assert.equal(ctx.callbackAnswered, false);
});

it('R301 editMessageText, editMessageReplyMarkup и deleteMessage обращаются к исходной панели', async () => {
  const h = host();
  h.api.editMessageText = async (...args) => { h.calls.push({ method: 'editMessageText', args }); return panel; };
  h.api.editMessageReplyMarkup = async (...args) => { h.calls.push({ method: 'editMessageReplyMarkup', args }); return panel; };
  h.api.deleteMessage = async (...args) => { h.calls.push({ method: 'deleteMessage', args }); return true; };
  const ctx = new Context(h, { update_id: 12, callback_query: callback }, 'callback_query');
  const kb = new InlineKeyboard().text('Обновить', 'st');
  assert.equal(await ctx.editMessageText('Новый статус', { reply_markup: kb }), panel);
  assert.equal(await ctx.editMessageText('Без кнопок'), panel);
  assert.equal(await ctx.editMessageReplyMarkup(kb), panel);
  assert.equal(await ctx.editMessageReplyMarkup(), panel);
  assert.equal(await ctx.deleteMessage(), true);
  assert.deepEqual(h.calls, [
    { method: 'editMessageText', args: ['panel-chat', 'panel-id', 'Новый статус', { reply_markup: kb }] },
    { method: 'editMessageText', args: ['panel-chat', 'panel-id', 'Без кнопок', {}] },
    { method: 'editMessageReplyMarkup', args: ['panel-chat', 'panel-id', kb] },
    { method: 'editMessageReplyMarkup', args: ['panel-chat', 'panel-id', undefined] },
    { method: 'deleteMessage', args: ['panel-chat', 'panel-id'] },
  ]);
});

it('R301 answerCallbackQuery принимает строку, объект и пустой ответ с исходным callback id', async () => {
  const h = host();
  h.api.answerCallbackQuery = async (...args) => { h.calls.push({ method: 'answerCallbackQuery', args }); return true; };
  for (const value of ['Готово', { text: 'Нет доступа', show_alert: true }, undefined]) {
    const ctx = new Context(h, { update_id: 13, callback_query: callback }, 'callback_query');
    assert.equal(await ctx.answerCallbackQuery(value), true);
    assert.equal(ctx.callbackAnswered, true);
  }
  assert.deepEqual(h.calls, [
    { method: 'answerCallbackQuery', args: ['cbq-panel', { text: 'Готово' }] },
    { method: 'answerCallbackQuery', args: ['cbq-panel', { text: 'Нет доступа', show_alert: true }] },
    { method: 'answerCallbackQuery', args: ['cbq-panel', {}] },
  ]);
});

it('R301 ответ помечается начатым до завершения API и сохраняет исходную ошибку API', async () => {
  const h = host();
  const failure = new Error('synthetic callback rejected');
  h.api.answerCallbackQuery = async () => { throw failure; };
  const ctx = new Context(h, { update_id: 14, callback_query: callback }, 'callback_query');
  const pending = ctx.answerCallbackQuery();
  assert.equal(ctx.callbackAnswered, true);
  await assert.rejects(pending, error => error === failure);
});

it('R301 вне нажатия callback-поля пусты и ответ запрещён, у удаления правка и удаление запрещены', async () => {
  const h = host();
  const regular = new Context(h, { update_id: 15, message }, 'message');
  assert.equal(regular.callbackData, '');
  assert.equal(regular.callbackQuery, undefined);
  await assert.rejects(regular.answerCallbackQuery('нет'), TypeError);
  assert.equal(regular.callbackAnswered, false);
  const deleted = new Context(h, { update_id: 16, message_deleted: {
    message_id: 'gone', chat: message.chat, date: message.date,
  } }, 'message_deleted');
  await assert.rejects(deleted.editMessageText('нет'), TypeError);
  await assert.rejects(deleted.editMessageReplyMarkup(), TypeError);
  await assert.rejects(deleted.deleteMessage(), TypeError);
  assert.deepEqual(h.calls, []);
});

it('R301 контрфакт корневого callback.chat теряет чат панели, оригинал проходит первым', () => {
  const scenario = (raw: string) => {
    const ctx = new (load(raw).Context)(host(), { update_id: 17, callback_query: callback }, 'callback_query');
    assert.equal(ctx.chat?.id, 'panel-chat', 'R301-callback-чат-из-панели');
  };
  scenario(source);
  const mutant = change('if (this.update.callback_query) return this.update.callback_query.message.chat;',
    'if (this.update.callback_query) return (this.update.callback_query as unknown as { chat: Chat }).chat;');
  assert.throws(() => scenario(mutant), error => guardFailure(error, 'R301-callback-чат-из-панели', undefined, 'panel-chat'));
});

const channelMessage: Message = { ...message, chat: { id: 'text-channel', type: 'channel', server_id: 'server', title: 'Общий' } };
const reaction: NonNullable<Update['message_reaction']> = { chat: channelMessage.chat,
  message_id: channelMessage.message_id, user: message.from, date: message.date,
  old_reaction: [{ type: 'emoji', emoji: '❤' }], new_reaction: [{ type: 'emoji', emoji: '❤' }, { type: 'emoji', emoji: '👍' }] };

it('R303 контекст канала хранит сервер и адресата команды, ответ идёт в канал, не в сервер', async () => {
  const h = host();
  const ctx = new Context(h, { update_id: 101, message: channelMessage }, 'message');
  assert.equal(ctx.chat, channelMessage.chat); assert.equal(ctx.isChannel, true); assert.equal(ctx.serverId, 'server');
  assert.equal(ctx.command, 'status'); assert.deepEqual(ctx.args, ['a', 'b']);
  await ctx.reply('Ответ в канал'); await ctx.replyTo('Цитата');
  assert.deepEqual(h.calls, [{ method: 'sendMessage', args: ['text-channel', 'Ответ в канал', undefined] },
    { method: 'sendMessage', args: ['text-channel', 'Цитата', { reply_to_message_id: 'message-id' }] }]);
});
it('R303 реакция берёт чат из message_reaction, автора из user, а не выдумывает сообщение', () => {
  const ctx = new Context(host(), { update_id: 102, message_reaction: reaction }, 'message_reaction');
  assert.equal(ctx.payload, reaction); assert.equal(ctx.chat, reaction.chat); assert.equal(ctx.from, reaction.user);
  assert.equal(ctx.isChannel, true); assert.equal(ctx.serverId, 'server');
  assert.equal(ctx.message, undefined); assert.equal(ctx.text, ''); assert.equal(ctx.command, undefined);
  assert.deepEqual(ctx.payload.old_reaction, [{ type: 'emoji', emoji: '❤' }]);
  assert.deepEqual(ctx.payload.new_reaction, [{ type: 'emoji', emoji: '❤' }, { type: 'emoji', emoji: '👍' }]);
});
it('R303 членство сервера и kicked в ЛС различаются по chat.type, from и serverId', () => {
  const membership: NonNullable<Update['chat_member']> = { chat: { id: 'server', type: 'server', title: 'Сервер' },
    from: me, user: message.from, date: message.date, old_status: 'member', new_status: 'kicked' };
  const ctx = new Context(host(), { update_id: 103, chat_member: membership }, 'chat_member');
  assert.equal(ctx.chat, membership.chat); assert.equal(ctx.from, me);
  assert.equal(ctx.isChannel, false); assert.equal(ctx.serverId, 'server'); assert.equal(ctx.payload.new_status, 'kicked');
  const dm = new Context(host(), { update_id: 104, my_chat_member: { ...membership, chat: message.chat } }, 'my_chat_member');
  assert.equal(dm.serverId, undefined); assert.equal(dm.isChannel, false); assert.equal(dm.payload.new_status, 'kicked');
});
it('R303 react ставит и снимает реакцию в ЛС, канале и на панели callback', async () => {
  const h = host(); h.api.setMessageReaction = async (...args) => { h.calls.push({ method: 'setMessageReaction', args }); return true; };
  for (const m of [message, channelMessage]) {
    const ctx = new Context(h, { update_id: 105, message: m }, 'message');
    assert.equal(await ctx.react('👍'), true); assert.equal(await ctx.react(), true);
  }
  await new Context(h, { update_id: 106, callback_query: { ...callback, message: { ...panel, chat: channelMessage.chat } } }, 'callback_query').react('❤');
  assert.deepEqual(h.calls, [
    { method: 'setMessageReaction', args: ['chat-id', 'message-id', [{ type: 'emoji', emoji: '👍' }]] },
    { method: 'setMessageReaction', args: ['chat-id', 'message-id', []] },
    { method: 'setMessageReaction', args: ['text-channel', 'message-id', [{ type: 'emoji', emoji: '👍' }]] },
    { method: 'setMessageReaction', args: ['text-channel', 'message-id', []] },
    { method: 'setMessageReaction', args: ['text-channel', 'panel-id', [{ type: 'emoji', emoji: '❤' }]] },
  ]);
});
it('R303 react без сообщения не отправляет пустой message_id в API', async () => {
  const h = host(); let calls = 0; h.api.setMessageReaction = async () => { calls++; return true; };
  const ctx = new Context(h, { update_id: 107, message_reaction: reaction }, 'message_reaction');
  await assert.rejects(ctx.react('👍'), /в этом событии нет сообщения/); assert.equal(calls, 0);
});
it('R303 команды канала без адресата и своему боту проходят, другому боту не исполняются', () => {
  for (const [text, command] of [['/Status', 'status'], ['/STATUS@pAnElBoT a', 'status'], ['/status@other', undefined]]) {
    const ctx = new Context(host(), { update_id: 108, message: { ...channelMessage, text: text! } }, 'message');
    assert.equal(ctx.command, command, text);
  }
});
it('R303 контрфакт: чат реакции из message не подменяет правильный message_reaction.chat', () => {
  const scenario = (raw: string) => {
    const ctx = new (load(raw).Context)(host(), { update_id: 109, message_reaction: reaction }, 'message_reaction');
    assert.equal(ctx.chat?.id, 'text-channel', 'R303-реакция-берёт-свой-чат');
  };
  scenario(source);
  const mutant = change('return (this.update[this.type] as { chat: Chat }).chat;',
    "if (this.type === 'message_reaction') return this.update.message?.chat as Chat; return (this.update[this.type] as { chat: Chat }).chat;");
  assert.throws(() => scenario(mutant), e => guardFailure(e, 'R303-реакция-берёт-свой-чат', undefined, 'text-channel'));
});
it('R303 контрфакт: отсутствие проверки @other ловится именно в контексте канала', () => {
  const scenario = (raw: string) => {
    const ctx = new (load(raw).Context)(host(), { update_id: 110, message: { ...channelMessage, text: '/status@other' } }, 'message');
    assert.equal(ctx.command, undefined, 'R303-чужая-команда-канала-не-наша');
  };
  scenario(source);
  const mutant = change('if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;', '/* mutant: чужой адресат разрешён */');
  assert.throws(() => scenario(mutant), e => guardFailure(e, 'R303-чужая-команда-канала-не-наша', 'status', undefined));
});
