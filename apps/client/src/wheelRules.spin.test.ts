import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import { load, normal, edited, sourceOf, type Edit } from './predictions.harness';

function paired(source: string, check: (raw: string) => void, edits: readonly Edit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
      const mutant = edited(source, edit);
      assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
        'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}

type Rules = typeof import('./wheelRules');
const source = sourceOf('./wheelRules.ts');
const P = 'R354/wheel-rules/';
const rules = (raw = source) => load<Rules>(raw, { '@gusvoice/shared': shared });
const bet = (userId: string, pick: shared.WheelPick = 1): shared.WheelBetDto => ({ userId, pick, amount: 10 });

// Прореживание не должно превращать трещотку в очередь опоздавших щелчков.
test('R354 щелчки стоят на настоящих границах и разделены хотя бы 70 мс', () => paired(source, raw => {
  const r = rules(raw);
  assert.equal(r.WHEEL_TICK_MIN_GAP_MS, 70, P + 'tick-gap/contract');
  const times = r.tickTimes(0, r.spinTarget(0, 4, 5), 6_000);
  assert.ok(times.some((t, i) => i > 0 && t - times[i - 1] < 70), P + 'tick-gap/fixture-is-dense');
  const plan = r.wheelTickPlan(times, 6_000);
  assert.ok(plan.length > 2 && plan.length < times.length, P + 'tick-gap/pruned-not-silenced');
  assert.ok(plan.every((t, i) => i === 0 || t - plan[i - 1] >= 70), P + 'tick-gap/minimum');
  assert.ok(plan.slice(0, -1).every(t => times.includes(t)), P + 'tick-gap/no-shift');
}, [['t - prev < gapMs', 'false']], P + 'tick-gap/'));

// Последний щелчок — отдельная остановка, а не случайно ближайшая граница.
test('R354 остановка всегда получает отдельный щелчок с округлением длины', () => paired(source, raw => {
  const r = rules(raw);
  assert.deepEqual(normal(r.wheelTickPlan([], 600.6)), [601], P + 'tick-stop/empty-boundaries');
  assert.deepEqual(normal(r.wheelTickPlan([0, 70, 140], 601.4)), [0, 70, 140, 601], P + 'tick-stop/last');
}, [['out.push(Math.round(durationMs));', '/* мутант: остановка потеряна */']], P + 'tick-stop/'));

// Граница за 69 мс уступает остановке; за ровно 70 мс ещё остаётся.
test('R354 последняя граница ближе порога выбрасывается, ровно порог сохраняется', () => paired(source, raw => {
  const r = rules(raw);
  assert.deepEqual(normal(r.wheelTickPlan([-1, 0, 530, 531, 599, 600], 600)), [0, 530, 600], P + 'tick-end/gap-boundary');
  assert.deepEqual(normal(r.wheelTickPlan([0, 100, 150, 399, 400], 500, 100)), [0, 100, 399, 500], P + 'tick-end/custom-gap');
}, [['durationMs - t < gapMs', 'false']], P + 'tick-end/'));

// Негодная длина не заводит даже одиночный щелчок «остановки».
test('R354 нулевая, отрицательная и NaN длины молчат, положительная работает', () => {
  const r = rules();
  for (const duration of [0, -1, Number.NaN]) assert.deepEqual(normal(r.wheelTickPlan([0, 70], duration)), [], P + 'tick-duration/rejected');
  assert.deepEqual(normal(r.wheelTickPlan([0, 1], 1)), [1], P + 'tick-duration/one-ms');
});

// На самой границе старый transition уже обязан уступить конечному углу.
test('R354 вращение завершено ровно на длине, миллисекунда до неё ещё анимируется', () => paired(source, raw => {
  const r = rules(raw);
  assert.deepEqual(normal(r.spinProgress(5_999, 6_000)), { done: false, atMs: 5_999 }, P + 'progress/before');
  assert.deepEqual(normal(r.spinProgress(6_000, 6_000)), { done: true }, P + 'progress/at-end');
  assert.deepEqual(normal(r.spinProgress(6_001, 6_000)), { done: true }, P + 'progress/after');
}, [['!(elapsedMs < durationMs)', '!(elapsedMs <= durationMs)']], P + 'progress/'));

// Сдвиг часов назад прижимает время, отсутствие длины не оставляет вечную анимацию.
test('R354 отрицательное прошедшее время прижимается к нулю, негодная длина завершает', () => {
  const r = rules();
  assert.deepEqual(normal(r.spinProgress(-100, 6_000)), { done: false, atMs: 0 }, P + 'progress-negative/clamp');
  assert.deepEqual(normal(r.spinProgress(0, 6_000)), { done: false, atMs: 0 }, P + 'progress-negative/start');
  for (const duration of [0, -1, Number.NaN]) assert.deepEqual(normal(r.spinProgress(0, duration)), { done: true }, P + 'progress-negative/invalid-duration');
});

// Управление экономикой само по себе не даёт доступ к административной проверке зерна.
test('R354 честность видна владельцу и администратору, но не одному MANAGE_ECONOMY', () => {
  const r = rules();
  assert.equal(r.wheelFairVisible('me', 'me', null), true, P + 'fair/owner');
  assert.equal(r.wheelFairVisible('me', 'other', shared.Permission.ADMINISTRATOR), true, P + 'fair/admin');
  assert.equal(r.wheelFairVisible('me', 'other', shared.Permission.MANAGE_ECONOMY), false, P + 'fair/economy-only');
  assert.equal(r.wheelFairVisible('me', 'other', 0n), false, P + 'fair/member');
  assert.equal(r.wheelFairVisible('me', 'other', null), false, P + 'fair/unknown-server');
  assert.equal(r.wheelFairVisible(null, 'me', shared.Permission.ADMINISTRATOR), false, P + 'fair/no-user');
  assert.equal(r.wheelFairVisible(null, null, null), false, P + 'fair/empty');
});

// Крутить досрочно нельзя зрителю, после нуля или уже заблокированному раунду.
test('R354 крутить сейчас может только поставивший в открытом раунде с остатком времени', () => {
  const r = rules();
  const round = { state: 'open', bets: [bet('me')] };
  assert.equal(r.canSpinNow(round, 'me', 1), true, P + 'spin-now/one-ms');
  assert.equal(r.canSpinNow(round, 'me', 30_000), true, P + 'spin-now/open');
  for (const time of [0, -1, null, Number.NaN]) assert.equal(r.canSpinNow(round, 'me', time), false, P + 'spin-now/no-time');
  assert.equal(r.canSpinNow(round, 'other', 1), false, P + 'spin-now/no-bet');
  assert.equal(r.canSpinNow(round, null, 1), false, P + 'spin-now/no-user');
  assert.equal(r.canSpinNow(null, 'me', 1), false, P + 'spin-now/no-round');
  for (const state of ['locked', 'settled', 'cancelled']) assert.equal(r.canSpinNow({ ...round, state }, 'me', 1), false, P + 'spin-now/not-open');
});

// Один человек в нескольких каналах/нескольких ставках не размножает предупреждение.
test('R354 предупреждение не включает себя, поставивших и повторные identity', () => {
  const r = rules();
  assert.deepEqual(normal(r.unbetVoiceUsers(['me', 'first', 'paid', 'first', 'second', 'paid'], [bet('paid'), bet('paid', 3)], 'me')),
    ['first', 'second'], P + 'unbet/order-and-dedup');
  assert.deepEqual(normal(r.unbetVoiceUsers([], [], 'me')), [], P + 'unbet/empty');
  assert.deepEqual(normal(r.unbetVoiceUsers(['guest'], [], null)), ['guest'], P + 'unbet/no-user');
});

// Новая вкладка должна спросить заново, запрет не должен приживаться в localStorage.
test('R354 запоминание подтверждения живёт только в экземпляре модуля, не в хранилище', () => {
  const first = rules();
  assert.equal(first.spinNowAsked(), false, P + 'asked/initial');
  first.markSpinNowAsked();
  first.markSpinNowAsked();
  assert.equal(first.spinNowAsked(), true, P + 'asked/sticky-in-session');
  assert.equal(rules().spinNowAsked(), false, P + 'asked/new-instance');
  const file = ts.createSourceFile('wheelRules.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = file.statements.filter(n => ts.isFunctionDeclaration(n) && (n.name?.text === 'spinNowAsked' || n.name?.text === 'markSpinNowAsked'));
  assert.equal(declarations.length, 2, P + 'asked/functions-present');
  const forbidden: string[] = [];
  const visit = (n: ts.Node) => { if (ts.isIdentifier(n) && ['localStorage', 'sessionStorage', 'indexedDB'].includes(n.text)) forbidden.push(n.text); ts.forEachChild(n, visit); };
  // Весь модуль правил остаётся чистым: сериализация флага в соседнем helper тоже запрещена.
  visit(file);
  assert.deepEqual(forbidden, [], P + 'asked/no-storage');
});
