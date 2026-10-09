import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as production from './uploadGate.js';

const MiB = 1024 * 1024;
type Timer = { run(): void; at: number; unref(): void };

// Загружаем целый чистый модуль: ручные часы заменяют только таймеры, не логику держателей билета.
function fixture(change?: [string, string]) {
  let now = 0;
  const timers = new Set<Timer>();
  const raw = readFileSync(new URL('./uploadGate.ts', import.meta.url), 'utf8');
  const source = change ? raw.replace(change[0], change[1]) : raw;
  if (change) assert.notEqual(source, raw, 'мутант меняет действующее правило');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports,
      setTimeout(run: () => void, delay: number) { const timer = { run, at: now + delay, unref() {} }; timers.add(timer); return timer; },
      clearTimeout(timer: Timer) { timers.delete(timer); },
    });
  return { api: module.exports as typeof production, timers,
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.run(); }
    },
  };
}

function ticket(gate: production.UploadGate, user: string, bytes: number): production.GateTicket {
  const result = gate.acquire(user, bytes);
  assert.ok(!('code' in result), 'билет в пределах квоты выдан');
  return result;
}
function usage(gate: production.UploadGate, user: string) { return { ...gate.usage(user) }; }
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('R131 пределы памяти задают четыре куска человека, 256 МиБ процесса и пять минут зависшей операции', () => {
  // Смена констант без согласования с клиентским параллелизмом или размером буфера незаметно меняет защиту памяти.
  assert.equal(production.UPLOAD_GATE_PER_USER, 4);
  assert.equal(production.UPLOAD_GATE_TOTAL_BYTES, 256 * MiB);
  assert.equal(production.UPLOAD_GATE_HOLD_CAP_MS, 5 * 60_000);
});

it('R131 четыре билета проходят, пятый получает 429 с Retry-After, освобождённое место снова доступно', () => {
  // Ловит границу на один кусок и смешивание персональной квоты с чужими загрузками.
  const check = (api: typeof production) => {
    const gate = api.createUploadGate();
    const held = Array.from({ length: 4 }, () => ticket(gate, 'u', 8 * MiB));
    const refusal = gate.acquire('u', 1);
    assert.ok('code' in refusal);
    assert.equal(refusal.code, 429); assert.ok(refusal.retryAfter > 0); assert.ok(refusal.error.length > 0);
    assert.deepEqual(usage(gate, 'u'), { bytes: 32 * MiB, mine: 4 });
    const other = ticket(gate, 'other', 1);
    assert.equal(gate.usage('other').mine, 1);
    held[0]!.release();
    const replacement = ticket(gate, 'u', 8 * MiB);
    held.forEach(t => t.release()); replacement.release(); other.release();
    assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
  };
  check(production);
  assert.throws(() => check(fixture(['mine >= perUser', 'mine > perUser']).api), assert.AssertionError);
});

it('R131 ровно 256 МиБ разрешены, лишний байт получает 503, release возвращает байты в бюджет', () => {
  // После заполнения/опустошения процесс должен принимать новые куски, а не навсегда остаться «занят».
  const check = (api: typeof production) => {
    const gate = api.createUploadGate();
    const held = Array.from({ length: 32 }, (_, i) => ticket(gate, `u-${i}`, 8 * MiB));
    assert.equal(gate.usage().bytes, 256 * MiB);
    const refusal = gate.acquire('next', 1);
    assert.ok('code' in refusal);
    assert.equal(refusal.code, 503); assert.ok(refusal.retryAfter > 0); assert.ok(refusal.error.length > 0);
    assert.equal(gate.usage('next').mine, 0, 'отказ не занимает персональное место');
    held[0]!.release();
    assert.equal(gate.usage().bytes, 248 * MiB);
    const replacement = ticket(gate, 'next', 8 * MiB);
    assert.equal(gate.usage().bytes, 256 * MiB);
    held.forEach(t => t.release()); replacement.release();
    assert.equal(gate.usage().bytes, 0);
  };
  check(production);
  assert.throws(() => check(fixture(['inFlight -= bytes;', '']).api), assert.AssertionError);
});

it('R131 release ждёт конец track, двойной release не освобождает операцию хранилища', async () => {
  // Тайм-аут ответа не освобождает буфер, который ещё держит S3, повтор закрытия не обходит этот счётчик.
  const check = async (f: ReturnType<typeof fixture>) => {
    const gate = f.api.createUploadGate(); const t = ticket(gate, 'u', 8 * MiB); const pending = deferred();
    assert.equal(t.track(pending.promise), pending.promise, 'track возвращает исходный результат');
    t.release(); t.release();
    assert.deepEqual(usage(gate, 'u'), { bytes: 8 * MiB, mine: 1 });
    pending.resolve('готово'); await pending.promise;
    assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
    assert.equal(f.timers.size, 0);
  };
  await check(fixture());
  await assert.rejects(() => check(fixture(['if (responded) return;', ''])), assert.AssertionError);
  await assert.rejects(() => check(fixture(['          holders++;', ''])), assert.AssertionError);
});

it('R131 новый track после закрытия ответа держит уже занятый билет до окончания последней операции', async () => {
  // Операции, добавленные после ответа при ещё живом билете, не должны отпустить память вместе с первой завершённой.
  const f = fixture(); const gate = f.api.createUploadGate(); const t = ticket(gate, 'u', 100);
  const first = deferred(); const second = deferred();
  t.track(first.promise); t.release(); assert.equal(t.track(second.promise), second.promise);
  first.resolve('первый'); await first.promise;
  assert.deepEqual(usage(gate, 'u'), { bytes: 100, mine: 1 });
  second.resolve('второй'); await second.promise;
  assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
  const late = deferred(); assert.equal(t.track(late.promise), late.promise);
  assert.equal(f.timers.size, 0, 'полностью освобождённый билет не открывается заново');
  late.resolve('после освобождения'); await late.promise;
  assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
});

it('R131 отказ track отпускает своего держателя, но живой ответ остаётся до release', async () => {
  // Отказ хранилища должен освободить слот после ответа, не утечь и не съесть билет другой загрузки.
  const f = fixture(); const gate = f.api.createUploadGate(); const t = ticket(gate, 'u', 100); const p = deferred();
  t.track(p.promise); p.reject(new Error('сбой копирования'));
  await assert.rejects(p.promise, /сбой копирования/);
  assert.deepEqual(usage(gate, 'u'), { bytes: 100, mine: 1 });
  assert.equal(f.timers.size, 0);
  t.release();
  assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
});

it('R131 предел holdCapMs освобождает зависший track ровно на границе, поздний успех не вычитает дважды', async () => {
  // Неответившее хранилище не должно навсегда закрыть загрузки, а поздний callback — сделать бюджет отрицательным.
  const f = fixture(); const gate = f.api.createUploadGate(1, 100, 20);
  const t = ticket(gate, 'u', 100); const p = deferred(); t.track(p.promise); t.release();
  f.advance(19);
  assert.deepEqual(usage(gate, 'u'), { bytes: 100, mine: 1 });
  f.advance(1);
  assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
  const next = ticket(gate, 'u', 100);
  p.resolve('поздно'); await p.promise; t.release(); f.advance(20);
  assert.deepEqual(usage(gate, 'u'), { bytes: 100, mine: 1 }, 'старое завершение не освобождает новый билет');
  next.release(); assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
});

it('R131 истечение track не закрывает ещё живой ответ; персональная квота важнее общей нехватки памяти', () => {
  // Таймер считает держателя хранилища, не подменяет release ответа и сохраняет осмысленный 429 человеку.
  const f = fixture(); const gate = f.api.createUploadGate(1, 100, 20); const t = ticket(gate, 'u', 100);
  t.track(new Promise(() => {})); f.advance(20);
  const mine = gate.acquire('u', 1); const other = gate.acquire('other', 1);
  assert.ok('code' in mine && 'code' in other);
  assert.equal(mine.code, 429); assert.equal(other.code, 503);
  assert.deepEqual(usage(gate, 'u'), { bytes: 100, mine: 1 });
  t.release(); assert.deepEqual(usage(gate, 'u'), { bytes: 0, mine: 0 });
});
