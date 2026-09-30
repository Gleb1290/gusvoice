import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VAD, vadFloor, vadInitial, vadOpenLevel, vadStep, type VadState } from './speakingVad.js';

function run(levelAt: (time: number) => number, durationMs: number): { time: number; speaking: boolean; state: VadState }[] {
  let state = vadInitial();
  const samples = [];
  for (let time = 0; time <= durationMs; time += 50) {
    const next = vadStep(state, levelAt(time), time);
    state = next.state;
    samples.push({ time, speaking: next.speaking, state });
  }
  return samples;
}

describe('обводка говорящего по его собственному полу шума', () => {
  it('первый замер шумной комнаты не зажигает обводку', () => {
    // Ловит ложное «говорит» сразу после входа в канал при ненулевом фоне.
    const samples = run(() => 0.0055, 10_000);
    assert.ok(samples.every((sample) => !sample.speaking));
    assert.equal(vadFloor(samples.at(-1)!.state), 0.0055);
  });

  it('после закрытого гейта шёпот с короткими провалами не мигает', () => {
    // Ловит возврат общего порога 0.015, под которым слышимый шёпот оставался без обводки.
    const samples = run((time) => time < 500 ? 0 : time % 400 < 300 ? 0.007 : 0.002, 4_000);
    assert.ok(samples.filter((s) => s.time >= 550).every((s) => s.speaking));
  });

  it('шёпот поверх фона комнаты открывает обводку, а один фон — нет', () => {
    // Ловит слишком низкий фиксированный порог, который подсвечивал бы комнату без речи.
    const samples = run((time) => time < 1_000 ? 0.0055 : time % 400 < 300 ? 0.012 : 0.006, 5_000);
    assert.ok(samples.filter((s) => s.time < 1_000).every((s) => !s.speaking));
    assert.ok(samples.filter((s) => s.time >= 1_050).every((s) => s.speaking));
  });

  it('долгая тихая речь не поднимает пол до уровня провалов между слогами', () => {
    // Ловит дрейф пола, из-за которого обводка горела только часть монолога.
    const samples = run((time) => time < 500 || time % 4_000 < 100 ? 0.005 : time % 400 < 250 ? 0.02 : 0.012, 12_000);
    assert.ok(samples.filter((s) => s.time >= 600).every((s) => s.speaking));
    assert.equal(vadFloor(samples.at(-1)!.state), 0.005);
  });

  it('ровный новый вентилятор гаснет после окна пола и удержания', () => {
    // Ловит вечную ложную обводку при смене постоянного фонового шума.
    const samples = run((time) => time < 500 ? 0.001 : 0.008, 6_000);
    assert.ok(samples.some((s) => s.time >= 500 && s.speaking));
    assert.equal(samples.find((s) => s.time === VAD.FLOOR_WINDOW_MS + VAD.HOLD_MS)!.speaking, false);
  });

  it('гистерезис и удержание 500 мс перекрывают промежутки между словами', () => {
    // Ловит дребезг обводки около порога и мгновенное исчезновение на короткой паузе.
    assert.equal(vadOpenLevel(0.005), 0.01);
    assert.equal(VAD.CLOSE_RATIO, 0.65);
    let state = vadInitial();
    for (const [time, level] of [[0, 0.005], [50, 0.012], [100, 0.007], [150, 0.005]] as const) {
      state = vadStep(state, level, time).state;
    }
    assert.equal(state.open, false);
    assert.equal(vadStep(state, 0.005, 550).speaking, true);
    assert.equal(vadStep(state, 0.005, 600).speaking, false);
  });
});
