import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
interface Block { header: string; body: string; children: Block[] }
function blocks(raw: string): Block[] {
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, ''), result: Block[] = [];
  let cursor = 0;
  while (cursor < code.length) {
    const open = code.indexOf('{', cursor); if (open < 0) break;
    let end = open + 1, depth = 1;
    while (end < code.length && depth) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; end++; }
    assert.equal(depth, 0, 'CSS сбалансирован');
    const header = code.slice(cursor, open).trim().replace(/\s+/g, ' '), body = code.slice(open + 1, end - 1);
    result.push({ header, body, children: header.startsWith('@') ? blocks(body) : [] }); cursor = end;
  }
  return result;
}
function phoneBlocks(raw: string) { return blocks(raw).filter(block => block.header === '@media (max-width: 700px)').flatMap(block => block.children); }
function declarations(rules: Block[], selector: string) {
  const result = new Map<string, string>();
  for (const rule of rules) if (rule.header.split(',').map(s => s.trim()).includes(selector)) for (const pair of rule.body.split(';')) {
    const colon = pair.indexOf(':'); if (colon >= 0) result.set(pair.slice(0, colon).trim(), pair.slice(colon + 1).trim());
  }
  return result;
}
function check(raw = css) {
  const phone = phoneBlocks(raw);
  assert.equal(declarations(phone, '.stranger-bar-btn').get('white-space'), 'nowrap', 'R238 stranger-nowrap: подпись кнопки не переносится');
  assert.equal(declarations(phone, '.stranger-bar-btn').get('text-overflow'), 'ellipsis', 'R238 stranger-ellipsis: сжатая подпись заканчивается многоточием');
  assert.equal(declarations(phone, '.stranger-bar-actions').get('min-width'), '0', 'R238 stranger-min: действия допускают сжатие в телефонной строке');
}
it('R238 плашка незнакомца при ширине до 700px сохраняет однострочные обрезаемые подписи и сжимаемые действия', () => {
  // Это проверка настоящего scoped CSS; happy-dom не измеряет переносы, ellipsis или ширину кнопки.
  check();
});
it('R238 потеря nowrap ellipsis или min-width ловится внутри нужного media, не подменяется комментарием или правилом ПК', () => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [selector, property, value, prefix] of [
    ['.stranger-bar-btn', 'white-space', 'nowrap', 'R238 stranger-nowrap:'],
    ['.stranger-bar-btn', 'text-overflow', 'ellipsis', 'R238 stranger-ellipsis:'],
    ['.stranger-bar-actions', 'min-width', '0', 'R238 stranger-min:'],
  ]) {
    check();
    const selected = phoneBlocks(clean).filter(block => block.header === selector);
    assert.equal(selected.length, 1);
    const anchor = `${selector} {${selected[0].body}}`;
    assert.equal(clean.split(anchor).length - 1, 1);
    const declaration = `${property}: ${value};`;
    assert.equal(anchor.split(declaration).length - 1, 1);
    const mutant = clean.replace(anchor, anchor.replace(declaration, '')) + `\n/* ${anchor} */\n${selector} { ${declaration} }`;
    assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.startsWith(prefix) &&
      e.operator === 'strictEqual' && e.actual === undefined && e.expected === value);
  }
});
