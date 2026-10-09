import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import { composerMaxPx } from './composerSizeRules';

it('R117 поле растёт до 35 процентов окна, не выше 200 и не ниже двух строк', () => {
  const check = (fn: typeof composerMaxPx) => {
    for (const [h, expected] of [[360, 126], [854, 200], [100, 56], [NaN, 200], [Infinity, 200], [0, 200], [-1, 200], [160, 56], [161, 56], [162, 57]])
      assert.equal(fn(h), expected, `доступная высота ${h}`);
  };
  check(composerMaxPx);
  const source = readFileSync(new URL('./composerSizeRules.ts', import.meta.url), 'utf8');
  for (const [old, next] of [['= 0.35', '= 0.5'],
    ['Math.min(COMPOSER_MAX_PX, Math.max(COMPOSER_MIN_CAP_PX, Math.round(availH * COMPOSER_MAX_SHARE)))',
      'Math.max(COMPOSER_MIN_CAP_PX, Math.round(availH * COMPOSER_MAX_SHARE))']]) {
    assert.ok(source.includes(old));
    const module = { exports: {} as { composerMaxPx: typeof composerMaxPx } };
    runInNewContext(ts.transpileModule(source.replace(old, next), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { module, exports: module.exports });
    assert.throws(() => check(module.exports.composerMaxPx), assert.AssertionError);
  }
});

it('R117 список закрепов ограничен местом от его реального верха до безопасного низа', () => {
  const source = readFileSync(new URL('./components/PinnedMessages.tsx', import.meta.url), 'utf8');
  const check = (s: string) => {
    assert.match(s, /el\.style\.maxHeight = `\$\{roomBelow\(toLayoutRect\(el\.getBoundingClientRect\(\)\)\.top, viewportSafe\(\)\)\}px`/);
    for (const target of ['window', 'window.visualViewport?']) for (const method of ['add', 'remove'])
      assert.ok(s.includes(`${target}.${method}EventListener('resize', fit)`));
  };
  check(source);
  for (const old of ['roomBelow(toLayoutRect(el.getBoundingClientRect()).top, viewportSafe())', "window.visualViewport?.addEventListener('resize', fit);"]) {
    assert.ok(source.includes(old));
    assert.throws(() => check(source.replace(old, '')), assert.AssertionError);
  }
});

it('R117 настоящее поле пересчитывает потолок на повороте и клавиатуре и снимает слушателей', () => {
  const source = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
  const check = (s: string) => {
    assert.match(s, /composerMaxPx\(safe\.vh - \(safe\.top \?\? 0\)\)/);
    assert.match(s, /const onViewport = \(\) => fitComposer\(\)/);
    for (const target of ['window', 'window.visualViewport?']) for (const method of ['add', 'remove'])
      assert.ok(s.includes(`${target}.${method}EventListener('resize', onViewport)`));
    assert.match(s, /Math\.min\(full, cap\)/);
  };
  check(source);
  for (const old of ["window.addEventListener('resize', onViewport);", "window.visualViewport?.addEventListener('resize', onViewport);", 'composerMaxPx(safe.vh - (safe.top ?? 0))']) {
    assert.ok(source.includes(old));
    assert.throws(() => check(source.replace(old, '')), assert.AssertionError);
  }
});
