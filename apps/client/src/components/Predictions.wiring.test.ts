import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as shared from '@gusvoice/shared';
import { sourceOf, load, NOW, FixedDate } from '../predictions.harness';

// R338: сохранена проверка результата макетов; AST-пины и строковые мутанты удалены по §11.
const P = 'Макеты игр: ';
it('макеты сохраняют выбранную руку КНБ и пять состояний ленты событий', () => {
  const raw = sourceOf('./benchMock.ts');
  const bench = load<typeof import('../benchMock')>(raw, { react: {}, '@gusvoice/shared': shared }, { Date: FixedDate });
  const duel = bench.mockChoiceDuelSnapshot('s', 'vc', 'rps-wait', 'me', NOW);
  assert.equal(duel.myHand, 'scissors', P + 'макет выбранной руки');
  assert.equal(duel.duel?.rps?.ready.challenger, true, P + 'макет КНБ готов');
  for (const kind of ['open', 'locked', 'settled', 'cancelled', 'empty'] as const) {
    const snap = bench.mockPredictionsSnapshot('s', kind, 'me', true, NOW);
    assert.equal(snap.serverId, 's', P + 'макет ленты своего сервера');
    assert.equal(snap.events.length, kind === 'open' ? 2 : kind === 'empty' ? 0 : 1, P + `макет ${kind} доступен`);
    if (kind !== 'empty') assert.equal(snap.events[0].state, kind, P + `макет ${kind} состояние`);
  }
});
