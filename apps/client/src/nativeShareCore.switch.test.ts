import assert from 'node:assert/strict';
import { it } from 'node:test';
import { load, mutate, sourceOf } from './R304.testHarness';
import type * as Core from './nativeShareCore';

const source = sourceOf('nativeShareCore');
const old = { sourceId: '1', isWindow: true };
const next = { sourceId: '2', isWindow: false };
function session(raw = source) {
  let sharing = false;
  const s = load<typeof Core>(raw).createNativeShareSession({
    getSharing: () => sharing, setSharing: v => { sharing = v; }, stopCapture: async () => {},
  });
  s.markSharing(old);
  return s;
}
async function videoFirst(raw: string) {
  const s = session(raw), events: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  s.setAudioStop(async () => { events.push('stop'); }, async () => {
    assert.equal(s.getSource(), next, 'звук видит уже принятый источник'); events.push('audio');
  });
  const p = s.switchTo(next, async () => {
    assert.equal(s.getSource(), old, 'до подтверждения видео остаётся прежний источник');
    events.push('video'); await wait; return 'hot';
  }, { wantAudio: true });
  void p.catch(() => {});
  try {
    assert.equal(s.getSource(), old, 'ожидание видео не меняет источник');
    assert.equal(events.join(','), 'video', 'звук не меняется во время ожидания видео');
  } finally { release(); }
  const result = await p;
  assert.equal(result.audio, 'retargeted');
  assert.equal(events.join(','), 'video,audio');
}
it('R304 видео подтверждается раньше источника и звука', async () => { await videoFirst(source); });
it('R304 отказ видео сохраняет прежний источник и живой звук', async () => {
  const s = session(); let audio = 0;
  s.setAudioStop(async () => { audio++; }, async () => { audio++; });
  await assert.rejects(s.switchTo(next, async () => { throw new Error('источник исчез'); }, { wantAudio: false }), /исчез/);
  assert.equal(s.getSource(), old); assert.equal(s.hasAudio(), true); assert.equal(audio, 0);
});
for (const playing of [false, true]) for (const wanted of [false, true]) {
  it(`R304 звук ${playing ? 'шёл' : 'не шёл'}, ${wanted ? 'нужен' : 'не нужен'} — ровно одна нужная операция`, async () => {
    const s = session(), calls: string[] = [];
    if (playing) s.setAudioStop(async () => { calls.push('stop'); }, async target => {
      assert.equal(target, undefined, 'экран переводит звук на весь системный микс'); calls.push('retarget');
    });
    const r = await s.switchTo(next, async () => 'republished', { wantAudio: wanted,
      startAudio: async () => { calls.push('start'); s.setAudioStop(async () => {}); } });
    const expected = playing ? wanted ? 'retarget' : 'stop' : wanted ? 'start' : '';
    assert.equal(calls.join(','), expected);
    assert.equal(r.audio, playing ? wanted ? 'retargeted' : 'stopped' : wanted ? 'started' : 'none');
    assert.equal(r.outcome, 'republished'); assert.equal(s.getSource(), next);
  });
}
it('R304 окно передаёт retarget свой id, same не переводит звук и не запускает новый', async () => {
  const s = session(); const calls: string[] = [];
  s.setAudioStop(async () => { calls.push('stop'); }, async target => { calls.push(target?.sourceId ?? 'system'); });
  const w = { sourceId: '3', isWindow: true };
  await s.switchTo(w, async () => 'hot'); assert.equal(calls.join(','), '3');
  calls.length = 0;
  const r = await s.switchTo(w, async () => 'same', { wantAudio: false, startAudio: async () => { calls.push('start'); } });
  assert.equal(calls.length, 0); assert.equal(r.audio, 'none'); assert.equal(s.hasAudio(), true);
  await s.stop(); assert.equal(s.getSource(), null);
});
async function failedRetarget(raw: string) {
  const s = session(raw); let stopped = 0;
  s.setAudioStop(async () => { stopped++; }, async () => { throw new Error('WASAPI отказ'); });
  const r = await s.switchTo(next, async () => 'hot', { wantAudio: true });
  assert.equal(r.audio, 'failed'); assert.equal(r.audioError, 'WASAPI отказ');
  assert.equal(stopped, 1, 'старый звук обязательно погашен'); assert.equal(s.hasAudio(), false);
  assert.equal(s.getSource(), next, 'отказ только звука не откатывает успешное видео');
}
it('R304 отказ перевода звука гасит старое приложение, не откатывая видео', async () => { await failedRetarget(source); });
it('R304 без показа смена отвергается до видео, пара id+вид различает пространства', async () => {
  const core = load<typeof Core>(source), s = session(); await s.stop();
  await assert.rejects(s.switchTo(next, async () => { assert.fail('видео не должно вызываться'); }), /показ не идёт/);
  assert.equal(core.sameNativeSource(old, { ...old }), true);
  assert.equal(core.sameNativeSource(old, { ...old, isWindow: false }), false);
  assert.equal(core.sameNativeSource(null, old), false);
});
for (const [title, anchor, replacement, check, marker] of [
  ['источник до видео', 'const outcome = await switchVideo(next);', 'source = next; const outcome = await switchVideo(next);', videoFirst, 'ожидание видео не меняет источник'],
  ['звук до видео', 'const outcome = await switchVideo(next);', 'if (audioRetarget) await audioRetarget(); const outcome = await switchVideo(next);', videoFirst, 'звук не меняется во время ожидания видео'],
  ['старый звук после отказа', "} catch (e) {\n          await stopAudio();", '} catch (e) {', failedRetarget, 'старый звук обязательно погашен'],
] as const) it(`R304 контрфакт: ${title} обнаруживается исходным сценарием`, async () => {
  await check(source); await assert.rejects(check(mutate(source, anchor, replacement)),
    e => e instanceof assert.AssertionError && e.message.includes(marker));
});
