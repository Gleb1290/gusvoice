import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as rules from './convNotificationRules';

it('сводка по беседам не включает нулевые записи и «только что прочитано» учитывает исчезнувшие', () => {
  assert.deepEqual(rules.unreadByConv([{ id: 'a', unread: 2 }, { id: 'b', unread: 0 }, { id: 'c' }]), { a: 2 });
  assert.deepEqual(rules.convsJustRead({ a: 2, b: 1, c: 0 }, { a: 0, b: 2, d: 1 }), ['a']);
  assert.deepEqual(rules.convsJustRead({}, { a: 1 }), []);
});
