import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadMuteRecent, saveMuteRecent } from './muteRecent';

function withStorage(run: (values: Map<string, string>) => void, blocked = false) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key: string) { if (blocked) throw new Error('хранилище закрыто'); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw new Error('хранилище закрыто'); values.set(key, value); },
  } });
  try { run(values); }
  finally {
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

it('R125 запомненные пятнадцать минут и три месяца читаются после сокращения пресетов', () => {
  // Старый короткий и длинный срок не пропадают из подменю только из-за нового набора выбора.
  withStorage(values => {
    values.set('gv.mute.recent', JSON.stringify([93 * 86400, 900, 900, '3600', 901]));
    assert.deepEqual(loadMuteRecent(), [900, 93 * 86400]);
    saveMuteRecent(3600);
    assert.deepEqual(loadMuteRecent(), [3600, 93 * 86400], 'сохраняются новый и наибольший прежний');
  });
});

it('R125 мусор в запомненных сроках и недоступное хранилище не блокируют меню', () => {
  // Повреждение localStorage не должно падением закрывать доступ к заглушке беседы.
  withStorage(values => {
    assert.deepEqual(loadMuteRecent(), []);
    for (const raw of ['{', '{}', 'null', '[null,false,-1,0,901,"900"]']) {
      values.set('gv.mute.recent', raw);
      assert.deepEqual(loadMuteRecent(), []);
    }
  });
  withStorage(() => {
    assert.deepEqual(loadMuteRecent(), []);
    assert.doesNotThrow(() => saveMuteRecent(3600));
  }, true);
});
