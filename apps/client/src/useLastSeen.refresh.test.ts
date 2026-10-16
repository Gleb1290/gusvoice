import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import type { UserLastSeen } from '@gusvoice/shared';
import * as lastSeenText from './lastSeenText';
import { React, environment, load, mutate } from './components/R171.phoneHarness';

const source = readFileSync(new URL('./useLastSeen.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const onlineSource = readFileSync(new URL('./dmOnline.ts', import.meta.url), 'utf8');
const seen = (at: string): UserLastSeen => ({ userId: 'peer', online: false, exact: true, approx: null, at,
  byMe: false, canCall: false });
const first = seen('2026-10-13T10:00:00.000Z'), latest = seen('2026-10-13T10:05:00.000Z');

async function scene(check: (f: {
  calls: { id: string; resolve: (value: UserLastSeen) => void }[];
  current: () => UserLastSeen | null;
  refresh: () => Promise<void>;
  answer: (index: number, value: UserLastSeen) => Promise<void>;
  start: () => Promise<void>;
}) => Promise<void>, raw = source, enabled = true, person: string | null = 'peer') {
  await environment(async (host, render) => {
    const state = { serverFeatures: enabled ? ['lastseen1', 'presence4'] : [], user: { id: 'me' },
      onlineUsers: [] as string[], dmOnlineUsers: [] as string[], dmAwayUsers: [] as string[], lastSeenEpoch: 0 };
    const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
    const calls: { id: string; resolve: (value: UserLastSeen) => void }[] = [];
    const api = { userLastSeen: (id: string) => new Promise<UserLastSeen>(resolve => calls.push({ id, resolve })) };
    const dmOnline = load<typeof import('./dmOnline')>(onlineSource, { '@gusvoice/shared': shared, './api': { api }, './store': { useStore } });
    const timers = new Map<number, { fn: () => void; ms: number }>(); let next = 0;
    const hooks = load<typeof import('./useLastSeen')>(raw,
      { './api': { api }, './store': { useStore }, './dmOnline': dmOnline, './lastSeenText': lastSeenText },
      { setTimeout: (fn: () => void, ms: number) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: (id: number) => timers.delete(id) });
    const Witness = () => React.createElement('output', null, JSON.stringify(hooks.useLastSeen(person)));
    const update = () => render(React.createElement(Witness));
    const requests = async () => {
      await React.act(async () => {
        for (const [id, timer] of [...timers]) if (timer.ms === 0) { timers.delete(id); timer.fn(); }
        for (let i = 0; i < 5; i++) await Promise.resolve();
      });
    };
    await update();
    await check({ calls,
      current: () => JSON.parse(host.querySelector('output')!.textContent!) as UserLastSeen | null,
      start: requests,
      refresh: async () => { state.lastSeenEpoch++; await update(); await requests(); },
      answer: async (index, value) => { await React.act(async () => { calls[index].resolve(value); for (let i = 0; i < 5; i++) await Promise.resolve(); }); },
    });
  });
}

async function epoch(raw = source) {
  await scene(async f => {
    assert.equal(f.current(), null); await f.start(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, 'peer');
    await f.answer(0, first); assert.deepEqual(f.current(), first);
    await f.refresh();
    assert.equal(f.calls.length, 2, 'эпоха повторно запрашивает смонтированный статус');
    assert.deepEqual(f.current(), first, 'ожидающий перезапрос не сбрасывает прежний статус');
    await f.answer(1, latest); assert.deepEqual(f.current(), latest, 'новый ответ обновляет показанный статус');
  }, raw);
}
// Возврат вкладки должен обновить давно смонтированный профиль, не оставляя пустой статус до ответа.
it('R208 useLastSeen перезапрашивает при смене эпохи и сохраняет ответ до нового', async () => { await epoch(); });

// Ответ устаревшего перезапроса не должен затереть данные следующей эпохи.
it('R208 useLastSeen игнорирует поздний ответ отменённой эпохи', async () => {
  await scene(async f => {
    await f.start(); await f.answer(0, first);
    await f.refresh(); await f.refresh(); assert.equal(f.calls.length, 3);
    await f.answer(2, latest); await f.answer(1, first);
    assert.deepEqual(f.current(), latest);
  });
});

// Эпоха не обходит старые гейты: нет человека/признака — нет запроса даже после возврата сети.
it('R208 эпоха не вызывает lastSeen без признака сервера или выбранного человека', async () => {
  for (const [enabled, person] of [[false, 'peer'], [true, null]] as const)
    await scene(async f => { await f.start(); await f.refresh(); assert.equal(f.calls.length, 0); assert.equal(f.current(), null); }, source, enabled, person);
});

// Забытый epoch в deps сохраняет видимость старого статуса, но лишает его реального обновления.
it('R208 контрфакт useLastSeen без epoch в зависимостях теряет перезапрос', async () => {
  await epoch();
  await assert.rejects(epoch(mutate(source, '[on, userId, online, myPrivacy, epoch]', '[on, userId, online, myPrivacy]')),
    e => e instanceof assert.AssertionError && e.message.startsWith('эпоха повторно запрашивает смонтированный статус')
      && e.actual === 1 && e.expected === 2);
});

// Контрфакт отдельно доказывает отсутствие мерцания, а не только новый HTTP-вызов.
it('R208 контрфакт сброса view в начале перезапроса теряет прежний ответ', async () => {
  await epoch();
  await assert.rejects(epoch(mutate(source, '    let alive = true;', '    setView(null);\n    let alive = true;')),
    e => e instanceof assert.AssertionError && e.message.startsWith('ожидающий перезапрос не сбрасывает прежний статус')
      && e.actual === null && JSON.stringify(e.expected) === JSON.stringify(first));
});
