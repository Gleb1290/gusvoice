import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CALLBACK_QUERY_WAIT_S, type InlineKeyboard } from '@gusvoice/shared';
import * as rules from './botKeyboardRules';

type Rules = typeof rules;
const source = readFileSync(new URL('./botKeyboardRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const commands = [
  { command: 'status', description: 'Состояние' },
  { command: 'restart', description: 'Перезапуск' },
  { command: 'STop', description: 'Остановить' },
];
const hundred = Array.from({ length: 100 }, (_, i) => ({ command: `cmd_${i}`, description: `Команда ${i}` }));

function mutated(before: string, after: string): Rules {
  assert.equal(source.split(before).length - 1, 1, 'мутация меняет единственный якорь настоящего модуля');
  const module = { exports: {} as Rules };
  runInNewContext(ts.transpileModule(source.replace(before, after), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return { CALLBACK_QUERY_WAIT_S }; },
  });
  return module.exports;
}

function expectedAssertion(error: unknown, message: string, operator: string): error is assert.AssertionError {
  return error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION' &&
    error.message.split('\n')[0] === message && error.operator === operator;
}

it('R302 ожидание клиента включает серверное окно и две секунды сети, кэш команд живёт минуту', () => {
  assert.equal(rules.BOT_CALLBACK_CLIENT_WAIT_MS, (CALLBACK_QUERY_WAIT_S + 2) * 1000);
  assert.equal(rules.BOT_COMMANDS_TTL_MS, 60_000);
  assert.equal(rules.STALE_BUTTON_TEXT, 'Кнопка устарела');
});

const channelBots = [
  { id: 'weather', username: 'WeatherBot', displayName: 'Погода', avatarUrl: null, commands: [commands[0], commands[1]] },
  { id: 'alerts', username: 'AlertsBot', displayName: 'Оповещения', avatarUrl: '/public-avatar.png', commands: [commands[2], { command: 'STATUS', description: 'Другая команда' }] },
];

it('R303 команды канала сохраняют порядок ботов и команд, аватар и автора каждой строки', () => {
  const list = rules.channelCommandList(channelBots);
  assert.deepEqual(list.map(c => [c.command, c.bot.id]), [['status', 'weather'], ['restart', 'weather'], ['STop', 'alerts'], ['STATUS', 'alerts']]);
  assert.deepEqual(list[2].bot, { id: 'alerts', username: 'AlertsBot', displayName: 'Оповещения', avatarUrl: '/public-avatar.png' });
  assert.deepEqual(rules.channelCommandList(null), []);
  assert.deepEqual(rules.channelCommandList(undefined), []);
  assert.deepEqual(rules.channelCommandList([{ ...channelBots[0], commands: [null, { command: '' }, commands[0]] }] as any).map(c => c.command), ['status']);
});

it('R303 фильтр канала проверяет префиксы команды И ника без регистра, не подстроку', () => {
  const list = rules.channelCommandList(channelBots);
  assert.deepEqual(rules.filterChannelCommands(list, 'ST@AL').map(c => c.command), ['STop', 'STATUS']);
  assert.deepEqual(rules.filterChannelCommands(list, '@we').map(c => c.command), ['status', 'restart']);
  assert.deepEqual(rules.filterChannelCommands(list, 'st@').map(c => c.command), ['status', 'STop', 'STATUS']);
  for (const q of ['tatus', 'st@lerts', 'restart@alerts', 'missing']) assert.deepEqual(rules.filterChannelCommands(list, q), [], q);
  assert.deepEqual(rules.filterChannelCommands(list, ''), list);
});

function conflict(r: Rules) {
  const list = r.channelCommandList(channelBots);
  assert.equal(r.channelCommandInsert(list[0], list), '/status@WeatherBot', 'R303 конфликт команды адресуется выбранному боту');
}
it('R303 ник добавляется только при одинаковой команде у РАЗНЫХ ботов, регистр команды не разделяет владельцев', () => {
  conflict(rules);
  const list = rules.channelCommandList(channelBots);
  assert.equal(rules.channelCommandInsert(list[1], list), '/restart');
  assert.equal(rules.channelCommandInsert(list[3], list), '/STATUS@AlertsBot');
  assert.equal(rules.channelCommandInsert(list[0], [list[0], list[0]]), '/status', 'дубликат одного бота не конфликт');
});
it('R303 команда из текста адресуется автору при конфликте, готовый адрес и неизвестный автор не переписываются', () => {
  const list = rules.channelCommandList(channelBots);
  assert.equal(rules.botCommandFromMessage('/status', 'WeatherBot', list), '/status@WeatherBot');
  assert.equal(rules.botCommandFromMessage('/status', 'WEATHERBOT', list.slice(0, 2)), '/status');
  assert.equal(rules.botCommandFromMessage('/restart', 'WeatherBot', list), '/restart');
  assert.equal(rules.botCommandFromMessage('/status@OtherBot', 'WeatherBot', list), '/status@OtherBot');
  assert.equal(rules.botCommandFromMessage('/status', undefined, list), '/status');
});
it('R303 поле с адресной командой принимается только в канале и без аргументов', () => {
  for (const value of ['/status@WeatherBot', '/st@', '/st@bot \n']) {
    assert.equal(rules.onlyCommandInField(value, true), true);
    assert.equal(rules.onlyCommandInField(value), false);
  }
  for (const value of ['/st@bot arg', '/st@@bot', ' /st@bot', '/st@бот']) assert.equal(rules.onlyCommandInField(value, true), false);
});
it('R303 контрфакт вставки без ника при конфликте ловит точный неверный адрес', () => {
  conflict(rules);
  const anchor = 'owners.size > 1';
  conflict(mutated(anchor, anchor));
  assert.throws(() => conflict(mutated(anchor, 'false')), (e: unknown) =>
    expectedAssertion(e, 'R303 конфликт команды адресуется выбранному боту', 'strictEqual') && e.actual === '/status' && e.expected === '/status@WeatherBot');
});

function prefix(r: Rules) {
  assert.deepEqual(Array.from(r.filterBotCommands(commands, 'St')), [commands[0], commands[2]],
    'R302 ищем только префикс, без регистра, сохраняя порядок бота');
}
function allHundred(r: Rules) {
  assert.deepEqual(Array.from(r.filterBotCommands(hundred, '')), hundred,
    'R302 все сто команд видны без обрезания до восьми');
}

it('R302 команды фильтруются по началу имени без регистра и без перестановки', () => {
  prefix(rules);
  assert.deepEqual(rules.filterBotCommands(commands, 'restart'), [commands[1]]);
  assert.deepEqual(rules.filterBotCommands(commands, 'missing'), []);
  assert.deepEqual(rules.filterBotCommands([], ''), []);
  assert.deepEqual(commands.map(c => c.command), ['status', 'restart', 'STop'], 'исходный список не меняется');
});

it('R302 пустой префикс и общий префикс показывают все 100 команд, а не первые восемь', () => {
  allHundred(rules);
  assert.deepEqual(rules.filterBotCommands(hundred, 'CMD_'), hundred);
  assert.equal(rules.filterBotCommands(hundred.slice(0, 8), '').length, 8);
  assert.equal(rules.filterBotCommands(hundred.slice(0, 9), '').length, 9);
});

it('R302 только команда с необязательными конечными пробелами отправляется сразу', () => {
  for (const text of ['/', '/st', '/status', '/A_12', '/status ', '/status\t', '/status\n'])
    assert.equal(rules.onlyCommandInField(text), true, JSON.stringify(text));
  for (const text of ['', 'status', ' /status', 'a /status', '/status arg', '/status\narg', '/etc/hosts', '/status!'])
    assert.equal(rules.onlyCommandInField(text), false, JSON.stringify(text));
});

it('R302 команды в начале, после пробела, переноса и открывающей скобки становятся отдельными частями', () => {
  assert.deepEqual(rules.splitBotCommands('/start затем (/status),\n/help!'), [
    { cmd: '/start' }, ' затем (', { cmd: '/status' }, '),\n', { cmd: '/help' }, '!',
  ]);
  assert.deepEqual(rules.splitBotCommands(' /one /two'), [' ', { cmd: '/one' }, ' ', { cmd: '/two' }]);
});

it('R302 URL, пути и слеш между словами сохраняются байт-в-байт обычным текстом', () => {
  for (const text of ['и/или', 'http://x/y', 'https://host/status', '/etc/hosts', 'a/b', 'a/status', '//status'])
    assert.deepEqual(rules.splitBotCommands(text), [text]);
  assert.deepEqual(rules.splitBotCommands(''), []);
  assert.deepEqual(rules.splitBotCommands('без команд'), ['без команд']);
});

it('R302 знаки после команды остаются текстом, имя длиной 32 допустимо, 33 уже не ссылка', () => {
  for (const end of [' ', '.', ',', '!', '?', ':', ';', ')', ']'])
    assert.deepEqual(rules.splitBotCommands(`/go${end}`), [{ cmd: '/go' }, end]);
  assert.deepEqual(rules.splitBotCommands('/' + 'a'.repeat(32)), [{ cmd: '/' + 'a'.repeat(32) }]);
  assert.deepEqual(rules.splitBotCommands('/' + 'a'.repeat(33)), ['/' + 'a'.repeat(33)]);
  assert.deepEqual(rules.splitBotCommands('/'), ['/']);
});

it('R302 повторное разбиение текста не теряет первую команду из-за состояния регулярного выражения', () => {
  const text = '/one /two';
  const expected = [{ cmd: '/one' }, ' ', { cmd: '/two' }];
  assert.deepEqual(rules.splitBotCommands(text), expected);
  assert.deepEqual(rules.splitBotCommands(text), expected);
});

it('R302 клавиатура сохраняет корректные callback и http(s) кнопки, порядок рядов и исходные объекты', () => {
  const callback = { text: 'Да', callback_data: 'yes' };
  const link = { text: 'Сайт', url: 'HTTPS://example.test/path' };
  const plainHttp = { text: 'HTTP', url: 'http://example.test' };
  const kb = [[callback, link], [], [plainHttp]];
  assert.deepEqual(rules.drawableKeyboard(kb), [[callback, link], [plainHttp]]);
  assert.equal(rules.drawableKeyboard(kb)[0][0], callback);
  assert.equal(kb.length, 3, 'страховка не меняет клавиатуру сообщения');
});

it('R302 обе цели, отсутствие цели, javascript и пустые подписи не рисуются, корректный сосед остаётся', () => {
  const valid = { text: 'Работает', callback_data: 'ok' };
  const malformed: unknown = [null, 'ряд', [], [
    null, { text: 'Обе', callback_data: 'x', url: 'https://example.test' }, { text: 'Нет цели' },
    { text: 'Опасно', url: 'javascript:alert(1)' }, { text: 'Файл', url: 'file:///tmp/test' },
    { text: 'Протокол', url: '//example.test' }, { text: '', callback_data: 'x' },
    { text: ' \t', url: 'https://example.test' }, { text: 12, callback_data: 'x' }, valid,
  ]];
  assert.deepEqual(rules.drawableKeyboard(malformed as InlineKeyboard), [[valid]]);
  for (const kb of [null, undefined, {}, 'keyboard', 17])
    assert.deepEqual(rules.drawableKeyboard(kb as InlineKeyboard), []);
});

function alertWindow(r: Rules) {
  assert.equal(r.callbackOutcome({ text: '  Важно  ', alert: true }).kind, 'alert', 'R302 alert открывает окно, а не тост');
}
function timeoutSilent(r: Rules) {
  assert.equal(r.callbackOutcome({ timeout: true, text: 'Не показывать' }).kind, 'none', 'R302 timeout молчит даже с текстом');
}
function staleVisible(r: Rules) {
  assert.equal(r.callbackErrorOutcome({ status: 409 }), 'stale', 'R302 409 показывает устаревшую кнопку, не молчит');
}

it('R302 alert даёт окно, обычный текст даёт тост, внешние пробелы убираются', () => {
  alertWindow(rules);
  assert.deepEqual(rules.callbackOutcome({ text: '  Важно\n', alert: true }), { kind: 'alert', text: 'Важно' });
  assert.deepEqual(rules.callbackOutcome({ text: '  Готово\t' }), { kind: 'toast', text: 'Готово' });
});

it('R302 пустой ответ, пробельный текст и таймаут не показывают ничего', () => {
  timeoutSilent(rules);
  for (const res of [null, undefined, {}, { text: '' }, { text: ' \n\t' }, { alert: true as const },
    { timeout: true as const }, { timeout: true as const, alert: true as const, text: 'Не показывать' }])
    assert.deepEqual(rules.callbackOutcome(res), { kind: 'none' });
});

it('R302 409 сообщает об устаревшей кнопке, свой таймаут молчит, остальные ошибки не теряются', () => {
  staleVisible(rules);
  assert.equal(rules.callbackErrorOutcome({ timeout: true }), 'silent');
  assert.equal(rules.callbackErrorOutcome({ status: 409, timeout: true }), 'silent', 'клиентский обрыв сильнее HTTP-ошибки');
  for (const error of [{ status: 500 }, { status: 403 }, new Error('network'), null, undefined])
    assert.equal(rules.callbackErrorOutcome(error), 'error');
});

it('R302 ожидание привязано к сообщению и callback_data, а не к соседней кнопке или подписи', () => {
  assert.equal(rules.kbPressKey('m1', 'yes'), rules.kbPressKey('m1', 'yes'));
  assert.notEqual(rules.kbPressKey('m1', 'yes'), rules.kbPressKey('m2', 'yes'));
  assert.notEqual(rules.kbPressKey('m1', 'yes'), rules.kbPressKey('m1', 'no'));
  assert.notEqual(rules.kbPressKey('ab', 'c'), rules.kbPressKey('a', 'bc'), 'граница двух полей не теряется');
  assert.equal(rules.kbUrlAction(true), 'open');
  assert.equal(rules.kbUrlAction(false), 'confirm');
});

it('R302 контрфакт поиска подстроки вместо префикса действительно пойман', () => {
  prefix(rules);
  const anchor = '.startsWith(q)';
  prefix(mutated(anchor, anchor));
  const mutant = mutated(anchor, '.includes(q)');
  assert.throws(() => prefix(mutant), (e: unknown) =>
    expectedAssertion(e, 'R302 ищем только префикс, без регистра, сохраняя порядок бота', 'deepStrictEqual') &&
    Array.isArray(e.actual) && Array.isArray(e.expected) &&
    e.actual.map((c: { command: string }) => c.command).join(',') === 'status,restart,STop' &&
    e.expected.map((c: { command: string }) => c.command).join(',') === 'status,STop');
});

it('R302 контрфакт ограничения списка восемью действительно пойман', () => {
  allHundred(rules);
  const anchor = 'return commands.filter((c) => c.command.toLowerCase().startsWith(q));';
  allHundred(mutated(anchor, anchor));
  const mutant = mutated(anchor,
    'return commands.filter((c) => c.command.toLowerCase().startsWith(q)).slice(0, 8);');
  assert.throws(() => allHundred(mutant), (e: unknown) =>
    expectedAssertion(e, 'R302 все сто команд видны без обрезания до восьми', 'deepStrictEqual') &&
    Array.isArray(e.actual) && e.actual.length === 8 && Array.isArray(e.expected) && e.expected.length === 100);
});

it('R302 контрфакт показа alert тостом действительно пойман', () => {
  alertWindow(rules);
  const anchor = "res.alert ? { kind: 'alert', text }";
  alertWindow(mutated(anchor, anchor));
  const mutant = mutated(anchor, "res.alert ? { kind: 'toast', text }");
  assert.throws(() => alertWindow(mutant), (e: unknown) =>
    expectedAssertion(e, 'R302 alert открывает окно, а не тост', 'strictEqual') && e.actual === 'toast' && e.expected === 'alert');
});

it('R302 контрфакт тоста при timeout действительно пойман', () => {
  timeoutSilent(rules);
  const anchor = 'if (!res || res.timeout)';
  timeoutSilent(mutated(anchor, anchor));
  const mutant = mutated(anchor, 'if (!res)');
  assert.throws(() => timeoutSilent(mutant), (e: unknown) =>
    expectedAssertion(e, 'R302 timeout молчит даже с текстом', 'strictEqual') && e.actual === 'toast' && e.expected === 'none');
});

it('R302 контрфакт молчаливой 409 действительно пойман', () => {
  staleVisible(rules);
  const anchor = "if (e?.status === 409) return 'stale';";
  staleVisible(mutated(anchor, anchor));
  const mutant = mutated(anchor, "if (e?.status === 409) return 'silent';");
  assert.throws(() => staleVisible(mutant), (e: unknown) =>
    expectedAssertion(e, 'R302 409 показывает устаревшую кнопку, не молчит', 'strictEqual') && e.actual === 'silent' && e.expected === 'stale');
});
