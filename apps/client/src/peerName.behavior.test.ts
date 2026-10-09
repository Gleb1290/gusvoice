import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { PeerNamer } from './peerName';
import { personLabel, serverContacts } from './contactRules';

function loadPeerName(state: { owner: string; list: { id: string; name: string | null }[] | null }, active: string, home = false, sourceText?: string) {
  const source = sourceText ?? readFileSync(new URL('./peerName.ts', import.meta.url), 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  const contacts = { getState: () => state };
  const useStore = (selector: (s: unknown) => unknown) => selector({ serverFeatures: ['contacts1'], user: { homeInstance: home ? { id: 'remote' } : null } });
  const useContactList = (enabled: boolean) => enabled ? state.list : null;
  const dependencies: Record<string, unknown> = {
    react: { useMemo: (factory: () => unknown) => factory() },
    './contactRules': { personLabel, serverContacts },
    './contacts': { useContactList, useContacts: contacts },
    './config': { activeInstanceId: () => active },
    './store': { useStore },
  };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => {
    assert.ok(id in dependencies, `неожиданный импорт ${id}`);
    return dependencies[id];
  } });
  return module.exports as {
    PLAIN_PEER: PeerNamer;
    usePeerName: () => PeerNamer;
    peerNameNow: (userId: string, fallback: string) => string;
  };
}

it('хук обрабатывает доступный список и fallback, а синхронный резолвер сверяет owner', () => {
  const peer = loadPeerName({ owner: 'instance-a', list: [{ id: 'peer-a', name: '  Сосед  ' }, { id: 'peer-b', name: '  ' }] }, 'instance-a');
  const resolve = peer.usePeerName();
  assert.equal(resolve('peer-a', 'Профиль А'), 'Сосед');
  assert.equal(resolve('peer-b', 'Профиль Б'), 'Профиль Б');
  assert.equal(resolve('peer-c', 'Профиль В'), 'Профиль В');
  assert.equal(peer.peerNameNow('peer-a', 'Профиль А'), 'Сосед');
  const otherOwner = loadPeerName({ owner: 'instance-b', list: [{ id: 'peer-a', name: 'Чужая подпись' }] }, 'instance-a');
  assert.equal(otherOwner.peerNameNow('peer-a', 'Профиль А'), 'Профиль А');
  const unloaded = loadPeerName({ owner: 'instance-a', list: null }, 'instance-a');
  assert.equal(unloaded.usePeerName()('peer-a', 'Профиль А'), 'Профиль А');
  const guest = loadPeerName({ owner: 'instance-a', list: [{ id: 'peer-a', name: 'Чужая подпись' }] }, 'instance-a', true);
  assert.equal(guest.usePeerName()('peer-a', 'Профиль А'), 'Профиль А');
  assert.equal(peer.PLAIN_PEER('peer-a', 'Профиль А'), 'Профиль А');

  const source = readFileSync(new URL('./peerName.ts', import.meta.url), 'utf8');
  const guard = "if (s.owner !== (activeInstanceId() ?? '')) return fallback;";
  assert.ok(source.includes(guard), 'найдена сверка владельца списка для синхронного резолвера');
  const withoutOwnerGuard = loadPeerName({ owner: 'instance-b', list: [{ id: 'peer-a', name: 'Чужая подпись' }] }, 'instance-a', false,
    source.replace(guard, ''));
  assert.throws(() => assert.equal(withoutOwnerGuard.peerNameNow('peer-a', 'Профиль А'), 'Профиль А'), assert.AssertionError,
    'мутант без сверки owner раскрывает подпись другого инстанса');
});

it('канал сервера не импортирует резолвер подписей ЛС', () => {
  // Имена в серверных каналах — отдельный ник; контактная подпись не должна перетекать из личных сообщений.
  const source = readFileSync(new URL('./components/ChatView.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*peerName(?:\.ts)?['"]/);
});
