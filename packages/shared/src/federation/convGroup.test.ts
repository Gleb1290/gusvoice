import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as fields from './fieldRules.js';
import * as wire from './convWire.js';
import {
  convMessageSigPayload,
  parseConvGroupExtras,
  parseGroupOp,
  parseMessageSig,
  serializeConvGroupExtras,
  serializeGroupOp,
  serializeMessageSig,
} from './convGroup.js';
import { parseConvMessageWire, parseConvWire, serializeConvMessageWire, serializeConvWire } from './convWire.js';

type PayloadApi = Pick<typeof import('./convGroup.js'), 'convMessageSigPayload'>;

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

function loadConvGroup(source: string): typeof import('./convGroup.js') {
  const module = { exports: {} as Record<string, unknown> };
  const dependencies: Record<string, unknown> = { './fieldRules': fields, './convWire': wire };
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        assert.ok(Object.hasOwn(dependencies, name), `неожиданный импорт convGroup: ${name}`);
        return dependencies[name];
      },
    },
  );
  return module.exports as typeof import('./convGroup.js');
}

function messageFixture() {
  const message = parseConvMessageWire(fixture('conv-message-sig-e7'));
  assert.ok(message, 'историческое сообщение E7 должно разбираться настоящим парсером провода');
  return message;
}

function fieldBoundaryContract(api: PayloadApi) {
  const base = messageFixture();
  const splitA = { ...base, id: 'a', conversationId: 'bc' };
  const splitB = { ...base, id: 'ab', conversationId: 'c' };
  assert.ok(
    api.convMessageSigPayload(splitA).startsWith('6:gvmsg1|1:a|2:bc|'),
    'границы id и conversationId должны кодироваться длинами в канонической строке',
  );
  assert.ok(
    api.convMessageSigPayload(splitB).startsWith('6:gvmsg1|2:ab|1:c|'),
    'границы id и conversationId должны кодироваться длинами в канонической строке',
  );
  assert.notEqual(
    api.convMessageSigPayload(splitA),
    api.convMessageSigPayload(splitB),
    'границы id и conversationId должны различаться даже при одинаковой склейке полей',
  );
}

function editVersionContract(api: PayloadApi) {
  const base = messageFixture();
  assert.notEqual(
    api.convMessageSigPayload(base),
    api.convMessageSigPayload({ ...base, editVersion: base.editVersion + 1 }),
    'правка должна менять подписываемую строку, иначе хост сможет подменить историю редакций',
  );
}

describe('федеративные группы Э7 — shared-провод', () => {
  it('исторические group, message signature и group-op проходят настоящий разбор и круговую сериализацию', () => {
    const groupRaw = fixture('conv-group-e7');
    const group = parseConvWire(groupRaw);
    assert.ok(group);
    assert.deepEqual(parseConvWire(serializeConvWire(group)), group);
    const extras = parseConvGroupExtras(groupRaw);
    assert.ok(extras);
    assert.equal(extras.version, 3);
    assert.deepEqual(parseConvGroupExtras(serializeConvGroupExtras(extras)), extras);

    const messageRaw = fixture('conv-message-sig-e7');
    const message = parseConvMessageWire(messageRaw);
    assert.ok(message);
    assert.deepEqual(parseConvMessageWire(serializeConvMessageWire(message)), message);
    const sig = parseMessageSig(messageRaw.sig);
    assert.ok(sig);
    assert.deepEqual(parseMessageSig(serializeMessageSig(sig)), sig);

    const op = parseGroupOp(fixture('conv-group-op'));
    assert.ok(op);
    assert.equal(op.op, 'add');
    assert.deepEqual(parseGroupOp(serializeGroupOp(op)), op);
  });

  it('подписываемая строка сохраняет границы полей вместо опасной склейки a|bc и ab|c', () => {
    fieldBoundaryContract({ convMessageSigPayload });

    const source = readFileSync(new URL('./convGroup.ts', import.meta.url), 'utf8');
    const anchor = "  return parts.map((p) => `${p.length}:${p}`).join('|');";
    assert.equal(source.split(anchor).length - 1, 1, 'якорь кодирования длин должен быть уникальным');
    const mutant = loadConvGroup(source.replace(anchor, "  return parts.join('|');"));
    assert.throws(
      () => fieldBoundaryContract(mutant),
      (error) => error instanceof assert.AssertionError && error.message.includes('границы id и conversationId'),
      'контракт должен поймать целый модуль без длины полей',
    );
  });

  it('текст, editVersion, надгробие и вложение меняют подписываемую строку', () => {
    const base = messageFixture();
    const original = convMessageSigPayload(base);
    assert.notEqual(convMessageSigPayload({ ...base, content: `${base.content}!` }), original, 'текст сообщения подписывается');
    editVersionContract({ convMessageSigPayload });
    assert.notEqual(convMessageSigPayload({ ...base, deleted: true }), original, 'надгробие нельзя подменить живым сообщением');
    const attachment = {
      id: 'attachment-1', name: 'photo.png', contentType: 'image/png', size: 12, width: null, height: null,
      durationMs: null, waveform: null, asFile: false, spoiler: false, sha256: null,
    };
    assert.notEqual(convMessageSigPayload({ ...base, attachments: [attachment] }), original, 'состав вложений подписывается');
  });

  it('подпись требует kid и корректный base64url, а сроки принимает только числовыми', () => {
    const raw = fixture('conv-message-sig-e7').sig as Record<string, unknown>;
    assert.ok(parseMessageSig(raw), 'корректная историческая подпись принимается');
    const key = raw.key as Record<string, unknown>;
    assert.equal(parseMessageSig({ ...raw, key: { ...key, kid: '' } }), null, 'ключ без kid отвергается');
    const { kid: _missingKid, ...keyWithoutKid } = key;
    assert.equal(parseMessageSig({ ...raw, key: keyWithoutKid }), null, 'ключ без поля kid отвергается');
    assert.equal(parseMessageSig({ ...raw, value: 'not base64url!' }), null, 'плохая base64url подпись отвергается');
    assert.equal(parseMessageSig({ ...raw, root: `${raw.root}= ` }), null, 'корневой ключ тоже обязан быть base64url');
    assert.equal(parseMessageSig({ ...raw, key: { ...key, not_before: String(key.not_before) } }), null, 'строковый not_before не является сроком');
    assert.equal(parseMessageSig({ ...raw, key: { ...key, not_after: String(key.not_after) } }), null, 'строковый not_after не является сроком');
    assert.equal(parseMessageSig({ ...raw, key: { ...key, not_before: Number.NaN } }), null, 'NaN не является сроком');
    assert.equal(parseMessageSig({ ...raw, key: { ...key, not_after: Number.POSITIVE_INFINITY } }), null, 'Infinity не является сроком');
    assert.ok(parseMessageSig({ ...raw, key: { ...key, not_before: 1_760_000_000_000, not_after: 1_762_592_000_000 } }), 'числовые границы срока принимаются');
    const urlKey = (length: number) => 'a'.repeat(length);
    assert.ok(parseMessageSig({ ...raw, root: urlKey(16), value: urlKey(512), key: { ...key, public_key: urlKey(16), sig: urlKey(512) } }), 'base64url длиной 16 и 512 принимается');
    assert.equal(parseMessageSig({ ...raw, root: urlKey(15) }), null, 'base64url короче 16 символов отвергается');
    assert.equal(parseMessageSig({ ...raw, root: urlKey(513) }), null, 'base64url длиннее 512 символов отвергается');
    assert.ok(parseMessageSig({ ...raw, key: { ...key, kid: 'k'.repeat(64) } }), 'kid длиной 64 символа принимается');
    assert.equal(parseMessageSig({ ...raw, key: { ...key, kid: 'k'.repeat(65) } }), null, 'kid длиннее 64 символов отвергается');
  });

  it('group_version обязателен, а профиль без username отбрасывается поштучно', () => {
    const raw = fixture('conv-group-e7');
    assert.equal(parseConvGroupExtras({ ...raw, group_version: undefined }), null, 'без версии нельзя принять снимок состава');
    const profiles = raw.profiles as Record<string, unknown>[];
    const parsed = parseConvGroupExtras({ ...raw, profiles: [{ ...profiles[0], username: undefined }, profiles[1]] });
    assert.ok(parsed);
    assert.equal(parsed.profiles.length, 1);
    assert.equal(parsed.profiles[0]?.username, 'utka', 'битый профиль не должен скрыть соседний корректный');
    assert.deepEqual(parseConvGroupExtras(serializeConvGroupExtras(parsed)), parsed);
  });

  it('group-op отвергает неизвестную операцию, принимает ровно 10 пользователей и ограничивает 11-м', () => {
    const raw = fixture('conv-group-op');
    assert.equal(parseGroupOp({ ...raw, op: 'ban' }), null, 'неизвестная операция не должна трактоваться как допустимая');
    const user = (raw.users as Record<string, unknown>[])[0]!;
    const users = Array.from({ length: 11 }, (_, index) => ({ ...user, user_id: `user-${index}` }));
    const atLimit = parseGroupOp({ ...raw, users: users.slice(0, 10) });
    assert.ok(atLimit);
    assert.equal(atLimit.users.length, 10, 'ровно десять профилей принимаются');
    const overLimit = parseGroupOp({ ...raw, users });
    assert.ok(overLimit);
    assert.equal(overLimit.users.length, 10, 'одиннадцатый профиль не попадает в команду');
  });

  it('контрфакт: целый модуль подписывает editVersion и ломается при удалении поля', () => {
    editVersionContract({ convMessageSigPayload });

    const source = readFileSync(new URL('./convGroup.ts', import.meta.url), 'utf8');
    const anchor = "    String(m.editVersion),";
    assert.equal(source.split(anchor).length - 1, 1, 'якорь editVersion должен быть уникальным');
    const mutant = loadConvGroup(source.replace(anchor, ''));
    assert.throws(
      () => editVersionContract(mutant),
      (error) => error instanceof assert.AssertionError && error.message.includes('правка должна менять подписываемую строку'),
      'контракт должен поймать целый модуль без editVersion',
    );
  });
});
