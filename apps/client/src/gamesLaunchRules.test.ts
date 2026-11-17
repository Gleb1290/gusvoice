import assert from 'node:assert/strict';
import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { GamesLaunchDto } from '@gusvoice/shared';
import type { launchNoticeDue } from './gamesLaunchRules';

const source = readFileSync(new URL('./gamesLaunchRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string) {
  const module = { exports: {} as { launchNoticeDue: typeof launchNoticeDue } };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, require(id: string) {
    assert.fail(`R351/подготовка/rules/неожиданный-импорт/${id}`);
  } }, { timeout: 2_000 });
  return module.exports.launchNoticeDue;
}
function guarded(check: (due: typeof launchNoticeDue) => void, needle: string, next: string, address: string) {
  check(load(source));
  counterfact(() => {
    assert.equal(source.split(needle).length, 2, 'R351/подготовка/rules/unique');
    assert.throws(() => check(load(source.replace(needle, next))), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  check(load(source));
}
const launch: GamesLaunchDto = { at: '2026-09-29T10:00:00.000Z', gift: 500, mine: 0 };
const at = Date.parse(launch.at);
const json = (value: unknown) => JSON.stringify(value);

// Сцена знакомит с играми при первом входе даже спустя месяц: старое окно семь суток больше не контракт.
it('R351 непросмотренный запуск тридцать суток назад показывается без срока давности', () => {
  guarded(due => {
    for (const age of [0, 7 * 86_400_000, 30 * 86_400_000]) {
      assert.equal(json(due('server-a', launch, false, at + age)), json({ serverId: 'server-a', ...launch }), 'R351/due/no-window');
    }
  }, 'if (!launch || seen || !Number.isFinite(Date.parse(launch.at))) return null;',
  'if (!launch || seen || !Number.isFinite(Date.parse(launch.at)) || (_now ?? Date.now()) - Date.parse(launch.at) > 7 * 86_400_000) return null;',
  'R351/due/no-window');
});
// Проверка отсутствия запуска и отметки просмотра сохраняется вместе с принимающей парой.
it('R351 сервер без запуска и уже видевший сцену молчат, непросмотренный запуск принимается', () => {
  guarded(due => {
    for (const absent of [null, undefined]) assert.equal(due('server-a', absent, false, at), null, 'R351/due/absent');
    assert.equal(due('server-a', launch, true, at), null, 'R351/due/seen');
    assert.notEqual(due('server-a', launch, false, at), null, 'R351/due/unseen');
  }, '!launch || seen || ', '!launch || ', 'R351/due/seen');
});
// Негодная дата не превращается в вечное приглашение, а допустимый снимок не пересчитывает подарки.
it('R351 негодная дата не показывает сцену, корректная сохраняет подарок и мою долю без мутации', () => {
  guarded(due => {
    for (const invalid of ['not-a-date', '']) assert.equal(due('server-a', { ...launch, at: invalid }, false, at), null, 'R351/due/invalid-date');
    const input = { ...launch, gift: 0, mine: 150 };
    assert.equal(json(due('server-b', input, false, at)), json({ serverId: 'server-b', ...input }), 'R351/due/payload');
    assert.equal(json(input), json({ ...launch, gift: 0, mine: 150 }));
  }, ' || !Number.isFinite(Date.parse(launch.at))', '', 'R351/due/invalid-date');
});
