import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  newSubsState,
  onDisconnect,
  onReady,
  onSubRejected,
  resetSubs,
  wantSub,
} from './gatewaySubs.js';

describe('подписки гейтвея', () => {
  it('до ready не отправляется НИЧЕГО', () => {
    // Ловит исходный баг: subscribe уезжал вплотную за identify, сервер отвечал «identify first»,
    // и человек молча оставался без всех серверных событий до перезапуска приложения.
    const s = newSubsState();
    assert.deepEqual(wantSub(s, 'a'), []);
    assert.deepEqual(wantSub(s, 'b'), []);
    assert.equal(s.want.size, 2, 'но само желание запомнено');
    assert.equal(s.sent.size, 0);
  });

  it('ready отправляет весь накопленный список', () => {
    const s = newSubsState();
    wantSub(s, 'a');
    wantSub(s, 'b');
    assert.deepEqual(onReady(s).sort(), ['a', 'b']);
  });

  it('после ready подписка уходит сразу', () => {
    const s = newSubsState();
    onReady(s);
    assert.deepEqual(wantSub(s, 'a'), ['a']);
  });

  it('повторное желание того же сервера не шлёт дубль', () => {
    const s = newSubsState();
    onReady(s);
    assert.deepEqual(wantSub(s, 'a'), ['a']);
    assert.deepEqual(wantSub(s, 'a'), []);
  });

  it('🔴 переподключение шлёт ВЕСЬ список заново', () => {
    // Ловит вторую половину бага: множество «уже подписан» переживало обрыв, и после переподключения
    // клиент не слал ничего, считая себя подписанным на соединении, которого больше нет.
    const s = newSubsState();
    onReady(s);
    wantSub(s, 'a');
    wantSub(s, 'b');
    onDisconnect(s);
    assert.equal(s.ready, false);
    assert.deepEqual(onReady(s).sort(), ['a', 'b']);
  });

  it('во время обрыва желание копится и уезжает на ready', () => {
    const s = newSubsState();
    onReady(s);
    onDisconnect(s);
    assert.deepEqual(wantSub(s, 'c'), [], 'слать некуда — сокет мёртв');
    assert.deepEqual(onReady(s), ['c']);
  });

  it('🔴 отказ сервера НЕ глушит сервер навсегда', () => {
    // Ловит третью дыру: один отказ («identify first», перезапуск базы) помечался как успех, и
    // повторной попытки не случалось никогда.
    const s = newSubsState();
    onReady(s);
    wantSub(s, 'a');
    onSubRejected(s, 'a');
    assert.equal(s.want.has('a'), true, 'из желаемого не выбывает — отказ бывает временным');
    assert.deepEqual(wantSub(s, 'a'), ['a'], 'и повторяется при первой возможности');
  });

  it('после отказа следующий ready автоматически повторяет подписку', () => {
    // Ловит разрыв между сохранённым want и единственным автоматическим retry после reconnect.
    const s = newSubsState();
    onReady(s);
    wantSub(s, 'a');
    onSubRejected(s, 'a');
    assert.deepEqual(onReady(s), ['a']);
  });

  it('отказ по неизвестному серверу ничего не ломает', () => {
    const s = newSubsState();
    onReady(s);
    assert.doesNotThrow(() => onSubRejected(s, 'нет такого'));
  });

  it('выход из аккаунта забывает всё', () => {
    // Иначе следующий вход подписался бы на серверы ПРЕДЫДУЩЕГО пользователя.
    const s = newSubsState();
    onReady(s);
    wantSub(s, 'a');
    resetSubs(s);
    assert.equal(s.want.size, 0);
    assert.equal(s.ready, false);
    assert.deepEqual(onReady(s), []);
  });
});
