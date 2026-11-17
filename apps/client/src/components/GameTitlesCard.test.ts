import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import type { GameTitleDto, GameTitlesDto } from '@gusvoice/shared';

const source = readFileSync(new URL('./GameTitlesCard.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Props = Record<string, any>;
type Element = React.ReactElement<Props>;
const elements = (node: React.ReactNode): Element[] => Array.isArray(node) ? node.flatMap(elements)
  : React.isValidElement<Props>(node) ? [node, ...elements(node.props.children)] : [];
const text = (node: React.ReactNode): string => Array.isArray(node) ? node.map(text).join('')
  : React.isValidElement<Props>(node) ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type Edit = { from: string; to: string };
function fixture(edit?: Edit) {
  const t: GameTitleDto = { key: shared.GAME_TITLE_KEYS[0], name: 'Своё', defaultName: 'Исходное', renamed: true,
    about: 'Повод', unit: 'count', holders: [] };
  const dto: GameTitlesDto = { month: null, titles: [t], canManage: true };
  const calls: unknown[][] = [], writes: unknown[][] = [], previews: unknown[] = [], errors: unknown[][] = [];
  let cursor = 0; const states: unknown[] = [];
  const state = { gameTitles: { server: dto }, setGameTitles: (...args: unknown[]) => writes.push(args), openRecap: (arg: unknown) => previews.push(JSON.parse(JSON.stringify(arg))) };
  const store = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
  const deps: Record<string, unknown> = {
    react: { ...React, useEffect() {}, useState(initial: unknown) {
      const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], (next: unknown) => { states[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(states[i]) : next; }];
    } }, 'react/jsx-runtime': jsx, '@gusvoice/shared': shared, '../store': { useStore: store },
    '../api': { api: { renameGameTitle: async (...args: unknown[]) => { calls.push(args); return dto; } } },
    '../benchMock': { isMockEconomy: () => false }, '../gameBoardClient': { ensureGameTitles() {} },
    '../toast': { toast: (...args: unknown[]) => errors.push(args), toastError: (...args: unknown[]) => errors.push(args) },
    './GameTitleChip': { GameTitleMark: () => null },
  };
  let raw = source;
  if (edit) { assert.equal(raw.split(edit.from).length, 2, 'R340 setup: адресный якорь TitleNameRow'); raw = raw.replace(edit.from, edit.to); }
  const module = { exports: {} as { __row: (p: Props) => React.ReactNode; GameTitlesCard: (p: Props) => React.ReactNode } };
  // Тестовая точка экспорта добавляется к ЦЕЛОМУ компоненту; обработчик save не вырезан/не скопирован.
  runInNewContext(ts.transpileModule(raw + '\nexport const __row = TitleNameRow;', { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, require(id: string) {
    assert.ok(Object.hasOwn(deps, id), `R340 setup: закрытый import ${id}`); return deps[id];
  } });
  return { calls, writes, previews, errors, render(canManage = true) { cursor = 0; return module.exports.__row({ serverId: 'server', t, canManage }); },
    card(enabled: boolean) { cursor = 0; return module.exports.GameTitlesCard({ serverId: 'server', gamesEnabled: enabled }); } };
}
type Fixture = ReturnType<typeof fixture>;
function paired(title: string, scenario: (f: Fixture) => void | Promise<void>, edit: Edit) {
  it(`R340 звания: ${title}`, async () => {
    await scenario(fixture());
    await counterfact(async () => {
      await assert.rejects(async () => scenario(fixture(edit)), e => e instanceof assert.AssertionError && e.message.startsWith('R340 карточка:'));
    });
    await scenario(fixture());
  });
}
const input = (tree: React.ReactNode) => { const found = elements(tree).find(e => e.type === 'input'); assert.ok(found, 'R340 карточка: поле названия есть'); return found; };
const normalizer = "const next = name?.replace(/\\s+/g, ' ').trim() || null;";

paired('кнопка «По умолчанию» отправляет null, а не буквальное имя', async f => {
  const button = elements(f.render()).find(e => e.type === 'button' && text(e) === 'По умолчанию');
  assert.ok(button, 'R340 карточка: кнопка сброса есть'); button.props.onClick(); await flush();
  assert.deepEqual(f.calls, [['server', shared.GAME_TITLE_KEYS[0], null]], 'R340 карточка: null означает сброс, не переименование');
  assert.equal(f.writes.length, 1, 'R340 карточка: ответ записан в стор');
}, { from: 'onClick={() => void save(null)}', to: 'onClick={() => void save(t.defaultName)}' });

for (const value of ['', ' \t ']) paired(`пустое поле ${JSON.stringify(value)} тоже отправляет null`, async f => {
  input(f.render()).props.onChange({ target: { value } }); input(f.render()).props.onBlur(); await flush();
  assert.deepEqual(f.calls, [['server', shared.GAME_TITLE_KEYS[0], null]], 'R340 карточка: пустое/пробельное имя — сброс');
}, { from: normalizer, to: "const next = name?.replace(/\\s+/g, ' ').trim() || '';" });

paired('обычное имя сохраняется со сжатыми пробелами', async f => {
  input(f.render()).props.onChange({ target: { value: '  Новый   заголовок  ' } }); input(f.render()).props.onBlur(); await flush();
  assert.deepEqual(f.calls, [['server', shared.GAME_TITLE_KEYS[0], 'Новый заголовок']], 'R340 карточка: нормализованное имя');
}, { from: normalizer, to: 'const next = name?.trim() || null;' });

paired('уход из неизменённого поля не делает сетевой записи', async f => {
  input(f.render()).props.onBlur(); await flush();
  assert.deepEqual(f.calls, [], 'R340 карточка: совпадающее имя не записывается повторно');
}, { from: "if ((next ?? '') === (t.renamed ? t.name : '')) return;", to: '' });

paired('без права поле отключено и сброс недоступен', f => {
  const tree = f.render(false);
  assert.equal(input(tree).props.disabled, true, 'R340 карточка: нет права — disabled');
  assert.equal(elements(tree).some(e => e.type === 'button'), false, 'R340 карточка: сброс не обходит право');
}, { from: 'disabled={!canManage || busy}', to: 'disabled={busy}' });

paired('61 символ отвергается, ровно 60 сохраняются', async f => {
  input(f.render()).props.onChange({ target: { value: 'а'.repeat(61) } }); input(f.render()).props.onBlur(); await flush();
  assert.equal(f.calls.length, 0, 'R340 карточка: слишком длинное не записано');
  assert.equal(f.errors.length, 1, 'R340 карточка: отказ объяснён');
  input(f.render()).props.onChange({ target: { value: 'а'.repeat(60) } }); input(f.render()).props.onBlur(); await flush();
  assert.equal(f.calls.length, 1, 'R340 карточка: ровно лимит принят');
}, { from: 'next.length > GAME_TITLE_NAME_MAX', to: 'next.length >= GAME_TITLE_NAME_MAX' });

paired('черновики обоих видов открываются как preview, выключенные игры не блокируют экономику', f => {
  let buttons = elements(f.card(false)).filter(e => e.type === 'button');
  assert.equal(buttons[0].props.disabled, true, 'R340 карточка: выключенные игры отключают свой preview');
  assert.notEqual(buttons[1].props.disabled, true, 'R340 карточка: экономика остаётся доступна');
  buttons = elements(f.card(true)).filter(e => e.type === 'button'); buttons.forEach(b => b.props.onClick());
  assert.deepEqual(f.previews, [{ serverId: 'server', kind: 'games', preview: true }, { serverId: 'server', kind: 'economy', preview: true }],
    'R340 карточка: оба preview не стали показом заморозки');
}, { from: "openRecap({ serverId, kind: 'games', preview: true })", to: "openRecap({ serverId, kind: 'games', preview: false })" });
