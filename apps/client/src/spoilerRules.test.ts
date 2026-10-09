import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type * as rules from './spoilerRules';

function load(source = readFileSync(new URL('./spoilerRules.ts', import.meta.url), 'utf8')): typeof rules {
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, './fileActions'); return { attachmentKey: (a: { id?: string; url?: string }) => a.id || a.url }; } });
  return module.exports as typeof rules;
}

it('спойлер действует только на кадр фото/видео, а не на аудио или отправленное как файл', () => {
  const api = load();
  const photo = { id: 'p', url: '/p', contentType: 'image/png', spoiler: true as const };
  assert.equal(api.spoilerApplies(photo), true);
  assert.equal(api.spoilerApplies({ ...photo, asFile: true }), false);
  assert.equal(api.spoilerApplies({ ...photo, contentType: 'audio/ogg' }), false);
  assert.equal(api.spoilerApplies({ ...photo, contentType: 'video/mp4' }), true);
  const mutant = load(readFileSync(new URL('./spoilerRules.ts', import.meta.url), 'utf8').replace('a.asFile !== true && ', ''));
  assert.throws(() => assert.equal(mutant.spoilerApplies({ ...photo, asFile: true }), false), assert.AssertionError,
    'мутант размывает карточку «как файл», где спойлера быть не должно');
});

it('однажды раскрытое вложение не закрывается повторно и уведомление приходит ровно один раз', () => {
  const api = load(); const img = { id: 'same-id', url: '/one', contentType: 'image/jpeg', spoiler: true as const };
  let changes = 0; const off = api.subscribeSpoilers(() => changes++);
  try {
    assert.equal(api.spoilerHidden(img), true);
    api.revealSpoiler(img); api.revealSpoiler({ id: 'same-id', url: '/changed' });
    assert.equal(api.spoilerHidden(img), false); assert.equal(changes, 1);
    api.resetSpoilers(); assert.equal(api.spoilerHidden(img), true);
  } finally { off(); api.resetSpoilers(); }
});
