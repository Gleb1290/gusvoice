import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { plural } from '../dmRowRules';
import type { DmChannel } from '@gusvoice/shared';
import type * as API from './dmClearActions';

function fixture(answer: { option: boolean } | null) {
  const calls: string[] = []; const windows: { option: { checked: boolean }; title: string; body: string }[] = [];
  const module = { exports: {} };
  const state = {
    clearConvHistory: async (id: string, scope: string) => { calls.push(`clear:${id}:${scope}`); },
    hideConv: async (id: string, scope: string) => { calls.push(`hide:${id}:${scope}`); },
  };
  const imports: Record<string, unknown> = { '../confirm': { confirmWithOption: async (p: typeof windows[number]) => { windows.push(p); return answer; } }, '../store': { useStore: { getState: () => state } }, '../dmRowRules': { plural }, '../toast': { toastError: (e: unknown) => { throw e; } } };
  runInNewContext(ts.transpileModule(readFileSync(new URL('./dmClearActions.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(id in imports); return imports[id]; } });
  return { api: module.exports as typeof API, calls, windows };
}
const dm = (id: string): DmChannel => ({ id, createdAt: '', lastMessageAt: null, unread: 0, otherUser: { id, username: id, displayName: id, avatarUrl: null } });
it('одна и несколько бесед чистятся одним подтверждением с me по умолчанию или both по галочке', async () => {
  // Массовое действие не должно открывать N окон или незаметно удалять копию собеседника.
  for (const option of [false, true]) for (const ids of [['a'], ['a', 'b']]) {
    const f = fixture({ option }); await f.api.clearHistories(ids.map(dm));
    assert.equal(f.windows.length, 1); assert.equal(f.windows[0].option.checked, false);
    assert.deepEqual(f.calls, ids.map((id) => `clear:${id}:${option ? 'both' : 'me'}`));
    const del = fixture({ option }); await del.api.deleteChats(ids.map(dm));
    assert.equal(del.windows.length, 1); assert.equal(del.windows[0].option.checked, false);
    assert.deepEqual(del.calls, ids.map((id) => `hide:${id}:${option ? 'both' : 'me'}`));
  }
});
it('отказ и пустой выбор не делают запросов удаления или очистки', async () => {
  // Закрытие опасного окна не является согласием, даже в пачке из одной беседы.
  for (const ids of [[], ['a'], ['a', 'b']]) {
    const f = fixture(null);
    assert.equal(await f.api.clearHistories(ids.map(dm)), false, 'отмена не завершает режим выбора');
    assert.equal(await f.api.deleteChats(ids.map(dm)), false);
    assert.deepEqual(f.calls, []); assert.equal(f.windows.length, ids.length ? 2 : 0);
  }
});

it('окна очистки и удаления используют подпись контакта, а без nameOf — имя профиля', async () => {
  // Человек узнаёт, для кого включена опция удаления у собеседника; в старом вызове остаётся прежнее имя профиля.
  const conversation = { ...dm('conv-a'), otherUser: { ...dm('peer-a').otherUser, displayName: 'Имя профиля' } };
  for (const action of ['clearHistory', 'deleteChat'] as const) {
    const signed = fixture(null);
    const calls: Array<[string, string]> = [];
    const nameOf = (id: string, fallback: string) => { calls.push([id, fallback]); return 'Сосед по мастерской'; };
    assert.equal(await signed.api[action](conversation, nameOf), false);
    assert.match(signed.windows[0]!.body, /а Сосед по мастерской (её|переписку) по-прежнему увидит/);
    assert.deepEqual(calls, [['peer-a', 'Имя профиля']], 'резолвер получает пользователя и имя профиля, а не id беседы');
    const plain = fixture(null);
    assert.equal(await plain.api[action](conversation), false);
    assert.match(plain.windows[0]!.body, /а Имя профиля (её|переписку) по-прежнему увидит/);
  }
});
