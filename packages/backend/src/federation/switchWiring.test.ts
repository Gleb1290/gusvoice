import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Закрытый снимок IO-границ, НЕ автоматически полученный из текущего файла в момент теста.
// Новый импорт или alias требует осмысленного решения о заглушке, а не превращается молча в noop.
const expectedImports = `
@fastify/cors:default as cors
@fastify/multipart:default as multipart
@fastify/websocket:default as websocket
fastify:default as Fastify
zod:ZodError
./activity.js:startActivitySweeper
./cleanup.js:startAttachmentSweeper,startDailyCleanup
./steam.js:startSteamPoller
./voiceActivity.js:startVoiceActivityCollector
./db/index.js:runMigrations
./env.js:env
./federation/devPeers.js:configureDevPeers
./federation/convChanges.js:configureFedConvDoorbell,configureFedGroupSigner,recordFedConvChanges
./federation/convAccept.js:configureFedCallRecord,configureFedMessagePrivacy,configureFedConvAttachments,configureFedConvCaps,configureFedConvRow,configureFedGroupAccept,ringDoorbell,startConvPull
./federation/convGroup.js:acceptGroupConvRow,applyGroupConv,groupInvitableHome,groupOpRemote,signOwnMessage,verifyMessageSig
./routes/fedGroups.js:fedGroupRoutes
./federation/dmCalls.js:callRecordCopied,callRecordPlanFor,homesWithoutCalls,inviteRemote,sendCallState,startDmCalls
./routes/fedCalls.js:fedCallRoutes
./federation/convAtt.js:fedAlbumAllowedFor,fedFilesAllowedFor,fedOnceAllowedFor,homesWithoutFiles,kickAttCopies,purgeCopiesNow,remoteAttachmentsFor,serveRemoteAttachment,startAttCopies
./federation/convLink.js:announceConvs,brokenHomes,downHomes,fedLinkBrokenFor,notePeerPull,onLinkRestored,refreshFedLinks,reportFedDmPeer,silentHomes,staleHomes,startFedLinkWatch
./federation/links.js:onLinksChanged
./federation/guestProfile.js:anonymizeShadow
./federation/convOpen.js:acceptConvRow,configureFedConvOpened,configureFedOpenPrivacy,openFederatedDirect
./conversations.js:configureFederatedConv
./federation/guestPush.js:registerGuestPushHandlers
./federation/instance.js:federation,startFederationAlerts,startFederationKeyRotation
./federation/switch.js:onFederationSwitch,startFederationSwitch
./federation/gate.js:federationDmGate,federationGate
./routes/federationSwitch.js:federationSwitchRoutes
./federation/instanceMeta.js:registerInstanceMetaHandler
./federation/outbox.js:startOutboxWorker
./federation/directoryEvents.js:registerDirectoryHandlers
./federation/guestMembership.js:registerMembershipHandlers
./federation/guestRevocation.js:configureShadowGone,registerRevocationHandlers
./federation/instanceBan.js:registerReportHandlers
./federation/directorySync.js:configureCapsChanged,refreshCapabilities,startDirectorySyncWorker
./routes/federation.js:configureFedConvPeerSeen,configureFedViaRoutes,federationRoutes
./federation/convVia.js:acceptClaims,fallbackFor,isShadowUser,pendingFor,startConvVia,viaGate
./routes/fedAtt.js:fedAttRoutes
./gateway.js:configureGatewayFed,isUserActive,isUserDmPresent,registerGateway
./lastSeen.js:configureRemoteLastSeen
./federation/dmEphemeral.js:announceMessagePrivacy,configureEphemeralStore,configureGroupTyping,configurePresenceMessagePrivacy,fedBlockChanged,fedPeerAdded,fedPresence,fedTyping,isKnownShadow,remoteLastSeenFor,remoteMessageRefusedFor,resendPresence,startDmEphemeral
./messagePrivacy.js:messageAllowedFor,wroteInDirect
./federation/dmGroupTyping.js:acceptHostedTyping,fedGroupTyping,forwardGroupTyping
./federation/dmEphemeralStore.js:redisEphemeralStore
./routes/fedEphemeral.js:fedEphemeralRoutes
./push.js:sendPushToUsers
./pushDefer.js:setPushActivityProbe,startPushDeferWorker
./linkThreats.js:startLinkThreatsWorker
./scheduled.js:startScheduledWorker
./mailer.js:verifyMailer
./seed.js:bindSuperAdmin,seedSuperAdmin
./superAdminRules.js:bootstrapIdentity
./storage.js:ensureMediaBucket,ensurePrivateBucket
./corsOrigins.js:corsOriginCheck,refreshPeerOrigins
./routes/admin.js:adminRoutes
./routes/appinfo.js:appInfoRoutes
./routes/audit.js:auditRoutes
./routes/auth.js:authRoutes
./routes/setup.js:setupRoutes
./routes/channels.js:channelRoutes
./routes/conv.js:configureFedDirect,configureFedDmReport,configureMessagePrivacy,configureFedVia,configureFedFilesGuard,configureFedLinkGuard,configureFedOnceGuard,configureFedAlbumGuard,convRoutes
./routes/calls.js:callRoutes
./calls.js:closeOrphanCalls,configureFedCalls
./routes/convGroups.js:configureFedGroups,convGroupRoutes
./routes/stickers.js:stickerRoutes
./routes/dmFolders.js:dmFolderRoutes
./routes/download.js:downloadRoutes
./routes/att.js:attRoutes,configureRemoteAttachments
./routes/uploads.js:uploadRoutes
./routes/gifs.js:gifFileRoutes,gifRoutes
./attachmentRules.js:redactLogUrl
./routes/economy.js:economyRoutes
./routes/diag.js:diagRoutes
./routes/invites.js:inviteRoutes
./routes/linkPreview.js:linkPreviewRoutes
./routes/mapsStatic.js:mapsStaticRoutes
./routes/mapsTiles.js:mapsTilesRoutes
./routes/messages.js:messageRoutes
./routes/webhooks.js:webhookRoutes
./routes/push.js:pushRoutes
./blocks.js:onBlockChange
./routes/blocks.js:blockRoutes
./routes/contacts.js:contactRoutes
./routes/roles.js:roleRoutes
./routes/servers.js:serverRoutes
./routes/soundboard.js:soundboardRoutes
./routes/sounds.js:soundRoutes
./routes/steam.js:steamRoutes
./routes/unread.js:unreadRoutes
./routes/users.js:configureMessagePrivacyChanged,userRoutes
./routes/voice.js:voiceRoutes
`.trim().split('\n');

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
const dmSetters = [
  'configureFedDirect', 'configureFedConvDoorbell', 'configureFedConvRow', 'configureFedConvCaps',
  'configureCapsChanged', 'configureFedConvPeerSeen', 'configureFedLinkGuard', 'configureFedFilesGuard',
  'configureFedOnceGuard', 'configureFedAlbumGuard', 'configureFedConvAttachments', 'configureRemoteAttachments',
  'configureShadowGone', 'configureFedDmReport', 'configureGatewayFed', 'configureGroupTyping',
  'configureRemoteLastSeen', 'configureEphemeralStore', 'configureFedConvOpened', 'configureFedVia',
  'configureFedViaRoutes', 'configureFedCalls', 'configureFedCallRecord', 'configureFedOpenPrivacy',
  'configureFedMessagePrivacy', 'configurePresenceMessagePrivacy', 'configureMessagePrivacyChanged',
  'configureFedGroupAccept', 'configureFedGroupSigner', 'configureFedGroups',
] as const;
type Listener = (...args: unknown[]) => unknown;

async function boot(raw = source) {
  const flags = { enabled: true, dmEnabled: false };
  const calls = new Map<string, unknown[][]>();
  const listeners = new Map<string, Set<Listener>>();
  const detached: string[] = [];
  let switched: (() => void) | undefined;
  const deps: Record<string, Record<string, unknown>> = {};
  const tree = ts.createSourceFile('index.ts', raw, ts.ScriptTarget.Latest, true);
  assert.deepEqual(runtimeImports(tree), expectedImports, 'R257 закрытый перечень границ index: новый runtime импорт/alias требует ревью');
  // Полный index, как в indexErrors.test.ts: заменены bootstrap/роуты/воркеры, а не тело wire/unwire.
  // Никаких настоящих сокетов, окружения, Redis или базы. До autostub проверен неизменяемый снимок границ.
  const stub = (name: string) => (...args: unknown[]) => {
    calls.set(name, [...(calls.get(name) ?? []), args]);
    return Promise.resolve();
  };
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const exports: Record<string, unknown> = { __esModule: true };
    if (node.importClause?.name) exports.default = stub(`${node.moduleSpecifier.text}.default`);
    const names = node.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const n of names.elements) {
      if (n.isTypeOnly) continue;
      const name = n.propertyName?.text ?? n.name.text;
      exports[name] = stub(name);
    }
    deps[node.moduleSpecifier.text] = exports;
  }
  const replace = (id: string, name: string, value: unknown) => {
    assert.ok(deps[id] && name in deps[id], `существующая граница ${id}:${name}`);
    deps[id][name] = value;
  };
  for (const [id, name] of [
    ['./federation/convLink.js', 'onLinkRestored'], ['./federation/links.js', 'onLinksChanged'], ['./blocks.js', 'onBlockChange'],
  ]) {
    const registered = new Set<Listener>();
    listeners.set(name, registered);
    replace(id, name, (fn: Listener) => {
      registered.add(fn);
      return () => { assert.ok(registered.delete(fn), `отписка ${name} ровно один раз`); detached.push(name); };
    });
  }
  replace('./federation/switch.js', 'onFederationSwitch', (fn: () => void) => { switched = fn; });
  replace('./env.js', 'env', { port: 0, federation: flags });
  replace('./federation/instance.js', 'federation', { identity: () => ({ instanceId: 'fixture' }) });
  const app = {
    register: async () => {}, addHook: () => {}, get: () => {}, addContentTypeParser: () => {}, setErrorHandler: () => {},
    listen: async () => {}, log: { info: () => {}, warn: () => {}, error: (error: unknown) => { throw error; } },
  };
  deps.fastify = { __esModule: true, default: () => app };
  const module = { exports: {} };
  await runInNewContext(`(async () => {\n${ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText}\n})()`, {
    module, exports: module.exports, console, process: { exit: assert.fail },
    setTimeout: () => ({ unref() {} }),
    require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `описанный импорт ${id}`); return deps[id]; },
  });
  assert.ok(switched, 'bootstrap действительно подписал переключатель');
  return {
    calls, listeners, detached,
    switchDm(value: boolean) { flags.dmEnabled = value; switched!(); },
    emit(name: string) { for (const fn of listeners.get(name) ?? []) fn('peer'); },
  };
}

async function subscriptions(raw = source) {
  const f = await boot(raw);
  const sizes = () => [...f.listeners.values()].map(x => x.size);
  assert.deepEqual(sizes(), [0, 0, 0], 'ЛС при старте выключены');
  for (let cycle = 0; cycle < 2; cycle++) {
    f.switchDm(true);
    assert.deepEqual(sizes(), [2, 1, 1], 'один комплект подписок');
    // Нажатие другого тумблера тоже вызывает wire: повторное уведомление с теми же флагами законно.
    f.switchDm(true);
    assert.deepEqual(sizes(), [2, 1, 1], 'повтор wire не умножает подписки');
    for (const [event, effect] of [
      ['onLinkRestored', 'kickAttCopies'], ['onLinkRestored', 'resendPresence'],
      ['onLinksChanged', 'refreshFedLinks'], ['onBlockChange', 'fedBlockChanged'],
    ]) {
      const before = f.calls.get(effect)?.length ?? 0;
      f.emit(event);
      assert.equal(f.calls.get(effect)?.length, before + 1, `${effect}: один вызов от одного события`);
    }
    f.switchDm(false);
    assert.deepEqual(sizes(), [0, 0, 0], 'выключение сняло все подписки');
    const count = [...f.calls.values()].reduce((n, xs) => n + xs.length, 0);
    for (const event of f.listeners.keys()) f.emit(event);
    assert.equal([...f.calls.values()].reduce((n, xs) => n + xs.length, 0), count, 'выключенные события пустые');
    f.switchDm(false);
    assert.equal(f.detached.length, (cycle + 1) * 4, 'повтор выключения не отписывает дважды');
  }
  for (const name of ['startConvPull', 'startConvVia', 'startDmCalls']) {
    assert.equal(f.calls.get(name)?.length, 1, `${name}: обработчики только при первом включении`);
    const active = f.calls.get(name)![0][0] as () => boolean;
    assert.equal(active(), false, 'воркер читает текущий выключенный флаг, не снимок при старте');
    f.switchDm(true);
    assert.equal(active(), true, 'тот же callback видит повторное включение');
    f.switchDm(false);
  }
}

it('R257 ЛС выкл → вкл → выкл → вкл не множат подписки и снимают их при каждом выключении', async () => {
  await subscriptions();
});

it('R257 каждый из тридцати крючков ЛС включается и сбрасывается в null, журнал на связку остаётся', async () => {
  const f = await boot();
  for (let cycle = 0; cycle < 2; cycle++) {
    f.switchDm(true);
    for (const name of dmSetters) assert.ok(f.calls.get(name)?.at(-1)?.[0] != null, `${name}: включён`);
    f.switchDm(false);
    for (const name of dmSetters) assert.equal(f.calls.get(name)?.at(-1)?.[0], null, `${name}: снят`);
    // Отключение ЛС не должно выключать запись журнала для будущей досылки сообщений.
    const journal = f.calls.get('configureFederatedConv')?.at(-1)?.[0] as { record?: unknown; linkBroken?: unknown };
    assert.equal(typeof journal.record, 'function');
    assert.equal(journal.linkBroken, null);
  }
});

it('R257 страж подписок отвергает удаление if (subscribe), сначала проверив оригинал', async () => {
  await subscriptions();
  const anchor = 'if (subscribe) fedDmSubs.push(onLinksChanged';
  assert.equal(source.split(anchor).length, 2);
  await assert.rejects(subscriptions(source.replace(anchor, 'fedDmSubs.push(onLinksChanged')), (e: unknown) =>
    e instanceof assert.AssertionError && e.message.startsWith('повтор wire не умножает подписки') &&
    JSON.stringify(e.actual) === '[2,2,1]' && JSON.stringify(e.expected) === '[2,1,1]');
});

it('R257 пропуск любого отдельного сброса в unwire обнаруживается после настоящего включения', async () => {
  const check = async (raw: string, name: string) => {
    const f = await boot(raw); f.switchDm(true);
    assert.ok(f.calls.get(name)?.at(-1)?.[0] != null, `${name}: крючок до выключения действительно стоял`);
    f.switchDm(false);
    assert.equal(f.calls.get(name)?.at(-1)?.[0], null, `${name}: должен быть снят`);
  };
  for (const name of dmSetters) {
    await check(source, name);
    const anchor = `  ${name}(null);`;
    assert.equal(source.split(anchor).length, 2, `единственный сброс ${name}`);
    await assert.rejects(check(source.replace(anchor, ''), name), (e: unknown) =>
      e instanceof assert.AssertionError && e.message.startsWith(`${name}: должен быть снят`) &&
      e.operator === 'strictEqual' && e.expected === null && e.actual != null);
  }
});
