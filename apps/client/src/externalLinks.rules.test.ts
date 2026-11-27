import assert from 'node:assert/strict';
import { mutantTest } from '../../../packages/shared/test/counterfacts.js';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./externalLinks.ts', import.meta.url), 'utf8');
const ORIGIN = 'https://app.example.org';
const EXTERNAL = 'https://other.example.org/docs?section=links#desktop';
const VM_TIMEOUT_MS = 250;
const STEP_LIMIT = 200;

type ClickSpec = {
  href: string;
  target?: string;
  download?: string;
  nested?: boolean;
  defaultPrevented?: boolean;
  button?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

class ExecutionBudgetError extends Error {}

function loadRules(moduleSource = source) {
  let steps = 0;
  let exhausted = false;
  const step = () => {
    if (++steps > STEP_LIMIT) {
      exhausted = true;
      throw new ExecutionBudgetError('R362: превышен бюджет 200 вызовов/шагов');
    }
  };

  // Модель только входа helper: настоящие URL и весь модуль, без DOM/React и новых зависимостей.
  // closest действительно поднимается от span к a; нельзя случайно пройти тест, читая target.href.
  class ElementInput {
    constructor(
      readonly tag: 'a' | 'span',
      readonly attributes: Readonly<Record<string, string>>,
      readonly parent: ElementInput | null = null,
    ) {}

    closest(selector: string): ElementInput | null {
      step();
      if (selector !== 'a[href]') throw new Error(`R362: неожиданный селектор ${selector}`);
      for (let node: ElementInput | null = this; node; node = node.parent) {
        step();
        if (node.tag === 'a' && node.hasAttribute('href')) return node;
      }
      return null;
    }

    hasAttribute(name: string): boolean {
      step();
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    }

    getAttribute(name: string): string | null {
      step();
      return this.attributes[name] ?? null;
    }
  }

  const module = { exports: {} as Record<string, unknown> };
  const context = createContext({
    module,
    exports: module.exports,
    URL,
    require(id: string) {
      step();
      if (id === './hotkeys') return { isDesktop: () => false, isAndroid: () => false };
      if (id === './toast') return { toast: () => assert.fail('разбор клика не показывает тост') };
      if (id === './desktopWindow') {
        return {
          openExternal() {
            step();
            throw new Error('R362: helper не должен вызывать IO openExternal');
          },
        };
      }
      throw new Error(`R362: неподменённый импорт ${id}`);
    },
  });
  const compiled = ts.transpileModule(moduleSource, {
    fileName: 'externalLinks.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error('R362: модуль не скомпилировался');
  }
  // Загружается ПОЛНЫЙ externalLinks.ts: не вырезаем и не пересказываем production-функцию.
  new Script(compiled.outputText, { filename: 'externalLinks.ts' }).runInContext(context, { timeout: VM_TIMEOUT_MS });
  if (typeof module.exports.externalLinkHref !== 'function' || typeof module.exports.installExternalLinks !== 'function') {
    throw new Error('R362: полный модуль не экспортировал обе функции');
  }
  const invoke = new Script('__result = module.exports.externalLinkHref(__event, __origin)', {
    filename: 'externalLinks.rules.invoke.js',
  });

  return {
    href(spec: ClickSpec, origin = ORIGIN): string | null {
      step();
      const attributes: Record<string, string> = { href: spec.href };
      if (spec.target !== undefined) attributes.target = spec.target;
      if (spec.download !== undefined) attributes.download = spec.download;
      const anchor = new ElementInput('a', attributes);
      context.__event = {
        target: spec.nested ? new ElementInput('span', {}, anchor) : anchor,
        defaultPrevented: spec.defaultPrevented ?? false,
        button: spec.button ?? 0,
        ctrlKey: spec.ctrlKey ?? false,
        shiftKey: spec.shiftKey ?? false,
        altKey: spec.altKey ?? false,
        metaKey: spec.metaKey ?? false,
      };
      context.__origin = origin;
      let result: unknown;
      try {
        invoke.runInContext(context, { timeout: VM_TIMEOUT_MS });
        result = context.__result;
      } finally {
        delete context.__event;
        delete context.__origin;
        delete context.__result;
        // Production catch не должен превращать проглоченный BudgetError в «убитого мутанта».
        if (exhausted) throw new ExecutionBudgetError('R362: превышен бюджет 200 вызовов/шагов');
      }
      assert.equal(result === null || typeof result === 'string', true, 'R362: результат helper — только строка или null');
      return result as string | null;
    },
  };
}

function replaceOnce(needle: string, replacement: string): string {
  assert.equal(source.split(needle).length - 1, 1, `R362: единственный якорь мутанта ${needle}`);
  return source.replace(needle, replacement);
}

function killedByHref(
  rules: ReturnType<typeof loadRules>,
  spec: ClickSpec,
  expected: string | null,
  mutantActual: string | null,
  label: string,
) {
  // Загрузка снаружи assert.throws; только конкретное несовпадение href считается kill.
  // Ошибки компиляции/VM, timeout и бюджет не подходят. В actual никогда нет DOM/объектов.
  assert.throws(
    () => assert.equal(rules.href(spec), expected, label),
    (error: unknown) => error instanceof assert.AssertionError
      && error.operator === 'strictEqual'
      && error.message.includes(label)
      && error.expected === expected
      && error.actual === mutantActual,
    `${label}: мутант обязан нарушить именно проверку адреса`,
  );
}

describe('R362 внешний адрес по клику — правила полного externalLinks.ts', () => {
  it('_blank отдаёт полный свой и чужой адрес для обоих протоколов http/https', () => {
    const rules = loadRules();
    for (const protocol of ['http:', 'https:']) {
      const origin = `${protocol}//app.example.org`;
      for (const host of ['app.example.org', 'other.example.org']) {
        const href = `${protocol}//${host}/docs?section=links#desktop`;
        assert.equal(rules.href({ href, target: '_blank' }, origin), href, `${protocol} ${host}`);
      }
    }
  });

  it('без _blank чужой origin уходит наружу, а свой остаётся навигацией приложения', () => {
    const rules = loadRules();
    for (const protocol of ['http:', 'https:']) {
      const origin = `${protocol}//app.example.org`;
      const foreign = `${protocol}//other.example.org/docs`;
      const own = `${origin}/docs`;
      assert.equal(rules.href({ href: foreign }, origin), foreign, `${protocol}: чужой без target`);
      assert.equal(rules.href({ href: own }, origin), null, `${protocol}: свой без target`);
      assert.equal(rules.href({ href: foreign, target: '_self' }, origin), foreign, `${protocol}: чужой _self`);
      assert.equal(rules.href({ href: own, target: '_self' }, origin), null, `${protocol}: свой _self`);
    }
  });

  it('уже отменённый переход не обходит linkGuard, обычный клик по тому же адресу принимается', () => {
    const rules = loadRules();
    assert.equal(rules.href({ href: EXTERNAL, target: '_blank', defaultPrevented: true }), null);
    assert.equal(rules.href({ href: EXTERNAL, target: '_blank', defaultPrevented: false }), EXTERNAL);
  });

  it('средняя и правая кнопки не перехватываются, левая по той же ссылке принимается', () => {
    const rules = loadRules();
    for (const button of [1, 2]) {
      assert.equal(rules.href({ href: EXTERNAL, target: '_blank', button }), null, `кнопка ${button}`);
    }
    assert.equal(rules.href({ href: EXTERNAL, target: '_blank', button: 0 }), EXTERNAL);
  });

  for (const modifier of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const) {
    it(`${modifier} сохраняет поведение браузера, без модификатора ссылка принимается`, () => {
      const rules = loadRules();
      assert.equal(rules.href({ href: EXTERNAL, target: '_blank', [modifier]: true }), null, modifier);
      assert.equal(rules.href({ href: EXTERNAL, target: '_blank', [modifier]: false }), EXTERNAL, modifier);
    });
  }

  it('download даже с пустым значением не уходит наружу, та же ссылка без атрибута принимается', () => {
    const rules = loadRules();
    for (const download of ['', 'archive.zip']) {
      assert.equal(rules.href({ href: EXTERNAL, target: '_blank', download }), null, `download=${download}`);
    }
    assert.equal(rules.href({ href: EXTERNAL, target: '_blank' }), EXTERNAL);
  });

  it('mailto/javascript/file не становятся внешними web-ссылками, http/https принимаются', () => {
    const rules = loadRules();
    for (const href of ['mailto:friend@example.org', 'javascript:void(0)', 'file:///docs/help.html']) {
      assert.equal(rules.href({ href, target: '_blank' }), null, href);
    }
    assert.equal(rules.href({ href: 'http://other.example.org/docs', target: '_blank' }), 'http://other.example.org/docs');
    assert.equal(rules.href({ href: EXTERNAL, target: '_blank' }), EXTERNAL);
  });

  it('вложенный span находит родительскую a, а не теряет ссылку из-за event.target', () => {
    const rules = loadRules();
    assert.equal(rules.href({ href: EXTERNAL, target: '_blank', nested: true }), EXTERNAL);
    assert.equal(rules.href({ href: `${ORIGIN}/docs`, nested: true }), null);
  });

  it('относительный href разрешается от origin и подчиняется тем же правилам своего/чужого адреса', () => {
    const rules = loadRules();
    assert.equal(rules.href({ href: 'docs/start?lang=ru#desktop', target: '_blank' }), `${ORIGIN}/docs/start?lang=ru#desktop`);
    assert.equal(rules.href({ href: '/docs/start' }), null);
    assert.equal(rules.href({ href: '//other.example.org/docs/start' }), 'https://other.example.org/docs/start');
  });

  mutantTest('контрфакт без defaultPrevented убивается именно повторным открытием уже отменённой ссылки', () => {
    const mutant = loadRules(replaceOnce('e.defaultPrevented || ', ''));
    killedByHref(mutant, { href: EXTERNAL, target: '_blank', defaultPrevented: true }, null, EXTERNAL, 'R362: отменённый переход');
  });

  mutantTest('контрфакт без проверки протокола убивается отдельно для mailto/javascript/file', () => {
    const mutant = loadRules(replaceOnce("  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;", ''));
    for (const href of ['mailto:friend@example.org', 'javascript:void(0)', 'file:///docs/help.html']) {
      killedByHref(mutant, { href, target: '_blank' }, null, href, `R362: запрещён протокол ${href}`);
    }
  });

  mutantTest('контрфакт || вместо && убивается и своим _blank, и чужим адресом без _blank', () => {
    const mutant = loadRules(replaceOnce('!blank && url.origin === origin', '!blank || url.origin === origin'));
    const own = `${ORIGIN}/docs`;
    killedByHref(mutant, { href: own, target: '_blank' }, own, null, 'R362: свой _blank разрешён');
    killedByHref(mutant, { href: EXTERNAL }, EXTERNAL, null, 'R362: чужой без _blank разрешён');
  });
});
