import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './linkThreatsRules.js';

const source = readFileSync(new URL('./linkThreatsRules.ts', import.meta.url), 'utf8');
function load(code: string): typeof rules {
  const exports = {};
  runInNewContext(ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, URL }, { timeout: 1000 });
  return exports as typeof rules;
}
function replaceOnce(code: string, from: string, to: string): string {
  assert.equal(code.split(from).length - 1, 1, `единственный якорь: ${from}`);
  return code.replace(from, to);
}
function hostBoundary(r: typeof rules) {
  assert.equal(r.isThreatHost([new Set(['evil.com'])], 'a.b.evil.com'), true);
  assert.equal(r.isThreatHost([new Set(['evil.com'])], 'notevil.com'), false);
}

describe('R148 локальные списки опасных ссылок', () => {
  it('три формата дают хосты, а комментарии, пустые строки и localhost пропускаются', () => {
    assert.deepEqual([...rules.parseThreatList('\n # пропуск\n! список\nlocalhost\n127.0.0.1\tHOSTS.EXAMPLE\nplain.example # комментарий\nhttps://url.example:8443/path?q=1\n')],
      ['hosts.example', 'plain.example', 'url.example']);
  });
  it('IPv4 в hosts выбирает второе поле, обычный домен с пояснением — первое', () => {
    assert.deepEqual([...rules.parseThreatList('0.0.0.0 blocked.example\nplain.example explanation.example')], ['blocked.example', 'plain.example']);
  });
  it('регистр, звёздочка, порт и конечные точки нормализуются, дубли исчезают', () => {
    assert.deepEqual([...rules.parseThreatList('*.EVIL.COM.\nevil.com:443\nhttps://EVIL.COM/path')], ['evil.com']);
    assert.equal(rules.normalizeListedHost(' MIXED.Example... '), 'mixed.example');
    assert.equal(rules.normalizeListedHost('mixed.example:80'), 'mixed.example');
  });
  it('IPv6 и неверный хост отклоняются, IPv4 и обычный домен принимаются', () => {
    for (const raw of ['::1', '[2001:db8::1]', 'https://[2001:db8::1]/', 'https://', 'bad/domain', 'localhost']) {
      assert.equal(rules.parseThreatList(raw).size, 0, raw);
    }
    assert.deepEqual([...rules.parseThreatList('127.0.0.2\nvalid.example')], ['127.0.0.2', 'valid.example']);
  });
  it('длина хоста 253 принимается, 254 и слишком короткое имя отклоняются', () => {
    const atLimit = `${'a'.repeat(251)}.b`;
    assert.equal(rules.normalizeListedHost(atLimit), atLimit);
    assert.equal(rules.normalizeListedHost(`a${atLimit}`), null);
    assert.equal(rules.normalizeListedHost('a.'), null);
    assert.equal(rules.normalizeListedHost('a.b'), 'a.b');
  });
  it('предел списка 3 млн зафиксирован, точная граница и следующая запись проверяются на уменьшенном полном модуле', () => {
    assert.equal(rules.THREAT_LIST_MAX_HOSTS, 3_000_000);
    assert.equal(load(source).THREAT_LIST_MAX_HOSTS, 3_000_000);
    // Не создаём три миллиона строк/элементов в общем гейте: меняется только
    // константа в полном модуле, тот же цикл проверяется с малым пределом.
    const small = load(replaceOnce(source, 'THREAT_LIST_MAX_HOSTS = 3_000_000', 'THREAT_LIST_MAX_HOSTS = 3'));
    assert.deepEqual([...small.parseThreatList('one.example\none.example\n# comment\ntwo.example\nthree.example')], ['one.example', 'two.example', 'three.example']);
    assert.deepEqual([...small.parseThreatList('one.example\ntwo.example\nthree.example\nfour.example')], ['one.example', 'two.example', 'three.example']);
  });
  it('родители доходят до двух меток, но не до зоны и не до частей IPv4', () => {
    assert.deepEqual(rules.hostAncestors('a.b.evil.com'), ['a.b.evil.com', 'b.evil.com', 'evil.com']);
    assert.deepEqual(rules.hostAncestors('evil.com'), ['evil.com']);
    assert.deepEqual(rules.hostAncestors('com'), []);
    assert.deepEqual(rules.hostAncestors('127.0.0.2'), ['127.0.0.2']);
  });
  it('угроза родителя ловит поддомены, но не соседний суффикс, пустое имя и одну метку', () => {
    hostBoundary(rules);
    assert.equal(rules.isThreatHost([new Set(), new Set(['evil.com'])], ' EVIL.COM... '), true);
    assert.equal(rules.isThreatHost([new Set(['com'])], 'com'), false);
    assert.equal(rules.isThreatHost([new Set(['com'])], 'good.com'), false);
    assert.equal(rules.isThreatHost([new Set(['evil.com'])], ''), false);
    assert.equal(rules.isThreatHost([], 'evil.com'), false);
    assert.equal(rules.isThreatHost([new Set(['127.0.0.2'])], '127.0.0.2'), true);
  });
  it('хост извлекается только из HTTP(S), порт и userinfo не становятся хостом', () => {
    assert.equal(rules.linkHost('https://user:pass@EVIL.COM:8443/a'), 'evil.com');
    assert.equal(rules.linkHost('http://example.com'), 'example.com');
    for (const raw of ['ftp://evil.com', 'javascript:alert(1)', 'evil.com', 'https://']) assert.equal(rules.linkHost(raw), null);
  });
  it('пунктуация не мешает, FTP пропускается, опасный поддомен отдаётся как хост ссылки, повтор один', () => {
    const seen: string[] = [];
    const found = rules.dangerousHostsIn('ftp://evil.com https://A.EVIL.COM/path).,;:!?] https://a.evil.com/next http://safe.example https://b.evil.com', h => {
      seen.push(h); return rules.isThreatHost([new Set(['evil.com'])], h);
    });
    assert.deepEqual(found, ['a.evil.com', 'b.evil.com']);
    assert.deepEqual(seen, ['a.evil.com', 'safe.example', 'b.evil.com']);
  });
  it('пустой и обычный текст не зовут проверку, безопасная HTTP ссылка проверяется без отметки', () => {
    let calls = 0;
    for (const text of ['', 'привет', 'ftp://evil.com']) assert.deepEqual(rules.dangerousHostsIn(text, () => { calls++; return true; }), []);
    assert.equal(calls, 0);
    assert.deepEqual(rules.dangerousHostsIn('https://safe.example', () => { calls++; return false; }), []);
    assert.equal(calls, 1);
  });
  it('ровно десять разных опасных хостов попадают в DTO, одиннадцатый не проверяется', () => {
    assert.equal(rules.THREAT_MAX_PER_MESSAGE, 10);
    const hosts = Array.from({ length: 11 }, (_, i) => `h${i}.example`);
    for (const count of [10, 11]) {
      const seen: string[] = [];
      assert.deepEqual(rules.dangerousHostsIn(hosts.slice(0, count).map(h => `https://${h}`).join(' '), h => { seen.push(h); return true; }), hosts.slice(0, 10));
      assert.deepEqual(seen, hosts.slice(0, 10));
    }
  });
  it('пятидесятая ссылка проверяется, пятьдесят первая уже не сканируется даже после безопасных', () => {
    const safe = Array.from({ length: 49 }, (_, i) => `https://safe${i}.example`).join(' ');
    const seen: string[] = [];
    assert.deepEqual(rules.dangerousHostsIn(`${safe} https://at50.example https://at51.example`, h => {
      seen.push(h); return h.startsWith('at');
    }), ['at50.example']);
    assert.equal(seen.length, 50);
    assert.equal(seen[49], 'at50.example');
  });
  it('проверка включена по умолчанию, выключается только словом false без учёта регистра и пробелов', () => {
    for (const raw of [undefined, 'true', '', '0', 'off', ' falsehood ']) assert.equal(rules.linkThreatsEnabled(raw), true);
    for (const raw of ['false', 'FALSE', ' false ']) assert.equal(rules.linkThreatsEnabled(raw), false);
  });
  it('контрфакт выбора второго поля для любой строки теряет обычный домен', () => {
    const check = (r: typeof rules) => assert.deepEqual([...r.parseThreatList('plain.example explanation.example\n127.0.0.1 hosts.example')], ['plain.example', 'hosts.example']);
    check(load(source));
    const mutant = load(replaceOnce(source, "parts.length >= 2 && IPV4.test(parts[0]!) ? parts[1]! : parts[0]!", "parts[1]!"));
    assert.throws(() => check(mutant), assert.AssertionError);
  });
  it('контрфакт суффикса без точки ошибочно объявляет notevil.com опасным', () => {
    hostBoundary(load(source));
    const mutant = load(replaceOnce(source, 'for (const c of chain) if (list.has(c)) return true;', 'for (const c of chain) for (const entry of list) if (c.endsWith(entry)) return true;'));
    assert.throws(() => hostBoundary(mutant), assert.AssertionError);
  });
  it('контрфакты без нижнего регистра теряют угрозу как при разборе списка, так и при сверке', () => {
    const checkParse = (r: typeof rules) => assert.deepEqual([...r.parseThreatList('EVIL.COM')], ['evil.com']);
    const checkMatch = (r: typeof rules) => assert.equal(r.isThreatHost([new Set(['evil.com'])], 'EVIL.COM'), true);
    checkParse(load(source)); checkMatch(load(source));
    assert.throws(() => checkParse(load(replaceOnce(source, 'let h = raw.trim().toLowerCase();', 'let h = raw.trim();'))), assert.AssertionError);
    assert.throws(() => checkMatch(load(replaceOnce(source, "const h = host.trim().toLowerCase().replace(/\\.+$/, '');", "const h = host.trim().replace(/\\.+$/, '');"))), assert.AssertionError);
  });
});
