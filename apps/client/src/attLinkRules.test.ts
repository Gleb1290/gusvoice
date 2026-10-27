import assert from 'node:assert/strict';
import { it } from 'node:test';
import { attIdOfLink, isAttLink } from './attLinkRules';

const id = '12345678-abcd-abcd-abcd-1234567890ab';
const base = `https://voice.example/api/att/${id}/viewer/${'s'.repeat(32)}`;
it('R304 файл ЛС разбирается с прежней подписью, сроком и query/hash', () => {
  for (const suffix of ['', '.1234567890', '?download=1', '.1234567890#play']) {
    const url = base + suffix; assert.equal(isAttLink(url), true); assert.equal(attIdOfLink(url), id);
  }
});
it('R304 не-вложение, неполный UUID и границы подписи/зрителя не распознаются', () => {
  for (const value of [null, undefined, '', base.replace('/api/att/', '/api/media/'), base.replace(id, 'not-uuid'),
    base.replace('viewer/', '/'), base.replace('viewer/', 'v'.repeat(65) + '/'), base.slice(0, -1), base + 's'.repeat(12)]) {
    assert.equal(isAttLink(value), false, String(value));
    if (typeof value === 'string') assert.equal(attIdOfLink(value), null);
  }
  assert.equal(isAttLink(base.replace('viewer/', 'v'.repeat(64) + '/')), true);
  assert.equal(isAttLink(base + 's'.repeat(11)), true);
});
