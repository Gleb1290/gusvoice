import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as shared from '@gusvoice/shared';
import ts from 'typescript';
import * as zod from 'zod';
import * as convRules from '../convRules.js';
import * as webhookRules from '../webhookRules.js';
import * as rules from './botRules.js';
import * as wire from './botWire.js';

const source = readFileSync(new URL('./botWire.ts', import.meta.url), 'utf8');
type Wire = typeof wire;
const button = (data = 'st') => ({ text: 'Статус', callback_data: data });
const markup = (count: number) => ({ inline_keyboard: Array.from({ length: Math.ceil(count / 8) }, (_, row) =>
  Array.from({ length: Math.min(8, count - row * 8) }, (_, col) => button(`${row}:${col}`))) });
const commands = (count: number) => Array.from({ length: count }, (_, i) => ({ command: `cmd_${i}`, description: 'Описание' }));

// Загружаем ВЕСЬ настоящий модуль; зависимости — настоящие чистые модули, неизвестный импорт закрывает тест.
function loadWire(raw: string): Wire {
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared, zod, '../convRules.js': convRules, '../webhookRules.js': webhookRules, './botRules.js': rules,
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (name: string) => {
      assert.ok(Object.hasOwn(deps, name), `неописанная зависимость ${name}`);
      return deps[name];
    } });
  return module.exports as Wire;
}

describe('R301 команды: настоящий разбор JSON и формы', () => {
  it('ровно 100 разных команд принимаются, 101-я отвергается, пустой список удаляет команды', () => {
    assert.equal(wire.setMyCommandsParams.safeParse({ commands: commands(100) }).success, true);
    assert.equal(wire.setMyCommandsParams.safeParse({ commands: commands(101) }).success, false);
    assert.deepEqual(wire.setMyCommandsParams.parse({ commands: [] }), { commands: [] });
  });
  it('имя 1 и 32 знака проходит, пустое и 33 знака не проходят', () => {
    for (const size of [1, 32]) assert.equal(wire.botCommand.safeParse({ command: 'a'.repeat(size), description: 'x' }).success, true);
    for (const size of [0, 33]) assert.equal(wire.botCommand.safeParse({ command: 'a'.repeat(size), description: 'x' }).success, false);
  });
  it('латиница нижнего регистра, цифры и подчёркивание разрешены, регистр и чужие символы запрещены', () => {
    for (const command of ['start', 'a_09', '_', '0']) assert.equal(wire.botCommand.safeParse({ command, description: 'x' }).success, true, command);
    for (const command of ['Foo', 'START', '/start', 'действие', 'a-b', 'a b', ' start']) {
      assert.equal(wire.botCommand.safeParse({ command, description: 'x' }).success, false, command);
    }
  });
  it('описания 1 и 256 принимаются, 0 и 257 отвергаются после удаления краевых пробелов', () => {
    for (const size of [1, 256]) {
      const description = 'я'.repeat(size);
      assert.deepEqual(wire.botCommand.parse({ command: 'start', description: ` \t${description}\n` }), { command: 'start', description });
    }
    for (const description of ['', ' \t\n', 'x'.repeat(257)]) assert.equal(wire.botCommand.safeParse({ command: 'start', description }).success, false);
  });
  it('реальная схема отвергает повтор имени, но не разные имена с одинаковым описанием', () => {
    assert.equal(wire.setMyCommandsParams.safeParse({ commands: [{ command: 'start', description: 'x' }, { command: 'start', description: 'другое' }] }).success, false);
    assert.equal(wire.setMyCommandsParams.safeParse({ commands: [{ command: 'start', description: 'x' }, { command: 'stop', description: 'x' }] }).success, true);
  });
  it('области по умолчанию, личных чатов и групп принимаются всеми тремя методами; адресные области отвергаются', () => {
    for (const schema of [wire.setMyCommandsParams, wire.getMyCommandsParams, wire.deleteMyCommandsParams]) {
      for (const type of ['default', 'all_private_chats', 'all_group_chats']) assert.equal(schema.safeParse({ commands: [], scope: { type } }).success, true, type);
      assert.equal(schema.safeParse({ commands: [] }).success, true);
      for (const type of ['chat', 'chat_member', 'all_chat_administrators', '', 'Default']) assert.equal(schema.safeParse({ commands: [], scope: { type } }).success, false, type);
    }
  });
  it('массив команд и scope из формы разбираются как JSON, битый JSON не превращается в пустой список', () => {
    const list = [{ command: 'start', description: ' Начать ' }];
    assert.deepEqual(wire.setMyCommandsParams.parse({ commands: JSON.stringify(list), scope: '{"type":"default"}' }),
      { commands: [{ command: 'start', description: 'Начать' }], scope: { type: 'default' } });
    assert.deepEqual(wire.setMyCommandsParams.parse({ commands: '[]' }), { commands: [] });
    for (const schema of [wire.getMyCommandsParams, wire.deleteMyCommandsParams]) {
      assert.deepEqual(schema.parse({ scope: '{"type":"all_private_chats"}' }), { scope: { type: 'all_private_chats' } });
    }
    for (const commands of ['[', '{}', 'null', '"[]"']) assert.equal(wire.setMyCommandsParams.safeParse({ commands }).success, false, commands);
    assert.equal(wire.getMyCommandsParams.safeParse({ scope: '{' }).success, false);
  });
});

describe('R301 клавиатура: форма, пределы и безопасные ссылки', () => {
  it('8 кнопок в ряду принимаются, 9-я отвергается', () => {
    for (const [count, expected] of [[8, true], [9, false]] as const) {
      assert.equal(wire.inlineKeyboardMarkup.safeParse({ inline_keyboard: [Array.from({ length: count }, () => button())] }).success, expected);
    }
  });
  it('100 кнопок несколькими рядами принимаются, 101-я отвергается', () => {
    assert.equal(wire.inlineKeyboardMarkup.safeParse(markup(100)).success, true);
    assert.equal(wire.inlineKeyboardMarkup.safeParse(markup(101)).success, false);
  });
  it('одна кнопка принимается, пустая клавиатура и пустой ряд отвергаются даже рядом с непустым', () => {
    assert.equal(wire.inlineKeyboardMarkup.safeParse(markup(1)).success, true);
    for (const inline_keyboard of [[], [[]], [[button()], []]]) assert.equal(wire.inlineKeyboardMarkup.safeParse({ inline_keyboard }).success, false);
  });
  it('ровно одно действие принимается, ни одного и сразу два отвергаются', () => {
    for (const action of [{ callback_data: 'st' }, { url: 'https://example.invalid/' }]) {
      assert.equal(wire.inlineKeyboardButton.safeParse({ text: 'Кнопка', ...action }).success, true);
    }
    for (const action of [{}, { callback_data: 'st', url: 'https://example.invalid/' }]) {
      assert.equal(wire.inlineKeyboardButton.safeParse({ text: 'Кнопка', ...action }).success, false);
    }
  });
  it('данные 1 и 64 ASCII-байта принимаются, пустые и 65 байт отвергаются', () => {
    for (const length of [1, 64]) assert.equal(wire.inlineKeyboardButton.safeParse(button('a'.repeat(length))).success, true);
    for (const length of [0, 65]) assert.equal(wire.inlineKeyboardButton.safeParse(button('a'.repeat(length))).success, false);
  });
  it('32 кириллические буквы это 64 UTF-8 байта; 33 буквы уже недопустимы, как и 17 эмодзи', () => {
    for (const [data, expected] of [['я'.repeat(32), true], ['я'.repeat(33), false], ['🪿'.repeat(16), true], ['🪿'.repeat(17), false]] as const) {
      assert.equal(wire.inlineKeyboardButton.safeParse(button(data)).success, expected);
      assert.equal(shared.callbackDataBytes(data), Buffer.byteLength(data, 'utf8'), 'независимый счётчик UTF-8');
    }
    assert.equal(wire.inlineKeyboardButton.parse(button(' st ')).callback_data, ' st ', 'данные не trim: сравнение с кнопкой точное');
  });
  it('подпись trim-ится, длины 1/64 допустимы, 0/65 недопустимы, чужие Telegram-поля срезаются', () => {
    for (const size of [1, 64]) assert.equal(wire.inlineKeyboardButton.parse({ ...button(), text: ` ${'я'.repeat(size)} ` }).text, 'я'.repeat(size));
    for (const text of ['', ' \n ', 'x'.repeat(65)]) assert.equal(wire.inlineKeyboardButton.safeParse({ ...button(), text }).success, false);
    assert.deepEqual(wire.inlineKeyboardButton.parse({ ...button(), web_app: { url: 'https://example.invalid/' } }), button());
  });
  it('http(s) без credentials разрешены, исполняемые и чужие схемы с логином или паролем запрещены', () => {
    for (const url of ['http://example.invalid/', 'https://example.invalid/path?q=1#x']) assert.equal(wire.inlineKeyboardButton.safeParse({ text: 'Сайт', url }).success, true, url);
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.invalid/', 'tg://resolve?domain=test',
      'https://a:b@example.invalid/', 'https://a@example.invalid/', 'https://:b@example.invalid/', '/relative', 'not a URL']) {
      assert.equal(wire.inlineKeyboardButton.safeParse({ text: 'Сайт', url }).success, false, url);
    }
  });
  it('URL ровно 2048 знаков разрешён, 2049 отвергается', () => {
    const prefix = 'https://example.invalid/';
    for (const [size, expected] of [[2048, true], [2049, false]] as const) {
      assert.equal(wire.inlineKeyboardButton.safeParse({ text: 'Сайт', url: prefix + 'x'.repeat(size - prefix.length) }).success, expected);
    }
  });
  it('sendMessage и обе правки принимают reply_markup строкой JSON, отсутствие снимающей опции сохраняется как отсутствие', () => {
    for (const schema of [wire.sendMessageParams, wire.editMessageTextParams, wire.editMessageReplyMarkupParams]) {
      const input = { chat_id: 'chat', message_id: 'panel', text: 'Панель' };
      assert.deepEqual(schema.parse({ ...input, reply_markup: JSON.stringify(markup(1)) }).reply_markup, markup(1));
      assert.equal(Object.hasOwn(schema.parse(input), 'reply_markup'), false);
      for (const reply_markup of ['{', 'null', '{"inline_keyboard":[[]]}']) assert.equal(schema.safeParse({ ...input, reply_markup }).success, false);
    }
  });
});

describe('R301 ответ на нажатие и неизменяемый образец callback_query', () => {
  it('текст ответа 0/200 допустим, 201 нет, текст не обрезается и не воспринимается как HTML', () => {
    for (const text of ['', 'я'.repeat(200), ' <b>текст</b> ']) assert.equal(wire.answerCallbackQueryParams.parse({ callback_query_id: 'cbq', text }).text, text);
    assert.equal(wire.answerCallbackQueryParams.safeParse({ callback_query_id: 'cbq', text: 'x'.repeat(201) }).success, false);
    assert.deepEqual(wire.answerCallbackQueryParams.parse({ callback_query_id: 'cbq' }), { callback_query_id: 'cbq' });
  });
  it('show_alert из формы разбирается настоящим flag, не всякая непустая строка становится true', () => {
    for (const value of [true, 'true', '1']) assert.equal(wire.answerCallbackQueryParams.parse({ callback_query_id: 'cbq', show_alert: value }).show_alert, true);
    for (const value of [false, 'false', '0', '']) assert.equal(wire.answerCallbackQueryParams.parse({ callback_query_id: 'cbq', show_alert: value }).show_alert, false);
    assert.equal(wire.answerCallbackQueryParams.safeParse({ callback_query_id: 'cbq', show_alert: 'yes' }).success, false);
  });

  // Новый образец, старые frozen v1 в botWire.test.ts НЕ меняются. SHA-256 вычислен отдельно .NET SHA256/UTF8.
  const frozenCallback = '{"update_id":105,"callback_query":{"id":"cbq_public_fixture","from":{"id":"person-1","username":"tester","display_name":"Испытатель","bot":false},"message":{"message_id":"panel-1","chat":{"id":"chat-1","type":"dm"},"from":{"id":"bot-1","username":"helperbot","display_name":"Помощник","bot":true},"date":1700000000,"text":"Панель","reply_markup":{"inline_keyboard":[[{"text":"Статус","callback_data":"st"},{"text":"Сайт","url":"https://example.invalid/"}]]}},"data":"st","date":1700000001}}';
  const callbackHash = '8b2bf1786522e4c715542e770eb6f2dea714dc3a05e6cd4d1b705f18c366c1c1';
  it('байты callback_query заморожены, настоящие схемы сохраняют нажавшего и сообщение с кнопками', () => {
    assert.equal(createHash('sha256').update(frozenCallback, 'utf8').digest('hex'), callbackHash);
    const expected = JSON.parse(frozenCallback);
    assert.deepEqual(wire.wireUpdate.parse(expected), expected);
    assert.deepEqual(wire.wireCallbackQuery.parse(expected.callback_query), expected.callback_query);
    assert.deepEqual(wire.getUpdatesParams.parse({ allowed_updates: '["callback_query"]' }).allowed_updates, ['callback_query']);
  });
  it('настоящий сериализатор панели воспроизводит frozen-ответ, нажавший человек не подменяется автором-ботом', () => {
    const expected = JSON.parse(frozenCallback);
    const message: shared.ConvMessage = {
      id: 'panel-1', channelId: '', conversationId: 'chat-1', sortKey: 1, clientId: null,
      author: { id: 'bot-1', username: 'helperbot', displayName: 'Помощник', avatarUrl: null, bot: true },
      content: 'Панель', createdAt: '2023-11-14T22:13:20.999Z', editedAt: null, attachments: [], reactions: [], replyTo: null,
      keyboard: [[button(), { text: 'Сайт', url: 'https://example.invalid/' }]],
    };
    assert.deepEqual(wire.toWireMessage(message), expected.callback_query.message);
    assert.deepEqual(wire.toWireUser({ id: 'person-1', username: 'tester', displayName: 'Испытатель', bot: false }), expected.callback_query.from);
    for (const keyboard of [undefined, []]) assert.equal(Object.hasOwn(wire.toWireMessage({ ...message, keyboard }), 'reply_markup'), false);
  });
  it('callback_query требует id/from/message/data/date с прежними типами и не принимает повреждённую клавиатуру', () => {
    const query = JSON.parse(frozenCallback).callback_query;
    for (const key of ['id', 'from', 'message', 'data', 'date']) {
      const missing = { ...query }; delete missing[key];
      assert.equal(wire.wireCallbackQuery.safeParse(missing).success, false, key);
      assert.equal(wire.wireCallbackQuery.safeParse({ ...query, [key]: key === 'date' ? '1700000001' : 42 }).success, false, key);
    }
    assert.equal(wire.wireCallbackQuery.safeParse({ ...query, message: { ...query.message, reply_markup: { inline_keyboard: [[]] } } }).success, false);
  });
});

const mutations = [
  { name: 'UTF-8 нельзя заменить числом символов', from: 'callbackDataBytes(s) <= CALLBACK_DATA_MAX_BYTES', to: 's.length <= CALLBACK_DATA_MAX_BYTES',
    message: '33 кириллические буквы не влезают в 64 байта', actual: true, expected: false,
    check: (w: Wire) => assert.strictEqual(w.inlineKeyboardButton.safeParse(button('я'.repeat(33))).success, false, '33 кириллические буквы не влезают в 64 байта') },
  { name: 'XOR нельзя заменить OR', from: '(b.callback_data !== undefined) !== (b.url !== undefined)', to: '(b.callback_data !== undefined) || (b.url !== undefined)',
    message: 'два действия в одной кнопке запрещены', actual: true, expected: false,
    check: (w: Wire) => assert.strictEqual(w.inlineKeyboardButton.safeParse({ ...button(), url: 'https://example.invalid/' }).success, false, 'два действия в одной кнопке запрещены') },
  { name: 'потолок 100 нельзя случайно сделать 99', from: '0) <= KEYBOARD_BUTTONS_MAX', to: '0) < KEYBOARD_BUTTONS_MAX',
    message: 'ровно 100 кнопок ещё принимаются', actual: false, expected: true,
    check: (w: Wire) => assert.strictEqual(w.inlineKeyboardMarkup.safeParse(markup(100)).success, true, 'ровно 100 кнопок ещё принимаются') },
];
describe('R301 исполняемые контрфакты всего модуля botWire', () => {
  for (const m of mutations) it(m.name, () => {
    m.check(wire);
    m.check(loadWire(source));
    assert.equal(source.split(m.from).length - 1, 1, 'единственный якорь контрфакта');
    assert.throws(() => m.check(loadWire(source.replace(m.from, m.to))), (error: unknown) => error instanceof assert.AssertionError
      && error.code === 'ERR_ASSERTION' && error.message.split(/\r?\n/, 1)[0] === m.message
      && error.operator === 'strictEqual' && error.actual === m.actual && error.expected === m.expected,
    `контрфакт убивается точным host AssertionError: ${m.message}`);
  });
});

describe('R301 границы контрактов: SDK, каналы и федерация', () => {
  it('страж SDK сохраняет двусторонние типы, равенство ключей и все новые пары схема↔SDK', () => {
    const raw = readFileSync(new URL('./botWireSdk.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('botWireSdk.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const aliases = new Map(file.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, node]));
    const compact = (value: string) => value.replace(/\s+/g, '');
    const helpers: Record<string, string> = {
      Same: '[A] extends [B] ? ([B] extends [A] ? true : false) : false',
      Mirror: 'Same<Sdk, Wire> extends true ? Same<keyof Sdk, keyof Wire> : false',
      Accepts: '[Params] extends [z.output<Schema>] ? Same<keyof Params, keyof z.output<Schema>> : false',
      Assert: 'T',
    };
    for (const [name, expected] of Object.entries(helpers)) {
      const alias = aliases.get(name); assert.ok(alias, `страж ${name} существует`);
      assert.equal(compact(alias.type.getText(file)), compact(expected), `страж ${name} не ослаблен`);
    }
    assert.equal(compact(aliases.get('Assert')!.typeParameters![0].constraint!.getText(file)), 'true');
    const checks = aliases.get('BotWireSdkChecks'); assert.ok(checks && ts.isTupleTypeNode(checks.type));
    const entries = checks.type.elements.map(node => compact(node.getText(file)));
    for (const pair of [
      'Mirror<Sdk.Message, WireMessage>', 'Mirror<Sdk.Update, WireUpdate>',
      'Mirror<Sdk.InlineKeyboardButton, z.infer<typeof inlineKeyboardButton>>',
      'Mirror<Sdk.InlineKeyboardMarkup, z.infer<typeof inlineKeyboardMarkup>>',
      'Mirror<Sdk.CallbackQuery, z.infer<typeof wireCallbackQuery>>',
      'Mirror<Sdk.BotCommand, z.infer<typeof botCommand>>',
      'Same<Sdk.UpdateType, BotUpdateType>',
      'Accepts<typeof sendMessageParams, Sdk.SendMessageParams>',
      'Accepts<typeof editMessageTextParams, Sdk.EditMessageTextParams>',
      'Accepts<typeof editMessageReplyMarkupParams, Sdk.EditMessageReplyMarkupParams>',
      'Accepts<typeof answerCallbackQueryParams, Sdk.AnswerCallbackQueryParams>',
      'Accepts<typeof setMyCommandsParams, Sdk.SetMyCommandsParams>',
      'Accepts<typeof getMyCommandsParams, Sdk.GetMyCommandsParams>',
      'Accepts<typeof deleteMyCommandsParams, Sdk.DeleteMyCommandsParams>',
    ]) assert.ok(entries.includes(compact(`Assert<${pair}>`)), `обязательная проверка ${pair}`);
    assert.doesNotMatch(raw, /@ts-(?:ignore|nocheck)/, 'нельзя отключить типовой гейт комментарием');
    const visit = (node: ts.Node): void => {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, 'any не подменяет проверку SDK');
      ts.forEachChild(node, visit);
    };
    visit(file);
  });

  it('ответ нажатия не добавляет события в WS людей: устройство ждёт свой HTTP-ответ', () => {
    const raw = readFileSync(new URL('../../../shared/src/ws.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('ws.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const literals: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) literals.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(literals.includes('conv.change'), 'читается настоящий протокол людей');
    for (const forbidden of ['bot.answer', 'bot.commands', 'callback_query']) assert.equal(literals.includes(forbidden), false, forbidden);
  });

  it('канальный сериализатор читает keyboard, а адаптер федерации не переносит клавиатуру', () => {
    // Это sourceguard границы, НЕ замена inject/PGlite-проверке пересылки. Эти модули имеют IO-импорты — не грузим их.
    for (const [path, name] of [['../serialize.ts', 'serializeMessage'], ['../federation/convChanges.ts', 'toWireMessage']]) {
      const raw = readFileSync(new URL(path, import.meta.url), 'utf8');
      const file = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const fn = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(fn?.body, `настоящая функция ${name}`);
      let readsKeyboard = false;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
          if (node.text === 'keyboard') readsKeyboard = true;
          if (name !== 'serializeMessage') assert.ok(!['keyboard', 'reply_markup'].includes(node.text), `${path}: поле ботов не читается федерацией`);
        }
        if (ts.isSpreadAssignment(node)) {
          assert.ok(!ts.isIdentifier(node.expression), `${path}: нельзя вывалить строку БД через spread`);
        }
        ts.forEachChild(node, visit);
      };
      visit(fn);
      assert.equal(readsKeyboard, name === 'serializeMessage', `${path}: клавиатура разрешена только канальному DTO`);
      const returns = fn.body.statements.filter(ts.isReturnStatement);
      assert.ok(returns.some(node => node.expression && ts.isObjectLiteralExpression(node.expression)), 'возвращается явно собранный DTO');
    }
  });

  it('настоящие сериализатор и парсер федерации не переносят подмешанную клавиатуру ни в одну сторону', () => {
    const message: shared.FedConvMessageWire = {
      id: 'panel', conversationId: 'conversation', author: { instanceId: 'home', userId: 'person' },
      clientId: null, payloadHash: null, createdAt: 1700000000000, originSortKey: 1, content: 'Читаемый текст',
      replyToId: null, forwardedFrom: null, silent: false, noPreview: false, captionAbove: false, replyQuote: null,
      sticker: null, service: null, attachments: [], editVersion: 0, editedAt: null, deleted: false,
    };
    const extra = { keyboard: markup(1).inline_keyboard, reply_markup: markup(1) };
    const baseline = shared.serializeConvMessageWire(message);
    assert.equal(baseline.content, 'Читаемый текст', 'обычное сообщение сериализуется');
    assert.deepEqual(shared.serializeConvMessageWire({ ...message, ...extra }), baseline);
    const parsed = shared.parseConvMessageWire(baseline); assert.ok(parsed, 'обычный федеративный провод принимается');
    assert.deepEqual(shared.parseConvMessageWire({ ...baseline, ...extra }), parsed);
    for (const key of ['keyboard', 'reply_markup']) {
      assert.equal(Object.hasOwn(baseline, key), false, key);
      assert.equal(Object.hasOwn(parsed, key), false, key);
    }
  });
});
