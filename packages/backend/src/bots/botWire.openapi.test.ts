import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MessageEmbed } from '@gusvoice/shared';
import type { z } from 'zod';
import * as wire from './botWire.js';
import { assertion, historical, loadOpenApi, loadSpec, loadWire } from './botOpenApi.harness.js';

type Assert<T extends true> = T;
type WireEmbed = z.infer<typeof wire.wireEmbed>;
// Двусторонняя проверка: дополнительные обязательные поля и сужение уже выпущенного типа запрещены.
type WireAcceptsShared = Assert<MessageEmbed extends WireEmbed ? true : false>;
type SharedAcceptsWire = Assert<WireEmbed extends MessageEmbed ? true : false>;
type AllSharedKeysKnown = Assert<Exclude<keyof MessageEmbed, keyof WireEmbed> extends never ? true : false>;
type NoExtraWireKeys = Assert<Exclude<keyof WireEmbed, keyof MessageEmbed> extends never ? true : false>;

const complete: MessageEmbed = {
  title: 'Заголовок', description: 'Описание', url: 'https://example.invalid', color: 0x123456, timestamp: '2026-10-27T00:00:00Z',
  author: { name: 'Автор', url: 'https://example.invalid/author', iconUrl: '/author.png' },
  footer: { text: 'Подвал', iconUrl: '/footer.png' }, fields: [{ name: 'Поле', value: 'Значение', inline: true }],
  image: { url: '/image.png' }, thumbnail: { url: '/thumb.png' }, imageLink: 'https://example.invalid/image', thumbnailLink: 'https://example.invalid/thumb',
};
const message = { message_id: 'm', chat: { id: 'chat', type: 'dm' }, from: { id: 'u', username: 'user', display_name: 'Имя', bot: false }, date: 1, text: '' };
it('R307 wireEmbed принимает все поля MessageEmbed без потерь, пустая и минимальная карточки допустимы', () => {
  assert.deepEqual(Object.keys(wire.wireEmbed.shape).sort(), Object.keys(complete).sort());
  assert.deepEqual(wire.wireEmbed.parse(complete), complete);
  for (const value of [{}, { title: 'Минимум' }, { author: { name: 'А' } }, { footer: { text: 'Ф' } }, { fields: [{ name: 'Н', value: 'В' }] }])
    assert.deepEqual(wire.wireEmbed.parse(value), value);
  assert.equal(wire.wireMessage.safeParse({ ...message, embeds: [complete] }).success, true);
  assert.equal(wire.wireMessage.safeParse(message).success, true);
});
const invalid: [string, unknown][] = [
  ['не объект', 'card'], ['null', null], ['title не строка', { title: 1 }], ['color не число', { color: '#fff' }],
  ['автор без имени', { author: { url: '/x' } }], ['footer без текста', { footer: {} }],
  ['fields не массив', { fields: {} }], ['поле без value', { fields: [{ name: 'Имя' }] }],
  ['inline не boolean', { fields: [{ name: 'Н', value: 'В', inline: 'true' }] }],
  ['image без url', { image: {} }], ['thumbnail url не строка', { thumbnail: { url: 7 } }], ['imageLink не строка', { imageLink: true }],
];
for (const [name, value] of invalid) it(`R307 embed неверной формы отклоняется и отдельно, и внутри wireMessage: ${name}`, () => {
  assert.equal(wire.wireEmbed.safeParse(value).success, false);
  assert.equal(wire.wireMessage.safeParse({ ...message, embeds: [value] }).success, false);
  assert.equal(wire.wireMessage.safeParse({ ...message, embeds: [complete] }).success, true);
});
it('R307 старые образцы sendMessage/getUpdates по-прежнему принимаются настоящими схемами без изменения полей', () => {
  const samples = historical();
  const sent = (samples.sendMessage as { result: unknown }).result;
  assert.deepEqual(wire.wireMessage.parse(sent), sent);
  const updates = (samples.getUpdates as { result: unknown[] }).result;
  assert.equal(updates.length, 4);
  for (const update of updates) assert.deepEqual(wire.wireUpdate.parse(update), update);
});
it('R307 неизвестные добавленные поля карточки не ломают приём старым клиентом', () => {
  assert.deepEqual(wire.wireEmbed.parse({ ...complete, future_extension: true }), complete);
});
const custom = { from: '  embeds: z.array(wireEmbed).optional(),', to: '  embeds: z.array(z.custom()).optional(),' };
it('R307 контрфакт: z.custom вновь пропускает неверный embed в wireMessage', () => {
  const check = (w: typeof wire) => assert.equal(w.wireMessage.safeParse({ ...message, embeds: [{ author: { name: 7 } }] }).success, false, 'R307 форма вложенного embed проверяется');
  check(wire); check(loadWire()); assert.throws(() => check(loadWire(custom)), assertion('R307 форма вложенного embed проверяется', true, false));
});
it('R307 контрфакт: z.custom теряет схему embed в OpenAPI, а не падает случайно при загрузке', () => {
  const check = (w: typeof wire) => {
    const doc = loadOpenApi(undefined, loadSpec(undefined, w), w).buildBotOpenApi();
    const schemas = doc.components.schemas as Record<string, unknown>;
    assert.equal(Object.hasOwn(schemas, 'MessageEmbed'), true, 'R307 OpenAPI описывает MessageEmbed');
  };
  check(wire); check(loadWire()); assert.throws(() => check(loadWire(custom)), assertion('R307 OpenAPI описывает MessageEmbed', false, true));
});
