import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScopedStorage, readScopedValue, scopedStorageKey } from './instanceScopeRules.js';

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

describe('обёртка хранилища активного инстанса (#143)', () => {
  it('ключ, чтение и запись каждый раз используют текущий активный инстанс', () => {
    // Ловит захваченный при создании id: после переключения аккаунта настройки продолжили бы течь в старый ключ.
    const s = memory({ 'volume@a': '10', 'volume@b': '20' });
    let active: string | null = 'a';
    const scoped = createScopedStorage({ activeInstanceId: () => active, getItem: s.get, setItem: s.set });
    assert.equal(scoped.key('volume'), 'volume@a');
    assert.equal(scoped.get('volume'), '10');
    active = 'b';
    assert.equal(scoped.get('volume'), '20');
    scoped.set('volume', '21');
    assert.equal(s.data.get('volume@b'), '21');
    active = null;
    scoped.set('volume', 'legacy');
    assert.equal(s.data.get('volume'), 'legacy');
  });

  it('первое чтение копирует legacy, а следующие чтения уже берут собственную копию', () => {
    // Ловит повторную миграцию, которая перетёрла бы локальное решение изменившимся общим ключом.
    const s = memory({ setting: 'old' });
    const scoped = createScopedStorage({ activeInstanceId: () => 'a', getItem: s.get, setItem: s.set });
    assert.equal(scoped.get('setting'), 'old');
    s.data.set('setting', 'new-legacy');
    assert.equal(scoped.get('setting'), 'old');
  });

  it('пустое собственное значение останавливает миграцию legacy', () => {
    // Ловит проверку truthy вместо null, которая возвращала бы удалённую человеком настройку.
    const s = memory({ setting: 'legacy', 'setting@a': '' });
    const scoped = createScopedStorage({ activeInstanceId: () => 'a', getItem: s.get, setItem: s.set });
    assert.equal(scoped.get('setting'), '');
  });

  it('два инстанса получают независимые копии общего значения и меняются отдельно', () => {
    // Ловит совместную запись после миграции, из-за которой настройки одного инстанса меняли другой.
    const s = memory({ setting: 'legacy' });
    let active: string | null = 'a';
    const scoped = createScopedStorage({ activeInstanceId: () => active, getItem: s.get, setItem: s.set });
    assert.equal(scoped.get('setting'), 'legacy');
    active = 'b';
    assert.equal(scoped.get('setting'), 'legacy');
    scoped.set('setting', 'only-b');
    active = 'a';
    assert.equal(scoped.get('setting'), 'legacy');
    assert.equal(s.data.get('setting@b'), 'only-b');
  });

  it('ошибка чтения хранилища превращается в отсутствие настройки', () => {
    // Ловит падение приложения, когда браузер запрещает доступ к данным сайта.
    const scoped = createScopedStorage({
      activeInstanceId: () => 'a',
      getItem: () => { throw new Error('denied'); },
      setItem: () => undefined,
    });
    assert.equal(scoped.get('setting'), null);
  });

  it('ошибка обычной записи выходит наружу, в отличие от миграционной копии', () => {
    // Ловит тихую потерю явного изменения настройки при переполненном storage.
    const scoped = createScopedStorage({
      activeInstanceId: () => 'a',
      getItem: (key) => (key === 'setting' ? 'legacy' : null),
      setItem: () => { throw new Error('quota'); },
    });
    assert.equal(scoped.get('setting'), 'legacy');
    assert.throws(() => scoped.set('setting', 'new'), /quota/);
  });
});
