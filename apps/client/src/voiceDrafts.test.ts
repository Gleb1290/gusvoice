import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type * as drafts from './voiceDrafts';

function load(): typeof drafts {
  const source = readFileSync(new URL('./voiceDrafts.ts', import.meta.url), 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      assert.equal(id, 'react');
      return { useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
    }, indexedDB: undefined });
  return module.exports as typeof drafts;
}

it('уход из беседы сохраняет черновик в памяти вкладки, а возвращение восстанавливает те же данные', async () => {
  const api = load();
  const draft = { file: { name: 'voice.webm', type: 'audio/webm' } as File, durationMs: 5200, waveform: [1, 2, 3], once: true,
    trim: { fromMs: 1000, toMs: null }, at: '2026-10-08T10:00:00.000Z' };
  api.saveVoiceDraft('dm:a', draft);
  const restored = await api.loadVoiceDraft('dm:a');
  assert.strictEqual(restored, draft, 'в той же вкладке запись не перекодируется и не теряет состояние ручек');
  assert.equal(api.useVoiceDraftKeys().get('dm:a'), draft.at);
  assert.equal(api.useVoiceDraftKeys().has('dm:b'), false);
});

it('отправка или выбрасывание снимает черновик из списка, неизвестный ключ не выдумывает запись', async () => {
  const api = load();
  assert.equal(await api.loadVoiceDraft('missing'), null);
  const draft = { file: { name: 'take.webm', type: 'audio/webm' } as File, durationMs: 1000, waveform: [], once: false, trim: null, at: 'now' };
  api.saveVoiceDraft('dm:x', draft);
  api.dropVoiceDraft('dm:x');
  assert.equal(api.useVoiceDraftKeys().has('dm:x'), false);
  assert.equal(await api.loadVoiceDraft('dm:x'), null);
});

it('повторное сохранение обновляет только тот же feedId, а список — снимок, не общий изменяемый Map', () => {
  const api = load();
  const draft = (at: string) => ({ file: { name: 'a.webm', type: 'audio/webm' } as File, durationMs: 1000, waveform: [], once: false, trim: null, at });
  api.saveVoiceDraft('dm:a', draft('first')); api.saveVoiceDraft('dm:b', draft('other'));
  const before = api.useVoiceDraftKeys();
  api.saveVoiceDraft('dm:a', draft('second'));
  const after = api.useVoiceDraftKeys();
  assert.notStrictEqual(after, before);
  assert.equal(after.get('dm:a'), 'second'); assert.equal(after.get('dm:b'), 'other');
  assert.equal(before.get('dm:a'), 'first', 'старый snapshot остаётся стабильным для useSyncExternalStore');
});
