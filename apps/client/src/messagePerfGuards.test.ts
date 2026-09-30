import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const paneText = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
const pane = ts.createSourceFile('MessagePane.tsx', paneText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const linkGuard = readFileSync(new URL('./linkGuard.tsx', import.meta.url), 'utf8');
const animated = readFileSync(new URL('./avatarAnimation.ts', import.meta.url), 'utf8');
const guest = readFileSync(new URL('./components/GuestMark.tsx', import.meta.url), 'utf8');

function nodes<T extends ts.Node>(root: ts.Node, accept: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  function visit(node: ts.Node): void {
    if (accept(node)) out.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return out;
}

function declaration(name: string): ts.VariableDeclaration {
  const found = nodes(pane, ts.isVariableDeclaration).find((node) => node.name.getText(pane) === name);
  assert.ok(found, `нет ${name}`);
  return found;
}

function openings(name: string): ts.JsxOpeningLikeElement[] {
  return nodes(pane, (node): node is ts.JsxOpeningLikeElement =>
    (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(pane) === name);
}

describe('стражи производительности ленты сообщений', () => {
  it('лента и строка остаются memo-компонентами', () => {
    // Ловит возвращение 344 мс на букву при 2000 сообщениях из-за полной пересборки ленты.
    for (const name of ['MessageList', 'MessageRow']) {
      const init = declaration(name).initializer;
      assert.ok(init && ts.isCallExpression(init) && init.expression.getText(pane) === 'memo', name);
    }
  });

  it('обе границы memo получают действия по стабильной ссылке и без свежих стрелок или объектов', () => {
    // Ловит невидимый откат memo из-за новой функции либо литерала объекта в JSX-пропсе.
    const acts = declaration('rowActs').initializer;
    assert.ok(acts && ts.isCallExpression(acts) && acts.expression.getText(pane) === 'useMemo');
    assert.equal(acts.arguments[1]?.getText(pane), '[]');
    for (const [component, value] of [['MessageList', 'rowActs'], ['MessageRow', 'p.act']] as const) {
      const tags = openings(component);
      assert.equal(tags.length, 1, `ожидается одна граница ${component}`);
      const attrs = tags[0]!.attributes.properties.filter(ts.isJsxAttribute);
      const act = attrs.find((attr) => attr.name.getText(pane) === 'act');
      assert.ok(act?.initializer && ts.isJsxExpression(act.initializer));
      assert.equal(act.initializer.expression?.getText(pane), value);
      for (const attr of attrs) {
        if (!attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) continue;
        const expr = attr.initializer.expression;
        assert.equal(ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) || ts.isObjectLiteralExpression(expr), false,
          `${component}.${attr.name.getText(pane)} создаёт новый пропс`);
      }
    }
  });

  it('время и умолчания резолверов не создаются заново на каждую строку', () => {
    // Ловит дорогой Intl на каждом сообщении и новую функцию при каждом рендере без переданных пропсов.
    for (const name of ['TIME_FMT', 'PLAIN_NAME', 'NO_EMOJI_BY_ID']) assert.ok(declaration(name));
    assert.match(paneText, /nameOf = PLAIN_NAME/);
    assert.match(paneText, /emojiById = NO_EMOJI_BY_ID/);
    assert.match(declaration('MessageRow').getText(pane), /TIME_FMT\.format\(new Date\(m\.createdAt\)\)/);
    assert.doesNotMatch(declaration('MessageRow').getText(pane), /\.toLocaleTimeString\(/);
  });

  it('изоляция раскладки ленты и портал ссылки остаются вместе', () => {
    // Ловит возврат раскладки 53 тысяч DOM-узлов на букву и обрезанное модальное окно ссылки.
    const messagesRule = css.match(/\.messages\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(messagesRule, /\bcontain:\s*strict\s*;/);
    assert.match(linkGuard, /return createPortal\([\s\S]*?,\s*document\.body,\s*\)/);
  });

  it('оба ростерных резолвера мемоизированы от ростера, а анимация — ещё и от выключателя', () => {
    // Ловит свежую функцию на каждую букву; идентичность функции без React-среды тут не исполнить.
    assert.match(animated, /return useMemo\(\(\) => \{[\s\S]*?if \(!on\) return \(\) => undefined;[\s\S]*?\}, \[on, members\]\)/);
    assert.match(guest, /return useMemo\(\(\) => \{[\s\S]*?\}, \[members\]\)/);
  });
});
