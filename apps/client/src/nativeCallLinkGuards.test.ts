import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

it('R119 ответ по ссылке звонка требует совпадения id и фазы ringing после resync', () => {
  // Не исполняем вырезанную функцию с искусственным store: проверяем AST ветки настоящего обработчика.
  const raw = readFileSync(new URL('./nativeUnifiedPush.ts', import.meta.url), 'utf8');
  const check = (source: string) => {
    const ast = ts.createSourceFile('push.ts', source, ts.ScriptTarget.Latest, true);
    const branches: ts.IfStatement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && node.expression.getText(ast) === "link.startsWith('call:')") branches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast); assert.equal(branches.length, 1);
    const body = branches[0]!.thenStatement.getText(ast);
    assert.match(body, /if\s*\(!callId\s*\|\|\s*!dmId\)\s*return/);
    assert.match(body, /await s\.loadDms\(\);\s*await s\.selectDm\(dmId\)/);
    assert.match(body, /if\s*\(call\.call\?\.id\s*!==\s*callId\)\s*await call\.resync\(\)/);
    assert.match(body, /const now = useCall\.getState\(\)\.call;\s*if\s*\(now\?\.id\s*===\s*callId\s*&&\s*now\.phase\s*===\s*'ringing'\)\s*await useCall\.getState\(\)\.answer\(\)/,
      'ответ только совпавшему звонящему вызову');
  };
  check(raw);
  for (const [from, to] of [
    [" && now.phase === 'ringing'", ''], ['now?.id === callId && ', ''],
    ['const now = useCall.getState().call;', 'const now = call.call;'],
  ]) {
    assert.ok(raw.includes(from!), 'якорь защиты существует');
    assert.throws(() => check(raw.replace(from!, to!)), assert.AssertionError);
  }
});
