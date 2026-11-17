import assert from 'node:assert/strict';
import { it } from 'node:test';
import { value, phone, reduce } from '../test-support/cssGuards.js';

it('полноэкранная страница не закрывает звонок, обычный лист остаётся над ним', () => {
  const z = (selector: string, scope?: string) => {
    const result = Number(value(selector, 'z-index', scope));
    assert.ok(Number.isFinite(result));
    return result;
  };
  assert.ok(z('.sheet-scrim.page') < z('.call-bar.call-bar-top', phone));
  assert.ok(z('.sheet-scrim') > z('.call-bar.call-bar-top', phone));
});

it('страница листа сохраняет безопасную прокрутку и отключает движение по запросу', () => {
  assert.equal(value('.sheet.page', 'max-height'), 'none');
  assert.equal(value('.sheet.page .sheet-body', 'min-height'), '0');
  assert.ok(['auto', 'scroll'].includes(value('.sheet.page .sheet-body', 'overflow-y')));
  assert.match(value('.sheet-page-bar', '--sheet-page-bar'), /--m-callbar-h/);
  assert.match(value('.sheet-page-bar', '--sheet-page-bar'), /--gv-sat/);
  assert.match(value('.sheet.page .sheet-body', 'padding'), /--gv-sab/);
  assert.equal(value('.sheet.page', 'animation', reduce), 'none');
});
