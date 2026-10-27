import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const source = readFileSync(new URL('../../desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/PushCrypto.kt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Только структура настоящего Kotlin. Не переводим криптографию/JSONObject в JS и не исполняем вырезки.
// Строки и char — неделимые токены: '{' не открывает блок, а комментарий не подменяет вызов парсера.
function tokens(text: string): string[] {
  return [...text.matchAll(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[A-Za-z_]\w*|\d[\d_]*|>=|<=|==|!=|&&|\|\||[^\s]/g)]
    .map(match => match[0]).filter(token => !token.startsWith('//') && !token.startsWith('/*'));
}
const normalized = (text: string) => tokens(text).join(' ');

function expression(code: string[], start: number): string {
  const stack: string[] = [];
  const closers: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let end = start; end < code.length; end++) {
    const token = code[end];
    if (stack.length === 0 && (token === '}' || ['private', 'fun', 'const', '@'].includes(token))) {
      assert.ok(end > start, 'непустое выражение перед следующим членом Kotlin');
      return code.slice(start, end).join(' ');
    }
    if (closers[token]) stack.push(closers[token]);
    else if ([')', ']', '}'].includes(token)) assert.equal(token, stack.pop(), 'сбалансированные скобки Kotlin');
  }
  assert.fail('у выражения есть конец внутри настоящего object PushCrypto');
}

function functionExpression(text: string, name: string): string {
  const code = tokens(text);
  const starts = code.flatMap((token, index) => token === 'fun' && code[index + 1] === name ? [index] : []);
  assert.equal(starts.length, 1, `единственная настоящая функция ${name}`);
  const start = starts[0];
  const signature = ['fun', name, '(', 'message', ':', 'ByteArray', ')', ':', 'Boolean', '='];
  assert.deepEqual(code.slice(start, start + signature.length), signature, `${name}: expression-body с ожидаемой сигнатурой`);
  return expression(code, start + signature.length);
}

function constantExpression(text: string, name: string): string {
  const code = tokens(text);
  const starts = code.flatMap((token, index) => token === 'const' && code[index + 1] === 'val' && code[index + 2] === name ? [index] : []);
  assert.equal(starts.length, 1, `единственная константа ${name}`);
  const start = starts[0];
  assert.equal(code[start + 3], '=');
  return expression(code, start + 4);
}

const encryptedExpression = 'message.size >= HEADER_MIN + TAG_LEN && !isPlainJson(message)';
const plainExpression = `message[0] == '{'.code.toByte() && try {
  JSONObject(String(message, Charsets.UTF_8))
  true
} catch (_: Exception) {
  false
}`;
const classifierMarker = 'R294:looksEncrypted-разбирает-JSON-после-порога';
const plainMarker = 'R294:isPlainJson-парсер-успех-и-отказ';

function checkClassifier(text: string) {
  assert.equal(functionExpression(text, 'looksEncrypted'), normalized(encryptedExpression), classifierMarker);
}

function checkPlain(text: string) {
  assert.equal(functionExpression(text, 'isPlainJson'), normalized(plainExpression), plainMarker);
  assert.equal(tokens(text).join(' ').includes('import org . json . JSONObject'), true, 'используется настоящий org.json.JSONObject');
}

function rejects(target: string, replacement: string, check: (text: string) => void, marker: string, original: string, changed: string) {
  check(source);
  assert.equal(source.split(target).length - 1, 1, 'мутант меняет ровно одно место настоящего Kotlin');
  const mutant = source.replace(target, replacement);
  assert.notEqual(mutant, source);
  assert.throws(() => check(mutant), (error: unknown) => error instanceof assert.AssertionError
    && error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual'
    && error.message.split(/\r?\n/, 1)[0] === marker
    && error.expected === normalized(original) && error.actual === normalized(changed),
  'контрфакт отклонён адресным инвариантом, а не ошибкой извлечения/скобок');
}

it('R294 порог шифрованного конверта включает 86 байт заголовка и 16 байт тега', () => {
  // Иначе формально правильный && мог бы пропустить пустой массив к message[0].
  assert.equal(constantExpression(source, 'HEADER_MIN'), normalized('21 + 65'));
  assert.equal(constantExpression(source, 'TAG_LEN'), normalized('16'));
  checkClassifier(source);
});

it('R294 первый байт { не отменяет расшифровку: после проверки длины требуется отрицательный результат isPlainJson', () => {
  // Фиксируем весь предикат, не просто присутствие вызова в комментарии/другой функции.
  checkClassifier(source);
});

it('R294 открытый объект принимается только после JSONObject UTF-8, а исключение разбора означает не JSON', () => {
  // Парное принятие старого открытого пуша и отказ для случайной соли, похожей лишь первым байтом.
  checkPlain(source);
});

it('R294 контрфакт первого байта снова пропускает шифр с { мимо расшифровки', () => {
  const old = "message[0] != '{'.code.toByte()";
  rejects('!isPlainJson(message)', old, checkClassifier, classifierMarker, encryptedExpression,
    encryptedExpression.replace('!isPlainJson(message)', old));
});

it('R294 контрфакт удаления JSONObject не проходит даже с прежним вызовом в комментарии', () => {
  const parse = 'JSONObject(String(message, Charsets.UTF_8))';
  const comment = `/* ${parse} */`;
  rejects(parse, comment, checkPlain, plainMarker, plainExpression, plainExpression.replace(parse, comment));
});

it('R294 контрфакт catch=true ошибочно объявляет битый JSON открытым пушем', () => {
  const target = 'catch (_: Exception) {\n      false\n    }';
  const replacement = target.replace('false', 'true');
  rejects(target, replacement, checkPlain, plainMarker, plainExpression,
    plainExpression.replace('false', 'true'));
});

it('R294 контрфакты строгого порога и разбора до длины нарушают границу 102 и защиту пустого входа', () => {
  // Ровно минимальная длина должна идти на расшифровку; короткий ввод не должен индексироваться парсером.
  rejects('message.size >= HEADER_MIN + TAG_LEN', 'message.size > HEADER_MIN + TAG_LEN',
    checkClassifier, classifierMarker, encryptedExpression, encryptedExpression.replace('>=', '>'));
  const reordered = '!isPlainJson(message) && message.size >= HEADER_MIN + TAG_LEN';
  rejects(encryptedExpression, reordered, checkClassifier, classifierMarker, encryptedExpression, reordered);
});
