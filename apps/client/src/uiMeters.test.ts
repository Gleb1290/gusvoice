import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let now = 0;
let nextId = 0;
const frames = new Map<number, FrameRequestCallback>();
const cancelled: number[] = [];
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  value: (cb: FrameRequestCallback) => { const id = ++nextId; frames.set(id, cb); return id; },
});
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  configurable: true,
  value: (id: number) => { cancelled.push(id); frames.delete(id); },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { visibilityState: 'visible', hasFocus: () => true, getAnimations: () => [] },
});

const { takeUiMeters } = await import('./uiMeters.js');

describe('редкая выборка кадров интерфейса', () => {
  it('не повторяет незавершённое число, чинит зависший rAF и не стартует чаще 55 секунд', () => {
    // Ловит измеритель, который сам постоянно будит страницу, и вечный frozen-срез скрытой вкладки.
    const first = takeUiMeters();
    assert.deepEqual([first.frames, first.frames_ms], [0, 0]);
    assert.equal(frames.size, 1);

    const [id, cb] = [...frames.entries()][0]!;
    frames.delete(id);
    now = 100;
    cb(now);
    const during = takeUiMeters();
    assert.deepEqual([during.frames, during.frames_ms], [0, 0]);

    now = 5_000;
    const stalePass = takeUiMeters();
    assert.deepEqual([stalePass.frames, stalePass.frames_ms], [0, 0]);
    assert.equal(cancelled.length, 1);
    const completed = takeUiMeters();
    assert.deepEqual([completed.frames, completed.frames_ms], [1, 2_000]);
    assert.deepEqual([takeUiMeters().frames, takeUiMeters().frames_ms], [0, 0]);

    const idsBefore = nextId;
    now = 54_999;
    takeUiMeters();
    assert.equal(nextId, idsBefore);
    now = 55_000;
    takeUiMeters();
    assert.equal(nextId, idsBefore + 1);
  });
});
