import assert from 'node:assert/strict';
import { it } from 'node:test';
import { value, phone } from '../test-support/cssGuards.js';

const chat = '.app.m-content .chat';
const scrim = `${chat} > .expr-scrim`;
it('декоративное затемнение панели не перехватывает касания', () => {
  assert.equal(value(scrim, 'pointer-events', phone), 'none');
});

it('управление открытой панели находится над затемнением и кнопкой возврата', () => {
  const layer = (selector: string) => {
    const z = Number(value(selector, 'z-index', phone));
    assert.ok(Number.isFinite(z));
    return z;
  };
  const shade = layer(scrim);
  assert.ok(shade > layer(`${chat} > .chat-top`));
  assert.ok(shade > layer('.app.m-content .mobile-back'));
  for (const selector of [`${chat} > .expr-under`, `${chat}.has-expr-under > .composer`, `${chat}.has-expr-under > .reply-strip`])
    assert.ok(layer(selector) > shade, selector);
});
