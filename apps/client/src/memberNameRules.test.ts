import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { voiceNameSource } from './memberNameRules';

const me = { id: 'self', displayName: 'Моё имя' };
it('R159 пустой локальный участник голоса берёт мои id и имя', () => {
  // LiveKit даёт пустые поля до подключения; своя плитка не должна остаться без имени.
  for (const name of ['', undefined, null]) assert.deepEqual(voiceNameSource({ identity: '', name, isLocal: true }, me), { id: 'self', fallback: 'Моё имя' });
});
it('R159 известные identity и имя сохраняются, имя важнее identity', () => {
  assert.deepEqual(voiceNameSource({ identity: 'known', name: 'Имя', isLocal: true }, me), { id: 'known', fallback: 'Имя' });
  assert.deepEqual(voiceNameSource({ identity: 'known', name: '', isLocal: true }, me), { id: 'known', fallback: 'known' });
  assert.deepEqual(voiceNameSource({ identity: '', name: 'Имя', isLocal: true }, me), { id: 'self', fallback: 'Имя' });
});
function checkNoImpersonation(fn = voiceNameSource) {
  for (const isLocal of [false, undefined]) assert.deepEqual({ ...fn({ identity: '', name: '', isLocal }, me) }, { id: '', fallback: '' });
  assert.deepEqual({ ...fn({ identity: '', name: '', isLocal: true }, null) }, { id: '', fallback: '' });
}
it('R159 чужой пустой участник и отсутствие me не получают моё имя', () => checkNoImpersonation());
it('R159 удаление isLocal обнаруживается как присвоение чужому моего имени', () => {
  checkNoImpersonation();
  const source = readFileSync(new URL('./memberNameRules.ts', import.meta.url), 'utf8');
  assert.equal(source.split('p.isLocal && me').length - 1, 2, 'меняем обе связанные проверки id и имени');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replaceAll('p.isLocal && me', 'me'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
  assert.throws(() => checkNoImpersonation((module.exports as { voiceNameSource: typeof voiceNameSource }).voiceNameSource), assert.AssertionError);
});
