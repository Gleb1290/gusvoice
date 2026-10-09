import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import type { Instance } from './configRules.js';
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
