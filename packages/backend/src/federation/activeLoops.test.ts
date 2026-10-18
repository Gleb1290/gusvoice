import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as orm from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { BIGFILE_PART_BYTES } from '../attachmentRules.js';
import { PEER_MAX_ATT_BYTES } from '../safeFetch.js';

// Снимки runtime-импортов включают имена и alias; type-only импорты намеренно не входят.
// Добавленная зависимость сначала останавливает тест здесь, а не получает автоматический fail/noop.
const expectedImports: Record<string, string> = {
  outbox: `
node:crypto:randomUUID
drizzle-orm:asc,eq,inArray
@gusvoice/shared:FED_EVENTS,serializeFedEvent
../db/index.js:db
../db/schema.js:federationLinks,federationOutbox
./instance.js:federation
./peerClient.js:postSignedToPeer
./outboxRules.js:dropReason,nextAttemptDelayMs,queueAction
./reportStatus.js:markReportsDelivered`,
  convAccept: `
drizzle-orm:and,eq,gt,inArray,isNull,lte,ne,sql
@gusvoice/shared:convMediaPreview,FED_CONV_CHANGE,FED_CONV_CHANGE_E2,FED_CONV_CHANGED_EVENT,FED_CONV_GROUPS_PATH,FED_FEATURES,fedConvExportPath,isListenable,isRoundVideo,parseConvListenWire,ROUND_ONCE_SPENT_TEXT,VOICE_ONCE_SPENT_TEXT,parseConvChangedPayload,parseConvChangesPage,parseConvExportPage,parseConvGroupsList,parseConvMessageWire,parseConvPinWire,parseConvPollVotesWire,parseConvReactionsWire,parseConvReadsWire
../conversations.js:convMediaFromWire,deliver,fedRecordRelay,journal,journalPins,lockConversation,msgEntries,removePins,unarchiveOnMessage
../convRules.js:changeAudience,removedByEdit
../convSendFanout.js:fanOutSend
../db/index.js:db
../db/schema.js:attachments,conversationMembers,conversationMessageReactions,conversationMessages,conversationPins,conversationVoiceListens,conversations,convPollVotes,fedConvCursor,federationLinks,userBlocks,users
./convLink.js:notePeerAnswer,onLinkRestored
./eventStream.js:onFedEvent,sendEventTo
./instance.js:federation
./peerClient.js:getSignedFromPeer`,
  convAtt: `
@gusvoice/shared:FED_FEATURES
drizzle-orm:and,asc,eq,inArray,isNull,lte,or,sql
../attachmentRules.js:BIGFILE_PART_BYTES
../attachments.js:attachmentStore,purgeDeleted
../conversations.js:deliver,journal,lockConversation,msgEntries,storedAttachment
../convRules.js:changeAudience
../db/index.js:db
../db/schema.js:attachments,conversationMembers,conversationMessages,federationLinks,users
../safeFetch.js:PEER_MAX_ATT_BYTES
./directorySync.js:refreshCapabilities
./instance.js:federation
./guestQuota.js:releaseLinkQuota,reserveLinkQuota
./peerClient.js:getSignedFromPeer
./peerStream.js:streamSignedFromPeer`,
  convLink: `
drizzle-orm:and,desc,eq,inArray,isNull,sql
@gusvoice/shared:FED_ERRORS
../conversations.js:deliver,journal
../db/index.js:db
../db/schema.js:conversationMessages,federationLinks,fedConvSync,users
./instanceMeta.js:readInstanceMeta
./instanceBan.js:sendReport`,
  convVia: `
drizzle-orm:and,eq,inArray,lt
@gusvoice/shared:FED_ERRORS,FED_FEATURES,FED_VIA_LIMITS,FED_VIA_PATH,FED_VIA_VERDICT_EVENT,parseConvMessageWire,parseGuestSession,parseViaClaims,parseViaPage,parseViaVerdict,serializeConvMessageWire,serializeViaPage,serializeViaVerdict,viaVerdictFor
../db/index.js:db
../db/schema.js:conversationMessages,conversations,federationLinks,fedViaClaims,fedViaPending,fedViaReports,users
../conversations.js:deleteMessage,deliver,journal,loadAccess,lockConversation,msgEntries,sendMessage
../convRules.js:changeAudience,payloadHash
../realtime.js:redisPub
../safeFetch.js:safePeerRequest
./auditLog.js:fedAudit
./convLink.js:onLinkRestored
./convChanges.js:toWireMessage
./eventStream.js:onFedEvent,sendEventTo
./guestHome.js:issueIdentityFor
./instance.js:federation
./instanceMeta.js:readInstanceMeta
./linkRules.js:linkVerdict
./links.js:getLink
./peerClient.js:getSignedFromPeer
./directorySync.js:refreshCapabilities`,
  dmEphemeral: `
drizzle-orm:and,eq,inArray
drizzle-orm:sql
@gusvoice/shared:FED_EPHEMERAL_PATH,FED_FEATURES,FED_PRESENCE_ALIVE_MS,FED_PRESENCE_STALE_MS,FED_TYPING_RESEND_MS,FED_TYPING_TTL_MS,parseEphemeralWire,parseTypingAction,serializeEphemeralWire
../blocks.js:isBlockedBy
../db/index.js:db
../db/schema.js:federationLinks,lastSeenExceptions,users
../gateway.js:isUserDmPresent,relayFedTyping,setRemoteDmPresence
../lastSeenRules.js:exceptionOf,normalizeLastSeenPrivacy,sharesLastSeen
./directorySync.js:refreshCapabilities
./guestHost.js:shadowUserFor
./instance.js:federation
./peerClient.js:postSignedToPeer`,
  dmCalls: `
@gusvoice/shared:CALL_BUSY_ERROR,CALL_PRIVACY_ERROR,CALL_RING_TIMEOUT_MS,FED_CALL_INVITE_PATH,FED_CALL_STATE_EVENT,FED_ERRORS,FED_FEATURES,parseCallInvite,parseCallInviteAnswer,parseCallState,serializeCallInvite,serializeCallInviteAnswer,serializeCallState
drizzle-orm:eq,inArray
../blocks.js:isBlockedBy
../callPrivacy.js:callAllowedFor
../callRules.js:callRecordPlan
../calls.js:applyRemoteState,ringRemote
../conversations.js:deliver,loadAccess,markRead
../db/index.js:db
../db/schema.js:federationLinks,users
./directorySync.js:refreshCapabilities
./eventStream.js:onFedEvent,sendEventTo
./guestHost.js:shadowUserFor
./instance.js:federation
./instanceMeta.js:readInstanceMeta
./linkRules.js:linkVerdict
./links.js:getLink
./peerClient.js:postSignedToPeer`,
};

function runtimeImports(tree: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const n of tree.statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly || !ts.isStringLiteral(n.moduleSpecifier)) continue;
    if (!n.importClause) { imports.push(`${n.moduleSpecifier.text}:<side-effect>`); continue; }
    const names: string[] = n.importClause.name ? [`default as ${n.importClause.name.text}`] : [];
    const bindings = n.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.push(`* as ${bindings.name.text}`);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if (!item.isTypeOnly) names.push(item.propertyName ? `${item.propertyName.text} as ${item.name.text}` : item.name.text);
    }
    if (names.length) imports.push(`${n.moduleSpecifier.text}:${names.join(',')}`);
  }
  return imports;
}

type Job = { fn: () => void; ms: number; unref(): void };
type EventHandler = (input: { instanceId: string; event: { payload: unknown } }) => Promise<void>;
const fail = (name: string) => () => { assert.fail(`неописанная IO-граница ${name}`); };
// Ограниченный microtask-drain для местных цепочек Promise, НЕ доказательство ожидания произвольного IO.
// Положительная ветка обязана показать вход в проход; SQL/сеть/реальные очереди здесь не проверяются.
const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

function fixture<T>(name: string, overrides: Record<string, unknown> = {}) {
  const raw = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
  const deps: Record<string, unknown> = {};
  const tree = ts.createSourceFile(name, raw, ts.ScriptTarget.Latest, true);
  assert.ok(expectedImports[name], `зафиксированные границы ${name}`);
  assert.deepEqual(runtimeImports(tree), expectedImports[name].trim().split('\n'),
    `R257 закрытый перечень границ ${name}: новый runtime импорт/alias требует ревью`);
  for (const n of tree.statements) {
    if (!ts.isImportDeclaration(n) || n.importClause?.isTypeOnly || !ts.isStringLiteral(n.moduleSpecifier)) continue;
    const exports: Record<string, unknown> = {};
    const bindings = n.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if (!item.isTypeOnly) exports[item.propertyName?.text ?? item.name.text] = fail(`${n.moduleSpecifier.text}.${item.name.text}`);
    }
    deps[n.moduleSpecifier.text] = exports;
  }
  const intervals: Job[] = [], timeouts: Job[] = [], events = new Map<string, EventHandler>();
  let reads = 0;
  const clock = { now: 2_000_000_000_000 };
  const query = () => {
    reads++;
    // Пустая выборка достаточна: считаем сам вход реального pullAll/kickAll/reconcileAll в базу.
    type EmptyQuery = Promise<never[]> & { from(): EmptyQuery; where(): EmptyQuery; limit(): EmptyQuery };
    const result: EmptyQuery = Object.assign(Promise.resolve([]), {
      from: () => result, where: () => result, limit: () => result,
    });
    return result;
  };
  Object.assign(deps, {
    '@gusvoice/shared': shared, 'drizzle-orm': orm, '../db/schema.js': schema,
    // Настоящие числовые пределы: fail-функция вместо числа делала бы строящийся SQL недостоверным.
    '../attachmentRules.js': { BIGFILE_PART_BYTES },
    '../safeFetch.js': { PEER_MAX_ATT_BYTES, safePeerRequest: fail('safePeerRequest') },
    '../db/index.js': { db: { select: query, selectDistinct: query, execute: async () => { reads++; return { rows: [] }; } } },
    './eventStream.js': { onFedEvent: (kind: string, fn: EventHandler) => {
      assert.ok(!events.has(kind), 'одна регистрация в фикстуре'); events.set(kind, fn);
    }, sendEventTo: fail('sendEventTo') },
    './convLink.js': { onLinkRestored: () => () => {}, notePeerAnswer: fail('notePeerAnswer') },
    ...overrides,
  });
  class ClockDate extends Date {
    constructor(value?: string | number) { super(value ?? clock.now); }
    static now() { return clock.now; }
  }
  const timer = (jobs: Job[]) => (fn: () => void, ms: number) => {
    const job = { fn, ms, unref() {} }; jobs.push(job); return job;
  };
  const module = { exports: {} };
  // Транспилируется и исполняется модуль ЦЕЛИКОМ. База, сеть и таймеры не импортируются в процесс.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module, exports: module.exports, Date: ClockDate, Buffer, URL, Map, Set, Promise,
    console: { warn: fail('неожиданная ошибка воркера') },
    setTimeout: timer(timeouts), setInterval: timer(intervals), clearTimeout: () => {},
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `описанный импорт ${id}`); return deps[id]; },
  });
  return { api: module.exports as T, clock, intervals, timeouts, events, reads: () => reads };
}

for (const [name, startName, intervalMs, startupMs] of [
  ['convAccept', 'startConvPull', 120_000, 5_000],
  ['convAtt', 'startAttCopies', 60_000, null],
  ['convLink', 'startFedLinkWatch', 30_000, null],
  ['convVia', 'startConvVia', 600_000, 8_000],
] as const) {
  it(`R257 ${startName}: выключенный такт пустой, тот же воркер оживает и снова замолкает без перезапуска`, async () => {
    const f = fixture<Record<string, (active: () => boolean) => void>>(name);
    let active = false;
    f.api[startName](() => active);
    // Некоторые модули делают начальную местную сверку без active; это НЕ контракт теста.
    // Проверяем именно очередной такт после завершения запуска, как требует R257.
    await drain();
    assert.equal(f.intervals.length, 1);
    const job = f.intervals[0]; assert.equal(job.ms, intervalMs);
    const before = f.reads();
    job.fn(); await drain();
    assert.equal(f.reads(), before, 'false: проход не дошёл даже до чтения базы');
    active = true;
    job.fn(); await drain();
    assert.ok(f.reads() > before, 'true: тот же реальный проход вошёл в базу');
    const after = f.reads(); active = false;
    job.fn(); await drain();
    assert.equal(f.reads(), after, 'повторное выключение видит текущий флаг');
    if (startupMs !== null) {
      const startup = f.timeouts.find(x => x.ms === startupMs); assert.ok(startup);
      startup.fn(); await drain();
      assert.equal(f.reads(), after, 'отложенный первый проход также проверяет active');
      active = true; startup.fn(); await drain();
      assert.ok(f.reads() > after, 'отложенный проход не запрещён навсегда');
    }
  });
}

it('R257 startOutboxWorker: false не входит в runOutboxPass, true входит, повторный start не создаёт второй таймер', async () => {
  let identities = 0, keys = 0;
  const f = fixture<typeof import('./outbox.js')>('outbox', {
    './instance.js': { federation: {
      identity: () => { identities++; return { instanceId: 'a'.repeat(32) }; },
      signingKey: () => { keys++; return { kid: 'synthetic-test-key', privateKeyDer: new Uint8Array([1]) }; },
    } },
  });
  let active = false;
  f.api.startOutboxWorker(() => active);
  f.api.startOutboxWorker(() => active);
  assert.equal(f.intervals.length, 1, 'повтор запуска не размножает фоновые проходы');
  assert.equal(f.timeouts.length, 0);
  const job = f.intervals[0]; assert.equal(job.ms, 5_000);
  job.fn(); await drain();
  assert.deepEqual([identities, keys, f.reads()], [0, 0, 0], 'false: проход даже не запросил signer');
  active = true; job.fn(); await drain();
  // Ненулевая синтетическая личность исключает ложную зелень от раннего возврата runOutboxPass без ключа.
  // Пустая DB-выборка связок завершает настоящий проход до сети и криптографической подписи.
  assert.deepEqual([identities, keys, f.reads()], [1, 1, 1], 'true: настоящий проход прочитал signer и связки');
  active = false; f.api.startOutboxWorker(() => active);
  assert.equal(f.intervals.length, 1, 'после выключения start всё ещё идемпотентен');
  job.fn(); await drain();
  assert.deepEqual([identities, keys, f.reads()], [1, 1, 1], 'снова false: signer и база не вызываются');
});

it('R257 startDmEphemeral: выключенный alive не рассылает присутствие, включённый доходит до flushPresence', async () => {
  let probes = 0;
  const f = fixture<typeof import('./dmEphemeral.js')>('dmEphemeral', {
    '../gateway.js': { isUserDmPresent: () => { probes++; return true; } },
    // flushPresence записывает reportedOnline ДО проверки ключа: не требуется ни сеть, ни личность инстанса.
    './instance.js': { federation: { identity: () => null } },
  });
  let active = false; f.api.startDmEphemeral(() => active); await drain();
  f.api.fedPresence('local', true);
  assert.equal(f.timeouts.length, 1); f.timeouts[0].fn(); await drain();
  assert.equal(probes, 1, 'наш онлайн-человек действительно добавлен к периодическому alive');
  const alive = f.intervals.find(x => x.ms === shared.FED_PRESENCE_ALIVE_MS); assert.ok(alive);
  alive.fn(); await drain(); assert.equal(probes, 1, 'false: flushPresence не вызывается');
  active = true; alive.fn(); await drain(); assert.equal(probes, 2, 'true: flushPresence вызывается');
  active = false; alive.fn(); await drain(); assert.equal(probes, 2, 'снова false: рассылка остановлена');
});

it('R257 startDmEphemeral: выключенный stale не меняет онлайн соседа, включённый гасит устаревшее присутствие', async () => {
  const presence: Array<[string, boolean]> = [];
  const peer = 'b'.repeat(32);
  const f = fixture<typeof import('./dmEphemeral.js')>('dmEphemeral', {
    '../gateway.js': { setRemoteDmPresence: (id: string, online: boolean) => { presence.push([id, online]); } },
    './guestHost.js': { shadowUserFor: async () => ({ id: 'shadow', deletedAt: null }) },
    './instance.js': { federation: { identity: () => null } },
  });
  let active = false; f.api.startDmEphemeral(() => active); await drain();
  const link = { instanceId: peer } as Parameters<typeof f.api.acceptEphemeral>[0];
  const wire = shared.serializeEphemeralWire(peer, { kind: 'presence', user: { instanceId: peer, userId: 'remote' },
    at: f.clock.now, online: true, views: [] });
  assert.equal((await f.api.acceptEphemeral(link, wire)).status, 202);
  assert.deepEqual(presence, [['shadow', true]]);
  f.clock.now += shared.FED_PRESENCE_STALE_MS + 1;
  const stale = f.intervals.find(x => x.ms === 30_000); assert.ok(stale);
  stale.fn(); assert.deepEqual(presence, [['shadow', true]], 'false: нет побочного offline');
  active = true; stale.fn();
  assert.deepEqual(presence, [['shadow', true], ['shadow', false]], 'true: просроченный сосед стал offline');
});

it('R257 startDmCalls: выключенный обработчик не меняет звонок, включённый применяет тот же корректный снимок', async () => {
  const applied: unknown[][] = [];
  const f = fixture<typeof import('./dmCalls.js')>('dmCalls', {
    '../calls.js': { applyRemoteState: async (...args: unknown[]) => { applied.push(args); } },
  });
  let active = false; f.api.startDmCalls(() => active);
  // У startDmCalls нет таймера: его такт — зарегистрированный обработчик call.state.
  assert.equal(f.intervals.length, 0);
  const handle = f.events.get(shared.FED_CALL_STATE_EVENT); assert.ok(handle);
  const state = { callId: 'call-1', conversationId: 'conv-1', phase: 'ended' as const, reason: 'hangup' as const, duration: 10 };
  const input = { instanceId: 'b'.repeat(32), event: { payload: shared.serializeCallState(state) } };
  await handle(input); assert.equal(applied.length, 0);
  active = true; await handle(input); assert.equal(applied.length, 1);
  assert.equal(applied[0][0], input.instanceId);
  assert.deepEqual(JSON.parse(JSON.stringify(applied[0][1])), state);
  active = false; await handle(input); assert.equal(applied.length, 1);
});
