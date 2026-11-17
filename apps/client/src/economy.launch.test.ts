import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { GAMES_LAUNCH_GIFT } from '@gusvoice/shared';
import type * as Economy from './economy';

const source = readFileSync(new URL('./economy.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw: string, window: object = {}) {
  const module = { exports: {} as typeof Economy };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { module, exports: module.exports, window, require(id: string) {
    assert.fail(`R343/подготовка/economy/unexpected-import/${id}`);
  } }, { timeout: 2_000 });
  return module.exports;
}
function guarded(check: (raw: string) => void, needle: string, next: string, address: string) {
  check(source);
  counterfact(() => {
    assert.equal(source.split(needle).length, 2, 'R343/подготовка/economy/unique');
    assert.throws(() => check(source.replace(needle, next)), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  });
  check(source);
}

it('R343 запуск виден только при явных gamesLaunch=null и gamesLocked=false, не на старом сервере', () => {
  guarded(raw => {
    const { launchButtonVisible } = load(raw);
    const launch = { at: '2026-10-29T10:00:00.000Z', gift: 500, mine: 0 };
    for (const gamesLaunch of [undefined, null, launch]) for (const gamesLocked of [undefined, false, true]) {
      assert.equal(launchButtonVisible({ gamesLaunch, gamesLocked }), gamesLaunch === null && gamesLocked === false,
        'R343/economy/launch-visibility');
    }
  }, 'v.gamesLaunch === null && v.gamesLocked === false', 'v.gamesLaunch == null && v.gamesLocked === false', 'R343/economy/launch-visibility');
});
it('R343 замок прячет включение игр, но не выключение уже включённых и не старый сервер', () => {
  guarded(raw => {
    const { gamesToggleVisible } = load(raw);
    for (const locked of [undefined, false, true]) for (const loaded of [false, true]) {
      assert.equal(gamesToggleVisible(locked, loaded), locked !== true || loaded, 'R343/economy/toggle-visibility');
    }
  }, 'gamesLocked !== true || loadedGamesOn', 'gamesLocked !== true', 'R343/economy/toggle-visibility');
});
it('R343 ползунок запуска побайтово совпадает с настоящими общими min/max/step/default', () => {
  guarded(raw => {
    assert.equal(JSON.stringify(load(raw).LAUNCH_GIFT_SLIDER), JSON.stringify(GAMES_LAUNCH_GIFT), 'R343/economy/gift-slider');
  }, 'export const LAUNCH_GIFT_SLIDER = { min: 0, max: 2000, step: 50, default: 500 }',
  'export const LAUNCH_GIFT_SLIDER = { min: 0, max: 2000, step: 1, default: 500 }', 'R343/economy/gift-slider');
});
it('R343 отметка просмотра записывается и очищается только для своего сервера', () => {
  guarded(raw => {
    const e = load(raw);
    const values = new Map<string, string>();
    const calls: string[] = [];
    const store = { getItem: (key: string) => values.get(key) ?? null,
      setItem(key: string, value: string) { calls.push(`set:${key}:${value}`); values.set(key, value); },
      removeItem(key: string) { calls.push(`remove:${key}`); values.delete(key); } };
    assert.equal(e.readLaunchSeen(store, 'server-a'), false);
    e.writeLaunchSeen(store, 'server-a');
    assert.equal(e.readLaunchSeen(store, 'server-a'), true, 'R343/economy/seen-write');
    assert.equal(e.readLaunchSeen(store, 'server-b'), false, 'R343/economy/server-isolation');
    e.writeLaunchSeen(store, 'server-b'); e.clearLaunchSeen(store, 'server-a');
    assert.equal(e.readLaunchSeen(store, 'server-a'), false, 'R343/economy/seen-clear');
    assert.equal(e.readLaunchSeen(store, 'server-b'), true, 'R343/economy/server-isolation');
    assert.deepEqual(calls, ['set:gv_games_launch_seen:server-a:1', 'set:gv_games_launch_seen:server-b:1', 'remove:gv_games_launch_seen:server-a']);
  }, 'return `gv_games_launch_seen:${serverId}`;', "return 'gv_games_launch_seen';", 'R343/economy/server-isolation');
});
it('R343 чтение бросающего хранилища и отсутствие хранилища равны непросмотренному объявлению', () => {
  guarded(raw => {
    const e = load(raw);
    const broken = { getItem() { throw new Error('storage disabled'); } };
    assert.equal(e.readLaunchSeen(broken, 'server-a'), false, 'R343/economy/read-throws');
    for (const absent of [null, undefined]) assert.equal(e.readLaunchSeen(absent, 'server-a'), false);
    assert.equal(e.readLaunchSeen({ getItem: () => '1' }, 'server-a'), true);
  }, 'return !!store?.getItem(launchSeenKey(serverId));\n  } catch {\n    return false;',
  'return !!store?.getItem(launchSeenKey(serverId));\n  } catch {\n    return true;', 'R343/economy/read-throws');
});
it('R343 запрет записи и очистки не ломает интерфейс, доступное хранилище принимает обе операции', () => {
  guarded(raw => {
    const e = load(raw);
    const broken = { setItem() { throw new Error('quota'); }, removeItem() { throw new Error('disabled'); } };
    let writeFailed = false;
    let clearFailed = false;
    try { e.writeLaunchSeen(broken, 'server-a'); } catch { writeFailed = true; }
    try { e.clearLaunchSeen(broken, 'server-a'); } catch { clearFailed = true; }
    assert.equal(writeFailed, false, 'R343/economy/write-throws');
    assert.equal(clearFailed, false, 'R343/economy/clear-throws');
    for (const absent of [null, undefined]) {
      e.writeLaunchSeen(absent, 'server-a'); e.clearLaunchSeen(absent, 'server-a');
    }
    let key = '';
    e.writeLaunchSeen({ setItem(next) { key = next; } }, 'server-a');
    assert.equal(key, 'gv_games_launch_seen:server-a');
  }, '/* хранилище недоступно — страховка на сессию у `MainLayout` */',
  "throw new Error('quota');", 'R343/economy/write-throws');
});
it('R343 launchStorage возвращает доступный localStorage и null, если его getter запрещён', () => {
  guarded(raw => {
    const storage = {};
    assert.equal(load(raw, { localStorage: storage }).launchStorage(), storage, 'R343/economy/storage-present');
    const broken = Object.defineProperty({}, 'localStorage', { get() { throw new Error('SecurityError'); } });
    assert.equal(load(raw, broken).launchStorage(), null, 'R343/economy/storage-denied');
  }, 'return window.localStorage;', 'return null;', 'R343/economy/storage-present');
});
it('R343 отказ removeItem тоже безопасен, а доступная очистка действительно снимает отметку', () => {
  guarded(raw => {
    const e = load(raw);
    let failed = false;
    try { e.clearLaunchSeen({ removeItem() { throw new Error('disabled'); } }, 'server-a'); } catch { failed = true; }
    assert.equal(failed, false, 'R343/economy/remove-throws');
    let removed = '';
    e.clearLaunchSeen({ removeItem(key) { removed = key; } }, 'server-a');
    assert.equal(removed, 'gv_games_launch_seen:server-a');
  }, '/* хранилище недоступно */', "throw new Error('disabled');", 'R343/economy/remove-throws');
});
