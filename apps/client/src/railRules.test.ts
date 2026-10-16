import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import type { Instance } from './configRules.js';
import * as configRules from './configRules.js';
import * as railRules from './railRules.js';
import { buildRail, groupHeadTitle, orderedInstances, serverTitle, type RailInput, type RailPlace } from './railRules.js';

const inst = (id: string, order: number, patch: Partial<Instance> = {}): Instance => ({
  id,
  order,
  name: id,
  apiUrl: `https://api.${id}.example.test`,
  presenceWs: `wss://presence.${id}.example.test`,
  token: 'token',
  ...patch,
});

type RailApi = typeof railRules;
const railSource = readFileSync(new URL('./railRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function loadRail(raw: string): RailApi {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    require(id: string) { assert.equal(id, './configRules'); return configRules; },
  });
  return module.exports as RailApi;
}
function linkStates(api: RailApi) {
  // Временная пауза и смена ключа не должны стирать гостевые сессии, которые ещё можно восстановить.
  for (const state of ['paused', 'trust-lost', 'active', 'requested', 'pending', '', 'future'])
    assert.equal(api.linkGone(state), false, `R234-link-${state}: обратимое состояние не разрыв`);
  for (const state of ['blocked', 'unknown']) assert.equal(api.linkGone(state), true);
}
it('R234 разрывом считаются только blocked и unknown, не пауза или потеря доверия', () => linkStates(railRules));

function goneFilters(api: RailApi) {
  // Ответ одного дома не уполномочен стирать гостей другого дома или текущую открытую запись.
  const blocked = place({ linkState: 'blocked' });
  const guest = (id: string, patch: Partial<Instance> = {}) => inst(id, 1, { guestOf: 'home', federationInstanceId: blocked.instanceId, ...patch });
  const list = [guest('active'), guest('gone'), guest('other-home', { guestOf: 'elsewhere' }),
    guest('own', { guestOf: undefined }), guest('unconfirmed', { federationInstanceId: 'unlisted' }),
    guest('paused', { federationInstanceId: 'paused-peer' })];
  const result = api.goneGuestEntries(list, 'home', 'active', [blocked, place({ instanceId: 'paused-peer', linkState: 'paused' })]);
  assert.equal(result.some(({ entry }) => entry.id === 'active'), false, 'R234-gone-active: открытая запись остаётся');
  assert.equal(result.some(({ entry }) => entry.id === 'other-home'), false, 'R234-gone-home: чужой дом не затронут');
  assert.equal(result.some(({ entry }) => entry.id === 'own'), false);
  assert.equal(result.some(({ entry }) => entry.id === 'unconfirmed'), false, 'R234-gone-place: молчание дома не разрыв');
  assert.equal(result.map(({ entry }) => entry.id).join(','), 'gone');
  assert.equal(result[0]!.entry, list[1]); assert.equal(result[0]!.title, 'gone');
  assert.equal(list.length, 6);
  assert.equal(api.goneGuestEntries(list, 'home', null, [place({ linkState: 'unknown' })]).length, 2);
}
it('R234 автоуборка берёт только подтверждённо потерянных гостей данного дома и не активную запись', () => goneFilters(railRules));

function matching(api: RailApi) {
  // После смены ключа id бывает старым; домен и хост API остаются последними надёжными способами найти соседа.
  const byId = place({ instanceId: 'exact', domain: 'id.example.test', linkState: 'blocked' });
  const byDomain = place({ instanceId: 'domain', domain: 'domain.example.test', linkState: 'blocked' });
  const byHost = place({ instanceId: 'host', domain: 'host.example.test', linkState: 'blocked' });
  const places = [byHost, byDomain, byId];
  const base = inst('g', 1, { guestOf: 'home', federationInstanceId: 'exact', domain: byDomain.domain, apiUrl: 'https://api.host.example.test' });
  for (const [entry, expected] of [[base, byId], [{ ...base, federationInstanceId: 'old' }, byDomain],
    [{ ...base, federationInstanceId: 'old', domain: 'obsolete.example.test' }, byHost]] as const) {
    assert.equal(api.placeOfEntry(entry, places)?.instanceId, expected.instanceId, `R234-match-${expected.instanceId}: порядок id-домен-хост`);
    assert.equal(api.goneGuestEntries([entry], 'home', null, places).length, 1);
  }
  assert.equal(api.placeOfEntry(inst('none', 0), places), null);
}
it('R234 место сопоставляется сначала по id, затем по домену и только потом по хосту API', () => matching(railRules));

function hiddenPlaces(api: RailApi) {
  // Одного нового сервера достаточно вернуть группу; удалённое членство новым доступом не является.
  const old = place().servers[0]!;
  const newer = { ...old, serverId: 'new' };
  const hidden = { 'peer-new': ['remote'] };
  assert.equal(api.placeHidden(place({ servers: [old, newer] }), hidden), false, 'R234-hidden-new: новый сервер возвращает группу');
  assert.equal(api.placeHidden(place({ servers: [old, { ...newer, state: 'removed' }] }), hidden), true, 'R234-hidden-removed: удалённый сервер не возвращает группу');
  assert.equal(api.placeHidden(place(), hidden), true);
  assert.equal(api.placeHidden(place({ servers: [{ ...old, state: 'blocked' }] }), hidden), true);
  assert.equal(api.placeHidden(place({ servers: [] }), hidden), true);
  assert.equal(api.placeHidden(place(), undefined), false);
  assert.equal(api.placeHidden(place(), { elsewhere: ['remote'] }), false);
  assert.equal(api.placeHidden(place(), { 'peer-new': [] }), false);
}
it('R234 ручное скрытие действует до нового сервера, removed не отменяет скрытие', () => hiddenPlaces(railRules));

function blockedAndHidden(api: RailApi) {
  // Индекс дома не должен тут же воскресить убранную группу, а текущая сессия должна сохранить дорогу домой.
  const home = inst('home', 0);
  const guest = inst('guest', 1, { guestOf: home.id, federationInstanceId: 'peer-new', servers: [{ id: 'remote', name: 'Чужой сервер' }] });
  for (const state of ['blocked', 'unknown']) {
    for (const withEntry of [true, false]) {
      const result = api.buildRail(input({ instances: withEntry ? [home, guest] : [home], activeId: home.id, places: [place({ linkState: state })] }));
      assert.equal(result.groups.some((g) => g.guest), false, `R234-build-${withEntry ? 'entry' : 'place'}: разорванная связка отсутствует`);
    }
  }
  const hiddenHome = { ...home, hiddenGuests: { 'peer-new': ['remote'] } };
  const build = (servers = place().servers) => api.buildRail(input({ instances: [hiddenHome], activeId: home.id, places: [place({ servers })] }));
  assert.equal(build().groups.some((g) => g.guest), false, 'R234-build-hidden: убранное место не воскресает из индекса');
  assert.equal(build([...place().servers, { ...place().servers[0]!, serverId: 'new' }]).groups.some((g) => g.guest), true);
  assert.equal(api.buildRail(input({ instances: [home, guest], activeId: guest.id, places: [place({ linkState: 'blocked' })] })).groups.some((g) => g.instanceId === guest.id), true);
}
it('R234 рейл не рисует blocked/unknown из записи или места и уважает скрытие у дома', () => blockedAndHidden(railRules));

function silentGroups(api: RailApi) {
  // «Не отвечает» описывает сеть фонового гостя, а не паузу связки, собственный дом или открытую сессию.
  const home = inst('home', 0, { servers: [{ id: 'ours', name: 'Наш' }] });
  const guest = inst('guest', 1, { name: 'Сосед', guestOf: home.id, federationInstanceId: 'peer-new', servers: [{ id: 'remote', name: 'Чужой сервер' }] });
  for (const [entry, live, state, down, expected] of [
    [guest, false, 'paused', true, false], [guest, false, 'trust-lost', true, false],
    [guest, false, 'active', true, true], [guest, false, 'active', false, false], [guest, false, 'active', undefined, false],
    [guest, true, 'active', true, false], [inst('own', 2, { servers: [{ id: 'own-server', name: 'Свой' }] }), false, 'active', true, false],
    [home, true, 'active', true, false],
  ] as const) {
    const result = api.buildRail(input({ instances: entry.id === home.id ? [home] : [home, entry], activeId: live ? entry.id : home.id,
      liveServers: entry.servers ?? [], places: entry.guestOf ? [place({ linkState: state })] : [], bgUnread: { [entry.id]: { servers: {}, down } } }));
    const group = result.groups.find((g) => g.instanceId === entry.id); assert.ok(group);
    assert.equal(group.silent === true, expected, `R234-silent-${state}-${entry.guestOf ? 'guest' : 'own'}-${live}-${down}: сеть не состояние связки`);
    if (expected) {
      assert.equal(api.groupHeadTitle(group), 'Сосед · не отвечает');
      assert.equal(api.serverTitle(group, group.servers[0]!), 'Чужой сервер — «Сосед» не отвечает');
      assert.equal(api.serverTitle(group, { ...group.servers[0]!, closed: true }), 'Чужой сервер — закрыт держателем');
    }
  }
}
it('R234 silent и подпись «не отвечает» появляются только у фонового гостя с живой связкой и down', () => silentGroups(railRules));

it('R234 контрфакты рейла ловятся именно соответствующей проверкой поведения', () => {
  const mutants: [string, string, string, (api: RailApi) => void, string, unknown, unknown][] = [
    ['пауза стала разрывом', "linkState === 'blocked' || linkState === 'unknown'", "linkState === 'blocked' || linkState === 'unknown' || linkState === 'paused'", linkStates, 'R234-link-paused:', true, false],
    ['потеря доверия стала разрывом', "linkState === 'blocked' || linkState === 'unknown'", "linkState === 'blocked' || linkState === 'unknown' || linkState === 'trust-lost'", linkStates, 'R234-link-trust-lost:', true, false],
    ['удаляется открытая запись', 'inst.guestOf !== homeId || inst.id === activeId', 'inst.guestOf !== homeId', goneFilters, 'R234-gone-active:', true, false],
    ['удаляется гость другого дома', 'inst.guestOf !== homeId || inst.id === activeId', 'inst.id === activeId', goneFilters, 'R234-gone-home:', true, false],
    ['молчание дома объявлено разрывом', 'if (!place || !linkGone(place.linkState)) continue;', 'if (place && !linkGone(place.linkState)) continue;', goneFilters, 'R234-gone-place:', true, false],
    ['игнорируется id соседа', 'if (inst.federationInstanceId) {', 'if (false) {', matching, 'R234-match-exact:', 'domain', 'exact'],
    ['игнорируется домен соседа', 'if (inst.domain) {', 'if (false) {', matching, 'R234-match-domain:', 'host', 'domain'],
    ['игнорируется запасной хост API', 'return places.find((p) => serverHost(`https://${p.domain}`) === host) ?? null;', 'return null;', matching, 'R234-match-host:', undefined, 'host'],
    ['один старый сервер скрывает и новый', 'return place.servers.every(', 'return place.servers.some(', hiddenPlaces, 'R234-hidden-new:', true, false],
    ['removed считается новым сервером', "s.state === 'removed' || was.includes(s.serverId)", 'was.includes(s.serverId)', hiddenPlaces, 'R234-hidden-removed:', false, true],
    ['разрыв не прячет запись', 'if (inst.guestOf && !live && place && linkGone(place.linkState)) continue;', '', blockedAndHidden, 'R234-build-entry:', true, false],
    ['разрыв не прячет место', 'linkGone(place.linkState) || placeHidden(place, hidden)', 'placeHidden(place, hidden)', blockedAndHidden, 'R234-build-place:', true, false],
    ['игнорируется ручное скрытие', 'linkGone(place.linkState) || placeHidden(place, hidden)', 'linkGone(place.linkState)', blockedAndHidden, 'R234-build-hidden:', true, false],
    ['silent вместо недоступности связки', 'inst.guestOf && !live && reachable && bgUnread[inst.id]?.down', 'inst.guestOf && !live && !reachable && bgUnread[inst.id]?.down', silentGroups, 'R234-silent-paused-guest-false-true:', true, false],
    ['silent без сетевого отказа', 'reachable && bgUnread[inst.id]?.down', 'reachable', silentGroups, 'R234-silent-active-guest-false-false:', true, false],
    ['silent у открытого гостя', 'inst.guestOf && !live && reachable &&', 'inst.guestOf && reachable &&', silentGroups, 'R234-silent-active-guest-true-true:', true, false],
    ['silent у своего дома', 'inst.guestOf && !live && reachable &&', '!live && reachable &&', silentGroups, 'R234-silent-active-own-false-true:', true, false],
  ];
  for (const [label, from, to, check, prefix, actual, expected] of mutants) {
    check(loadRail(railSource)); assert.equal(railSource.split(from).length - 1, 1, label);
    assert.throws(() => check(loadRail(railSource.replace(from, to))), e => e instanceof assert.AssertionError
      && e.message.startsWith(prefix) && e.operator === 'strictEqual' && e.actual === actual && e.expected === expected, label);
  }
});

const input = (patch: Partial<RailInput>): RailInput => ({
  instances: [],
  activeId: null,
  liveServers: [],
  closedServerIds: [],
  liveUnread: {},
  liveMentions: {},
  bgUnread: {},
  places: [],
  placesLoaded: true,
  ...patch,
});

const place = (patch: Partial<RailPlace> = {}): RailPlace => ({
  instanceId: 'peer-new',
  name: 'Сосед',
  domain: 'voice.peer.test',
  clientOrigin: 'https://voice.peer.test',
  linkState: 'active',
  servers: [{ serverId: 'remote', name: 'Чужой сервер', state: 'active', reason: null }],
  ...patch,
});

describe('группы инстансов в рейле', () => {
  it('дома идут по order, а гости сразу после своего дома; осиротевший гость не теряется', () => {
    // Ловит прыгающий при переключении порядок и исчезновение гостевой записи удалённого дома.
    const list = [
      inst('home-b', 20), inst('guest-a', 30, { guestOf: 'home-a' }), inst('home-a', 10),
      inst('orphan', 5, { guestOf: 'gone' }), inst('guest-b', 1, { guestOf: 'home-b' }),
    ];
    assert.deepEqual(orderedInstances(list).map((x) => x.id), ['home-a', 'guest-a', 'home-b', 'guest-b', 'orphan']);
  });

  it('две записи одного соседа схлопываются в запись с нынешней личностью', () => {
    // Ловит две группы — живую и мёртвую — после перепривязки ключа соседа.
    const home = inst('home', 0, { servers: [{ id: 'ours', name: 'Наш сервер' }] });
    const old = inst('old', 1, { guestOf: home.id, federationInstanceId: 'peer-old', domain: 'voice.peer.test' });
    const fresh = inst('fresh', 2, { guestOf: home.id, federationInstanceId: 'peer-new', domain: 'voice.peer.test' });
    const result = buildRail(input({ instances: [home, old, fresh], activeId: home.id, places: [place()] }));
    assert.deepEqual(result.groups.filter((g) => g.guest).map((g) => g.instanceId), ['fresh']);
  });

  it('активная старая запись остаётся приоритетной, а без places побеждает живая новая по order', () => {
    // Ловит исчезновение текущего инстанса и дубль в момент, когда дом ещё не отдал места.
    const home = inst('home', 0);
    const old = inst('old', 1, { guestOf: home.id, federationInstanceId: 'peer-old', domain: 'voice.peer.test' });
    const fresh = inst('fresh', 2, { guestOf: home.id, federationInstanceId: 'peer-new', domain: 'voice.peer.test' });
    const activeOld = buildRail(input({ instances: [home, old, fresh], activeId: old.id, places: [place()] }));
    assert.deepEqual(activeOld.groups.filter((g) => g.guest).map((g) => g.instanceId), ['old']);
    const noPlaces = buildRail(input({ instances: [home, old, fresh], activeId: fresh.id, places: [], placesLoaded: true }));
    assert.deepEqual(noPlaces.groups.filter((g) => g.guest).map((g) => g.instanceId), ['fresh']);
  });

  it('пустой дом остаётся дорогой назад из гостей, а обычная пустая группа скрыта', () => {
    // Ловит единственный путь домой, исчезавший у человека без собственных серверов.
    const home = inst('home', 0);
    const empty = inst('empty', 1);
    const guest = inst('guest', 2, { guestOf: home.id, domain: 'voice.peer.test' });
    const result = buildRail(input({ instances: [home, empty, guest], activeId: guest.id }));
    assert.deepEqual(result.groups.map((g) => g.instanceId), ['home', 'guest']);
    assert.equal(result.showHeaders, true);
  });

  it('потеря доверия говорит починить связь, обычная недоступность предлагает подождать, замок важнее', () => {
    // При смене ключа ожидание бесполезно: связь чинится админами; закрытый сервер остаётся отдельным отказом.
    const baseGroup = { key: 'g', instanceId: 'g', title: 'Сосед', guest: true, live: false, reachable: false,
      place: place({ linkState: 'trust-lost' }), servers: [] };
    const server = { id: 's', name: 'Дом', closed: false, unread: 0, mentions: 0 };
    assert.match(serverTitle(baseGroup, server), /связь с «Сосед» разорвана/);
    assert.match(groupHeadTitle(baseGroup), /связь разорвана/);
    const down = { ...baseGroup, place: place({ linkState: 'paused' }) };
    assert.match(serverTitle(down, server), /сейчас недоступен/);
    assert.match(groupHeadTitle(down), /сейчас недоступен/);
    assert.equal(serverTitle(baseGroup, { ...server, closed: true }), 'Дом — закрыт держателем');
    const original = readFileSync(new URL('./railRules.ts', import.meta.url), 'utf8');
    const changed = original.replace('if (trustLost(group)) return `${server.name} — связь с «${group.title}» разорвана: ${TRUST_LOST_WHY}`;', 'if (false) return `${server.name} — связь с «${group.title}» разорвана: ${TRUST_LOST_WHY}`;');
    assert.notEqual(changed, original, 'реальный рейл отдельно подписывает потерю доверия');
    const mod = { exports: {} as Record<string, unknown> };
    runInNewContext(ts.transpileModule(changed, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module: mod, exports: mod.exports, require: (id: string) => {
        assert.equal(id, './configRules'); return { serverHost: (url: string) => new URL(url).hostname.replace(/^api\./, '') };
      } });
    const mutant = mod.exports as typeof import('./railRules.js');
    assert.throws(() => assert.match(mutant.serverTitle(baseGroup, server), /связь с «Сосед» разорвана/), assert.AssertionError,
      'мутант без специальной подписи trust-lost обязан провалить контракт');
  });
});
