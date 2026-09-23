import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EVIDENCE_MAX, addEvidence, clearEvidence, evidenceOf, removeEvidence, type EvidenceItem } from './reportEvidence.js';

const users = new Set<string>();
const item = (id: string): EvidenceItem => ({ messageId: id, text: `текст ${id}`, at: 1, channel: 'общий' });
afterEach(() => { for (const id of users) clearEvidence(id); users.clear(); });
const user = (id: string) => { users.add(id); return id; };

describe('ручные доказательства к жалобе', () => {
  it('сообщения добавляются в порядке выбора и снимок стабилен без изменений', () => {
    // Ловит перестановку осознанно выбранных строк и бесконечную перерисовку React по новой ссылке.
    const id = user('order');
    addEvidence(id, item('a')); addEvidence(id, item('b'));
    const first = evidenceOf(id);
    assert.deepEqual(first.map((e) => e.messageId), ['a', 'b']);
    assert.strictEqual(evidenceOf(id), first);
  });

  it('одно сообщение нельзя приложить дважды', () => {
    // Ловит заполнение лимита повторами одной и той же строки.
    const id = user('duplicate');
    assert.equal(addEvidence(id, item('a')), true);
    assert.equal(addEvidence(id, item('a')), false);
    assert.equal(evidenceOf(id).length, 1);
  });

  it('ровно пять сообщений принимаются, шестое явно отвергается', () => {
    // Ловит ошибку на границе серверного лимита доказательств.
    const id = user('limit');
    for (let i = 0; i < EVIDENCE_MAX; i++) assert.equal(addEvidence(id, item(String(i))), true);
    assert.equal(addEvidence(id, item('extra')), false);
    assert.equal(evidenceOf(id).length, EVIDENCE_MAX);
  });

  it('корзины разных людей не пересекаются', () => {
    // Ловит отправку чужой переписки в жалобе на другого человека.
    const a = user('person-a'); const b = user('person-b');
    addEvidence(a, item('a')); addEvidence(b, item('b'));
    assert.deepEqual(evidenceOf(a).map((e) => e.messageId), ['a']);
    assert.deepEqual(evidenceOf(b).map((e) => e.messageId), ['b']);
  });

  it('удаление и очистка затрагивают только выбранную корзину', () => {
    // Ловит сохранение доказательств после отмены жалобы или удаление корзины соседа.
    const a = user('remove-a'); const b = user('remove-b');
    addEvidence(a, item('a')); addEvidence(a, item('b')); addEvidence(b, item('c'));
    removeEvidence(a, 'a');
    assert.deepEqual(evidenceOf(a).map((e) => e.messageId), ['b']);
    clearEvidence(a);
    assert.deepEqual(evidenceOf(a), []);
    assert.deepEqual(evidenceOf(b).map((e) => e.messageId), ['c']);
  });
});
