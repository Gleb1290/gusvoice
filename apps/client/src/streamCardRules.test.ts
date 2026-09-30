import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canSnapshotStream, PREVIEW_EVERY_MS, SNAPSHOT_EVERY_MS, streamCardCycle } from './streamCardRules.js';

function harness(patch: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const d = {
    channelId: 'voice-1' as string | null,
    ownerId: 'user-1',
    cancelled: () => false,
    getPreview: async () => ({ image: 'preview' as string | null }),
    setSnapshot: (url: string) => { calls.push(`snapshot:${url}`); },
    setSubscribed: (on: boolean) => { calls.push(`sub:${on}`); },
    requestLow: () => { calls.push('low'); },
    waitTrack: async () => { calls.push('wait'); return 'track'; },
    capture: async () => { calls.push('capture'); return 'frame'; },
    next: (ms: number) => { calls.push(`next:${ms}`); },
    ...patch,
  };
  return { calls, d };
}

describe('снимок карточки показа', () => {
  it('живым снимком пользуется только чужая управляемая публикация', () => {
    // Ловит подписку на свой показ и попытку управлять публикацией без setSubscribed.
    assert.equal(canSnapshotStream(false, { setSubscribed() {} }), true);
    assert.equal(canSnapshotStream(true, { setSubscribed() {} }), false);
    assert.equal(canSnapshotStream(false, {}), false);
    assert.equal(canSnapshotStream(false, null), false);
  });

  it('готовое превью не подписывает карточку на поток', async () => {
    // Главная регрессия #207: дешёвая картинка не должна будить три слоя NVENC.
    const { calls, d } = harness();
    await streamCardCycle(d);
    assert.deepEqual(calls, [`snapshot:preview`, `next:${PREVIEW_EVERY_MS}`]);
  });

  it('ошибка превью просит нижний слой в том же такте до ожидания трека', async () => {
    // Ловит краткую выдачу верхнего слоя до LOW, которая будит полный кодировщик у показывающего.
    const { calls, d } = harness({ getPreview: async () => { throw new Error('404'); } });
    await streamCardCycle(d);
    assert.deepEqual(calls, ['sub:true', 'low', 'wait', 'capture', 'snapshot:frame', 'sub:false', `next:${SNAPSHOT_EVERY_MS}`]);
  });

  it('без channelId сразу использует запасной путь', async () => {
    // Ловит бессмысленный запрос превью без адреса канала и пропуск fallback.
    const { calls, d } = harness({ channelId: null, getPreview: async () => assert.fail('не должен вызываться') });
    await streamCardCycle(d);
    assert.deepEqual(calls.slice(0, 3), ['sub:true', 'low', 'wait']);
  });

  it('отмена до и после ожидания не пишет снимок и не планирует новый заход', async () => {
    // Ловит обновление размонтированной карточки и оставленный таймер старого потока.
    let cancelled = true;
    const first = harness({ cancelled: () => cancelled });
    await streamCardCycle(first.d);
    assert.deepEqual(first.calls, []);
    cancelled = false;
    const second = harness({
      getPreview: async () => ({ image: null }),
      cancelled: () => cancelled,
      waitTrack: async () => { second.calls.push('wait'); cancelled = true; return 'track'; },
    });
    await streamCardCycle(second.d);
    assert.deepEqual(second.calls, ['sub:true', 'low', 'wait']);
  });
});
