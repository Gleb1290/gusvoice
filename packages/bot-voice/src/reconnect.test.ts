import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './reconnect.js';
import type { VoiceStateUpdated } from '@gusvoice/bot';

for (const [reason, expected] of [
  ['CLIENT_INITIATED', 'ignore'], ['PARTICIPANT_REMOVED', 'kicked'], ['ROOM_DELETED', 'kicked'], ['DUPLICATE_IDENTITY', 'kicked'],
  [undefined, 'retry'], ['', 'retry'], ['SERVER_SHUTDOWN', 'retry'], ['SIGNAL_CLOSE', 'retry'], ['FUTURE_REASON', 'retry'],
] as const) {
  it(`R306 reconnect: ${reason ?? 'нет причины'} → ${expected}`, () => assert.equal(rules.classifyDisconnect(reason), expected));
}
it('R306 reconnect: ровно шесть пауз 1–2–4–8–16–30 секунд, затем повтора нет', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => rules.retryDelay(i)), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.equal(rules.MAX_RETRIES, 6);
  assert.equal(rules.retryDelay(-1), null);
  assert.equal(rules.retryDelay(6), null);
  assert.equal(rules.retryDelay(7), null);
  assert.equal(rules.MOVE_WAIT_MS, 3000);
});
for (const [error, expected] of [
  [{ code: 401 }, true], [{ code: 403 }, true], [{ code: 400 }, false], [{ code: 429 }, false], [{ code: 500 }, false],
  [{ code: '403' }, false], [new Error('403'), false], [null, false], [undefined, false], ['403', false],
] as const) {
  it(`R306 reconnect: ошибка ${JSON.stringify(error)} ${expected ? 'останавливает' : 'не запрещает'} повтор`, () => {
    assert.equal(rules.isPermanentJoinError(error), expected);
  });
}
function moved(): VoiceStateUpdated {
  return { chat: { id: 'old', type: 'voice', server_id: 'server' }, user: { id: 'self', username: 'MusicBot', display_name: 'Музыка', bot: true },
    action: 'left', date: 1_700_000_000, move_to: { id: 'new', type: 'voice', server_id: 'server' } };
}
it('R306 reconnect: свой left из текущего канала с move_to переводит в новый голос', () => {
  assert.equal(rules.moveTarget(moved(), 'self', 'old'), 'new');
});
const invalid: Array<{ name: string; change(u: VoiceStateUpdated): void }> = [
  { name: 'другой участник', change: u => { u.user.id = 'other'; } },
  { name: 'другой исходный канал', change: u => { u.chat.id = 'other'; } },
  { name: 'joined вместо left', change: u => { u.action = 'joined'; } },
  { name: 'нет move_to', change: u => { delete u.move_to; } },
  { name: 'цель текстовая', change: u => { u.move_to!.type = 'channel'; } },
  { name: 'пустой id цели', change: u => { u.move_to!.id = ''; } },
  { name: 'тот же канал', change: u => { u.move_to!.id = 'old'; } },
];
for (const c of invalid) it(`R306 reconnect: ${c.name} не вызывает перенос`, () => {
  const update = moved(); c.change(update);
  assert.equal(rules.moveTarget(update, 'self', 'old'), null);
});

const source = readFileSync(new URL('./reconnect.ts', import.meta.url), 'utf8');
function load(raw: string): typeof rules {
  const exports = {};
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: (name: string) => { throw new Error(`reconnect: запрещённый импорт ${name}`); } });
  return exports as typeof rules;
}
for (const c of [
  { name: 'кик ошибочно повторяется', needle: "if (reason && KICKED_REASONS.has(reason)) return 'kicked';", replacement: "if (false) return 'kicked';",
    probe: (m: typeof rules) => assert.equal(m.classifyDisconnect('PARTICIPANT_REMOVED'), 'kicked', 'R306 reconnect кик не повторяется'), message: 'R306 reconnect кик не повторяется' },
  { name: '403 ошибочно повторяется', needle: 'return code === 401 || code === 403;', replacement: 'return code === 401;',
    probe: (m: typeof rules) => assert.equal(m.isPermanentJoinError({ code: 403 }), true, 'R306 reconnect 403 останавливает повторы'), message: 'R306 reconnect 403 останавливает повторы' },
  { name: 'чужое событие переносит бота', needle: "if (update.action !== 'left' || update.user.id !== selfId) return null;", replacement: "if (update.action !== 'left') return null;",
    probe: (m: typeof rules) => assert.equal(m.moveTarget({ ...moved(), user: { ...moved().user, id: 'other' } }, 'self', 'old'), null, 'R306 reconnect чужой участник не переносит бота'), message: 'R306 reconnect чужой участник не переносит бота' },
]) it(`R306 reconnect контрфакт: ${c.name}, оригинал проходит первым`, () => {
  c.probe(load(source));
  assert.equal(source.split(c.needle).length - 1, 1, 'reconnect: точный уникальный якорь');
  assert.throws(() => c.probe(load(source.replace(c.needle, c.replacement))), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.message.split('\n', 1)[0] === c.message
    && e.operator === 'strictEqual');
});
