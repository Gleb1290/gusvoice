import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const source = readFileSync(new URL('./PhoneServerList.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
async function scene(canCreate: boolean, check: (host: HTMLDivElement, calls: string[]) => Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const calls: string[] = []; const server = { id: 's', name: 'Сервер', ownerId: 'owner' };
  const state = { servers: [server], user: { canCreateServers: canCreate }, switching: false, loadServers: async () => { calls.push('load'); } };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../store': { useStore: (pick: (s: typeof state) => unknown) => pick(state) },
    '../config': { activeInstanceId: () => 'home', instances: () => [] },
    './Icon': { Icon: () => null }, './Goose': { Goose: () => null },
    './BottomSheet': {
      BottomSheet: ({ children }: { children: React.ReactNode }) => React.createElement('section', { className: 'server-sheet' }, children),
      SheetRow: ({ label, onClick }: { label: string; onClick: () => void }) => React.createElement('button', { onClick }, label),
    },
    './RailGroups': { RailGroups: (p: { rows: boolean; onOpenLive: (id: string) => void; onMenu: (event: React.MouseEvent, s: typeof server) => void }) => {
      assert.equal(p.rows, true, 'список просит строки вместо рейла');
      return React.createElement('button', { className: 'server-row-boundary', onClick: () => p.onOpenLive('s'), onContextMenu: e => p.onMenu(e, server) }, 'Сервер');
    } },
    './ServerMenu': { selectServer: async (id: string) => { calls.push(`select:${id}`); },
      ServerMenu: (p: { menu: { id: string; name: string; ownerId: string }; onClose: () => void }) => {
        assert.equal(p.menu.id, 's'); assert.equal(p.menu.name, 'Сервер'); assert.equal(p.menu.ownerId, 'owner');
        return React.createElement('button', { className: 'server-menu', onClick: p.onClose }, 'Закрыть меню');
      } },
    './ServerActionModals': {
      JoinServerModal: (p: { onJoined: (id: string) => Promise<void> }) => React.createElement('button', { className: 'join-modal', onClick: () => void p.onJoined('joined') }, 'Присоединиться'),
      CreateServerModal: (p: { onCreated: (id: string) => Promise<void> }) => React.createElement('button', { className: 'create-modal', onClick: () => void p.onCreated('created') }, 'Создать'),
    },
  };
  const module = { exports: {} as typeof import('./PhoneServerList') };
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неописанный импорт ${id}`); return deps[id]; } });
    await React.act(async () => root.render(React.createElement(module.exports.PhoneServerList))); await check(host, calls);
  } finally {
    try { await React.act(async () => root.unmount()); } finally {
      host.remove(); GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}
const click = async (element: Element | null) => { assert.equal(element !== null, true, 'кнопка существует'); await React.act(async () => (element as HTMLButtonElement).click()); };
async function noCreate(host: HTMLDivElement, calls: string[]) {
  assert.equal(host.querySelector('.dm-fab')?.getAttribute('aria-label'), 'Войти по приглашению');
  await click(host.querySelector('.dm-fab')); assert.equal(host.querySelector('.server-sheet') === null, true, 'без права нет листа создания');
  assert.equal(host.querySelector('.create-modal') === null, true); assert.equal(host.querySelector('.join-modal') !== null, true);
  await click(host.querySelector('.join-modal')); assert.equal(calls.join(','), 'load,select:joined');
}
it('R174 без права создавать FAB сразу открывает приглашение, вступление перечитывает серверы и открывает новый', async () => {
  // Лист с недоступным созданием обещал бы действие, которое сервер запрещает.
  await scene(false, noCreate);
});
it('R174 право создавать показывает два варианта, каждый открывает своё окно без второго', async () => {
  // Парный разрешённый путь не даёт «исправить права» удалением создания для всех.
  for (const create of [true, false]) await scene(true, async (host, calls) => {
    await click(host.querySelector('.dm-fab')); assert.equal(host.querySelector('.server-sheet') !== null, true);
    const buttons = [...host.querySelectorAll('.server-sheet button')]; assert.equal(buttons.length, 2);
    await click(buttons.find(b => b.textContent === (create ? 'Создать сервер' : 'Войти по приглашению'))!);
    assert.equal(host.querySelector('.server-sheet') === null, true);
    assert.equal(host.querySelector(create ? '.join-modal' : '.create-modal') === null, true);
    await click(host.querySelector(create ? '.create-modal' : '.join-modal'));
    assert.equal(calls.join(','), `load,select:${create ? 'created' : 'joined'}`);
  });
});
it('R174 строка списка открывает сервер, контекст удержания передаёт сервер меню и закрывает его', async () => {
  // Жест удержания — граница RailGroups; здесь проверяем настоящие callbacks PhoneServerList, не таймер браузера.
  await scene(true, async (host, calls) => {
    await click(host.querySelector('.server-row-boundary')); assert.equal(calls.join(','), 'select:s');
    await React.act(async () => host.querySelector('.server-row-boundary')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 11, clientY: 12 })));
    assert.equal(host.querySelector('.server-menu') !== null, true); await click(host.querySelector('.server-menu')); assert.equal(host.querySelector('.server-menu') === null, true);
  });
});
it('R174 контрфакт листа создания без права отвергается настоящим FAB', async () => {
  // Мутант меняет весь компонент, исходное поведение проверяется первым.
  await scene(false, noCreate); const anchor = 'canCreate ? setSheet(true) : setShowJoin(true)'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(scene(false, noCreate, source.replace(anchor, 'true ? setSheet(true) : setShowJoin(true)')),
    e => e instanceof assert.AssertionError && e.message.includes('без права нет листа'));
});

const rail = readFileSync(new URL('./RailGroups.tsx', import.meta.url), 'utf8');
function railContract(raw = rail) {
  // AST/text wiring, не обещает проверку жеста удержания или сторонних инстансов в настоящем браузере.
  const tree = ts.createSourceFile('rail.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const badges: ts.VariableDeclaration[] = [];
  function visit(n: ts.Node) { if (ts.isVariableDeclaration(n) && n.name.getText(tree) === 'badge') badges.push(n); ts.forEachChild(n, visit); } visit(tree);
  // R180: с превью badge общий, без превью сохранён прежний приоритет упоминаний.
  assert.equal(badges.length, 1); assert.equal(badges[0]!.initializer?.getText(tree).replace(/\s+/g, ' ').trim(),
    's.closed ? 0 : last ? Math.max(s.unread, s.mentions) : s.mentions > 0 ? s.mentions : s.unread', 'приоритет badge упоминаний без превью');
  assert.match(raw, /const solo = !last && !line;/, 'центрирование только без обеих вторых строк');
  assert.match(raw, /dm-row srv-row\$\{solo \? ' srv-solo' : ''\}/, 'пустая подпись центрирует имя');
  assert.match(raw, /onContextMenu=\{\(e\) => \{\s*if \(!full\) return;\s*e.preventDefault\(\);\s*onMenu\(e, full\);/);
}
it('R174 строки RailGroups используют обращения перед непрочитанным и srv-solo без второй строки', () => {
  // Связь badge/line проверяется по настоящему JSX/AST, чистый расчёт строки покрыт отдельно.
  railContract();
});
it('R174 контрфакты badge непрочитанного вместо обращений и потерянного srv-solo отвергаются', () => {
  // Уникальный якорь не должен незаметно мутировать компьютерную ветку рейла.
  for (const [anchor, replacement] of [["? s.mentions\n                    : s.unread", "? s.unread\n                    : s.unread"], ["solo ? ' srv-solo' : ''", "solo ? '' : ''"]]) {
    const normalized = rail.replace(/\r\n/g, '\n');
    railContract(normalized); assert.equal(normalized.split(anchor).length - 1, 1);
    assert.throws(() => railContract(normalized.replace(anchor, replacement)), assert.AssertionError);
  }
});
it('R174 общее меню сервера содержит Открыть, переключение пушей и выход только не владельцу', () => {
  // Source wiring guard дополняет мок границы ServerMenu: список передаёт реальное общее меню, не свою копию действий.
  const full = readFileSync(new URL('./ServerMenu.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('ServerMenu.tsx', full, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = tree.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'ServerMenu');
  assert.equal(declaration !== undefined, true, 'общее меню существует'); const raw = declaration!.getText(tree);
  assert.equal(raw.includes('menu.id !== currentServerId'), true, 'Открыть только для другого сервера');
  assert.equal(raw.includes('label="Открыть"'), true); assert.equal(raw.includes('void selectServer(menu.id)'), true);
  assert.equal(raw.includes("'Включить пуши сервера' : 'Отключить пуши сервера'"), true, 'парные подписи пушей');
  assert.equal(raw.includes("setPushMuted('server', menu.id, !muted)"), true, 'пуши переключают конкретный сервер');
  assert.equal(raw.includes('menu.ownerId !== user?.id'), true, 'владелец не покидает свой сервер');
  assert.equal(raw.includes('label="Покинуть сервер"'), true); assert.equal(raw.includes('void leaveServerAsk(id, name)'), true);
});
