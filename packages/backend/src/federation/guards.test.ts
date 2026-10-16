import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { EVENTS_BATCH_MAX, FED_LIMITS, fedRateKey, seenIdentityJtiWith, seenSignatureWith, type NonceStore } from './guards.js';

function withoutParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function dm2OnceIsGated(source: string): boolean {
  const file = ts.createSourceFile('state.ts', source, ts.ScriptTarget.Latest, true);
  let guarded = 0;
  let unguarded = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'features' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (element.getText(file) === 'FED_FEATURES.dm2once') unguarded += 1;
        if (!ts.isSpreadElement(element)) continue;
        // Скобки у ...(условие ? [...] : []) — отдельный AST-узел, а соседние dm3/dm4 не часть этого контракта.
        const conditional = withoutParens(element.expression);
        if (!ts.isConditionalExpression(conditional)) continue;
        if (withoutParens(conditional.condition).getText(file) !== 'deps.dmEnabled' || !ts.isArrayLiteralExpression(conditional.whenTrue) || !ts.isArrayLiteralExpression(conditional.whenFalse)) continue;
        if (conditional.whenTrue.elements.some((feature) => feature.getText(file) === 'FED_FEATURES.dm2once') && conditional.whenFalse.elements.length === 0)
          guarded += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return guarded === 1 && unguarded === 0;
}

function memoryStore(): NonceStore & { calls: unknown[][] } {
  const seen = new Set<string>();
  const calls: unknown[][] = [];
  return {
    calls,
    async set(...args) {
      calls.push(args);
      const key = args[0];
      if (seen.has(key)) return null;
      seen.add(key);
      return 'OK';
    },
  };
}

describe('защита федеративных маршрутов от повтора', () => {
  it('первая подпись проходит, та же вторая считается повтором', async () => {
    const store = memoryStore();
    assert.equal(await seenSignatureWith(store, 'sig'), false);
    assert.equal(await seenSignatureWith(store, 'sig'), true);
  });

  it('подпись ставится атомарно с NX и хранится дольше окна с обоими допусками часов', async () => {
    const store = memoryStore();
    await seenSignatureWith(store, 'sig');
    const [, , ex, ttl, nx] = store.calls[0];
    assert.equal(ex, 'EX');
    assert.equal(nx, 'NX');
    assert.ok((ttl as number) > 60 + 60 * 2);
  });

  it('пустая подпись закрывается, а отказ кеша не гасит федерацию', async () => {
    const failed: NonceStore = { async set() { throw new Error('redis down'); } };
    assert.equal(await seenSignatureWith(failed, ''), true);
    assert.equal(await seenSignatureWith(failed, 'sig'), false);
  });

  it('одноразовый jti и ключи лимита не пересекаются между соседями', async () => {
    const store = memoryStore();
    assert.equal(await seenIdentityJtiWith(store, 'jti'), false);
    assert.equal(await seenIdentityJtiWith(store, 'jti'), true);
    assert.notEqual(fedRateKey('events', 'peer-a').key, fedRateKey('events', 'peer-b').key);
  });

  it('лимиты до подписи ключуются по адресу и щедрее гостевой активности офиса', () => {
    // Ловит возврат уязвимости, где посторонний забивал лимит честного соседа его публичным id.
    assert.deepEqual(fedRateKey('peerAddress', '203.0.113.1'), {
      key: 'fed:peerAddress:203.0.113.1', ...FED_LIMITS.peerAddress,
    });
    assert.deepEqual(fedRateKey('guestSessionAddress', '203.0.113.1'), {
      key: 'fed:guestSessionAddress:203.0.113.1', ...FED_LIMITS.guestSessionAddress,
    });
  });

  it('пачка событий ограничена сотней независимо от лимита числа запросов', () => {
    // Ловит снятие отдельного барьера на тяжёлое последовательное применение событий.
    assert.equal(EVENTS_BATCH_MAX, 100);
  });

  it('dm2once объявляется только вместе с включёнными ЛС между инстансами', () => {
    // Класс ошибки: сосед получает неподдерживаемый флаг, когда федеративные ЛС выключены.
    const source = readFileSync(new URL('./state.ts', import.meta.url), 'utf8');
    assert.equal(dm2OnceIsGated(source), true, 'целый state.ts включает dm2once только под deps.dmEnabled');
    const anchor = '...(deps.dmEnabled ? [FED_FEATURES.dm2once] : []),';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь capability должен быть уникальным');
    const mutant = source.replace(anchor, 'FED_FEATURES.dm2once,');
    assert.throws(
      () => assert.equal(dm2OnceIsGated(mutant), true, 'всегда включённый dm2once недопустим'),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes('всегда включённый dm2once недопустим'),
      'AST oracle обнаруживает объявление флага при выключенных ЛС',
    );
  });
});

it('R201 журнал открытых федеративных ЛС подключён при федерации независимо от флага новых ЛС', () => {
  // Класс ошибки: откат DM-флага перестаёт записывать уже существующую переписку для доставки соседу.
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const check = (raw: string) => {
    const file = ts.createSourceFile('index.ts', raw, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'configureFederatedConv') calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file); assert.equal(calls.length, 1, 'одна регистрация журнала');
    const call = calls[0], config = call.arguments[0]; assert.ok(ts.isObjectLiteralExpression(config));
    const record = config.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'record') as ts.PropertyAssignment;
    assert.equal(record?.initializer.getText(file), 'recordFedConvChanges', 'record не выключается флагом ЛС');
    const conditions: string[] = [];
    for (let node: ts.Node | undefined = call.parent; node; node = node.parent) if (ts.isIfStatement(node)) conditions.push(node.expression.getText(file));
    assert.equal(conditions.includes('env.federation.enabled'), true, 'подключение защищено только общим флагом федерации');
    assert.equal(conditions.some(condition => condition.includes('dmEnabled')), false, 'журнал не зависит от флага новых ЛС');
  };
  check(source);
  const anchor = 'if (env.federation.enabled) {\n    configureFederatedConv({'; assert.equal(source.split(anchor).length - 1, 1);
  assert.throws(() => check(source.replace(anchor, 'if (env.federation.enabled && env.federation.dmEnabled) {\n    configureFederatedConv({')),
    e => e instanceof assert.AssertionError && e.message.includes('защищено только общим флагом'));
  const record = 'record: recordFedConvChanges,'; assert.equal(source.split(record).length - 1, 1);
  assert.throws(() => check(source.replace(record, 'record: env.federation.dmEnabled ? recordFedConvChanges : null,')),
    e => e instanceof assert.AssertionError && e.message.includes('record не выключается'));
});
