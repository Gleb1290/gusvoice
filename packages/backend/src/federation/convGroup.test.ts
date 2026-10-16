import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as groupRules from '../groupRules.js';
import * as userRules from '../userSearchRules.js';
import * as instanceIdentity from './instanceIdentity.js';
import * as keyRules from './signingKeys.js';
import * as linkRules from './linkRules.js';

type Group = typeof import('./convGroup.js');
type Mutation = readonly [string, string];
const source = readFileSync(new URL('./convGroup.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NOW = 2_000_000_000_000;
const unavailable = (name: string) => () => { throw new Error(`неисполняемая IO-граница ${name}`); };
function identity() {
  const root = crypto.generateKeyPairSync('ed25519');
  const rootPrivate = root.privateKey.export({ type: 'pkcs8', format: 'der' });
  const rootPublic = root.publicKey.export({ type: 'spki', format: 'der' });
  return { instanceId: instanceIdentity.instanceIdFrom(rootPublic), rootPublicKeyDer: rootPublic,
    key: keyRules.issueSigningKey(rootPrivate, NOW), rootPrivate };
}
function moduleOf(id: ReturnType<typeof identity>, options: { mutation?: Mutation; missing?: 'identity' | 'key'; badKey?: boolean } = {}): Group {
  let raw = source;
  if (options.mutation) {
    assert.equal(raw.split(options.mutation[0]).length - 1, 1, 'единственный якорь подписи');
    raw = raw.replace(...options.mutation);
  }
  const deps: Record<string, unknown> = {
    'node:crypto': crypto, '@gusvoice/shared': shared, 'drizzle-orm': orm,
    '../convGroups.js': { addGroupMembers: unavailable('add'), removeGroupMember: unavailable('remove'), updateGroupInfo: unavailable('title') },
    '../conversations.js': { deliver: unavailable('deliver'), journal: unavailable('journal'), lockConversation: unavailable('lock') },
    '../db/index.js': { db: new Proxy({}, { get: (_obj, name) => unavailable(`db.${String(name)}`) }) }, '../db/schema.js': {},
    '../groupRules.js': groupRules, '../userSearchRules.js': userRules,
    './directorySync.js': { refreshCapabilities: unavailable('capabilities') },
    './guestHost.js': { ensureShadowUser: unavailable('ensure shadow'), shadowUserFor: unavailable('find shadow') },
    './instance.js': { federation: { identity: () => options.missing === 'identity' ? null : id,
      signingKey: () => options.missing === 'key' ? null : options.badKey ? { ...id.key, privateKeyDer: Buffer.from('не ключ') } : id.key } },
    './instanceIdentity.js': instanceIdentity, './instanceMeta.js': { readInstanceMeta: unavailable('meta') }, './linkRules.js': linkRules,
    './links.js': { getLink: unavailable('link') }, './peerClient.js': { postSignedToPeer: unavailable('network') }, './signingKeys.js': keyRules,
  };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Buffer, Date, URL,
    require: (name: string) => { assert.ok(Object.hasOwn(deps, name), `явный импорт ${name}`); return deps[name]; },
  });
  return module.exports as Group;
}
function message(author: string): shared.FedConvMessageWire {
  return { id: 'signed-message', conversationId: 'signed-group', author: { instanceId: author, userId: 'local-author' },
    clientId: null, payloadHash: null, createdAt: NOW - 1, originSortKey: 1, content: 'Текст автора', replyToId: null,
    forwardedFrom: null, silent: false, noPreview: false, captionAbove: false, replyQuote: null, sticker: null, service: null,
    attachments: [], editVersion: 0, editedAt: null, deleted: false };
}
function signed(api: Group, w: shared.FedConvMessageWire) {
  const sig = api.signOwnMessage(w); assert.ok(sig, 'реальный сменный ключ подписывает сообщение');
  assert.ok(shared.parseMessageSig(sig)); return { ...shared.serializeConvMessageWire(w), sig };
}
it('R203 подпись настоящего дома проходит без базы и связки с автором, истёкший сертификат доказывает выпуск корневым', () => {
  const id = identity(), api = moduleOf(id), w = message(id.instanceId);
  const entity = signed(api, w); assert.equal(api.verifyMessageSig(w, entity), true);
  // Истёкший срок не отменяет криптографический факт выпуска: это не допуск текущего HTTP-запроса.
  const old = { ...id, key: keyRules.issueSigningKey(id.rootPrivate, 1, 1) };
  assert.equal(api.verifyMessageSig(w, signed(moduleOf(old), w)), true);
});
it('R203 подмена текста, правки, надгробия, ответа или вложения отвергается, исходное сообщение по-прежнему проходит', () => {
  const id = identity(), api = moduleOf(id), w = message(id.instanceId), entity = signed(api, w);
  const attachment: shared.FedConvAttachmentWire = { id: 'new-file', name: 'a.txt', contentType: 'text/plain', size: 1,
    width: null, height: null, durationMs: null, waveform: null, asFile: false, spoiler: false, sha256: null };
  for (const patch of [{ content: 'Другой текст' }, { editVersion: 1 }, { deleted: true }, { replyToId: 'other-message' }, { attachments: [attachment] }])
    assert.equal(api.verifyMessageSig({ ...w, ...patch }, entity), false, 'каждое подписанное поле защищено от подмены');
  assert.equal(api.verifyMessageSig(w, entity), true);
});
function rootBound(mutation?: Mutation) {
  const author = identity(), foreign = identity(), api = moduleOf(author, { mutation }), w = message(author.instanceId);
  assert.equal(api.verifyMessageSig(w, signed(api, w)), true);
  // Другой дом подписал тот же текст, но у сообщения осталась личность исходного автора.
  assert.equal(api.verifyMessageSig(w, signed(moduleOf(foreign), w)), false, 'корневой ключ другого дома не подписывает нашего автора');
}
it('R203 чужой настоящий корневой ключ не подменяет дом автора даже с валидной цепочкой и подписью сообщения', () => rootBound());
function certified(mutation?: Mutation) {
  const author = identity(), attacker = identity(), api = moduleOf(author, { mutation }), w = message(author.instanceId);
  assert.equal(api.verifyMessageSig(w, signed(api, w)), true);
  // Корень тот самый, но сертификат сменного ключа выпущен НЕ им; подпись самого текста корректна.
  const forgedIssuer = { ...author, key: attacker.key };
  const entity = signed(moduleOf(forgedIssuer), w);
  assert.equal(api.verifyMessageSig(w, entity), false, 'сменный ключ требует подписи именно корневым ключом автора');
}
it('R203 корректная подпись текста не заменяет сертификат сменного ключа от корня автора', () => certified());
it('R203 повреждённая подпись или DER и отсутствующая подпись отвергаются без исключения, нормальная пара принимается', () => {
  const id = identity(), api = moduleOf(id), w = message(id.instanceId), entity = signed(api, w);
  const valid = shared.parseMessageSig(entity.sig)!;
  for (const sig of [undefined, null, {}, shared.serializeMessageSig({ ...valid, value: '!not-base64url' }),
    shared.serializeMessageSig({ ...valid, value: 'a'.repeat(86) }),
    shared.serializeMessageSig({ ...valid, root: 'a'.repeat(32) })])
    assert.equal(api.verifyMessageSig(w, { ...entity, sig }), false);
  assert.equal(api.verifyMessageSig(w, entity), true);
});
it('R203 отсутствие личности, сменного ключа или повреждённый private DER не выдают фиктивную подпись', () => {
  const id = identity(), w = message(id.instanceId);
  for (const options of [{ missing: 'identity' as const }, { missing: 'key' as const }, { badKey: true }])
    assert.equal(moduleOf(id, options).signOwnMessage(w), null);
  assert.ok(moduleOf(id).signOwnMessage(w));
});
it('R203 мутант без instanceIdFrom допускает другой дом и ловится настоящими двумя корневыми ключами', () => {
  rootBound();
  assert.throws(() => rootBound(['if (instanceIdFrom(root) !== w.author.instanceId) return false;', '']),
    e => e instanceof assert.AssertionError && e.message.includes('корневой ключ другого дома'));
});
it('R203 мутант без verifySigningKey допускает неподтверждённый сменный ключ и ловится настоящей подписью текста', () => {
  certified();
  assert.throws(() => certified(['if (!verifySigningKey(root, s.key)) return false;', '']),
    e => e instanceof assert.AssertionError && e.message.includes('сменный ключ требует подписи'));
});
