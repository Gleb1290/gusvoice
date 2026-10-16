import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { FEATURE_CALLS1, FEATURE_CALLS2, type DmCall } from '@gusvoice/shared';
import * as rules from './callView';

function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./callView.ts', import.meta.url), 'utf8'); assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: () => ({ FEATURE_CALLS1: 'calls1', FEATURE_CALLS2: 'calls2', callDurationText: (s: number) => `${s} с` }) });
  return module.exports as typeof rules;
}

const ringing: DmCall = { id: 'c', conversationId: 'dm', callerId: 'a', calleeId: 'b', phase: 'ringing', createdAt: '', callerDevice: 'phone' };

it('каждое устройство видит только свою фазу звонка, чужое устройство не дублирует звонок', () => {
  assert.equal(rules.callViewFor(ringing, 'b', 'laptop'), 'incoming');
  assert.equal(rules.callViewFor(ringing, 'a', 'phone'), 'outgoing');
  assert.equal(rules.callViewFor(ringing, 'a', 'laptop'), 'elsewhere');
  assert.equal(rules.callViewFor({ ...ringing, phase: 'active', calleeDevice: 'laptop' }, 'b', 'laptop'), 'active');
  assert.equal(rules.callViewFor({ ...ringing, phase: 'active', calleeDevice: 'laptop' }, 'b', 'phone'), 'elsewhere');
  assert.equal(rules.callViewFor({ ...ringing, phase: 'ended' }, 'b', 'phone'), 'none');
  assert.equal(rules.callViewFor(ringing, 'stranger', 'phone'), 'none');
  const broken = mutant('return call.calleeDevice === device ? \'active\' : \'elsewhere\';', "return 'active';");
  assert.throws(() => assert.equal(broken.callViewFor({ ...ringing, phase: 'active', calleeDevice: 'tablet' }, 'b', 'phone'), 'elsewhere'), assert.AssertionError,
    'мутант включает микрофон на устройстве, которое не ответило');
});

it('счётчик не теряет часы, статус и времена превью, серверные функции требуют capability', () => {
  assert.equal(rules.callTimerText(0), '0:00'); assert.equal(rules.callTimerText(65_000), '1:05'); assert.equal(rules.callTimerText(3_723_000), '1:02:03');
  assert.equal(rules.callStatusText('active', { connected: false, elapsedMs: 9000 }), 'соединение…');
  assert.equal(rules.callStatusText('active', { connected: true, elapsedMs: 9000 }), '0:09');
  assert.equal(rules.callStatusText('incoming', { connected: false, elapsedMs: 0 }), 'звонит вам…');
  assert.equal(rules.callStatusText('none', { connected: false, elapsedMs: 0, ended: { reason: 'busy' } as DmCall }), 'звонок отклонён');
  assert.equal(rules.previewCorner(0, 0, 100, 100), 'tl'); assert.equal(rules.previewCorner(50, 50, 100, 100), 'br');
  assert.equal(rules.previewCorner(50, 49, 100, 100), 'tr'); assert.equal(rules.previewCorner(49, 50, 100, 100), 'bl');
  assert.equal(rules.callRecordStatus('12:30', 0), '12:30'); assert.equal(rules.callRecordStatus('12:30', 60), '12:30, 1 мин');
  assert.equal(rules.serverCalls([FEATURE_CALLS1]), true); assert.equal(rules.serverCalls([FEATURE_CALLS2]), false);
  assert.equal(rules.serverCallVideo([FEATURE_CALLS2]), true); assert.equal(rules.serverCallVideo(null), false);
});

it('отказ приватности объясняет запрет и подставляет нейтральное имя', () => {
  // Человек должен отличить запрет по настройкам от поломки связи, даже если имя не загрузилось.
  const named = rules.callPrivacyNotice('Алиса');
  assert.equal(named.title, 'Позвонить нельзя');
  assert.equal(named.body, 'Алиса не принимает звонки.');
  assert.equal(named.icon, 'ban');
  assert.equal(rules.callPrivacyNotice('  Алиса  ').body, named.body);
  for (const name of ['', '  ']) {
    assert.equal(rules.callPrivacyNotice(name).body, 'Собеседник не принимает звонки.');
    assert.equal(rules.callPrivacyNotice(name).icon, 'ban');
  }
});
