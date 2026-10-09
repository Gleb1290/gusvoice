import assert from 'node:assert/strict';
import { it } from 'node:test';
import { callDurationText, callServiceFallback, callServiceMark, callServiceText, callServiceTitle, isMissedCall } from './calls.js';

it('входящие и исходящие причины звонка имеют разные подписи и для видео', () => {
  // Ловит подмену отклонённого входящего отменённым исходящим.
  const reasons = ['missed', 'busy', 'hangup', 'disconnect'] as const;
  const incoming = ['Пропущенный', 'Отклонённый', 'Входящий', 'Входящий'];
  const outgoing = ['Отменённый', 'Исходящий', 'Исходящий', 'Исходящий'];
  reasons.forEach((reason, i) => {
    for (const video of [false, true]) {
      const noun = video ? 'видеозвонок' : 'звонок';
      assert.equal(callServiceTitle({ reason, video }, false), `${incoming[i]} ${noun}`);
      assert.equal(callServiceTitle({ reason, video }, true), `${outgoing[i]} ${noun}`);
      assert.equal(callServiceText({ reason, video, duration: 0 }, false), `${incoming[i]} ${noun}`);
      assert.equal(callServiceText({ reason, video, duration: 61 }, true), `${outgoing[i]} ${noun}, 1 мин`);
    }
    assert.equal(isMissedCall({ reason }), reason === 'missed');
  });
});

it('длительность проходит границы минуты и часа, отрицательная не показывается', () => {
  // Ловит лишнюю минуту и неверное округление у пограничной длительности.
  for (const [seconds, expected] of [[-1, '0 с'], [0, '0 с'], [59, '59 с'], [59.5, '1 мин'], [60, '1 мин'], [3599, '59 мин'], [3600, '1 ч'], [3900, '1 ч 5 мин']] as const) assert.equal(callDurationText(seconds), expected);
  assert.equal(callServiceText({ reason: 'hangup', duration: -1 }, false), 'Входящий звонок');
});

it('запасной текст старому клиенту нейтрален и различает видео', () => {
  // Ловит неверное «я звонил» у второго участника на старом клиенте.
  assert.equal(callServiceFallback({ reason: 'hangup', duration: 60 }), 'Звонок, 1 мин');
  assert.equal(callServiceFallback({ reason: 'disconnect', duration: 0, video: true }), 'Видеозвонок');
  assert.equal(callServiceFallback({ reason: 'missed', duration: 0, video: true }), 'Пропущенный видеозвонок');
  assert.equal(callServiceFallback({ reason: 'busy', duration: 0 }), 'Отклонённый звонок');
});

it('метка звонка принимает минимальный контракт, video=false не сериализуется', () => {
  // Ловит разрастание DTO ложными optional-полями и падение на чужом service.
  for (const service of [undefined, null, {}, { kind: 'other', reason: 'missed', callId: 'c' }, { kind: 'call', reason: 'missed' }]) assert.equal(callServiceMark({ service }), null);
  const mark = { kind: 'call', callId: 'c', reason: 'hangup' };
  assert.deepEqual(callServiceMark({ service: { ...mark, video: false } }), { ...mark, duration: 0 });
  assert.deepEqual(callServiceMark({ service: { ...mark, video: true, duration: 3 } }), { ...mark, duration: 3, video: true });
});
