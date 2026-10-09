import assert from 'node:assert/strict';
import { it } from 'node:test';
import { REPORT_REASONS, reportReasonTitle, serverStranger, strangerBarShown } from './strangerBarRules';
import { FEATURE_STRANGER1 } from '@gusvoice/shared';

it('плашка незнакомца появляется только при включённой фиче и до первого ответа/блокировки/группы', () => {
  const base = { feature: true, stranger: true, blocked: false, group: false, hasOwnMessage: false };
  assert.equal(strangerBarShown(base), true);
  for (const patch of [{ feature: false }, { stranger: false }, { blocked: true }, { group: true }, { hasOwnMessage: true }])
    assert.equal(strangerBarShown({ ...base, ...patch }), false);
  assert.equal(serverStranger([FEATURE_STRANGER1]), true); assert.equal(serverStranger(undefined), false);
});

it('причины жалобы соблюдают контрактный порядок, неизвестная причина остаётся читаемой', () => {
  assert.deepEqual([...REPORT_REASONS], ['spam', 'scam', 'violence', 'child_abuse', 'porn', 'illegal', 'other']);
  assert.equal(reportReasonTitle('spam'), 'Спам');
  assert.equal(reportReasonTitle('new_server_reason'), 'new_server_reason');
});
