import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { DmChannel } from '@gusvoice/shared';
import * as rowRules from '../dmRowRules';
import * as listRules from '../dmListRules';
import * as convRules from '../convSyncRules';
import * as groupRules from '../groupChatRules';
import * as cornerRules from '../cornerButtonsRules';
import { StatusDot } from './StatusDot';

const source = readFileSync(new URL('./DmSidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const parse = (raw: string) => ts.createSourceFile('DmSidebar.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const unused = (name: string) => () => { throw new Error(`R284 непредметная граница: ${name}`); };
const noView = () => null;
const peer = { id: 'peer-distinct-from-dm', username: 'peer', displayName: 'Собеседник', avatarUrl: null };
const dm: DmChannel = { id: 'conversation-distinct-from-peer', otherUser: peer, createdAt: '2026-10-20T09:00:00Z', lastMessageAt: null };

function load(raw: string) {
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../dmRowRules': rowRules, '../dmListRules': listRules, '../convSyncRules': convRules,
    '../groupChatRules': groupRules, '../cornerButtonsRules': cornerRules,
    '../typing': { useTyping: () => [], useTypingAction: () => null, typingActionLabel: () => '' },
    '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback,
      dmPeerLabel: (value: DmChannel) => value.otherUser.displayName || value.otherUser.username },
    '../uiPrefs': { useSidebarNarrow: () => false, setNarrowAllowed: unused('setNarrowAllowed') },
    '../dmListView': { DM_ROW_AVA: 48, useListLines: unused('useListLines') },
    './Avatar': { Avatar: noView }, './SavedAvatar': { SavedAvatar: noView }, './Icon': { Icon: noView },
    './StatusDot': { StatusDot },
  };
  // Неиспользуемые ветки всего модуля закрыты по именам импортов: новый импорт не получает молчаливую заглушку.
  const dormant = new Set([
    '../api', '../hotkeys', '../store', '../dmOnline', '../useContactSeen', '../toast', '../dialogChrome', '../dmRules',
    '../channelRules', '../chatKeysRules', '../dmArchiveRules', '../dmCompose', '../phoneLayout', '../androidBack',
    '../connState', '../contactRules', '../contacts', './GroupDialogs', './DmRowMenu', './DmFolderBar', '../dmFolderView',
    '../dmFolders', '../dmListSearchRules', './DmServerSearch', './DmAllSearch', './DmListSearch', './DmArchive',
    '../dragOut', '../filesDrop', './DmListSwipe', './DmPinDrag', '../chatSwipe', './BottomSheet', './Goose',
    './SelfVoiceBar', './SettingsShell', './SharedMedia', './VoicePanel', '../voiceDrafts',
  ]);
  for (const node of parse(raw).statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const id = node.moduleSpecifier.text;
    if (Object.hasOwn(deps, id)) continue;
    assert.equal(dormant.has(id), true, `R284 объявленный импорт: ${id}`);
    const names = node.importClause?.namedBindings;
    assert.ok(names && ts.isNamedImports(names), `R284 именованный импорт: ${id}`);
    deps[id] = Object.fromEntries(names.elements.filter(n => !n.isTypeOnly)
      .map(n => [n.propertyName?.text ?? n.name.text, unused(`${id}:${n.name.text}`)]));
  }
  const module = { exports: {} as Pick<typeof import('./DmSidebar'), 'DmRow'> };
  // Настоящий memo-компонент, хуки React и StatusDot; исполнен полный модуль, не извлечённая копия строки.
  const code = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, { module, exports: module.exports,
    require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `R284 объявленный require: ${id}`); return deps[id]; },
  });
  return module.exports.DmRow;
}

function render(raw: string, online: boolean, peerAway?: boolean, phone = false) {
  return renderToStaticMarkup(React.createElement(load(raw), {
    dm, summary: undefined, meId: 'me', online, peerAway, phone,
    active: false, unread: false, unreadN: 0, draft: undefined, failed: false, query: '', onOpen() {},
  }));
}
const AWAY = 'R284-DM-AWAY: присутствующий отошедший собеседник получает луну';
const OFFLINE = 'R284-DM-OFFLINE: вне видимого online нет точки присутствия даже со статусом away';
const WIRING = 'R284-DM-WIRING: строка настоящей карты получает away своего собеседника из userStatuses';

function away(raw = source) {
  for (const phone of [false, true]) {
    const html = render(raw, true, true, phone);
    assert.equal(html.includes('stdot stdot-away'), true, AWAY);
    assert.equal(html.includes('stdot-online'), false, 'луна не дублируется зелёным кружком');
    assert.equal(html.includes('mp-dot-wrap'), true, 'луна остаётся на аватаре строки');
  }
}
function offline(raw = source) {
  for (const phone of [false, true]) for (const peerAway of [false, true]) {
    const html = render(raw, false, peerAway, phone);
    assert.equal(!html.includes('stdot'), true, OFFLINE);
    assert.equal(html.includes('mp-dot-wrap'), false, 'скрытый lastseen не оставляет пустую обёртку точки');
    assert.equal(html.includes('в сети'), false, 'скрытый lastseen не раскрывается в доступной подписи');
  }
}

function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node) => { if (predicate(child)) found.push(child); ts.forEachChild(child, visit); };
  visit(node); return found;
}
function property(node: ts.Node | undefined, base: string, ...path: string[]): boolean {
  if (!node) return false;
  if (!path.length) return ts.isIdentifier(node) && node.text === base;
  return ts.isPropertyAccessExpression(node) && node.name.text === path.at(-1)
    && property(node.expression, base, ...path.slice(0, -1));
}
function attr(node: ts.JsxSelfClosingElement, name: string): ts.Expression | undefined {
  const a = node.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText() === name);
  return a && ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
}
function wiring(raw = source) {
  const ast = parse(raw);
  const sidebar = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'DmSidebar');
  assert.ok(sidebar && ts.isFunctionDeclaration(sidebar) && sidebar.body, 'настоящая функция DmSidebar');
  const declarations = sidebar.body.statements.flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []);
  const statuses = declarations.find(d => ts.isIdentifier(d.name) && d.name.text === 'userStatuses')?.initializer;
  const selector = statuses && ts.isCallExpression(statuses) && property(statuses.expression, 'useStore') ? statuses.arguments[0] : undefined;
  const stateName = selector && ts.isArrowFunction(selector) ? selector.parameters[0]?.name : undefined;
  assert.equal(!!selector && ts.isArrowFunction(selector) && !!stateName && ts.isIdentifier(stateName)
    && property(selector.body, stateName.text, 'userStatuses'), true, WIRING);

  // Проверяется именно return DmRow внутри listRows.map, не пример JSX/строка/комментарий по соседству.
  const maps = descendants(sidebar.body, n => ts.isCallExpression(n) && property(n.expression, 'listRows', 'map'));
  assert.equal(maps.length, 1, 'единственная настоящая карта строк ЛС');
  const map = maps[0] as ts.CallExpression;
  const callback = map.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body), 'карта содержит исполняемый callback');
  const item = callback.parameters[0]?.name;
  assert.ok(item && ts.isIdentifier(item), 'карта объявляет свой элемент');
  const returned = callback.body.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(returned, 'карта возвращает JSX');
  const rows = descendants(returned, n => ts.isJsxSelfClosingElement(n) && property(n.tagName, 'DmRow'));
  assert.equal(rows.length, 1, 'карта возвращает одну настоящую DmRow');
  const row = rows[0] as ts.JsxSelfClosingElement;
  assert.equal(property(attr(row, 'dm'), item.text), true, 'строка получает тот же элемент карты');
  const away = attr(row, 'peerAway');
  const status = away && ts.isBinaryExpression(away) ? away.left : undefined;
  const index = status && ts.isPropertyAccessExpression(status) && status.name.text === 'status' ? status.expression : undefined;
  assert.equal(!!away && ts.isBinaryExpression(away) && away.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isStringLiteral(away.right) && away.right.text === 'away'
    && !!index && ts.isElementAccessExpression(index) && property(index.expression, 'userStatuses')
    && property(index.argumentExpression, item.text, 'otherUser', 'id'), true, WIRING);
  const online = attr(row, 'online');
  assert.equal(!!online && ts.isCallExpression(online) && property(online.expression, 'onlineSet', 'has')
    && property(online.arguments[0], item.text, 'otherUser', 'id'), true, 'видимость online остаётся отдельным lastseen-гейтом');
  const visible = declarations.find(d => property(d.name, 'onlineSet'))?.initializer;
  assert.equal(!!visible && ts.isCallExpression(visible) && property(visible.expression, 'useVisibleOnline'), true,
    'список сохраняет фильтрацию видимого присутствия');
}

it('R284 строка ЛС показывает луну присутствующему собеседнику away на ПК и телефоне', () => {
  // Класс ошибки: away игнорируется и заменяется прежней зелёной точкой.
  away();
});
it('R284 строка ЛС сохраняет зелёную точку online при false и отсутствии peerAway', () => {
  // Класс ошибки: необязательный статус ошибочно делает обычного собеседника отошедшим.
  for (const phone of [false, true]) for (const peerAway of [false, undefined]) {
    const html = render(source, true, peerAway, phone);
    assert.equal(html.includes('stdot stdot-online'), true);
    assert.equal(html.includes('stdot-away'), false);
  }
});
it('R284 строка ЛС не раскрывает скрытый online точкой даже при сохранённом away', () => {
  // Класс ошибки: userStatuses обходит приватность lastseen и рисует луну отсутствующему.
  offline();
});
it('R284 карта ЛС берёт peerAway по id собеседника и сохраняет видимый online', () => {
  // Класс ошибки: правильная изолированная строка не получает настоящий статус своего собеседника.
  wiring();
});

function mutant(from: string, to: string, scenario: (raw: string) => void, marker: string) {
  scenario(source);
  assert.equal(source.split(from).length - 1, 1, 'мутант имеет один якорь в полном модуле');
  assert.throws(() => scenario(source.replace(from, to)), (error: unknown) => error instanceof assert.AssertionError
    && error.message.split('\n')[0] === marker && error.operator === 'strictEqual'
    && error.actual === false && error.expected === true);
}
it('R284 контрфакт: строка всегда показывает online вместо away', () => {
  // Класс ошибки: зелёная точка маскирует статус отошедшего собеседника.
  mutant("status={peerAway ? 'away' : 'online'}", 'status="online"', away, AWAY);
});
it('R284 контрфакт: away рисуется без видимого online', () => {
  // Класс ошибки: луна раскрывает присутствие вопреки lastseen-гейту.
  mutant('{online && (', '{(online || peerAway) && (', offline, OFFLINE);
});
it('R284 контрфакт: карта ищет статус по id беседы вместо собеседника', () => {
  // Класс ошибки: два разных пространства идентификаторов обрывают передачу peerAway.
  mutant("peerAway={userStatuses?.[d.otherUser.id]?.status === 'away'}",
    "peerAway={userStatuses?.[d.id]?.status === 'away'}", wiring, WIRING);
});
it('R284 контрфакт: карта передаёт постоянный false вместо настоящего away', () => {
  // Класс ошибки: строка поддерживает луну, но список никогда не разрешает её показать.
  mutant("peerAway={userStatuses?.[d.otherUser.id]?.status === 'away'}", 'peerAway={false}', wiring, WIRING);
});
