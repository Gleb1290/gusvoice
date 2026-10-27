import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import * as imageSize from './imageSize';
import { forwardedAuthorOpenable } from './bubbleRules';
import { load, mutate, sourceOf } from './R304.testHarness';
import type * as Bubble from './bubbleRules';

it('R304 подтверждённый автор открывается, неподтверждённый и удалённый — только текст', () => {
  for (const deleted of [undefined, true] as const) for (const unverified of [undefined, true] as const)
    assert.equal(forwardedAuthorOpenable({ deleted, unverified }), deleted !== true && unverified !== true);
});
it('R304 контрфакт: доверие неподтверждённой пересылке обнаруживается', () => {
  const source = sourceOf('bubbleRules');
  const check = (raw: string) => assert.equal(load<typeof Bubble>(raw, { '@gusvoice/shared': shared, './imageSize': imageSize })
    .forwardedAuthorOpenable({ unverified: true }), false, 'неподтверждённый автор не открывается');
  check(source); assert.throws(() => check(mutate(source, 'from.deleted !== true && from.unverified !== true', 'from.deleted !== true')),
    e => e instanceof assert.AssertionError && e.message.includes('неподтверждённый автор не открывается'));
});
