import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import jwt from 'jsonwebtoken';
import * as sdk from 'livekit-server-sdk';
import * as shared from '@gusvoice/shared';
import * as rules from './livekitRules.js';
import type * as Livekit from './livekit.js';

const P = shared.Permission;
const all = P.SPEAK | P.STREAM | P.VIDEO | P.SHARE_SCREEN | P.SEND_MESSAGES | P.PRIORITY_SPEAKER;
const source = readFileSync(new URL('./livekit.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const syntheticKey = 'r306-test-signing-material-not-a-deployed-secret';
function ruleModule(s: string): typeof rules {
  const module = { exports: {} }; const deps: Record<string, unknown> = { '@gusvoice/shared': shared, 'livekit-server-sdk': sdk };
  runInNewContext(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) { assert.ok(Object.hasOwn(deps, id)); return deps[id]; } });
  return module.exports as typeof rules;
}
function fixture(raw = source) {
  let present = true;
  const ttls: unknown[] = [];
  class AccessToken extends sdk.AccessToken {
    constructor(...args: ConstructorParameters<typeof sdk.AccessToken>) { super(...args); ttls.push(args[2]?.ttl); }
  }
  const calls: { room: string; identity: string; value: { permission: sdk.ParticipantPermission } }[] = [];
  class RoomServiceClient {
    constructor() {}
    async listParticipants(room: string) { assert.equal(room, 'channel-voice'); return present ? [{ identity: 'music-bot' }] : []; }
    async updateParticipant(room: string, identity: string, value: { permission: sdk.ParticipantPermission }) { calls.push({ room, identity, value }); }
  }
  const deps: Record<string, unknown> = { 'livekit-server-sdk': { ...sdk, RoomServiceClient, AccessToken },
    './env.js': { env: { livekit: { urlInternal: 'http://livekit.invalid', apiKey: 'r306-key', apiSecret: syntheticKey } } },
    '@gusvoice/shared': shared, './livekitRules.js': rules };
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(id: string) { assert.ok(Object.hasOwn(deps, id), `описан импорт LiveKit ${id}`); return deps[id]; } });
  return { mod: module.exports as typeof Livekit, calls, ttls, absent: () => { present = false; } };
}
function mutate(from: string, to: string) { assert.equal(source.split(from).length - 1, 1, 'уникальный якорь LiveKit'); return source.replace(from, to); }
for (const [perms, muted, publish] of [[all, false, true], [all, true, false], [P.STREAM, false, false], [0n, false, false]] as const)
  it(`R306 грант бота только микрофон: права ${perms}, мьют ${muted}`, () => {
    assert.deepEqual(rules.botPublishGrant(perms, muted), { canPublish: publish, canPublishSources: publish ? [sdk.TrackSource.MICROPHONE] : [] });
  });
it('R306 метаданные бота не выдают приоритет говорящего, человеческий JSON не меняется', () => {
  assert.equal(rules.voiceTokenMetadata(all, '/avatar.png', { bot: true }), '{"avatarUrl":"/avatar.png","priority":false,"bot":true}');
  assert.deepEqual(JSON.parse(rules.voiceTokenMetadata(all, null)), { avatarUrl: null, priority: true });
  assert.equal(Object.hasOwn(JSON.parse(rules.voiceTokenMetadata(all)), 'bot'), false);
});
async function mute(raw = source) {
  const f = fixture(raw);
  for (const muted of [true, false]) {
    await f.mod.serverMute('channel-voice', 'music-bot', muted, all, { bot: true });
    const c = f.calls.at(-1)!; assert.equal(c.identity, 'music-bot'); assert.equal(c.room, 'channel-voice');
    const p = c.value.permission;
    assert.equal(p.canSubscribe, false, 'R306 мьют бота не возвращает слух');
    assert.equal(p.canPublishData, false); assert.equal(p.canUpdateMetadata, false);
    assert.equal(p.canPublish, !muted); assert.deepEqual(p.canPublishSources, muted ? [] : [sdk.TrackSource.MICROPHONE]);
  }
  assert.equal(f.calls.length, 2);
  f.absent(); await f.mod.serverMute('channel-voice', 'music-bot', true, all, { bot: true }); assert.equal(f.calls.length, 2);
}
it('R306 настоящий serverMute и размьют сохраняют боту запрет слушать, отсутствующему ничего не пишут', () => mute());
it('R306 человеческий serverMute сохраняет камеру/экран и право слушать', async () => {
  const f = fixture(); await f.mod.serverMute('channel-voice', 'music-bot', true, all);
  const p = f.calls[0].value.permission;
  assert.equal(p.canSubscribe, true); assert.equal(p.canPublishData, true); assert.equal(p.canUpdateMetadata, true);
  assert.deepEqual(p.canPublishSources, [sdk.TrackSource.CAMERA, sdk.TrackSource.SCREEN_SHARE, sdk.TrackSource.SCREEN_SHARE_AUDIO]);
});
type Claims = jwt.JwtPayload & { video: { roomJoin: boolean; room: string; canSubscribe: boolean; canPublish: boolean;
  canPublishData: boolean; canUpdateOwnMetadata: boolean; canPublishSources: string[] }; metadata: string; name: string };
async function token(raw = source, muted = false) {
  const f = fixture(raw);
  const before = Math.floor(Date.now() / 1000);
  const value = await f.mod.createBotVoiceToken({ botId: 'music-bot', name: 'Музыка', room: 'channel-voice', permissions: all,
    avatarUrl: '/avatar.png', serverMuted: muted });
  // Настоящая подпись проверяется синтетическим ключом; не только декодирование произвольного JSON.
  const p = jwt.verify(value, syntheticKey, { algorithms: ['HS256'], issuer: 'r306-key', subject: 'music-bot' }) as Claims;
  const after = Math.floor(Date.now() / 1000);
  assert.equal(p.name, 'Музыка'); assert.equal(f.ttls[0], 600, 'R306 JWT бота живёт десять минут');
  // SDK отдельно читает часы для exp и nbf: пересечение границы секунды не должно сделать тест flaky.
  assert.ok(p.exp! >= before + 600 && p.exp! <= after + 600);
  assert.ok(p.nbf! >= before && p.nbf! <= after);
  assert.equal(p.video.roomJoin, true); assert.equal(p.video.room, 'channel-voice');
  assert.equal(p.video.canSubscribe, false, 'R306 JWT бота не разрешает слушать');
  assert.equal(p.video.canPublishData, false); assert.equal(p.video.canUpdateOwnMetadata, false);
  assert.equal(p.video.canPublish, !muted); assert.deepEqual(p.video.canPublishSources, muted ? [] : ['microphone']);
  assert.deepEqual(JSON.parse(p.metadata), { avatarUrl: '/avatar.png', priority: false, bot: true });
  assert.equal(f.calls.length, 0, 'подпись токена не требует сети LiveKit');
}
for (const muted of [false, true]) it(`R306 настоящий JWT бота сохраняет privacy, identity и TTL600, мьют ${muted}`, () => token(source, muted));
it('R306 контрфакт: общий serverMute возвращает боту слух', async () => {
  await mute(); await assert.rejects(mute(mutate('opts?.bot ? botVoicePermission(permissions, muted)', 'false ? botVoicePermission(permissions, muted)')),
    e => e instanceof assert.AssertionError && e.message.startsWith('R306 мьют бота не возвращает слух') && e.actual === true && e.expected === false);
});
it('R306 контрфакт: человеческий TTL не проходит настройку настоящего JWT бота', async () => {
  await token(); await assert.rejects(token(mutate('ttl: BOT_VOICE_TOKEN_TTL_S,', "ttl: '4h',")),
    e => e instanceof assert.AssertionError && e.message.startsWith('R306 JWT бота живёт десять минут') && e.actual === '4h' && e.expected === 600);
});
it('R306 контрфакт: publishGrant с STREAM даёт боту лишние источники', () => {
  const raw = readFileSync(new URL('./livekitRules.ts', import.meta.url), 'utf8');
  const check = (r: typeof rules) => assert.equal(r.botPublishGrant(all).canPublishSources.includes(sdk.TrackSource.CAMERA), false, 'R306 бот не публикует камеру');
  check(rules); check(ruleModule(raw)); const from = 'if (!serverMuted && has(permissions, Permission.SPEAK)) return { canPublish: true, canPublishSources: [TrackSource.MICROPHONE] };';
  assert.equal(raw.split(from).length - 1, 1);
  assert.throws(() => check(ruleModule(raw.replace(from, 'return publishGrant(permissions, serverMuted);'))),
    e => e instanceof assert.AssertionError && e.message.startsWith('R306 бот не публикует камеру') && e.actual === true && e.expected === false);
});
it('R306 контрфакт: пустой список без canPublish false не запрещает публикацию', () => {
  const raw = readFileSync(new URL('./livekitRules.ts', import.meta.url), 'utf8');
  const from = 'return { canPublish: false, canPublishSources: [] };'; assert.equal(raw.split(from).length - 1, 1);
  const check = (r: typeof rules) => assert.equal(r.botPublishGrant(0n).canPublish, false, 'R306 пустой список запрещает публикацию');
  check(rules); check(ruleModule(raw));
  assert.throws(() => check(ruleModule(raw.replace(from, 'return { canPublishSources: [] };'))),
    e => e instanceof assert.AssertionError && e.message.startsWith('R306 пустой список запрещает публикацию') && e.actual === undefined && e.expected === false);
});
