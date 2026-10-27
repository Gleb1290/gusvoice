import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as rules from './botRules.js';
import * as roles from '../roleRules.js';
import * as wire from './botWire.js';

const bot = { id: 'bot', username: 'HelperBot', roleId: 'role-bot' };
const source = readFileSync(new URL('./botRules.ts', import.meta.url), 'utf8');
function load<T>(raw: string): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Buffer, URL, require(name: string) {
      if (name === '@gusvoice/shared') return shared;
      if (name === 'node:crypto') return crypto;
      assert.fail(`неописанная граница ${name}`);
    } });
  return module.exports as T;
}
it('R303 команда без адресата приходит всем, адресная команда учитывает ник без регистра', () => {
  for (const content of ['/cmd', '/cmd arg', '/cmd@helperbot', '/CMD@HelperBOT arg']) assert.equal(rules.botAddressed({ content }, bot), true, content);
  for (const content of ['/cmd@otherbot', ' /cmd', 'слово /cmd', '/', '', 'обычный текст']) assert.equal(rules.botAddressed({ content }, bot), false, content);
});
it('R303 личное упоминание не подменяется массовым, подстрокой ника или почтовым адресом', () => {
  for (const content of ['@helperbot', 'Привет, @HELPERBOT!', '(@HelperBot)']) assert.equal(rules.botAddressed({ content }, bot), true, content);
  for (const content of ['@everyone', '@here', '@helperbot_extra', 'mail@helperbot']) assert.equal(rules.botAddressed({ content }, bot), false, content);
});
it('R303 управляемая роль и ответ адресуют боту только собственные идентификаторы', () => {
  assert.equal(rules.botAddressed({ content: '', mentionRoles: ['other', 'role-bot'] }, bot), true);
  assert.equal(rules.botAddressed({ content: '', replyToAuthorId: 'bot' }, bot), true);
  for (const m of [{ content: '', mentionRoles: ['other'] }, { content: '', replyToAuthorId: 'other' }, { content: '', mentionRoles: null, replyToAuthorId: null }]) {
    assert.equal(rules.botAddressed(m, bot), false);
  }
  assert.equal(rules.botAddressed({ content: '', mentionRoles: ['role-bot'] }, { ...bot, roleId: null }), false);
});
it('R303 прочтение канала не превращается в прочтение ЛС, смешанная пачка сохраняет личное сообщение', () => {
  const rows = ['channel', 'dm'].map(type => ({ type: 'message', payload: { message_id: type, chat: { id: type, type } } }));
  assert.deepEqual([...rules.readMarksOf(rows)], [['dm', ['dm']]]);
  assert.deepEqual([...rules.readMarksOf(rows.slice(0, 1))], []);
});
it('R303 HTML поддерживает парные теги, вложения, спойлер, код и цитату', () => {
  for (const [html, expected] of [
    ['<b>жирный</b><strong>x</strong>', '**жирный****x**'],
    ['<i>x</i><em>y</em>', '__x____y__'], ['<u>x</u><ins>y</ins>', '<u>x</u><u>y</u>'],
    ['<s>x</s><strike>y</strike><del>z</del>', '~~x~~~~y~~~~z~~'],
    ['<b><i>x</i></b>', '**__x__**'], ['<tg-spoiler>x</tg-spoiler><span class="tg-spoiler">y</span>', '||x||||y||'],
    ['<code>x</code>', '`x`'], ['<pre><code>x</code></pre>', '```\nx\n```'],
    ['<blockquote>a<br>b</blockquote>', '> a\n> b'], ['<B>x</B>', '**x**'],
  ]) assert.equal(rules.htmlToMarkers(html), expected, html);
});
it('R303 HTML оставляет текст неизвестного тега, раскодирует сущности и не дублирует адрес ссылки', () => {
  for (const [html, expected] of [
    ['<unknown>текст</unknown>', 'текст'], ['&lt;tag&gt; &amp; &quot;x&quot; &apos;y&apos; &#65; &#x1F986;', '<tag> & "x" \'y\' A 🦆'],
    ['<a href="https://example.invalid/?a=1&amp;b=2">сайт</a>', 'сайт (https://example.invalid/?a=1&b=2)'],
    ['<a href="https://example.invalid/">https://example.invalid/</a>', 'https://example.invalid/'],
    ['<b>не закрыт', '**не закрыт**'], ['&unknown; &#0; &#1114112;', '&unknown; &#0; &#1114112;'],
  ]) assert.equal(rules.htmlToMarkers(html), expected, html);
});
it('R303 роль бота не получает ADMINISTRATOR даже от владельца; доступные права не теряются', () => {
  const P = shared.Permission;
  for (const owner of [false, true]) {
    assert.equal(roles.botGrant(shared.ALL_PERMISSIONS, shared.ALL_PERMISSIONS, owner) & P.ADMINISTRATOR, 0n);
    assert.equal(roles.botAdminRequested(P.ADMINISTRATOR | P.VIEW_CHANNEL), true);
    assert.equal(roles.botAdminRequested(P.VIEW_CHANNEL), false);
    assert.equal(roles.botGrant(P.VIEW_CHANNEL | P.BAN_MEMBERS, P.VIEW_CHANNEL, owner), P.VIEW_CHANNEL);
    assert.equal(roles.botGrant(P.VIEW_CHANNEL | P.SEND_MESSAGES, P.VIEW_CHANNEL | P.SEND_MESSAGES, owner), P.VIEW_CHANNEL | P.SEND_MESSAGES);
  }
});
it('R303 канальный провод сохраняет клавиатуру, публичный файл, ответ и данные гостя', () => {
  const m: shared.Message = { id: 'm', channelId: 'c', content: 'ответ', author: { id: 'a', username: 'local', displayName: 'Имя', avatarUrl: null },
    createdAt: '2026-01-01T00:00:00.999Z', editedAt: null, attachments: [{ url: 'https://example.invalid/a', name: 'a', contentType: 'text/plain', size: 1 }],
    replyTo: { id: 'parent', content: '', authorName: 'Автор' }, reactions: [], keyboard: [[{ text: 'Кнопка', callback_data: 'ok' }]] };
  const chat = wire.channelChat({ id: 'c', serverId: 's', name: 'general' });
  const from = { id: 'a', username: 'home', display_name: 'Имя', bot: false, instance_domain: 'neighbor.invalid' };
  const result = wire.toWireChannelMessage(m, chat, from);
  assert.deepEqual(result.chat, { id: 'c', type: 'channel', server_id: 's', title: 'general' });
  assert.deepEqual(result.from, from); assert.deepEqual(result.reply_markup, { inline_keyboard: m.keyboard });
  assert.equal(result.reply_to_message_id, 'parent'); assert.equal(result.attachments?.[0].url, m.attachments[0].url);
  assert.equal(result.date, 1767225600); assert.equal(Object.hasOwn(result, 'edit_date'), false);
  assert.equal(wire.toWireChannelMessage({ ...m, embedsFallback: true }, chat).text, '');
  for (const keyboard of [undefined, []]) assert.equal(Object.hasOwn(wire.toWireChannelMessage({ ...m, keyboard }, chat), 'reply_markup'), false);
});
it('R303 новые формы чатов и события принимаются без ослабления неизвестных типов', () => {
  for (const type of ['dm', 'channel', 'server']) assert.equal(wire.wireChat.safeParse({ id: 'c', type }).success, true);
  assert.equal(wire.wireChat.safeParse({ id: 'c', type: 'group' }).success, false);
  const user = { id: 'u', username: 'user', display_name: 'Человек', bot: false };
  const chat = { id: 'c', type: 'channel', server_id: 's' };
  assert.equal(wire.wireUpdate.safeParse({ update_id: 1, message_reaction: { chat, message_id: 'm', user, date: 1, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } }).success, true);
  assert.equal(wire.wireUpdate.safeParse({ update_id: 2, chat_member: { chat: { id: 's', type: 'server' }, from: user, user, date: 1, old_status: 'member', new_status: 'kicked' } }).success, true);
});
it('R303 реакции ограничены тремя emoji, а страницы участников и истории проверяют обе стороны лимита', () => {
  for (const count of [0, 1, 3]) assert.equal(wire.setMessageReactionParams.safeParse({ chat_id: 'c', message_id: 'm', reaction: Array.from({ length: count }, () => ({ type: 'emoji', emoji: '👍' })) }).success, true);
  assert.equal(wire.setMessageReactionParams.safeParse({ chat_id: 'c', message_id: 'm', reaction: Array.from({ length: 4 }, () => ({ type: 'emoji', emoji: '👍' })) }).success, false);
  assert.equal(wire.setMessageReactionParams.safeParse({ chat_id: 'c', message_id: 'm', reaction: [{ type: 'custom_emoji', emoji: '👍' }] }).success, false);
  for (const [schema, cap] of [[wire.getChatMembersParams, 200], [wire.getChatHistoryParams, 100]] as const) {
    for (const limit of [1, cap]) assert.equal(schema.safeParse({ chat_id: 'c', limit }).success, true);
    for (const limit of [0, cap + 1]) assert.equal(schema.safeParse({ chat_id: 'c', limit }).success, false);
  }
});
it('R303 контрфакты приватности и HTML убиваются точным AssertionError после полного original-first', () => {
  const cases = [
    { from: 'if (at < 0)', to: 'if (true)', marker: 'чужая команда закрыта', check: (r: typeof rules) => assert.strictEqual(r.botAddressed({ content: '/cmd@other' }, bot), false, 'чужая команда закрыта'), actual: true, expected: false },
    { from: "if (mentionedNames(text).some", to: "if (text === '@everyone') return true;\n  if (mentionedNames(text).some", marker: 'everyone не адресует боту', check: (r: typeof rules) => assert.strictEqual(r.botAddressed({ content: '@everyone' }, bot), false, 'everyone не адресует боту'), actual: true, expected: false },
    { from: 'first.slice(at + 1).toLowerCase() === nick', to: 'first.slice(at + 1) === nick', marker: 'регистр не мешает адресной команде', check: (r: typeof rules) => assert.strictEqual(r.botAddressed({ content: '/cmd@HELPERBOT' }, bot), true, 'регистр не мешает адресной команде'), actual: false, expected: true },
    { from: 'return out.join(\'\');', to: 'return html;', marker: 'HTML преобразуется в маркеры', check: (r: typeof rules) => assert.strictEqual(r.htmlToMarkers('<b>x</b>'), '**x**', 'HTML преобразуется в маркеры'), actual: '<b>x</b>', expected: '**x**' },
  ];
  for (const m of cases) {
    m.check(rules); m.check(load<typeof rules>(source));
    assert.equal(source.split(m.from).length - 1, 1, 'единственный якорь');
    assert.throws(() => m.check(load<typeof rules>(source.replace(m.from, m.to))), e => e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION'
      && e.message.split(/\r?\n/, 1)[0] === m.marker && e.operator === 'strictEqual' && e.actual === m.actual && e.expected === m.expected);
  }
});
it('R303 контрфакт ADMINISTRATOR от владельца пойман на полном модуле прав', () => {
  const raw = readFileSync(new URL('../roleRules.ts', import.meta.url), 'utf8');
  const anchor = 'return clampGrant(requested, actor, owner) & ~Permission.ADMINISTRATOR;';
  const check = (r: typeof roles) => assert.strictEqual(r.botGrant(shared.Permission.ADMINISTRATOR, shared.ALL_PERMISSIONS, true), 0n, 'бот никогда не администратор');
  check(roles); check(load<typeof roles>(raw)); assert.equal(raw.split(anchor).length - 1, 1);
  assert.throws(() => check(load<typeof roles>(raw.replace(anchor, 'return clampGrant(requested, actor, owner);'))), e => e instanceof assert.AssertionError
    && e.message.startsWith('бот никогда не администратор') && e.operator === 'strictEqual' && e.actual === shared.Permission.ADMINISTRATOR && e.expected === 0n);
});
