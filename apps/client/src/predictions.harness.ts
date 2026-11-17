import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { GameRules } from './components/GameRules';
import { testVmImports } from './testVmImports';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import type { PredictionEventDto, PredictionQuestionDto, PredictionSnapshotDto } from '@gusvoice/shared';

/** Test-only: каждый контрфакт меняет полный модуль только в памяти. Никаких регистраторов node:test. */
export const sourceOf = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export type Edit = readonly [from: string, to: string];
export type LazyEdit = Edit | (() => Edit);
export function edited(source: string, [from, to]: Edit): string {
  assert.equal(source.split(from).length - 1, 1, `R338 setup: уникальный якорь ${from}`);
  return source.replace(from, to);
}
export function load<T>(source: string, deps: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} as T };
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const imports = testVmImports(new URL('./components/Predictions.tsx', import.meta.url), { './GameRules': { GameRules }, ...deps });
  runInNewContext(compiled, { module, exports: module.exports, URL, Error, TypeError, ...globals,
    require: imports,
  });
  return module.exports;
}
export function paired(source: string, check: (raw: string) => void, edits: readonly LazyEdit[], prefix: string): void {
  check(source);
  for (const edit of edits) {
    counterfact(() => {
      const mutant = edited(source, typeof edit === 'function' ? edit() : edit);
      assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
        'контрфакт убит адресным host AssertionError, не setup/import/исключением');
    });
    check(source);
  }
}
export async function pairedAsync(source: string, check: (raw: string) => Promise<void>, edits: readonly LazyEdit[], prefix: string): Promise<void> {
  await check(source);
  for (const edit of edits) {
    await counterfact(async () => {
      const mutant = edited(source, typeof edit === 'function' ? edit() : edit);
      await assert.rejects(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix),
        'контрфакт убит адресным host AssertionError, не setup/import/HTTP 500');
    });
    await check(source);
  }
}
export const normal = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const NOW = Date.parse('2026-10-28T12:00:00Z');
export const iso = (offset = 0) => new Date(NOW + offset).toISOString();
export class FixedDate extends Date {
  constructor(value?: string | number | Date) { super(value === undefined ? NOW : value instanceof Date ? value.getTime() : value); }
  static override now() { return NOW; }
}
export function question(id = 'q'): PredictionQuestionDto {
  return { id, pos: 0, question: 'Кто выиграет?', options: [
    { id: 'a', label: 'Альфа', pool: 100, bettors: 1 }, { id: 'b', label: 'Бета', pool: 200, bettors: 1 },
  ], pool: 300, winnerOptionId: null, void: false, fee: null, bets: [], mine: null };
}
export function event(id = 'event', patch: Partial<PredictionEventDto> = {}): PredictionEventDto {
  return { id, serverId: 's', title: 'Событие', createdBy: 'creator', state: 'open', lockAt: iso(60_000),
    createdAt: iso(-1_000), lockedAt: null, settledAt: null, cancelReason: null, autoCancelAt: null,
    feePercent: 10, questions: [question()], ...patch };
}
export const snapshot = (events = [event()]): PredictionSnapshotDto => ({
  serverId: 's', serverNow: iso(5_000), enabled: true, betMax: 321, canManage: true, events,
});
export const noop = () => {};
export const flush = () => new Promise<void>(resolve => setImmediate(resolve));
