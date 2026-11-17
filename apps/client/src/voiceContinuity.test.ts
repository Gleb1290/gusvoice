import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createVoiceContinuity } from './voiceContinuity';
import { REJOIN_WINDOW_MS } from './voiceCueRules';

function fixture(enabled = true) {
  let now = 1_000_000;
  const calls: string[] = [];
  const room = createVoiceContinuity({ now: () => now, enabled,
    touch: () => calls.push('touch'), expire: () => calls.push('disconnect') });
  return { room, calls, advance: (ms: number) => { now += ms; }, setTime: (value: number) => { now = value; } };
}

it('первый heartbeat после ночного сна отключает комнату до обновления сохранённой сессии', () => {
  const f = fixture();
  f.advance(12 * 60 * 60_000);
  assert.equal(f.room.heartbeat(), false);
  assert.deepEqual(f.calls, ['disconnect']);
  assert.equal(f.room.check(), false);
  assert.equal(f.room.heartbeat(), false);
  assert.deepEqual(f.calls, ['disconnect']);
});

it('первый callback SDK после долгого сна не разрешает восстановление, последующий heartbeat тоже отклонён', () => {
  const f = fixture();
  f.advance(REJOIN_WINDOW_MS + 1);
  assert.equal(f.room.check(), false);
  assert.equal(f.room.heartbeat(), false);
  assert.deepEqual(f.calls, ['disconnect']);
});

it('живой разговор не обрывается через пять минут: heartbeat подтверждает непрерывность', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    f.advance(4_000);
    assert.equal(f.room.heartbeat(), true);
  }
  assert.equal(f.calls.filter(x => x === 'touch').length, 100);
  assert.equal(f.calls.includes('disconnect'), false);
});

it('короткий обрыв допускает ровно пять минут, проверка без heartbeat не продлевает этот срок', () => {
  const boundary = fixture();
  boundary.advance(REJOIN_WINDOW_MS);
  assert.equal(boundary.room.heartbeat(), true);
  assert.deepEqual(boundary.calls, ['touch']);
  const overdue = fixture();
  overdue.advance(REJOIN_WINDOW_MS - 1);
  assert.equal(overdue.room.check(), true);
  overdue.advance(2);
  assert.equal(overdue.room.check(), false);
  assert.deepEqual(overdue.calls, ['disconnect']);
});

it('обратный или некорректный ход часов не разрешает продлевать голос, истёкшая комната не оживает', () => {
  for (const time of [999_999, Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = fixture();
    f.setTime(time);
    assert.equal(f.room.heartbeat(), false);
    f.setTime(1_000_000);
    assert.equal(f.room.heartbeat(), false);
    assert.deepEqual(f.calls, ['disconnect']);
  }
});

it('у мобильного фонового голоса пауза таймеров страницы не становится выходом из живой комнаты', () => {
  const f = fixture(false);
  f.advance(12 * 60 * 60_000);
  assert.equal(f.room.check(), true);
  assert.equal(f.room.heartbeat(), true);
  assert.deepEqual(f.calls, ['touch']);
});
