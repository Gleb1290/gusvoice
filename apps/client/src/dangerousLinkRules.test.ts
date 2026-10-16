import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as rules from './dangerousLinkRules';

it('без признака сервера, в том числе у старого сервера, проверка выключена', () => {
  for (const features of [undefined, null, [], ['other'], ['LINKTHREATS1'], ['linkthreats10']]) assert.equal(rules.serverLinkThreats(features), false);
});
it('точный признак linkthreats1 включает проверку среди других возможностей', () => {
  assert.equal(rules.serverLinkThreats(['other', 'linkthreats1']), true);
});
it('http и https выделяют хост без порта, регистра, завершающих точек и учётных данных', () => {
  for (const url of ['https://user:pass@EVIL.COM.:8443/x?q=safe.com', 'http://evil.com/path']) assert.equal(rules.dangerousLinkHost(url), 'evil.com');
});
it('не-http адреса и сломанная ссылка не получают хост угрозы', () => {
  for (const url of ['javascript:alert(1)', 'ftp://evil.com', 'mailto:x@evil.com', 'evil.com', 'https://']) assert.equal(rules.dangerousLinkHost(url), null);
});
it('точный хост помечается независимо от регистра и завершающих точек списка', () => {
  assert.equal(rules.isDangerousLink('https://EVIL.com./path', ['other.com', 'EvIl.CoM..']), true);
});
it('родитель, подстрока, путь и userinfo не подменяют точный хост сообщения', () => {
  for (const url of ['https://notevil.com', 'https://evil.com.safe.com', 'https://sub.evil.com', 'https://safe.com/evil.com', 'https://evil.com@safe.com']) assert.equal(rules.isDangerousLink(url, ['evil.com']), false, url);
});
it('поддомен принимается, когда сервер передал именно его хост', () => {
  assert.equal(rules.isDangerousLink('https://sub.evil.com/x', ['sub.evil.com']), true);
});
it('пустой или отсутствующий список не делает обычную ссылку опасной', () => {
  for (const list of [undefined, null, []]) assert.equal(rules.isDangerousLink('https://evil.com', list), false);
});
it('javascript не становится опасной веб-ссылкой даже с похожим списком', () => {
  assert.equal(rules.isDangerousLink('javascript:alert(1)', ['evil.com', '']), false);
});
it('подписи предупреждения и действий объясняют осознанное открытие', () => {
  assert.equal(rules.DANGEROUS_LINK_LABEL, 'Опасная ссылка');
  assert.equal(rules.DANGEROUS_LINK_TITLE, 'Опасная ссылка');
  assert.equal(rules.DANGEROUS_LINK_CONFIRM, 'Всё равно открыть');
  assert.equal(rules.DANGEROUS_LINK_CANCEL, 'Отмена');
  assert.equal(rules.dangerousLinkBody('evil.com'), 'Адрес evil.com есть в списках мошеннических и вредоносных сайтов. Такая ссылка может украсть пароль, деньги или установить вирус. Открывать её не стоит.');
});

const source = readFileSync(new URL('./dangerousLinkRules.ts', import.meta.url), 'utf8');
function load(text: string): typeof rules {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, URL,
    require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return { FEATURE_LINKTHREATS1: 'linkthreats1' }; },
  });
  return module.exports as typeof rules;
}
it('контрфакт подстроки вместо точного хоста отвергается настоящим целым модулем', () => {
  const check = (r: typeof rules) => {
    assert.equal(r.isDangerousLink('https://evil.com', ['evil.com']), true);
    assert.equal(r.isDangerousLink('https://notevil.com', ['evil.com']), false);
  };
  check(load(source));
  const target = "h.toLowerCase().replace(/\\.+$/, '') === host";
  assert.equal(source.split(target).length - 1, 1, 'цель мутации единственная');
  const mutant = load(source.replace(target, "host.includes(h.toLowerCase().replace(/\\.+$/, ''))"));
  assert.throws(() => check(mutant), assert.AssertionError);
});
