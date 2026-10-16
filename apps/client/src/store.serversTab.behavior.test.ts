import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import { create } from 'zustand';
import * as channel from './channelRules';
import * as conv from './convSyncRules';
import * as stream from './streamAudioRules';
import * as history from './historyPage';

const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Store = typeof import('./store').useStore;
const placeSource = readFileSync(new URL('./lastPlace.ts', import.meta.url), 'utf8');
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(raw = source, place?: string, instance: string | null = 'home') {
  const calls: string[] = [], places: import('./lastPlace').LastPlace[] = [];
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); if (key === 'gv_last_place') places.push(JSON.parse(value)); },
    removeItem: (key: string) => { values.delete(key); },
  };
  // Настоящий формат места: один gv_last_place, JSON с instanceId; чужая/legacy запись без instanceId отвергается.
  const placeModule = { exports: {} as typeof import('./lastPlace') };
  runInNewContext(ts.transpileModule(placeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module: placeModule, exports: placeModule.exports, localStorage: storage });
  if (place && instance) placeModule.exports.rememberPlace({ instanceId: instance, serverId: place });
  places.length = 0;
  const api = {
    getServer: async (id: string) => { calls.push(`server:${id}`); return { server: { id, name: id }, channels: [{ id: 'text', type: 'text' }, { id: 'voice', type: 'voice' }], sounds: {}, reads: {} }; },
    listMembers: async () => [],
    markChannelRead: async (id: string) => { calls.push(`read:${id}`); },
    listMessages: async (id: string) => { calls.push(`history:${id}`); return []; },
  };
  const noop = () => {};
  const deps: Record<string, unknown> = {
    zustand: { create }, './api': { api }, './config': { activeInstanceId: () => instance },
    './channelRules': channel, './convSyncRules': conv, './streamAudioRules': stream, './historyPage': history,
    // Беседы — отдельная подсистема: её действия не участвуют ни в одном из трёх серверных переходов.
    './convStore': { createConvActions: () => ({}) },
    './instanceScope': { scopedGetItem: () => null }, './channelPrefs': { markChannelSeen: noop },
    './lastPlace': placeModule.exports,
    './tabSync': { publishTabEvent: (e: { kind: string; channelId: string }) => calls.push(`${e.kind}:${e.channelId}`) },
    './hotkeys': { isMobile: () => true }, './sounds': { setCustomSounds: noop, setChannelSounds: noop },
  };
  const unused = ['./convCacheRules', './dmListRules', './convCache', './nativeUnifiedPush', './tipHints', './toastRules',
    './profilePatch', './voiceCueRules', './voiceSession'];
  for (const id of unused) deps[id] = new Proxy({}, { get(_target, key) { assert.fail(`неожиданное исполнение ${id}.${String(key)}`); } });
  const module = { exports: {} as { useStore: Store } };
  // Весь настоящий store, настоящее create Zustand, без извлечения/переписывания action и без таймеров браузера.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: storage,
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `неописанный импорт ${id}`); return deps[id]; } });
  return { store: module.exports.useStore, calls, places, values };
}
function replaceOnce(anchor: string, replacement: string) {
  assert.equal(source.split(anchor).length - 1, 1, `единственный якорь ${anchor}`); return source.replace(anchor, replacement);
}
function tabStates(raw = source) {
  for (const [wasActive, pane, currentServerId, serverListOpen, expected] of [
    [false, 'list', 's', false, false], [true, 'list', 's', false, true],
    [true, 'list', 's', true, false], [true, 'content', 's', false, false], [true, 'list', null, false, false],
  ] as const) {
    const f = fixture(raw); f.store.setState({ view: 'dm', mobilePane: pane, currentServerId, serverListOpen, mobileProfileOpen: true, mobileMembersOpen: true });
    f.store.getState().openServersTab(wasActive); const s = f.store.getState();
    assert.equal(s.serverListOpen, expected, 'список открывается только повторным нажатием активных каналов');
    assert.equal(s.view, 'server'); assert.equal(s.mobilePane, 'list');
    assert.equal(s.mobileProfileOpen, false, 'профиль сброшен'); assert.equal(s.mobileMembersOpen, false);
    assert.equal(f.calls.length, 0, 'при текущем сервере не перечитываем его');
  }
}
it('R174 настоящий стор различает повторный тап, другую вкладку и уже открытый список, сбрасывает профиль', () => {
  // Пять реальных состояний не дают подменить wasActive безусловным возвратом к списку.
  tabStates();
});
it('R174 последний сервер восстанавливается только без текущего и пока он есть в списке', async () => {
  // Ушедший сервер и отсутствие записи места не должны породить API-вызов к несуществующему серверу.
  for (const [place, listed, current, expected] of [
    ['last', true, null, true], ['last', false, null, false], [undefined, true, null, false], ['last', true, 'current', false],
  ] as const) {
    const f = fixture(source, place); f.store.setState({ currentServerId: current, servers: listed ? [{ id: 'last' }] as never : [] });
    // openServersTab запускает openServer без await. Две microtask-паузы недостаточны для Promise между host и VM realms.
    // Следующая очередь event loop ждёт весь микротасковый checkpoint, не зависит от числа await внутри action.
    f.store.getState().openServersTab(false); await settle();
    assert.equal(f.calls.includes('server:last'), expected, 'восстановление доступного последнего сервера');
    assert.equal(f.store.getState().currentServerId, expected ? 'last' : current);
  }
  for (const stored of [{ serverId: 'last' }, { instanceId: 'other', serverId: 'last' }]) {
    const f = fixture(); f.values.set('gv_last_place', JSON.stringify(stored)); f.store.setState({ servers: [{ id: 'last' }] as never });
    f.store.getState().openServersTab(false); await settle();
    assert.equal(f.calls.length, 0, 'legacy или чужое место не запускает восстановление');
    assert.equal(f.store.getState().currentServerId, null);
  }
});
async function rememberScenario(raw = source) {
  const f = fixture(raw); f.store.setState({ serverListOpen: true });
  await f.store.getState().openServer('s');
  assert.equal(f.store.getState().serverListOpen, false, 'openServer закрывает список');
  assert.equal(f.store.getState().currentServerId, 's'); assert.equal(f.store.getState().currentChannelId, null);
  // Проверка наличия записи идёт первой: мутант без rememberPlace обязан погибнуть именно на поведении сохранения,
  // а не на следующей безымянной проверке instanceId, которую фильтр assert.rejects раньше не распознавал.
  assert.equal(f.places.length, 1, 'openServer запоминает сервер сразу');
  assert.equal(f.places[0]?.instanceId, 'home', 'запись относится к активному инстансу'); assert.equal(f.places[0]?.serverId, 's', 'openServer запоминает сервер сразу');
  assert.equal(f.places[0]?.channelId, undefined, 'при выборе сервера канал не придумывается');
  f.store.setState({ serverListOpen: true }); await f.store.getState().openChannel('text');
  assert.equal(f.store.getState().serverListOpen, false, 'openChannel закрывает список'); assert.equal(f.store.getState().mobilePane, 'content');
  assert.equal(f.places[1]?.channelId, 'text', 'openChannel запоминает канал'); assert.equal(f.places[1]?.serverId, 's');
  assert.equal(f.calls.includes('read:text'), true); assert.equal(f.calls.includes('history:text'), true);
}
it('R174 openServer и openChannel выполняют настоящий сброс списка и сохраняют сервер, затем канал', async () => {
  // Телефон остаётся на списке каналов после openServer, но перезагрузка уже обязана помнить этот сервер.
  await rememberScenario();
  const f = fixture(source, undefined, null); await f.store.getState().openServer('s'); await f.store.getState().openChannel('voice');
  assert.equal(f.places.length, 0, 'без активного инстанса место не сохраняется');
});
it('R174 реальные мутанты wasActive и сброса профиля отвергаются действиями Zustand', () => {
  // VM исполняет целиком мутированный store; исходный сценарий проходит до каждой ошибки.
  for (const [anchor, replacement, message] of [
    ['const toList = wasActive &&', 'const toList =', 'список открывается'],
    ["view: 'server', mobileProfileOpen: false, mobilePane: 'list', mobileMembersOpen: false, serverListOpen: toList", "view: 'server', mobileProfileOpen: true, mobilePane: 'list', mobileMembersOpen: false, serverListOpen: toList", 'профиль сброшен'],
  ]) { tabStates(); const raw = replaceOnce(anchor, replacement); assert.throws(() => tabStates(raw), e => e instanceof assert.AssertionError && e.message.includes(message)); }
});
it('R174 реальный мутант без немедленного запоминания сервера отвергается после его открытия', async () => {
  // Запоминание канала позже не может компенсировать отсутствующее сохранение сервера на телефоне.
  await rememberScenario(); const raw = replaceOnce('if (inst0) rememberPlace({ instanceId: inst0, serverId });', 'if (inst0) void serverId;');
  await assert.rejects(rememberScenario(raw), e => e instanceof assert.AssertionError && e.message.includes('запоминает сервер сразу'));
});
