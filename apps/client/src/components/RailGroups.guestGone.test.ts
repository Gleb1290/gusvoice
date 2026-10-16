import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./RailGroups.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function parse(raw: string) {
  const file = ts.createSourceFile('RailGroups.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = file.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'RailGroups');
  assert.ok(component?.body, 'проверяется реальный RailGroups, а не подставленный фрагмент');
  const headers: ts.JsxOpeningElement[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) && n.tagName.getText(file) === 'button') {
      const attr = n.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(file) === 'className');
      if (attr?.initializer && /(?:srv-group-head|rail-group-head) go/.test(attr.initializer.getText(file))) {
        let parent: ts.Node | undefined = n.parent, foreign = false;
        while (parent && parent !== component) {
          if (ts.isConditionalExpression(parent) && parent.condition.getText(file) === 'group.live'
            && n.pos >= parent.whenFalse.pos && n.end <= parent.whenFalse.end) foreign = true;
          parent = parent.parent;
        }
        assert.equal(foreign, true, 'заголовок находится в чужой ветке group.live'); headers.push(n);
      }
    }
    ts.forEachChild(n, walk);
  };
  const desktop = component.body.statements.filter(ts.isReturnStatement);
  const rows = component.body.statements.find((n): n is ts.IfStatement => ts.isIfStatement(n) && n.expression.getText(file) === 'rows');
  assert.equal(desktop.length, 1); assert.ok(rows && ts.isBlock(rows.thenStatement));
  const phone = rows.thenStatement.statements.filter(ts.isReturnStatement); assert.equal(phone.length, 1);
  assert.ok(desktop[0]!.expression); assert.ok(phone[0]!.expression);
  // Только реально возвращаемая разметка обеих раскладок, не JSX-приманка в невызываемой локальной функции.
  walk(desktop[0]!.expression); walk(phone[0]!.expression);
  headers.sort((a, b) => a.pos - b.pos);
  assert.equal(headers.length, 2, 'и строки телефона, и рейл ПК');
  return { file, component, headers };
}
function headerGuard(raw = source) {
  const { file, headers } = parse(raw);
  for (const header of headers) {
    const attrs = new Map(header.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.getText(file), a]));
    const expression = (name: string) => {
      const value = attrs.get(name)?.initializer; return value && ts.isJsxExpression(value) ? value.expression : undefined;
    };
    assert.equal(expression('disabled')?.getText(file), 'busy === `head:${group.key}`', 'R234-header-disabled: недоступность не блокирует нативные события заголовка');
    assert.equal(expression('aria-disabled')?.getText(file), '!group.reachable || undefined', 'R234-header-aria: недоступность объявлена семантически');
    const context = expression('onContextMenu');
    assert.equal(!!context && ts.isArrowFunction(context) && context.body.getText(file) === 'groupMenu(e, group)', true,
      'R234-header-context: правый клик без проверки reachable передаётся меню');
    const click = expression('onClick');
    assert.equal(!!click && ts.isArrowFunction(click) && click.body.getText(file) === 'group.reachable && void goToInstance(group)', true,
      'R234-header-click: обычный клик всё ещё запрещает переход в недоступную группу');
  }
}
function menuGuard(raw = source) {
  const { component, file } = parse(raw);
  const fn = component.body!.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'groupMenu');
  assert.ok(fn?.body, 'меню объявлено в том же живом компоненте');
  const statements = fn.body.statements;
  assert.equal(statements.length, 3);
  assert.equal(statements[0]!.getText(file), 'if (!group.guest || !onGroupMenu) return;', 'R234-group-menu-guard: меню требует гостевую группу и обработчик, не reachable');
  assert.equal(statements[1]!.getText(file), 'e.preventDefault();');
  assert.equal(statements[2]!.getText(file), 'onGroupMenu(e, group);');
}
it('R234 оба чужих заголовка доступны правому клику даже с aria-disabled, обычный переход остаётся под гейтом', () => headerGuard());
it('R234 обработчик меню внутри RailGroups не отсекает серые гостевые группы', () => menuGuard());
for (const [index, label] of ['телефон', 'ПК'].entries()) for (const mutation of [
  { label: 'нативный disabled по reachable', from: 'disabled={busy === `head:${group.key}`}', to: 'disabled={!group.reachable || busy === `head:${group.key}`}', prefix: 'R234-header-disabled:', actual: '!group.reachable || busy === `head:${group.key}`', expected: 'busy === `head:${group.key}`' },
  { label: 'правый клик отсекает серую группу', from: 'onContextMenu={(e) => groupMenu(e, group)}', to: 'onContextMenu={(e) => group.reachable && groupMenu(e, group)}', prefix: 'R234-header-context:', actual: false, expected: true },
  { label: 'недоступность без aria-disabled', from: 'aria-disabled={!group.reachable || undefined}', to: 'data-disabled={!group.reachable || undefined}', prefix: 'R234-header-aria:', actual: undefined, expected: '!group.reachable || undefined' },
]) it(`R234 контрфакт заголовка ${label}: ${mutation.label}`, () => {
  headerGuard(source);
  const { file, headers } = parse(source), anchor = headers[index]!.getText(file);
  assert.equal(source.split(anchor).length - 1, 1); assert.equal(anchor.split(mutation.from).length - 1, 1);
  const changed = source.replace(anchor, anchor.replace(mutation.from, mutation.to));
  assert.throws(() => headerGuard(changed), e => e instanceof assert.AssertionError && e.message.startsWith(mutation.prefix)
    && e.operator === 'strictEqual' && e.actual === mutation.actual && e.expected === mutation.expected);
});
it('R234 контрфакт обработчика меню: недоступную группу ошибочно отсекает reachable', () => {
  menuGuard(source); const anchor = 'if (!group.guest || !onGroupMenu) return;'; assert.equal(source.split(anchor).length - 1, 1);
  const changed = 'if (!group.guest || !onGroupMenu || !group.reachable) return;';
  assert.throws(() => menuGuard(source.replace(anchor, changed)), e => e instanceof assert.AssertionError && e.message.startsWith('R234-group-menu-guard:')
    && e.operator === 'strictEqual' && e.actual === changed && e.expected === anchor);
});
