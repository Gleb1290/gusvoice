import assert from 'node:assert/strict';
import { it } from 'node:test';
import { soundboardForecast, soundboardScopeIncludes } from './soundboardForecast';

const servers = [
  { id: 'a', clipCount: 8, projectedClipCount: 20 },
  { id: 'b', clipCount: 3, projectedClipCount: 11 },
];
it('при выключенной модели прогноз учитывает имеющиеся звуки', () => {
  assert.equal(soundboardForecast(servers, 'off', ['a']), 11);
});
it('для всех серверов используются серверные прогнозы', () => {
  assert.equal(soundboardForecast(servers, 'all', []), 31);
});
it('для выбранных серверов прогноз сочетается с текущими звуками остальных', () => {
  assert.equal(soundboardForecast(servers, 'selected', ['b']), 19);
  assert.equal(soundboardForecast(servers, 'selected', []), 11);
});
it('выбор не включает другие серверы', () => {
  assert.equal(soundboardScopeIncludes('selected', ['a'], 'a'), true);
  assert.equal(soundboardScopeIncludes('selected', ['a'], 'b'), false);
});
