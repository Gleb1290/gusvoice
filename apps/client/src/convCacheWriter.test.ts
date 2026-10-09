import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as cacheRules from './convCacheRules';
import * as outboxRules from './outboxRules';
import { emptyConvState } from './convSyncRules';

it('срочный кеш пишет прежним ключом после хуков черновика и до серверных хуков, отписки работают', () => {
  let state = { convActive: true, convCacheKey: 'old|me', conv: { ...emptyConvState(), pts: 1 }, dmMessages: {}, outbox: {}, drafts: {}, places: {}, draftDirty: [] };
  let subscribe!: (s: typeof state, prev: typeof state) => void;
  const log: string[] = []; const timers = new Map<number, () => void>(); let n = 0;
  const deps: Record<string, unknown> = {
    './convCache': { writeConvCache: (key: string) => { log.push(`write:${key}`); } },
    './convCacheRules': cacheRules, './outboxRules': outboxRules,
    './store': { useStore: { getState: () => state, subscribe: (fn: typeof subscribe) => { subscribe = fn; } } },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('./convCacheWriter.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module, exports: module.exports, require: (id: string) => { assert.ok(id in deps, id); return deps[id]; },
    setTimeout: (fn: () => void) => { timers.set(++n, fn); return n; }, clearTimeout: (id: number) => timers.delete(id) });
  const writer = module.exports as typeof import('./convCacheWriter'); writer.startConvCacheWriter();
  writer.flushConvCacheNow(); assert.equal(log.length, 0);
  const unBefore = writer.onConvCacheUrgent(() => {
    log.push('draft'); const prev = state; state = { ...state, drafts: { c: { text: 'latest', replyToId: null } } }; subscribe(state, prev);
  });
  const unAfter = writer.onConvCacheFlushed(() => log.push('server'));
  writer.flushConvCacheNow(); assert.deepEqual(log, ['draft', 'write:old|me', 'server']); assert.equal(timers.size, 0);
  unBefore(); unAfter(); state = { ...state, convCacheKey: 'new|me' }; writer.flushConvCacheNow();
  assert.deepEqual(log, ['draft', 'write:old|me', 'server']);
});
