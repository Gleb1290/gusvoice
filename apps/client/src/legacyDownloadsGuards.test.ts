import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../../desktop/src-tauri/gen/android/app/src/main/java/tech/gusik/gusvoice/LegacyDownloads.kt', import.meta.url), 'utf8');

type Token = { text: string; kind: 'code' | 'string' };

// Kotlin lexical scan: comments disappear, quoted strings stay opaque tokens, so braces or fake
// assertions inside documentation and URL literals cannot affect function extraction.
function tokens(input: string): Token[] {
  const out: Token[] = [];
  const operators = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '->', '?:', '?.', '!!'];
  for (let i = 0; i < input.length;) {
    if (/\s/.test(input[i]!)) { i++; continue; }
    if (input.startsWith('//', i)) {
      i = input.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (input.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < input.length && depth > 0) {
        if (input.startsWith('/*', i)) { depth++; i += 2; }
        else if (input.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (input.startsWith('"""', i)) {
      const end = input.indexOf('"""', i + 3);
      const stop = end < 0 ? input.length : end + 3;
      out.push({ text: input.slice(i, stop), kind: 'string' });
      i = stop;
      continue;
    }
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i]!;
      const start = i++;
      while (i < input.length) {
        if (input[i] === '\\') { i += 2; continue; }
        if (input[i++] === quote) break;
      }
      out.push({ text: input.slice(start, i), kind: 'string' });
      continue;
    }
    const operator = operators.find((candidate) => input.startsWith(candidate, i));
    if (operator) { out.push({ text: operator, kind: 'code' }); i += operator.length; continue; }
    if (/[\p{L}\p{N}_]/u.test(input[i]!)) {
      const start = i++;
      while (i < input.length && /[\p{L}\p{N}_]/u.test(input[i]!)) i++;
      out.push({ text: input.slice(start, i), kind: 'code' });
      continue;
    }
    out.push({ text: input[i]!, kind: 'code' });
    i++;
  }
  return out;
}

function body(input: string, name: string): string {
  const ts = tokens(input);
  let start = -1;
  for (let i = 0; i + 2 < ts.length; i++) {
    if (ts[i]!.text === 'fun' && ts[i + 1]!.text === name) { start = i + 2; break; }
  }
  assert.notEqual(start, -1, `найдено объявление fun ${name}`);
  let open = start;
  while (open < ts.length && ts[open]!.text !== '{') open++;
  assert.ok(open < ts.length, `найдено тело fun ${name}`);
  let depth = 1;
  for (let i = open + 1; i < ts.length; i++) {
    if (ts[i]!.kind === 'code' && ts[i]!.text === '{') depth++;
    if (ts[i]!.kind === 'code' && ts[i]!.text === '}' && --depth === 0) {
      return ts.slice(open + 1, i).map((token) => token.text).join(' ');
    }
  }
  assert.fail(`закрыто тело fun ${name}`);
}

function normalized(input: string): string {
  return tokens(input).map((token) => token.text).join(' ');
}

function regexLiteral(input: string, name?: string): string {
  const ts = tokens(input);
  const at = name
    ? ts.findIndex((token, i) => token.text === name && ts[i - 1]?.text === 'val')
    : ts.findIndex((token) => token.text === 'Regex');
  assert.notEqual(at, -1, name ? `объявлен val ${name}` : 'найден Regex');
  const literalAt = name ? at + 4 : at + 2;
  if (name) {
    assert.equal(ts[at + 1]?.text, '=');
    assert.equal(ts[at + 2]?.text, 'Regex');
  }
  assert.equal(ts[literalAt - 1]?.text, '(');
  assert.equal(ts[literalAt]?.kind, 'string');
  return ts[literalAt]!.text;
}

function checkPrivate(input: string): void {
  const allowed = body(input, 'allowedUrl');
  assert.match(allowed, /url \. startsWith \( att \)/);
  assert.match(allowed, /val att = "\$base\/api\/att\/"/);
  assert.match(allowed, /val parts = url \. substring \( att \. length \) \. split \( '\/' \)/);
  assert.match(allowed, /return parts \. size == 3 && ATT_ID \. matches \( parts \[ 0 \] \) && VIEWER \. matches \( parts \[ 1 \] \) && SIG \. matches \( parts \[ 2 \] \)/);
  assert.equal(regexLiteral(input, 'ATT_ID'), '"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"');
  assert.equal(regexLiteral(input, 'VIEWER'), '"^[A-Za-z0-9-]{1,64}$"');
  assert.equal(regexLiteral(input, 'SIG'), '"^[A-Za-z0-9_-]{32}$"');
}

function checkPublic(input: string): void {
  const allowed = body(input, 'allowedUrl');
  assert.match(allowed, /val pub = "\$base\/api\/download\/attachment\?"/);
  assert.match(allowed, /url \. startsWith \( pub \)/);
  assert.match(allowed, /val q = url \. substring \( pub \. length \) \. split \( '&' \)/);
  assert.match(allowed, /"key" -> if \( key == null \) key = v else return false/);
  assert.match(allowed, /"name" -> \{ \}/);
  assert.match(allowed, /else -> return false/);
  assert.match(allowed, /return key != null && KEY \. matches \( key \)/);
  assert.equal(regexLiteral(input, 'KEY'), '"^attachments/[A-Za-z0-9._-]{1,200}$"');
}

function checkInputRejections(input: string): void {
  const allowed = body(input, 'allowedUrl');
  assert.match(allowed, /if \( url \. length > 4096 \|\| url \. any \{ it \. code < 0x21 \|\| it \. code > 0x7e \|\| it == '\\\\' \|\| it == '#' \} \) return false/);
  assert.match(allowed, /authority \. isEmpty \( \) \|\| authority \. contains \( '@' \)/);
}

function rejectsMutation(target: string, replacement: string, check: (input: string) => void): void {
  check(source); // Original-first: demonstrate the actual implementation satisfies the guard.
  assert.equal(source.split(target).length - 1, 1, 'мутант затрагивает ровно один исходный фрагмент');
  const mutant = source.replace(target, replacement);
  assert.notEqual(mutant, source);
  assert.throws(() => check(mutant), assert.AssertionError, 'удаление защиты должно покраснить страж');
}

describe('R133 Android: исходниковые стражи LegacyDownloads', () => {
  it('приватный URL требует точную границу /api/att/ и ровно id/viewer/signature', () => {
    checkPrivate(source);
  });

  it('публичный URL допускает только key и name, а key может встретиться лишь один раз', () => {
    checkPublic(source);
  });

  it('опасные символы и authority с @ отвергаются до разбора формы ссылки', () => {
    checkInputRejections(source);
  });

  it('имя файла очищает разделители и ведущие точки, ограничивает длину и даёт запасное имя', () => {
    const safe = body(source, 'safeName');
    assert.match(safe, /val clean = raw \. replace \( Regex \( ".+" \) , "_" \) \. trim \( \) \. trimStart \( '\.' \) \. take \( 120 \)/);
    assert.equal(regexLiteral(safe), String.raw`"[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f]+"`);
    assert.match(safe, /return if \( clean \. isEmpty \( \) \) "file" else clean/);
  });

  it('удаления защит URL и ослабление форм частей и имени ловятся на настоящих исходных фрагментах', () => {
    rejectsMutation('if (url.startsWith(att))', 'if (url.startsWith(base))', checkPrivate);
    rejectsMutation('parts.size == 3 && ', '', checkPrivate);
    rejectsMutation('"key" -> if (key == null) key = v else return false', '"key" -> key = v', checkPublic);
    rejectsMutation('private val SIG = Regex("^[A-Za-z0-9_-]{32}$")', 'private val SIG = Regex("^[A-Za-z0-9_-]+$")', checkPrivate);
    rejectsMutation('private val KEY = Regex("^attachments/[A-Za-z0-9._-]{1,200}$")', 'private val KEY = Regex("^attachments/.+$")', checkPublic);
    rejectsMutation('if (url.startsWith(pub)) {', 'if (true) {', checkPublic);
    const safeLiteral = regexLiteral(body(source, 'safeName'));
    rejectsMutation(`Regex(${safeLiteral})`, 'Regex("[/:*?\\"<>|]+")', (input) => {
      const safe = body(input, 'safeName');
      assert.equal(regexLiteral(safe), String.raw`"[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f]+"`);
    });
  });
});
