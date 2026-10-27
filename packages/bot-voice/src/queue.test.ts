import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as pcm from './pcm.js';
import * as queue from './queue.js';

const source = readFileSync(new URL('./queue.ts', import.meta.url), 'utf8');
function load(raw: string): typeof queue {
  const exports = {};
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, URL, require: (name: string) => {
      assert.equal(name, './pcm.js', 'queue: разрешён только чистый PCM'); return pcm;
    } });
  return exports as typeof queue;
}
function harness(mod = queue) {
  const events: string[] = [];
  let q: queue.TrackQueue;
  q = new mod.TrackQueue({
    start: t => {
      assert.equal(q.current, t); assert.equal(t.state, 'playing');
      events.push(`start:${t.id}`);
    },
    abort: t => { events.push(`abort:${t.id}`); },
    ended: (t, reason) => { assert.equal(t.state, 'ended'); assert.equal(t.endReason, reason); events.push(`end:${t.id}:${reason}`); },
    idle: () => { assert.equal(q.current, null); events.push('idle'); },
    pauseChanged: paused => { events.push(`pause:${paused}`); },
  });
  return { q, events };
}

it('R306 queue: первый play стартует сразу, ожидающие имеют queued и уникальные id', () => {
  const { q, events } = harness();
  assert.equal(q.current, null); assert.deepEqual(q.waiting, []); assert.equal(q.paused, false);
  const first = q.add('first'), second = q.add('second'), third = q.add('third');
  assert.equal(q.current, first); assert.equal(first.endReason, null);
  assert.deepEqual([first.id, second.id, third.id], [1, 2, 3]);
  assert.deepEqual([first.state, second.state, third.state], ['playing', 'queued', 'queued']);
  assert.deepEqual(q.waiting, [second, third]); assert.deepEqual(events, ['start:1']);
  const exposed = q.waiting as queue.QueueTrack[]; exposed.length = 0;
  assert.equal(q.waiting.length, 2, 'изменение копии списка не портит очередь');
  q.stop();
});
it('R306 queue: skip прерывает текущий, завершает skipped до запуска следующего, последним даёт idle', async () => {
  const { q, events } = harness(); const first = q.add('a'), second = q.add('b');
  assert.equal(q.skip(), true); assert.equal(await first.finished, 'skipped'); assert.equal(q.current, second);
  assert.deepEqual(events, ['start:1', 'abort:1', 'end:1:skipped', 'start:2']);
  assert.equal(q.skip(), true); assert.equal(await second.finished, 'skipped'); assert.equal(q.skip(), false);
  assert.deepEqual(events.slice(-3), ['abort:2', 'end:2:skipped', 'idle']);
});
for (const reason of ['finished', 'error'] as const) {
  it(`R306 queue: ${reason} выполняет finished без rejection, продолжает очередь и один раз idle`, async () => {
    const { q, events } = harness(); const first = q.add('a'), second = q.add('b');
    assert.equal(q.finish(first, reason), true); assert.equal(await first.finished, reason);
    assert.equal(q.current, second); assert.equal(q.finish(first, reason), false);
    assert.equal(q.finish(second, reason), true); assert.equal(await second.finished, reason);
    assert.equal(q.finish(second, reason), false);
    assert.deepEqual(events, ['start:1', `end:1:${reason}`, 'start:2', `end:2:${reason}`, 'idle']);
  });
}
async function oldFinish(mod = queue) {
  const { q, events } = harness(mod); const old = q.add('old'), next = q.add('next');
  q.skip();
  assert.equal(q.finish(old, 'finished'), false, 'R306 queue старый finish после skip игнорируется');
  assert.equal(q.current, next); assert.equal(next.state, 'playing');
  assert.equal(await old.finished, 'skipped');
  assert.deepEqual(events, ['start:1', 'abort:1', 'end:1:skipped', 'start:2']);
  q.stop(); assert.equal(await next.finished, 'stopped');
}
it('R306 queue: запоздалый finish прерванного ffmpeg не закрывает новый трек', () => oldFinish());
it('R306 queue: stop завершает все треки stopped, снимает паузу и даёт ровно один idle, повтор пуст', async () => {
  const { q, events } = harness(); const tracks = [q.add('a'), q.add('b'), q.add('c')];
  q.pause(); q.stop();
  assert.deepEqual(await Promise.all(tracks.map(t => t.finished)), ['stopped', 'stopped', 'stopped']);
  assert.deepEqual(events, ['start:1', 'pause:true', 'abort:1', 'pause:false', 'end:1:stopped', 'end:2:stopped', 'end:3:stopped', 'idle']);
  assert.equal(q.current, null); assert.deepEqual(q.waiting, []); assert.equal(q.paused, false);
  const snapshot = [...events]; q.stop(); assert.deepEqual(events, snapshot);
  assert.equal(q.finish(tracks[0], 'error'), false);
  const after = q.add('after'); assert.equal(after.state, 'playing'); assert.equal(after.id, 4); q.stop();
});
it('R306 queue: pause/resume возвращают bool без повторных уведомлений, пустую очередь не ставят на паузу', () => {
  const { q, events } = harness(); assert.equal(q.pause(), false); assert.equal(q.resume(), false);
  const first = q.add('a'); q.add('b');
  assert.equal(q.pause(), true); assert.equal(q.paused, true); assert.equal(q.pause(), false);
  assert.equal(q.resume(), true); assert.equal(q.paused, false); assert.equal(q.resume(), false);
  q.pause(); q.finish(first, 'finished'); assert.equal(q.paused, true, 'пауза сохраняется при переходе к следующему');
  q.skip(); assert.equal(q.paused, false, 'пустая очередь снимает паузу');
  assert.deepEqual(events.filter(e => e.startsWith('pause:')), ['pause:true', 'pause:false', 'pause:true', 'pause:false']);
});
for (const [input, expected] of [
  ['/music/song.ogg', 'song.ogg'], ['C:\\music\\song.mp3', 'song.mp3'], ['https://radio.invalid/path/a%20b.mp3?token=synthetic', 'radio.invalid/a b.mp3'],
  ['https://radio.invalid/', 'radio.invalid'], ['', ''],
] as const) it(`R306 queue: название по умолчанию ${input} → ${expected}`, () => assert.equal(queue.defaultTitle(input), expected));
it('R306 queue: поток называется stream, явный заголовок обрезает пробелы, пустой использует fallback', () => {
  const stream = new PassThrough();
  assert.equal(queue.defaultTitle(stream), 'stream'); assert.equal(queue.defaultTitle({ pcm: stream }), 'stream');
  assert.equal(new queue.QueueTrack(1, 'file.mp3', { title: '  Песня  ' }).title, 'Песня');
  assert.equal(new queue.QueueTrack(2, 'file.mp3', { title: '  ' }).title, 'file.mp3');
});
it('R306 queue: громкость трека по умолчанию 1, ноль не теряется, предел 2 и NaN нормализуются', () => {
  for (const [options, expected] of [[{}, 1], [{ volume: 0 }, 0], [{ volume: -1 }, 0], [{ volume: 2 }, 2], [{ volume: 3 }, 2], [{ volume: NaN }, 1]] as const) {
    assert.equal(new queue.QueueTrack(1, 'song', options).volume, expected);
  }
});

for (const flag of ['paused', 'muted', 'offline'] as const) {
  it(`R306 PlaybackGate: ${flag} удерживает wait до открытия, повтор set не пробуждает`, async () => {
    const gate = new queue.PlaybackGate(); const signal = new AbortController().signal;
    assert.equal(gate.open, true); assert.equal(await gate.wait(signal), true);
    gate.set(flag, true); assert.equal(gate.get(flag), true); assert.equal(gate.open, false);
    let finished = false; const wait = gate.wait(signal).then(value => { finished = true; return value; });
    gate.set(flag, true); await Promise.resolve(); assert.equal(finished, false);
    gate.set(flag, false); assert.equal(await wait, true); assert.equal(finished, true);
  });
}
it('R306 PlaybackGate: три независимые причины, wake не открывает ворота, последний флаг выпускает всех', async () => {
  const gate = new queue.PlaybackGate(); const signal = new AbortController().signal;
  gate.set('paused', true); gate.set('muted', true); gate.set('offline', true);
  let finished = 0; const waits = [gate.wait(signal), gate.wait(signal)].map(p => p.then(v => { finished++; return v; }));
  gate.set('paused', false); gate.set('muted', false); gate.wake();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, 0); assert.equal(gate.open, false);
  gate.set('offline', false);
  assert.deepEqual(await Promise.all(waits), [true, true]);
});
it('R306 PlaybackGate: abort выпускает false даже при закрытых воротах, заранее отменённый тоже false', async () => {
  const gate = new queue.PlaybackGate(); gate.set('muted', true);
  const abort = new AbortController(); const wait = gate.wait(abort.signal);
  abort.abort(); assert.equal(await wait, false);
  gate.set('muted', false); assert.equal(await gate.wait(abort.signal), false);
});
it('R306 PlaybackGate: ожидание снимает abort-listener после открытия и отмены', async () => {
  const gate = new queue.PlaybackGate(); gate.set('paused', true);
  const listeners = new Set<() => void>();
  const signal = { aborted: false, addEventListener: (_t: 'abort', l: () => void) => { listeners.add(l); }, removeEventListener: (_t: 'abort', l: () => void) => { listeners.delete(l); } };
  const first = gate.wait(signal); assert.equal(listeners.size, 1);
  gate.set('paused', false); assert.equal(await first, true); assert.equal(listeners.size, 0);
  gate.set('paused', true); const second = gate.wait(signal); signal.aborted = true;
  for (const listener of [...listeners]) listener();
  assert.equal(await second, false); assert.equal(listeners.size, 0);
});
it('R306 queue контрфакт: finish старого трека больше не защищён, оригинал проходит первым', async () => {
  await oldFinish(load(source));
  const needle = 'if (this.cur !== track) return false;';
  assert.equal(source.split(needle).length - 1, 1, 'queue: точный уникальный якорь');
  await assert.rejects(() => oldFinish(load(source.replace(needle, '/* мутант: принимаем чужой finish */'))), (e: unknown) => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.message.split('\n', 1)[0] === 'R306 queue старый finish после skip игнорируется'
    && e.operator === 'strictEqual' && e.actual === true && e.expected === false);
});
