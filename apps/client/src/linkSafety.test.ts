import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as safety from './linkSafety.js';

type Safety = typeof safety;
const source = readFileSync(new URL('./linkSafety.ts', import.meta.url), 'utf8');

/** Исполняем весь модуль, а не отдельный кусок: взаимосвязь декодера и правил тоже часть контракта. */
function load(raw: string): Safety {
  const module = { exports: {} };
  const code = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(code, { module, exports: module.exports, URL }, { timeout: 1000 });
  return module.exports as Safety;
}

function ranges(api: Safety, shown: string): { from: number; length: number }[] {
  // Переводим объекты другого realm в обычные объекты, не ослабляя проверку полей и индексов.
  return Array.from(api.suspiciousRanges(shown), (r) => ({ from: r.from, length: r.length }));
}

describe('подозрительные ссылки — вопрос только при признаках подделки', () => {
  it('кириллическая а в латинском apple требует подтверждения', () => {
    assert.equal(safety.isSuspiciousUrl('https://аpple.com'), true);
  });
  it('логин и пароль нельзя принять за часть доверенного домена', () => {
    for (const url of ['https://user@evil.com', 'https://user:pw@a.com', 'https://:pw@a.com', 'https://почта.рф@evil.com']) {
      assert.equal(safety.isSuspiciousUrl(url), true, url);
    }
  });
  it('битый адрес и некорректный punycode требуют вопроса', () => {
    for (const url of ['https://xn--a.com', 'https://[', 'https://', '']) {
      assert.equal(safety.isSuspiciousUrl(url), true, url);
    }
  });
  it('смесь кириллицы с армянской буквой в метке подозрительна', () => {
    assert.equal(safety.isSuspiciousUrl('https://почтօ.рф'), true);
  });
  it('однородные метки не скрывают кириллицу, греческий и армянский рядом с латиницей', () => {
    for (const url of ['https://почта.com', 'https://αβ.com', 'https://օ.com']) {
      assert.equal(safety.isSuspiciousUrl(url), true, url);
    }
  });
  it('обычная ссылка, порт localhost и латиница с диакритикой не требуют вопроса', () => {
    for (const url of ['https://example.com/page?x=1', 'http://localhost:3000', 'https://café.fr', 'example.com']) {
      assert.equal(safety.isSuspiciousUrl(url), false, url);
    }
  });
  it('кириллический домен целиком, включая www и ACE, принимается', () => {
    for (const url of ['https://почта.рф', 'https://www.почта.рф', 'https://xn--e1afmkfd.xn--p1ai']) {
      assert.equal(safety.isSuspiciousUrl(url), false, url);
    }
  });
  it('японские, корейские и китайские разрешённые сочетания принимаются', () => {
    for (const url of ['https://例え.jp', 'https://漢한.kr', 'https://漢ㄅ.tw', 'https://カタカナー.jp']) {
      assert.equal(safety.isSuspiciousUrl(url), false, url);
    }
  });
  it('буква не из рекомендованных письменностей требует вопроса', () => {
    assert.equal(safety.isSuspiciousUrl('https://𐐀.example'), true);
  });
  it('кириллица в пути и запросе не превращает латинский хост в подделку', () => {
    assert.equal(safety.isSuspiciousUrl('https://example.com/почта?next=рф#օ'), false);
  });
});

describe('декодирование и отображение адреса', () => {
  it('ACE раскрывается побайтово в ожидаемые Unicode домены', () => {
    assert.equal(safety.unicodeHost('xn--pple-43d.com'), 'аpple.com');
    assert.equal(safety.unicodeHost('xn--e1afmkfd.xn--p1ai'), 'пример.рф');
    assert.equal(safety.unicodeHost('xn--bcher-kva.de'), 'bücher.de');
  });
  it('префикс ACE нечувствителен к регистру, остальные метки сохраняются', () => {
    assert.equal(safety.unicodeHost('XN--pple-43d.COM.'), 'аpple.COM.');
    assert.equal(safety.unicodeHost('localhost'), 'localhost');
    assert.equal(safety.unicodeHost('почта.рф'), 'почта.рф');
  });
  it('обрыв и выход за диапазон декодера бросают исключение', () => {
    for (const host of ['xn--z.com', `xn--${'9'.repeat(50)}a.com`]) assert.throws(() => safety.unicodeHost(host), Error, host);
  });
  it('R145 знак вопроса в ACE не превращается в отрицательную цифру декодера', () => checkBadDigit(safety));
  it('R145 пустая ACE-метка отвергается, а обычная и корректная ACE сохраняются', () => checkEmptyLabel(safety));
  it('R145 совпадающий с ACE-хостом логин не раскрывается вместо настоящего хоста', () => checkUserinfo(safety));
  it('отображение раскрывает только хост, сохраняя путь, порт, запрос и фрагмент', () => {
    assert.equal(safety.displayUrl('https://xn--e1afmkfd.xn--p1ai:8443/a?x=1#end'), 'https://пример.рф:8443/a?x=1#end');
  });
  it('обычный адрес нормализуется URL, а неразбираемый сохраняется', () => {
    assert.equal(safety.displayUrl('example.com'), 'http://example.com/');
    assert.equal(safety.displayUrl('https://EXAMPLE.com:443/a'), 'https://example.com/a');
    assert.equal(safety.displayUrl('https://['), 'https://[');
    assert.equal(safety.displayUrl('https://xn--a.com'), 'https://xn--a.com');
  });
});

function checkBadDigit(api: Safety) {
  // Раньше '?' становился digit=-2 и выдавал '~', скрывая ошибку входных данных.
  assert.throws(() => api.unicodeHost('xn--?.com'), /punycode: цифра/);
  assert.equal(api.unicodeHost('xn--pple-43d.com'), 'аpple.com');
}
function checkEmptyLabel(api: Safety) {
  // Пустой payload ACE — не пустая разрешённая DNS-метка.
  assert.throws(() => api.unicodeHost('xn--.com'), /punycode: пустая метка/);
  assert.equal(api.unicodeHost('xn--e1afmkfd.xn--p1ai'), 'пример.рф');
  assert.equal(api.unicodeHost('example.com'), 'example.com');
}
function checkUserinfo(api: Safety) {
  // Первое совпадение строки hostname может находиться в логине или пароле.
  for (const userinfo of ['xn--pple-43d.com', 'user:xn--pple-43d.com']) {
    const url = `https://${userinfo}@xn--pple-43d.com/login`;
    const shown = api.displayUrl(url);
    assert.equal(shown, `https://${userinfo}@аpple.com/login`);
    assert.deepEqual(ranges(api, shown), [{ from: 8 + userinfo.length + 1, length: 1 }]);
  }
  assert.equal(api.displayUrl('https://xn--pple-43d.com/login'), 'https://аpple.com/login');
}

describe('подсветка чужих букв', () => {
  it('в apple подсвечивается только кириллическая а по UTF-16 смещению', () => {
    assert.deepEqual(safety.suspiciousRanges('https://аpple.com/login'), [{ from: 8, length: 1 }]);
  });
  it('смежные чужие буквы объединяются, дефис разделяет отрезки', () => {
    assert.deepEqual(safety.suspiciousRanges('https://аб-cdя.com'), [{ from: 8, length: 2 }, { from: 13, length: 1 }]);
  });
  it('логин, путь и запрос не входят в подсветку хоста', () => {
    assert.deepEqual(safety.suspiciousRanges('https://user@evil.com'), []);
    assert.deepEqual(safety.suspiciousRanges('https://а@evil.com/я?օ'), []);
    assert.deepEqual(safety.suspiciousRanges('https://user@аpple.com'), [{ from: 13, length: 1 }]);
  });
  it('одна письменность и адрес без схемы не дают отрезков', () => {
    for (const shown of ['https://example.com', 'https://почта.рф', 'аpple.com']) {
      assert.deepEqual(safety.suspiciousRanges(shown), [], shown);
    }
  });
  it('без латинских двойников выделяется меньшинство, а суррогатная буква занимает два UTF-16 элемента', () => {
    const shown = 'https://漢漢𐐀.test';
    // Latin из .test — большинство; Han и Deseret оказываются меньшинством.
    assert.deepEqual(safety.suspiciousRanges(shown), [{ from: 8, length: 4 }]);
    assert.equal(shown.slice(8, 12), '漢漢𐐀');
  });
  it('видимые буквы и пустой набор пригодны для подсветки', () => {
    assert.equal(safety.rangesVisible('https://аpple.com', [{ from: 8, length: 1 }]), true);
    assert.equal(safety.rangesVisible('abc', []), true);
    assert.equal(safety.rangesVisible('𐐀', [{ from: 0, length: 2 }]), true);
  });
  it('комбинирующие, пробелы и управляющие символы делают подсветку невидимой', () => {
    for (const ch of ['\u0301', ' ', '\n', '\u200d']) {
      assert.equal(safety.rangesVisible(`a${ch}`, [{ from: 1, length: 1 }]), false);
    }
    assert.equal(safety.rangesVisible('a\u0301', [{ from: 0, length: 2 }]), false);
  });
});

describe('контрфакты всего модуля правил ссылок', () => {
  const mutants: { name: string; from: string; to: string; check: (api: Safety) => void }[] = [
    { name: 'без логина и пароля опасный адрес принимается', from: 'if (u.username || u.password) return true;', to: '',
      check: (api) => { assert.equal(api.isSuspiciousUrl('https://user:pw@a.com'), true); assert.equal(api.isSuspiciousUrl('https://a.com'), false); } },
    { name: 'без латинских двойников отдельная кириллическая метка принимается', from: "const LATIN_LOOKALIKES: Script[] = ['Cyrillic', 'Greek', 'Armenian'];", to: 'const LATIN_LOOKALIKES: Script[] = [];',
      check: (api) => { assert.equal(api.isSuspiciousUrl('https://почта.com'), true); assert.equal(api.isSuspiciousUrl('https://почта.рф'), false); } },
    { name: 'без раскрытия ACE гомограф ошибочно безопасен', from: 'host = unicodeHost(u.hostname);', to: 'host = u.hostname;',
      check: (api) => { assert.equal(api.isSuspiciousUrl('https://xn--pple-43d.com'), true); assert.equal(api.isSuspiciousUrl('https://example.com'), false); } },
    { name: 'подсвечивание всех букв захватывает безопасную латиницу', from: 'if (!bad(c.s)) continue;', to: '',
      check: (api) => { assert.deepEqual(ranges(api, 'https://аpple.com/login'), [{ from: 8, length: 1 }]); assert.deepEqual(ranges(api, 'https://example.com'), []); } },
    { name: 'неверная цифра декодера меняет настоящий Unicode домен', from: 'c >= 48 && c <= 57 ? c - 22', to: 'c >= 48 && c <= 57 ? c - 21',
      check: (api) => { assert.equal(api.unicodeHost('xn--pple-43d.com'), 'аpple.com'); assert.equal(api.unicodeHost('example.com'), 'example.com'); } },
    { name: 'без замены хоста окно остаётся с нечитаемым ACE', from: 'return at > 1 && u.href.startsWith(ace, at) ? u.href.slice(0, at) + uni + u.href.slice(at + ace.length) : u.href;', to: 'return u.href;',
      check: (api) => { assert.equal(api.displayUrl('https://xn--pple-43d.com/login'), 'https://аpple.com/login'); assert.equal(api.displayUrl('https://example.com'), 'https://example.com/'); } },
    { name: 'R145 возврат неполных границ цифры принимает знак вопроса',
      from: 'c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : BASE',
      to: 'c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : BASE', check: checkBadDigit },
    { name: 'R145 снятая защита пустой ACE-метки принимает пустой домен',
      from: "if (!input) throw new Error('punycode: пустая метка');", to: '', check: checkEmptyLabel },
    { name: 'R145 поиск хоста без пропуска userinfo раскрывает не ту часть адреса',
      from: "if (u.username || u.password) at = u.href.indexOf('@', at) + 1;", to: '', check: checkUserinfo },
  ];
  for (const mutant of mutants) {
    it(mutant.name, () => {
      assert.equal(source.split(mutant.from).length - 1, 1, 'мутация должна попасть ровно в одно место');
      const original = load(source);
      mutant.check(original);
      const changed = load(source.replace(mutant.from, mutant.to));
      assert.throws(() => mutant.check(changed), assert.AssertionError);
    });
  }
});
