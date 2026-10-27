import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BotInfo } from '@gusvoice/shared';
import { botCreateBlock, botStateLine, BOTS_OFF_TEXT, isBotUser, botsUnsupported, botAccessLabel,
  botDeliveryRows, middleEllipsis, botHookErrorText } from './botRules';
import { bot, readClient, load, assertion, mutate, environment } from './components/R297.bot.harness';
import * as shared from '@gusvoice/shared';

const create = { bots: [], canCreate: true, limit: 1 };
it('R297 выключенный сервер объясняет запрет до прав и исчерпанного лимита', () => {
  assert.equal(botCreateBlock({ ...create, enabled: false, canCreate: false, limit: 0 }), BOTS_OFF_TEXT);
});
it('R297 включённый и старый сервер без enabled разрешают создание ниже лимита', () => {
  assert.equal(botCreateBlock({ ...create, enabled: true }), null);
  assert.equal(botCreateBlock(create), null);
});
it('R297 запрет администратора объясняется отдельно от выключенных ботов', () => {
  assert.match(botCreateBlock({ ...create, canCreate: false })!, /так решил его администратор/);
});
it('R297 лимит: место до границы доступно, ровно лимит и ноль блокируют создание', () => {
  assert.equal(botCreateBlock({ ...create, bots: [bot], limit: 2 }), null);
  assert.match(botCreateBlock({ ...create, bots: [bot], limit: 1 })!, /У вас уже 1 из 1/);
  assert.match(botCreateBlock({ ...create, limit: 0 })!, /У вас уже 0 из 0/);
});
const hook: NonNullable<BotInfo['webhook']> = { url: 'https://bot.example.test/events', lastError: 'сбой', failures: 10, disabledAt: '2026-01-01' };
it('R297 выключение администратором приоритетнее общего выключателя и доставки', () => {
  assert.deepEqual(botStateLine({ ...bot, disabledAt: '2026-01-01', webhook: hook }, false),
    { text: 'Выключен администратором — бот не может работать', tone: 'off' });
});
it('R297 общий выключатель приоритетнее ошибки и выключения доставки', () => {
  assert.deepEqual(botStateLine({ ...bot, webhook: hook }, false),
    { text: 'Сейчас не работает: боты на этом сервере выключены', tone: 'off' });
});
it('R297 выключенная доставка приоритетнее последней ошибки', () => {
  assert.deepEqual(botStateLine({ ...bot, webhook: hook }),
    { text: 'Доставка выключена после сбоев — бот должен заново указать свой адрес', tone: 'off' });
});
it('R297 ошибка доставки предупреждает, исправная доставка зелёная, самостоятельное чтение без строки', () => {
  assert.deepEqual(botStateLine({ ...bot, webhook: { ...hook, disabledAt: null } }), { text: 'Доставка не удалась: сбой', tone: 'warn' });
  assert.deepEqual(botStateLine({ ...bot, webhook: { ...hook, disabledAt: null, lastError: null } }), { text: 'Доставка работает', tone: 'ok' });
  assert.equal(botStateLine(bot), null);
});
it('R297 только явные bot:true и status:404 обозначают бота и неподдерживаемый сервер', () => {
  assert.equal(isBotUser({ bot: true }), true); assert.equal(botsUnsupported({ status: 404 }), true);
  for (const value of [null, undefined, false, 'bot', {}, { bot: false }, { bot: 1 }, { bot: 'true' }]) assert.equal(isBotUser(value), false);
  for (const value of [null, undefined, {}, { status: '404' }, { status: 403 }, { status: 500 }]) assert.equal(botsUnsupported(value), false);
  assert.equal(botAccessLabel(true), 'Для всех'); assert.equal(botAccessLabel(false), 'Приватный');
});
const raw = readClient('../botRules.ts');
for (const [label, from, to, probe, actual, expected] of [
  ['проигнорирован enabled', 'if (!botsEnabled(r)) return BOTS_OFF_TEXT;', '',
    (m: typeof import('./botRules')) => m.botCreateBlock({ ...create, enabled: false }), null, BOTS_OFF_TEXT],
  ['потеряна граница лимита', 'r.bots.length >= r.limit', 'r.bots.length > r.limit',
    (m: typeof import('./botRules')) => m.botCreateBlock({ ...create, bots: [bot] }), null,
    'У вас уже 1 из 1 возможных ботов. Удалите ненужного, чтобы создать нового.'],
  ['игнорируется отключение бота', 'if (b.disabledAt)', 'if (false)',
    (m: typeof import('./botRules')) => m.botStateLine({ ...bot, disabledAt: '2026-01-01' }, false)?.text,
    'Сейчас не работает: боты на этом сервере выключены', 'Выключен администратором — бот не может работать'],
] as const) it(`R297 контрфакт правил клиента: ${label}`, async () => {
  // Исполняется весь настоящий модуль с одной точечной мутацией, не копия его условий.
  await environment(async () => {
    const message = 'R297-client-rule';
    const check = (source: string) => assert.equal(probe(load<typeof import('./botRules')>(source, { '@gusvoice/shared': shared })), expected, message);
    check(raw); assert.throws(() => check(mutate(raw, from, to)), assertion(message, actual, expected));
  });
});

it('R300 HTTP-ошибка называет адрес бота, остальные сообщения сохраняются без выдуманного кода', () => {
  assert.equal(botHookErrorText('ответ 500'), 'адрес бота ответил кодом 500');
  assert.equal(botHookErrorText('ответ 404'), 'адрес бота ответил кодом 404');
  for (const text of ['', 'ECONNREFUSED', 'сбой сети', 'ответ 50', 'ответ 5000', 'ответ 500 затем сбой', ' ответ 500']) {
    assert.equal(botHookErrorText(text), text);
  }
  assert.deepEqual(botStateLine({ ...bot, webhook: { ...hook, disabledAt: null, lastError: 'ответ 502' } }),
    { text: 'Доставка не удалась: адрес бота ответил кодом 502', tone: 'warn' });
});
it('R300 адрес до лимита и ровно 48 символов не обрезается, 49 сохраняет начало и конец', () => {
  assert.equal(middleEllipsis(''), '');
  assert.equal(middleEllipsis('x'.repeat(47)), 'x'.repeat(47));
  assert.equal(middleEllipsis('x'.repeat(48)), 'x'.repeat(48));
  const text = 'https://bot.example.test/' + 'x'.repeat(20) + 'tail'; // 49 символов.
  assert.equal(text.length, 49);
  assert.equal(middleEllipsis(text), `${text.slice(0, 24)}…${text.slice(-23)}`);
  assert.equal(middleEllipsis(text).length, 48);
});
it('R300 явный нечётный и чётный лимиты оставляют обе стороны адреса', () => {
  assert.equal(middleEllipsis('abcdef', 5), 'ab…ef');
  assert.equal(middleEllipsis('abcdefg', 6), 'abc…fg');
  assert.equal(middleEllipsis('abcde', 5), 'abcde');
  assert.equal(middleEllipsis('abc', 3), 'abc');
  assert.equal(middleEllipsis('abcd', 3), 'a…d');
});
it('R300 без webhook бот забирает события опросом или WebSocket, адреса и ошибки нет', () => {
  const rows = botDeliveryRows(null, () => assert.fail('у опроса нет времени ошибки'));
  assert.deepEqual(rows, [{ label: 'Способ', value: 'Опрос или WebSocket — программа бота забирает события сама, адреса доставки нет' }]);
});
it('R300 исправная доставка показывает адрес с полной подсказкой и зелёное состояние без ошибки', () => {
  const url = `https://bot.example.test/${'long-path/'.repeat(8)}events`;
  assert.deepEqual(botDeliveryRows({ ...hook, url, disabledAt: null, lastError: null, lastErrorAt: '2026-10-26', failures: 0 },
    () => assert.fail('без ошибки время не показывается')),
  [{ label: 'Адрес', value: middleEllipsis(url), title: url }, { label: 'Состояние', value: 'Работает', tone: 'ok' }]);
});
it('R300 сбои доставки предупреждают о повторе и показывают перевод ошибки с переданным временем', () => {
  const seen: string[] = [];
  assert.deepEqual(botDeliveryRows({ ...hook, disabledAt: null, lastError: 'ответ 500', lastErrorAt: '2026-10-26T12:00:00Z' },
    iso => { seen.push(iso); return '26 окт. 15:00'; }),
  [{ label: 'Адрес', value: hook.url, title: hook.url },
    { label: 'Состояние', value: 'Есть сбои — сервер повторяет доставку', tone: 'warn' },
    { label: 'Последняя ошибка', value: 'адрес бота ответил кодом 500 · 26 окт. 15:00', tone: 'warn' }]);
  assert.deepEqual(seen, ['2026-10-26T12:00:00Z']);
});
it('R300 старый сервер без времени ошибки не оставляет пустой разделитель', () => {
  for (const lastErrorAt of [undefined, null]) {
    const rows = botDeliveryRows({ ...hook, disabledAt: null, lastErrorAt }, () => assert.fail('времени нет'));
    assert.deepEqual(rows[2], { label: 'Последняя ошибка', value: 'сбой', tone: 'warn' });
  }
});
it('R300 выключенная доставка важнее последней ошибки и объясняет повторный setWebhook', () => {
  const rows = botDeliveryRows({ ...hook, failures: 10, lastError: 'ответ 502' });
  assert.deepEqual(rows[1], { label: 'Состояние',
    value: 'Выключена после 10 сбоев подряд. Включится снова, когда программа бота заново вызовет setWebhook.', tone: 'off' });
  assert.deepEqual(rows[2], { label: 'Последняя ошибка', value: 'адрес бота ответил кодом 502', tone: 'warn' });
  assert.equal(botDeliveryRows({ ...hook, lastError: null }).length, 2);
});
for (const [label, from, to, probe, actual, expected] of [
  ['обрезан хвост вместо середины', 'text.slice(text.length - (keep - head))', 'text.slice(0, keep - head)',
    (m: typeof import('./botRules')) => m.middleEllipsis('abcdefg', 6), 'abc…ab', 'abc…fg'],
  ['выключенная доставка названа работающей', 'if (w.disabledAt) {', 'if (false) {',
    (m: typeof import('./botRules')) => m.botDeliveryRows({ ...hook, lastError: null })[1].tone, 'ok', 'off'],
  ['время ошибки потеряно', 'const at = w.lastErrorAt ?', 'const at = false ?',
    (m: typeof import('./botRules')) => m.botDeliveryRows({ ...hook, lastErrorAt: 'iso' }, () => 'время')[2].value,
    'сбой', 'сбой · время'],
] as const) it(`R300 контрфакт доставки: ${label}`, async () => {
  await environment(async () => {
    const message = `R300-delivery-${label}`;
    const check = (source: string) => assert.equal(probe(load<typeof import('./botRules')>(source, { '@gusvoice/shared': shared })), expected, message);
    check(raw);
    assert.throws(() => check(mutate(raw, from, to)), assertion(message, actual, expected));
  });
});
