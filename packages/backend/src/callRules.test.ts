import assert from 'node:assert/strict';
import { it } from 'node:test';
import { callAllowed, callDurationSec, callRecordPlan, callRoomName, callTransition, inCall, normalizeCallPrivacy, orphanCallEnd, silentParticipant } from './callRules.js';
import { channelFromRoom } from '../../shared/src/ws.js';
import type { DmCall } from '@gusvoice/shared';

const call = (phase: DmCall['phase'] = 'ringing') => ({ phase, callerId: 'a', calleeId: 'b' });

it('звонящий не может ответить сам, а отмена, отклонение и разговор имеют разные исходы', () => {
  // Если перепутать missed и busy, получатели увидят ложный пропущенный звонок или не получат настоящий.
  assert.deepEqual(callTransition(call(), 'a', 'answer'), { kind: 'forbidden' });
  assert.deepEqual(callTransition(call(), 'b', 'answer'), { kind: 'answer' });
  assert.deepEqual(callTransition(call(), 'a', 'hangup'), { kind: 'end', reason: 'missed' });
  assert.deepEqual(callTransition(call(), 'b', 'hangup'), { kind: 'end', reason: 'busy' });
  assert.deepEqual(callTransition(call(), 'b', 'decline'), { kind: 'end', reason: 'busy' });
  assert.deepEqual(callTransition(call('active'), 'a', 'hangup'), { kind: 'end', reason: 'hangup' });
  assert.deepEqual(callTransition(call('active'), null, 'drop'), { kind: 'end', reason: 'disconnect' });
  assert.deepEqual(callTransition(call('ended'), 'b', 'answer'), { kind: 'gone' });
  assert.deepEqual(callTransition(call(), 'stranger', 'decline'), { kind: 'forbidden' });
  const source = callTransition.toString();
  const swapped = source.replace('isCaller?"missed":"busy"', 'isCaller?"busy":"missed"');
  // nosemgrep: gv-no-eval — тест исполняет свой callTransition.toString() с фиксированной заменой; чужого ввода нет.
  const mutant = (new Function(`return (${swapped})`)()) as typeof callTransition; // nosemgrep: gv-no-eval
  assert.throws(() => assert.deepEqual(mutant(call(), 'a', 'hangup'), { kind: 'end', reason: 'missed' }), assert.AssertionError);
});

it('пропущенный звонок уведомляет, остальные записи тихие и уже прочитаны', () => {
  assert.deepEqual(callRecordPlan('missed'), { notify: true, silent: false, markRead: false });
  for (const reason of ['busy', 'hangup', 'disconnect'] as const) {
    assert.deepEqual(callRecordPlan(reason), { notify: false, silent: true, markRead: true });
  }
  assert.equal(callDurationSec(undefined, 50_000), 0);
  assert.equal(callDurationSec('2026-10-08T12:00:00.999Z', Date.parse('2026-10-08T12:00:02.000Z')), 1);
  assert.equal(callDurationSec('bad date', 50_000), 0);
  assert.equal(callDurationSec('2026-10-08T12:00:01Z', Date.parse('2026-10-08T12:00:00Z')), 0);
});

it('проверка тишины звонка включает точную границу и закрытый звонок не занимает линию', () => {
  // На самой границе ping ещё жив; после неё сервер должен завершить звонок, иначе зависнет занятая линия.
  const ringing = call();
  assert.equal(silentParticipant(ringing, { caller: 55, callee: 0 }, 100, 45), null);
  assert.equal(silentParticipant(ringing, { caller: 54, callee: 0 }, 100, 45), 'a');
  const active = call('active');
  assert.equal(silentParticipant(active, { caller: 100, callee: 54 }, 100, 45), 'b');
  assert.equal(silentParticipant(ringing, { caller: 100, callee: 0 }, 100, 45), null, 'до ответа stale heartbeat вызываемого не завершает звонок');
  assert.equal(silentParticipant(active, { caller: 55, callee: 55 }, 100, 45), null, 'ровно на границе оба участника ещё активны');
  assert.equal(silentParticipant(active, { caller: 0, callee: 0 }, 100, 45), 'a', 'если пропали оба, первым выбирается звонящий');
  assert.equal(silentParticipant(call('ended'), { caller: 0, callee: 0 }, 100, 45), null);
  assert.equal(inCall([ringing, active, call('ended')], 'b'), true);
  assert.equal(inCall([call('ended')], 'b'), false);
  assert.equal(inCall([call('active')], 'stranger'), false, 'занята только линия участника звонка');
  assert.equal(inCall([{ ...call('ended'), callerId: 'b', calleeId: 'b' }], 'b'), false, 'закрытая запись не занимает линию');
  assert.deepEqual(orphanCallEnd({ phase: 'active', answeredAt: '2026-10-08T12:00:00Z' }, Date.parse('2026-10-08T12:00:10Z')), { reason: 'disconnect', duration: 10 },
    'после рестарта длительность заканчивается на последнем ping, а не на времени запуска нового процесса');
  assert.deepEqual(orphanCallEnd({ phase: 'ringing', answeredAt: undefined }, 1), { reason: 'missed', duration: 0 });
});

it('комната звонка не попадает в voice-channel presence и постороннему линия свободна', () => {
  // Политика звонков — полный набор правила × соседство × исключение; «никогда» важнее «всегда».
  for (const privacy of ['everyone', 'peers', 'nobody'] as const) for (const peer of [false, true]) {
    assert.equal(callAllowed(privacy, peer), privacy === 'everyone' || (privacy === 'peers' && peer));
    assert.equal(callAllowed(privacy, peer, 'always'), true);
    assert.equal(callAllowed(privacy, peer, 'never'), false);
  }
  for (const value of ['everyone', 'peers', 'nobody']) assert.equal(normalizeCallPrivacy(value), value);
  for (const value of [null, 'invalid', 1]) assert.equal(normalizeCallPrivacy(value), 'everyone');
  const room = callRoomName('call-123');
  assert.equal(room, 'dmcall_call-123');
  assert.equal(channelFromRoom(room), null, 'иначе presence примет звонок за голосовой канал сервера');
  assert.equal(inCall([call('active')], 'c'), false);
});
