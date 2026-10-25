import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as original from './gatewaySubs';

type Rules = typeof original;
const source = readFileSync(new URL('./gatewaySubs.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string): Rules {
  const module = { exports: {} as Rules };
  // Полный чистый модуль, не извлечённое тело функции; импорты здесь не разрешены вовсе.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports,
    require: (id: string) => assert.fail(`неописанная граница gatewaySubs ${id}`),
  });
  return module.exports;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function wanted(r: Rules) {
  const state = r.newSubsState();
  r.wantSub(state, 'server-a');
  r.onReady(state);
  return state;
}
function delays(r = original) {
  const s = wanted(r);
  for (const expected of [2000, 4000, 8000, 16000, 30000]) {
    const retry = r.onSubRejected(s, 'server-a', 'subscribe failed');
    assert.deepEqual(plain(retry), { delayMs: expected, gen: s.gen });
    assert.equal(s.sent.has('server-a'), false);
    assert.deepEqual(plain(r.onRetryDue(s, 'server-a', retry!.gen)), ['server-a']);
    assert.deepEqual(plain(r.onRetryDue(s, 'server-a', retry!.gen)), [], 'один срок не отправляет дубль');
  }
  assert.equal(s.retries.get('server-a'), 5, 'ровно пять повторов разрешены');
}
function ceiling(r = original) {
  const s = wanted(r);
  for (let n = 0; n < 5; n++) assert.notEqual(r.onSubRejected(s, 'server-a', 'subscribe failed'), null);
  assert.equal(r.onSubRejected(s, 'server-a', 'subscribe failed'), null, 'R264 потолок: шестой отказ не назначает повтор');
  assert.equal(s.retries.get('server-a'), 5);
  assert.equal(s.want.has('server-a'), true, 'после потолка сервер восстановится на ready');
  r.wantSub(s, 'server-b');
  assert.equal(r.onSubRejected(s, 'server-b', 'subscribe failed')?.delayMs, 2000, 'потолок считается отдельно для сервера');
}
function finalReason(r = original) {
  const s = wanted(r);
  assert.equal(r.onSubRejected(s, 'server-a', 'not a member'), null, 'R264 окончательный отказ: без таймера');
  assert.equal(s.retries.size, 0);
  assert.equal(s.sent.has('server-a'), false);
  assert.equal(s.want.has('server-a'), true);
  assert.deepEqual(plain(r.onReady(s)), ['server-a'], 'ready всё-таки проверяет членство заново');
}
function generation(r = original) {
  for (const transition of ['disconnect', 'ready'] as const) {
    const s = wanted(r);
    const old = r.onSubRejected(s, 'server-a', 'subscribe failed')!;
    if (transition === 'disconnect') { r.onDisconnect(s); r.onReady(s); }
    else r.onReady(s);
    // Свежий отказ снимает sent: без него старый таймер маскировался бы проверкой sent.has.
    const fresh = r.onSubRejected(s, 'server-a', 'subscribe failed')!;
    assert.notEqual(old.gen, fresh.gen);
    assert.deepEqual(plain(r.onRetryDue(s, 'server-a', old.gen)), [], 'R264 поколение: старый таймер не крадёт свежую попытку');
    assert.equal(s.sent.has('server-a'), false);
    assert.deepEqual(plain(r.onRetryDue(s, 'server-a', fresh.gen)), ['server-a']);
  }
}
function readyReset(r = original) {
  const s = wanted(r);
  for (let n = 0; n < 5; n++) r.onSubRejected(s, 'server-a', 'subscribe failed');
  r.onReady(s);
  assert.equal(r.onSubRejected(s, 'server-a', 'subscribe failed')?.delayMs, 2000,
    'R264 ready: новый ready возвращает первую отсрочку после исчерпания потолка');
  assert.equal(s.retries.get('server-a'), 1);
}

// Класс ошибки: пропущенная ступень backoff или шестой запрос превращает отказ в шторм.
it('R264 временные отказы проходят ровно 2/4/8/16/30 секунд и каждый срок отправляет один subscribe', () => delays());
it('R264 пятая попытка разрешена, шестая запрещена, другой сервер имеет собственный лимит', () => ceiling());
// Класс ошибки: окончательный отказ повторяется бесконечно, а временный ошибочно глушится навсегда.
it('R264 not a member не назначает повтор, но сохраняет желание для следующего ready', () => finalReason());
for (const reason of ['identify first', 'subscribe failed', 'future-server-error', undefined]) {
  it(`R264 временная причина «${reason ?? 'без причины'}» назначает первую попытку`, () => {
    const s = wanted(original);
    assert.deepEqual(original.onSubRejected(s, 'server-a', reason), { delayMs: 2000, gen: s.gen });
  });
}
// Класс ошибки: отказ постороннего сервера или ранний кадр создаёт ненужные таймеры.
it('R264 отказ ненужного сервера и отказ до ready возвращают null, готовый нужный сервер принимается', () => {
  const s = original.newSubsState(); original.wantSub(s, 'server-a');
  assert.equal(original.onSubRejected(s, 'server-a', 'subscribe failed'), null);
  assert.equal(s.retries.size, 0);
  original.onReady(s);
  assert.equal(original.onSubRejected(s, 'stranger', 'subscribe failed'), null);
  assert.equal(s.retries.size, 0);
  assert.notEqual(original.onSubRejected(s, 'server-a', 'subscribe failed'), null);
});
// Класс ошибки: таймер с прошлого подключения повторяет подписку уже в новой сессии.
it('R264 старое поколение после обрыва и после ready не отправляется, свежее отправляется', () => generation());
it('R264 срок без ready, без желания и после выхода молчит, повтор после wantSub не задваивается', () => {
  const s = wanted(original); const retry = original.onSubRejected(s, 'server-a')!;
  assert.deepEqual(original.wantSub(s, 'server-a'), ['server-a']);
  assert.deepEqual(original.onRetryDue(s, 'server-a', retry.gen), []);
  original.onSubRejected(s, 'server-a'); s.want.delete('server-a');
  assert.deepEqual(original.onRetryDue(s, 'server-a', s.gen), []);
  s.want.add('server-a'); s.ready = false;
  assert.deepEqual(original.onRetryDue(s, 'server-a', s.gen), []);
  original.resetSubs(s);
  assert.deepEqual(original.onRetryDue(s, 'server-a', retry.gen), []);
  assert.equal(s.retries.size, 0);
});
// Класс ошибки: исчерпанный счётчик переживает ready или обрыв и оставляет стабильный сокет глухим.
it('R264 ready сбрасывает исчерпанный счётчик без обязательного обрыва', () => readyReset());
it('R264 обрыв очищает счётчики сразу, следующее соединение начинает с двух секунд', () => {
  const s = wanted(original); original.onSubRejected(s, 'server-a');
  original.onDisconnect(s); assert.equal(s.retries.size, 0);
  assert.equal(original.onSubRejected(s, 'server-a'), null);
  original.onReady(s);
  assert.equal(original.onSubRejected(s, 'server-a')?.delayMs, 2000);
});

for (const [name, anchor, replacement, probe, marker] of [
  ['поколение забыто', 'gen !== s.gen || ', '', generation, 'R264 поколение:'],
  ['потолок убран', 'if (done >= SUB_RETRY_DELAYS_MS.length) return null;', '', ceiling, 'R264 потолок:'],
  ['окончательный отказ забыт', 'if (reason !== undefined && FINAL_REJECT_REASONS.has(reason)) return null;', '', finalReason, 'R264 окончательный отказ:'],
  ['ready не очищает счётчик', 's.gen++;\n  s.retries.clear();\n  s.sent = new Set(s.want);', 's.gen++;\n  s.sent = new Set(s.want);', readyReset, 'R264 ready:'],
] as const) {
  // Класс ошибки: тест выглядит полезным, но регрессия в реальном исходнике его не меняет.
  it(`R264 исходниковый мутант «${name}» пойман адресным AssertionError после original-first`, () => {
    probe(load(source));
    assert.equal(source.split(anchor).length - 1, 1, 'якорь мутации уникален');
    const mutated = source.replace(anchor, replacement); assert.notEqual(mutated, source);
    assert.throws(() => probe(load(mutated)),
      e => e instanceof assert.AssertionError && e.message.startsWith(marker));
  });
}
