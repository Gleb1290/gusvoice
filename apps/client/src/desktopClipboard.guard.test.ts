import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const source = readFileSync(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const clipboard = 'COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ';
const microphone = 'COREWEBVIEW2_PERMISSION_KIND_MICROPHONE';
const camera = 'COREWEBVIEW2_PERMISSION_KIND_CAMERA';
const allow = 'COREWEBVIEW2_PERMISSION_STATE_ALLOW';
type Range = { start: number; end: number };
type Rust = { tokens: string[]; closes: Map<number, number> };

// Страж текста Rust, не JS-копия обработчика. Строки и комментарии не могут изображать живой код.
// Все проходы конечны: один файл <=256 КиБ, <=100000 токенов, стек <=256.
function lex(raw: string): Rust {
  assert.ok(raw.length <= 256 * 1024, 'R370/setup/source-budget');
  const tokens: string[] = [], closes = new Map<number, number>();
  const literal = /b?"(?:\\[\s\S]|[^"\\])*"|b?'(?:\\[\s\S]|[^'\\\r\n])'|[A-Za-z_][A-Za-z_0-9]*|==|::|\|\||&&|[^\s]/y;
  for (let index = 0; index < raw.length;) {
    if (/\s/.test(raw[index])) { index++; continue; }
    if (raw.startsWith('//', index)) {
      const newline = raw.indexOf('\n', index + 2);
      index = newline < 0 ? raw.length : newline + 1;
      continue;
    }
    if (raw.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < raw.length && depth > 0) {
        if (raw.startsWith('/*', index)) { depth++; index += 2; }
        else if (raw.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      assert.equal(depth, 0, 'R370/setup/closed-comment');
      continue;
    }
    const rawString = /^(?:br|r)(#{0,16})"/.exec(raw.slice(index, index + 20));
    if (rawString) {
      const stop = raw.indexOf(`"${rawString[1]}`, index + rawString[0].length);
      assert.ok(stop >= 0, 'R370/setup/closed-raw-string');
      tokens.push('<raw-string>');
      index = stop + 1 + rawString[1].length;
    } else {
      literal.lastIndex = index;
      const token = literal.exec(raw);
      assert.ok(token, 'R370/setup/token');
      tokens.push(token[0]);
      index = literal.lastIndex;
    }
    assert.ok(tokens.length <= 100_000, 'R370/setup/token-budget');
  }
  const stack: { token: string; index: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const [index, token] of tokens.entries()) {
    if (['(', '[', '{'].includes(token)) {
      stack.push({ token, index });
      assert.ok(stack.length <= 256, 'R370/setup/stack-budget');
    } else if (Object.hasOwn(pairs, token)) {
      const open = stack.pop();
      assert.equal(open?.token, pairs[token], 'R370/setup/balanced-delimiters');
      closes.set(open!.index, index);
    }
  }
  assert.equal(stack.length, 0, 'R370/setup/closed-delimiters');
  return { tokens, closes };
}

function positions(rust: Rust, sequence: string[], range: Range): number[] {
  const found: number[] = [];
  for (let index = range.start; index + sequence.length <= range.end; index++) {
    if (sequence.every((token, offset) => rust.tokens[index + offset] === token)) found.push(index);
  }
  return found;
}
function inside(rust: Rust, open: number): Range {
  const close = rust.closes.get(open);
  assert.notEqual(close, undefined, 'R370/setup/block-close');
  return { start: open + 1, end: close! };
}
function functionBody(rust: Rust, name: string): Range {
  const starts = positions(rust, ['fn', name, '('], { start: 0, end: rust.tokens.length });
  assert.equal(starts.length, 1, `R370/setup/function/${name}`);
  const endArgs = rust.closes.get(starts[0] + 2)!;
  assert.equal(rust.tokens[endArgs + 1], '{', `R370/setup/function-body/${name}`);
  return inside(rust, endArgs + 1);
}
function hasDirect(rust: Rust, sequence: string[], range: Range): boolean {
  for (let index = range.start; index < range.end; index++) {
    if (sequence.every((token, offset) => index + offset < range.end && rust.tokens[index + offset] === token)) return true;
    // Вложенный if/closure не считается безусловным SetState/вызовом в этой ветке.
    if (rust.tokens[index] === '{') index = rust.closes.get(index)!;
  }
  return false;
}

function checkPermission(raw = source) {
  const rust = lex(raw), body = functionBody(rust, 'grant_media_permissions');
  const imports = positions(rust, ['use', 'webview2_com', '::', 'Microsoft', '::', 'Web', '::', 'WebView2', '::', 'Win32', '::', '{'], body);
  assert.equal(imports.length, 1, 'R370/import: WebView2 импортируется внутри обработчика');
  const imported = inside(rust, imports[0] + 11);
  assert.ok(rust.tokens.slice(imported.start, imported.end).includes(clipboard), 'R370/import: импортирован CLIPBOARD_READ');
  const registrations = positions(rust, ['core', '.', 'add_PermissionRequested', '('], body);
  assert.equal(registrations.length, 1, 'R370/handler: обработчик подписан на PermissionRequested');
  const registration = inside(rust, registrations[0] + 3);
  const callbacks = positions(rust, ['PermissionRequestedEventHandler', '::', 'create', '(', 'Box', '::', 'new', '(', '|', '_', ',', 'args', '|', '{'], registration);
  assert.equal(callbacks.length, 1, 'R370/handler: проверяется callback зарегистрированного обработчика');
  const callback = inside(rust, callbacks[0] + 13);
  assert.equal(positions(rust, ['args', '.', 'PermissionKind', '(', '&', 'mut', 'kind', ')', '?', ';'], callback).length, 1,
    'R370/kind: условие читает вид настоящего запроса');
  const branches = positions(rust, ['if', 'kind', '=='], callback).map(start => {
    let open = start + 1;
    while (open < callback.end && rust.tokens[open] !== '{') open++;
    assert.ok(open < callback.end, 'R370/setup/if-body');
    return { condition: rust.tokens.slice(start + 1, open).join(' '), body: inside(rust, open) };
  });
  const expected = [microphone, camera, clipboard].map(kind => `kind == ${kind}`).sort();
  const permitting = branches.filter(branch => {
    const clauses = branch.condition.split(' || ').sort();
    return clauses.length === expected.length && clauses.every((clause, index) => clause === expected[index]) &&
      hasDirect(rust, ['args', '.', 'SetState', '(', allow, ')', '?', ';'], branch.body);
  });
  assert.equal(permitting.length, 1,
    'R370/allow: CLIPBOARD_READ, микрофон и камера в одной OR-ветке с прямым SetState(ALLOW)');
}

function checkSetup(raw = source) {
  const rust = lex(raw), run = functionBody(rust, 'run');
  const setups = positions(rust, ['.', 'setup', '(', '|', '_app', '|', '{'], run);
  assert.equal(setups.length, 1, 'R370/setup-live: setup зарегистрирован в run');
  const setup = inside(rust, setups[0] + 6);
  const mainBranches = positions(rust, ['if', 'let', 'Some', '(', 'window', ')', '=', '_app', '.', 'get_webview_window', '(', '"main"', ')', '{'], setup);
  const active = mainBranches.filter(start => hasDirect(rust, ['grant_media_permissions', '(', '&', 'window', ')', ';'], inside(rust, start + 13)));
  assert.equal(active.length, 1, 'R370/setup-live: разрешения установлены в setup для настоящего main');
}

function replaceOnce(raw: string, needle: string, replacement: string): string {
  assert.equal(raw.split(needle).length - 1, 1, 'R370/setup/mutation-anchor');
  return raw.replace(needle, replacement);
}
function failsAt(prefix: string) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(prefix);
}

// Ловит возврат диалога вставки после обновления WebView2, не разрешая всё подряд.
it('R370 чтение буфера разрешено той же веткой, что микрофон и камера', () => {
  checkPermission();
});

// Отдельно ловит правильный, но ни разу не подключённый обработчик.
it('R370 разрешения подключены к главному окну при setup', () => {
  checkSetup();
});

// Положительный контроль лексера: поясняющие комментарии/литералы не меняют живую ветку.
it('R370 комментарии, строки и переносы не мешают корректному разрешению', () => {
  const decorated = source.replace('if kind ==', '/* if kind == fake { /* nested */ } */ if\n kind ==') +
    '\nconst NOTE: &str = r#"fn grant_media_permissions() { if fake { SetState(ALLOW); } }"#;';
  checkPermission(decorated);
  checkSetup(decorated);
});

// Импорт сам по себе не устраняет окно запроса: нужен вид запроса в разрешающем if.
it('R370 контрфакт без CLIPBOARD_READ в условии отвергнут адресной проверкой', () => {
  checkPermission();
  counterfact(() => {
    const mutant = replaceOnce(source, `|| kind == ${clipboard}`, '');
    assert.throws(() => checkPermission(mutant), failsAt('R370/allow:'));
  });
});

// Мимо глобального поиска: символ присутствует в отдельной пустой ветке, ALLOW остаётся только у медиа.
it('R370 контрфакт с буфером в ветке без SetState не выдаётся за разрешение', () => {
  checkPermission();
  counterfact(() => {
    const mutant = replaceOnce(source, `|| kind == ${clipboard}`, '');
    const separated = replaceOnce(mutant, `args.SetState(${allow})?;`,
      `args.SetState(${allow})?;\n                }\n                if kind == ${clipboard} {`);
    assert.throws(() => checkPermission(separated), failsAt('R370/allow:'));
  });
});

// Сохранив текст вызова в комментарии, нельзя заменить реальную настройку main.
it('R370 контрфакт с закомментированным подключением к setup отвергнут', () => {
  checkSetup();
  counterfact(() => {
    const mutant = replaceOnce(source, 'grant_media_permissions(&window);', '// grant_media_permissions(&window);');
    assert.throws(() => checkSetup(mutant), failsAt('R370/setup-live:'));
  });
});

// Не даём будущей подмене ALLOW на DEFAULT пройти лишь по наличию нужной константы в файле.
it('R370 контрфакт с потерянным SetState при сохранённом импорте отвергнут', () => {
  checkPermission();
  counterfact(() => {
    const mutant = replaceOnce(source, `args.SetState(${allow})?;`, '// разрешение больше не устанавливается');
    assert.throws(() => checkPermission(mutant), failsAt('R370/allow:'));
  });
});

// Отсутствие импорта диагностируется отдельно от условия/регистрации, не ошибкой парсера.
it('R370 контрфакт без импорта буфера отвергнут, хотя условие сохранено', () => {
  checkPermission();
  counterfact(() => {
    const mutant = replaceOnce(source, `${clipboard}, ${microphone},`, `${microphone},`);
    assert.throws(() => checkPermission(mutant), failsAt('R370/import:'));
  });
});
