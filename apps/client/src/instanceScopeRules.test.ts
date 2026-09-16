import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readScopedValue, scopedStorageKey } from './instanceScopeRules.js';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    set: (k: string, v: string) => void data.set(k, v),
  };
}

describe('настройки устройства по инстансам (F0, #139)', () => {
  it('записанное на одном инстансе не читается на другом', () => {
    // Ловит общий ключ на все инстансы: громкость человека с одного инстанса применялась бы к id с другого.
    const s = memory();
    s.set(scopedStorageKey('gv_user_audio', 'inst-a'), '{"u1":{"volume":0.2}}');
    assert.equal(readScopedValue('gv_user_audio', 'inst-b', s.get, s.set), null);
    assert.equal(readScopedValue('gv_user_audio', 'inst-a', s.get, s.set), '{"u1":{"volume":0.2}}');
  });

  it('прежнее общее значение достаётся каждому инстансу копией и не удаляется', () => {
    // Ловит потерю уже выставленных настроек при переходе на ключи по инстансам.
    const s = memory({ gv_muted_channels: '["c1"]' });
    assert.equal(readScopedValue('gv_muted_channels', 'inst-a', s.get, s.set), '["c1"]');
    assert.equal(s.data.get('gv_muted_channels@inst-a'), '["c1"]');
    assert.equal(readScopedValue('gv_muted_channels', 'inst-b', s.get, s.set), '["c1"]');
    assert.equal(s.data.get('gv_muted_channels'), '["c1"]');
  });

  it('своё значение сильнее общего, даже пустое', () => {
    // Ловит общий ключ, перетирающий то, что человек уже поменял на этом инстансе.
    const s = memory({ gv_muted_channels: '["c1"]', 'gv_muted_channels@inst-a': '[]' });
    assert.equal(readScopedValue('gv_muted_channels', 'inst-a', s.get, s.set), '[]');
  });

  it('без записи в реестре — прежний общий ключ', () => {
    assert.equal(scopedStorageKey('gv_channel_seen', null), 'gv_channel_seen');
  });

  it('ошибка записи миграционной копии не скрывает прежнее значение', () => {
    // Ловит потерю настроек в private mode/при переполненном storage только из-за неудачной миграции.
    const s = memory({ gv_channel_seen: '{"c1":"m1"}' });
    assert.equal(
      readScopedValue('gv_channel_seen', 'inst-a', s.get, () => {
        throw new Error('quota');
      }),
      '{"c1":"m1"}',
    );
    assert.equal(s.data.has('gv_channel_seen@inst-a'), false);
  });
});
