import assert from 'node:assert/strict';
import { it } from 'node:test';
import { load, mutate, sourceOf } from './R304.testHarness';
import * as channel from './channelRules';
import * as sync from './convSyncRules';
import * as cache from './convCacheRules';
import * as outgoing from './outgoingRules';
import * as outbox from './outboxRules';
import * as feed from './feedWindowRules';
import type * as Store from './convStore';

const source = sourceOf('convStore');
async function hydration(raw: string, locks: 'leader' | 'follower' | 'missing') {
  let grant: ((lock: unknown) => unknown) | undefined;
  const requests: { name: string; options: unknown }[] = [];
  const navigator = locks === 'missing' ? {} : { locks: { request: (name: string, options: unknown, fn: (lock: unknown) => unknown) => {
    requests.push({ name, options }); grant = fn; return new Promise<void>(() => {});
  } } };
  const mod = load<typeof Store>(raw, { './channelRules': channel, './convSyncRules': sync, './convCacheRules': cache,
    './outgoingRules': outgoing, './outboxRules': outbox, './feedWindowRules': feed }, { navigator, window: {}, AbortController });
  let state: Store.ConvHost = { conv: sync.emptyConvState(), convActive: true, dms: [], dmMessages: {}, unreadDms: [],
    historyFailed: [], currentDmId: null, view: 'server', mobilePane: 'content', outbox: {}, drafts: {} };
  const deps: Store.ConvDeps = { api: {} as Store.ConvDeps['api'], now: () => 1, setTimeout: () => 1, clearTimeout: () => {},
    onOnline: () => {}, isMobile: () => false, markChannelSeen: () => {} };
  const actions = mod.createConvActions(p => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; }, () => state, deps);
  const item = { ...outbox.toPersisted(outbox.newOutboxItem('c', { key: 'disk', content: '', files: [], replyToId: null }, 1)),
    fileNames: ['lost.png'], uploaded: [] };
  actions.convHydrate({ v: 1, pts: 7, savedAt: 0, summaries: [], messages: {}, gone: [], outbox: [item],
    drafts: { c: { text: 'черновик', replyToId: null } } });
  assert.equal(state.conv.pts, 7, 'история поднимается и у ведомой вкладки');
  assert.equal(state.drafts.c.text, 'черновик');
  if (locks !== 'missing') {
    assert.equal(Object.keys(state.outbox).length, 0, 'до решения Web Locks очередь не поднимается');
    assert.equal(requests.length >= 1, true); assert.equal(requests.every(r => r.name === 'gv-conv-outbox'), true);
    assert.equal(requests.every(r => (r.options as { ifAvailable: boolean }).ifAvailable === true), true);
    const held = grant!(locks === 'leader' ? {} : null);
    assert.equal(held instanceof Promise || !!(held as Promise<void> | undefined)?.then, locks === 'leader', 'ведущий удерживает замок');
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  assert.equal(state.outbox.c?.length ?? 0, locks === 'follower' ? 0 : 1, 'без лидерства очередь с диска не поднимается');
  if (locks !== 'follower') assert.match(state.outbox.c[0].error!, /прикрепите.*снова/);
}
for (const mode of ['leader', 'follower', 'missing'] as const)
  it(`R304 очередь с диска: Web Locks ${mode}`, async () => { await hydration(source, mode); });
it('R304 контрфакт: подъём outbox без лидерства обнаруживается на реальном convHydrate', async () => {
  await hydration(source, 'follower');
  await assert.rejects(hydration(mutate(source, 'if (outboxLeader === true || !hasLocks()) restore();', 'if (true) restore();'), 'follower'),
    e => e instanceof assert.AssertionError && e.message.includes('до решения Web Locks'));
});
