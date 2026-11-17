import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const boom = readFileSync(new URL('./components/gamesLaunchBoom.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
interface Rule { selectors: string[]; parents: string[]; body: string }

function rules(raw: string): Rule[] {
  // CSS разбирается текстом: happy-dom не рассчитывает расположение крестика и метрики шрифта.
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, value => ' '.repeat(value.length));
  const out: Rule[] = [];
  function scope(from: number, to: number, parents: string[]) {
    let start = from, quote = '', parens = 0;
    for (let i = from; i < to; i++) {
      const char = clean[i]!;
      if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') parens++;
      if (char === ')') parens--;
      if (char === ';' && parens === 0) { start = i + 1; continue; }
      if (char !== '{' || parens !== 0) continue;
      let depth = 1, end = i + 1, innerQuote = '';
      for (; end < to && depth; end++) {
        const next = clean[end]!;
        if (innerQuote) { if (next === '\\') end++; else if (next === innerQuote) innerQuote = ''; continue; }
        if (next === '"' || next === "'") innerQuote = next;
        else if (next === '{') depth++;
        else if (next === '}') depth--;
      }
      assert.equal(depth, 0, 'R352/typography/setup/balanced-css');
      const header = clean.slice(start, i).trim();
      if (/^@(media|supports|container|layer)\b/.test(header)) scope(i + 1, end - 1, [...parents, header]);
      else out.push({ selectors: header.split(',').map(value => value.trim()), parents, body: clean.slice(i + 1, end - 1) });
      i = end - 1; start = end;
    }
  }
  scope(0, clean.length, []);
  return out;
}

function declarations(body: string): Map<string, string> {
  // В data: есть «;», в clamp()/url() — скобки: они не являются границами объявлений.
  const out = new Map<string, string>();
  let start = 0, quote = '', parens = 0;
  for (let i = 0; i <= body.length; i++) {
    const char = body[i];
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') parens++;
    if (char === ')') parens--;
    if (i < body.length && (char !== ';' || parens !== 0)) continue;
    const part = body.slice(start, i), colon = part.indexOf(':');
    if (colon >= 0) out.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    start = i + 1;
  }
  return out;
}

function styles(all: Rule[], selector: string, predicate = (rule: Rule) => rule.parents.length === 0) {
  const found = all.filter(rule => rule.selectors.includes(selector) && predicate(rule));
  assert.ok(found.length, `R352/typography/setup/selector/${selector}`);
  return new Map(found.flatMap(rule => [...declarations(rule.body)]));
}
function exactFailure(action: () => unknown, address: string) {
  assert.throws(action, (error: unknown) =>
    error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
}
function cssPair(check: (raw: string) => void, makeMutant: () => string, address: string) {
  check(css); counterfact(() => exactFailure(() => check(makeMutant()), address)); check(css);
}

it('R352 Ruslan Display загружается локальным woff2 вместе с лицензией, без запрещённого CSP data:', () => {
  // Наличие @font-face недостаточно: data: блокируется font-src self, а потеря OFL ломает поставку шрифта.
  function check(raw: string, hasFile: (url: URL) => boolean = existsSync) {
    const faces = rules(raw).filter(rule => rule.selectors.includes('@font-face')
      && /^(['"])Ruslan Display\1$/.test(declarations(rule.body).get('font-family') || ''));
    assert.equal(faces.length, 1, 'R352/typography/font-face');
    const src = declarations(faces[0]!.body).get('src') || '';
    assert.equal(/\bdata:/i.test(src), false, 'R352/typography/font-file-not-data');
    assert.match(src, /^url\(\s*(['"])\.\/assets\/fonts\/RuslanDisplay-Regular\.woff2\1\s*\)\s+format\(\s*(['"])woff2\2\s*\)$/, 'R352/typography/font-url');
    const font = new URL('./assets/fonts/RuslanDisplay-Regular.woff2', import.meta.url);
    const license = new URL('./assets/fonts/OFL-RuslanDisplay.txt', import.meta.url);
    assert.ok(hasFile(font), 'R352/typography/font-file-exists');
    assert.ok(hasFile(license), 'R352/typography/font-license-exists');
    assert.equal(readFileSync(font).subarray(0, 4).toString('ascii'), 'wOF2', 'R352/typography/font-woff2');
    assert.match(readFileSync(license, 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/, 'R352/typography/font-license');
  }
  cssPair(check, () => {
    const from = "url('./assets/fonts/RuslanDisplay-Regular.woff2')";
    assert.equal(css.split(from).length, 2, 'R352/typography/setup/font-url-edit');
    return css.replace(from, "url('data:font/woff2;base64,d09GMg==')");
  }, 'R352/typography/font-file-not-data');
  // Это подмена read-only проверки существования, а не удаление живого файла/лицензии из дерева.
  exactFailure(() => check(css, url => !url.pathname.endsWith('/OFL-RuslanDisplay.txt') && existsSync(url)), 'R352/typography/font-license-exists');
  exactFailure(() => check(css, url => !url.pathname.endsWith('/RuslanDisplay-Regular.woff2') && existsSync(url)), 'R352/typography/font-file-exists');
  check(css);
});

it('R352 имя говорящего, реплика и заголовок используют единый Ruslan Display первым в стеке', () => {
  // Иначе только часть сцены сохраняет выбранный облик, а таблички прыгают между несовместимыми метриками.
  const check = (raw: string) => {
    const all = rules(raw);
    assert.match(styles(all, '.boom-overlay').get('--boom-display') || '', /^(['"])Ruslan Display\1\s*,/, 'R352/typography/display-first');
    for (const selector of ['.boom-who', '.boom-line', '.boom-title']) {
      const style = styles(all, selector);
      assert.match(style.get('font-family') || style.get('font') || '', /var\(\s*--boom-display\s*\)/, 'R352/typography/display-roles');
    }
  };
  cssPair(check, () => css + '\n.boom-overlay { --boom-display: Georgia, serif; }', 'R352/typography/display-first');
  for (const selector of ['.boom-who', '.boom-line', '.boom-title']) {
    cssPair(check, () => css + `\n${selector} { font-family: var(--font-ui); }`, 'R352/typography/display-roles');
  }
});

function padding(value: string): { left: number; right: number } {
  const parts = value.trim().split(/\s+/).map(part => {
    assert.match(part, /^(?:0|\d+(?:\.\d+)?px)$/, 'R352/typography/setup/padding-unit');
    return Number.parseFloat(part);
  });
  assert.ok(parts.length >= 1 && parts.length <= 4);
  return { right: parts[1] ?? parts[0]!, left: parts[3] ?? parts[1] ?? parts[0]! };
}

it('R352 заголовок карточки оставляет симметричное место под крестик и балансирует строки', () => {
  // Резерв считается по настоящим размерам кнопки, её right и полю карточки, а не по снимку в happy-dom.
  const check = (raw: string) => {
    const all = rules(raw), title = styles(all, '.boom-title');
    const reserve = padding(title.get('padding') || '0');
    const card = padding(styles(all, '.boom-card').get('padding') || '0');
    const closeWidth = Number.parseFloat(styles(all, '.icon-close').get('width') || '');
    const closeRight = Number.parseFloat(styles(all, '.boom-card .boom-close').get('right') || '');
    assert.equal(closeWidth, 30, 'R352/typography/setup/close-width');
    assert.ok(Number.isFinite(closeRight), 'R352/typography/setup/close-right');
    const required = Math.max(0, closeWidth + closeRight - card.right);
    assert.ok(reserve.left >= required && reserve.right >= required, 'R352/typography/title-close-reserve');
    assert.equal(reserve.left, reserve.right, 'R352/typography/title-symmetric');
    assert.equal(title.get('text-wrap'), 'balance', 'R352/typography/title-balance');
  };
  cssPair(check, () => css + '\n.boom-title { padding: 0; }', 'R352/typography/title-close-reserve');
  cssPair(check, () => css + '\n.boom-title { text-wrap: wrap; }', 'R352/typography/title-balance');
});

it('R352 на телефоне заголовок БУМ сжимается через clamp до 22 px или меньше', () => {
  // На узких экранах широкий кириллический display-шрифт не должен принудительно занимать три строки.
  const check = (raw: string) => {
    const phone = rules(raw).filter(rule => rule.selectors.includes('.boom-title') && declarations(rule.body).has('font-size')
      && rule.parents.some(parent => /^@media\b/.test(parent)
        && /\(\s*max-width\s*:\s*(?:[1-6]\d{2}|7[0-5]\d|760)px\s*\)/.test(parent)));
    assert.ok(phone.length > 0, 'R352/typography/title-phone-clamp');
    // Не сливаем разные ширины в одну Map: позднее правило480 не скрывает плохой размер на320.
    for (const rule of phone) {
      const match = /^clamp\(\s*(\d+(?:\.\d+)?)px\s*,\s*[^,]+,\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(declarations(rule.body).get('font-size') || '');
      assert.ok(match, 'R352/typography/title-phone-clamp');
      assert.ok(Number(match[1]) > 0 && Number(match[1]) <= 22, 'R352/typography/title-phone-min');
      assert.ok(Number(match[2]) >= Number(match[1]), 'R352/typography/title-phone-max');
    }
  };
  cssPair(check, () => css + '\n@media (max-width: 480px) { .boom-title { font-size: clamp(26px, 6.6vw, 30px); } }', 'R352/typography/title-phone-min');
  cssPair(check, () => css + '\n@media (max-width: 480px) { .boom-title { font-size: 21px; } }', 'R352/typography/title-phone-clamp');
  cssPair(check, () => css + '\n@media (max-width: 320px) { .boom-title { font-size: clamp(26px, 7vw, 30px); } }'
    + '\n@media (max-width: 480px) { .boom-title { font-size: clamp(21px, 6.6vw, 26px); } }', 'R352/typography/title-phone-min');
});

function lines(raw: string) {
  const file = ts.createSourceFile('gamesLaunchBoom.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ts.StringLiteralLike[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const index = node.expression.text === 'say' ? 1 : node.expression.text === 'parrotIn' ? 3 : -1;
      const argument = node.arguments[index];
      if (argument && ts.isStringLiteralLike(argument)) out.push(argument);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(out.length >= 5, 'R352/typography/setup/dialogue');
  return { file, values: out };
}

it('R352 во всех репликах капитана и команды тире приклеено к предыдущему слову NBSP', () => {
  // AST берёт именно произносимые строки say/parrotIn, а не комментарий с правильным примером.
  const check = (raw: string) => {
    const entries = lines(raw).values.filter(line => line.text.includes('—'));
    assert.ok(entries.length >= 4, 'R352/typography/setup/dash-lines');
    for (const line of entries) {
      for (let i = 0; i < line.text.length; i++) {
        if (line.text[i] === '—') assert.equal(line.text[i - 1], '\u00a0', 'R352/typography/reply-dash');
      }
    }
  };
  check(boom);
  counterfact(() => {
    const { file, values } = lines(boom);
    for (const line of values.filter(value => value.text.includes('—'))) {
      const token = line.getText(file), changed = token.replace(/(?:\\u00a0|\u00a0)(?=—)/u, ' ');
      assert.notEqual(changed, token, 'R352/typography/setup/dash-edit');
      const mutant = boom.slice(0, line.getStart(file)) + changed + boom.slice(line.end);
      exactFailure(() => check(mutant), 'R352/typography/reply-dash');
    }
  });
  check(boom);
});

it('R352 «гусей-пиратов» не рвётся после дефиса даже без неразрывного дефиса в шрифте', () => {
  // У Ruslan Display нет U+2011: перенос запрещает word joiner после обычного дефиса.
  const check = (raw: string) => {
    const compounds = lines(raw).values.filter(line => line.text.includes('гусей-'));
    assert.equal(compounds.length, 1, 'R352/typography/setup/compound-line');
    assert.ok(compounds[0]!.text.includes('гусей-\u2060пиратов'), 'R352/typography/compound-joiner');
  };
  check(boom);
  counterfact(() => {
    const from = 'гусей-\\u2060пиратов';
    assert.equal(boom.split(from).length, 2, 'R352/typography/setup/compound-edit');
    exactFailure(() => check(boom.replace(from, 'гусей-пиратов')), 'R352/typography/compound-joiner');
  });
  check(boom);
});
