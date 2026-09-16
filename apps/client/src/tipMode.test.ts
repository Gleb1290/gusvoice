import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TIP_CUE_THROTTLE_MS, canTipRow, nextTipMode, shouldPlayTipCue, tipInteraction } from './tipMode.js';

describe('режим типа', () => {
  it('Alt включает кнопки на десктопе только при включённой экономике', () => {
    assert.equal(tipInteraction(true, true, false), 'button');
    assert.equal(tipInteraction(false, true, false), 'none');
  });

  it('без Alt на десктопе кнопок нет', () => {
    assert.equal(tipInteraction(true, false, false), 'none');
  });

  it('на мобильном доступно долгое нажатие вместо несуществующего Alt', () => {
    assert.equal(tipInteraction(true, false, true), 'hold');
  });

  it('отпускание Alt выключает режим', () => {
    assert.equal(nextTipMode(true, 'alt-up'), false);
  });

  it('потеря фокуса выключает режим — иначе кнопки залипнут после Alt+Tab', () => {
    assert.equal(nextTipMode(true, 'blur'), false);
  });

  it('первый звук типа проходит, а повтор внутри секунды схлопывается', () => {
    assert.equal(shouldPlayTipCue(null, 100), true);
    assert.equal(shouldPlayTipCue(100, 100 + TIP_CUE_THROTTLE_MS - 1), false);
  });

  it('ровно через секунду следующий звук снова разрешён', () => {
    assert.equal(shouldPlayTipCue(100, 100 + TIP_CUE_THROTTLE_MS), true);
  });

  it('в сайдбаре ник обводится только у соседа по своему каналу', () => {
    assert.equal(canTipRow(true, false, 'ch1', 'ch1'), true);
  });

  it('себя не обводим — типнуть себя нельзя', () => {
    assert.equal(canTipRow(true, true, 'ch1', 'ch1'), false);
  });

  it('человек из ДРУГОГО канала без рамки: сервер требует сидеть вместе', () => {
    assert.equal(canTipRow(true, false, 'ch1', 'ch2'), false);
  });

  it('не в голосовом канале — рамок нет вовсе', () => {
    assert.equal(canTipRow(true, false, null, 'ch1'), false);
  });

  it('без Alt рамок нет даже у соседа', () => {
    assert.equal(canTipRow(false, false, 'ch1', 'ch1'), false);
  });
});
