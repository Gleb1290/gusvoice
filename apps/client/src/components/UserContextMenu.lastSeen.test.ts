import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { UserMenuTarget } from './UserContextMenu';

const source = readFileSync(new URL('./UserContextMenu.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function hookCall(view: 'server' | 'dm', convId?: string, self = false, raw = source) {
  const calls: unknown[][] = [], unexpected: string[] = [], stop = {};
  const state = { view, user: { id: 'me' }, members: [], onlineUsers: [], userStatuses: {}, convActive: false,
    blockedUsers: [], presence: {}, serverFeatures: [], dmOnlineUsers: [], dmAwayUsers: [], dms: [], pushMutedDmUsers: [] };
  const deps: Record<string, unknown> = {
    '@gusvoice/shared': shared,
    react: { useState: (initial: unknown) => [initial, () => {}], useMemo: (fn: () => unknown) => fn(), useEffect: () => {} },
    'livekit-client': { ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost' } },
    '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
    '../localUserAudio': { useUserAudio: () => ({ volume: 1, muted: false }) },
    './GuestMark': { useGuestHome: () => () => null },
    '../dmRules': { serverFedDm: () => false, dmPeerHome: () => null, peerPresenceShown: () => true },
    '../contactRules': { serverContacts: () => false },
    '../contacts': { useContactList: () => [] },
    '../reportEvidence': { useEvidence: () => [] },
    '../dmOnline': { serverPresence4: () => false, serverHidesOnline: () => false },
    '../useLastSeen': { useLastSeen(...args: unknown[]) { calls.push(args); throw stop; } },
  };
  const dormant = ['react/jsx-runtime', '../callStore', '../callView', '../api', '../toast', './Avatar', './AvatarZoom',
    '../status', './ContextMenu', './Icon', './PokeModal', './ProfileEconomy', './SharedMedia', '../avatarAnimation',
    '../confirm', './StatusDot', '../lastSeenText', './ContactEditModal', '../userAudioRules'];
  for (const id of dormant) deps[id] = new Proxy({}, { get(_target, key) {
    const label = `${id}.${String(key)}`; unexpected.push(label); throw new Error(`непредметная граница ${label}`);
  } });
  const module = { exports: {} as typeof import('./UserContextMenu') };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports,
    require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `явный импорт ${id}`); return deps[id]; } });
  const target: UserMenuTarget = { userId: self ? 'me' : 'peer', name: 'Собеседник', ...(convId !== undefined ? { convId } : {}) };
  // Исполняется целая настоящая функция меню с её selector/hooks, останавливаемся ровно на наблюдаемой IO-границе.
  assert.throws(() => module.exports.UserContextMenu({ target, pos: { x: 0, y: 0 }, onClose() {} }), e => e === stop);
  assert.deepEqual(unexpected, []); assert.equal(calls.length, 1);
  return calls[0]!;
}
function context(raw = source) {
  // Карточка из шапки ЛС не должна стать серверной только потому, что человек переключил основную вкладку.
  assert.deepEqual(hookCall('server', 'conv-one', false, raw), ['peer', 'dm'], 'R235-profile-context: convId сохраняет правила ЛС на серверной вкладке');
  assert.deepEqual(hookCall('server', undefined, false, raw), ['peer', 'server']);
  assert.deepEqual(hookCall('server', '', false, raw), ['peer', 'server']);
  assert.deepEqual(hookCall('dm', undefined, false, raw), ['peer', 'dm']);
  assert.deepEqual(hookCall('server', 'conv-self', true, raw), [null, 'dm'], 'свой профиль не запрашивает чужое время');
}
it('R235 меню с convId спрашивает время по правилам ЛС даже из серверной вкладки, обычное серверное меню не меняется', () => context());
it('R235 потеря convId в выборе контекста ловится на настоящем вызове useLastSeen', () => {
  context(); const anchor = "s.view === 'dm' || !!target.convId";
  assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => context(source.replace(anchor, "s.view === 'dm'")), e => e instanceof assert.AssertionError
    && e.message.startsWith('R235-profile-context:') && e.operator === 'deepStrictEqual'
    && JSON.stringify(e.actual) === '["peer","server"]' && JSON.stringify(e.expected) === '["peer","dm"]');
});
