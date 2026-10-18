import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import Fastify, { type FastifyInstance, type onRequestAsyncHookHandler } from 'fastify';
import ts from 'typescript';

const source = readFileSync(new URL('./gate.ts', import.meta.url), 'utf8');
type Gates = typeof import('./gate.js');

function loadGates(flags: { enabled: boolean; dmEnabled: boolean }, code = source): Gates {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require(name: string) {
      assert.equal(name, '../env.js', `Неописанный импорт gate: ${name}`);
      return { env: { federation: flags } };
    },
  });
  return module.exports as Gates;
}

const url = '/api/fed/probe?format=raw';
function appWith(gate?: onRequestAsyncHookHandler, customNotFound = false): FastifyInstance {
  const app = Fastify();
  if (customNotFound) {
    app.setNotFoundHandler((request, reply) => {
      void reply.code(404).header('x-not-found', 'application').send(`Нет ${request.method} ${request.url}`);
    });
  }
  if (gate) app.post('/api/fed/probe', { onRequest: gate }, async () => ({ allowed: true }));
  return app;
}

async function same404(gate: onRequestAsyncHookHandler, customNotFound = false): Promise<void> {
  const hidden = appWith(gate, customNotFound);
  const missing = appWith(undefined, customNotFound);
  try {
    // Одинаковые метод и URL в двух приложениях: стандартный 404 Fastify включает их в message.
    const [actual, expected] = await Promise.all([
      hidden.inject({ method: 'POST', url }),
      missing.inject({ method: 'POST', url }),
    ]);
    assert.equal(actual.statusCode, 404);
    assert.equal(actual.statusCode, expected.statusCode);
    assert.deepEqual(actual.rawPayload, expected.rawPayload, 'закрытый маршрут не выдаёт наличие федерации телом ответа');
    assert.equal(actual.headers['content-type'], expected.headers['content-type']);
    assert.equal(actual.headers['content-length'], expected.headers['content-length']);
    assert.equal(actual.headers['x-not-found'], expected.headers['x-not-found']);
  } finally {
    await Promise.all([hidden.close(), missing.close()]);
  }
}

describe('выключенная федерация неотличима от отсутствующего маршрута (#224)', () => {
  for (const name of ['federationGate', 'federationDmGate'] as const) {
    it(`${name}: выключено — стандартный 404 совпадает байт в байт`, async () => {
      await same404(loadGates({ enabled: false, dmEnabled: false })[name]);
    });

    it(`${name}: выключено — используется и собственный обработчик «не найдено»`, async () => {
      await same404(loadGates({ enabled: false, dmEnabled: false })[name], true);
    });

    it(`${name}: включение и выключение видны тому же маршруту без перерегистрации`, async () => {
      const flags = { enabled: false, dmEnabled: false };
      const app = appWith(loadGates(flags)[name]);
      try {
        assert.equal((await app.inject({ method: 'POST', url })).statusCode, 404);
        flags.enabled = true;
        flags.dmEnabled = true;
        const accepted = await app.inject({ method: 'POST', url });
        assert.equal(accepted.statusCode, 200);
        assert.deepEqual(accepted.json(), { allowed: true });
        flags.enabled = false;
        flags.dmEnabled = false;
        assert.equal((await app.inject({ method: 'POST', url })).statusCode, 404);
      } finally {
        await app.close();
      }
    });
  }

  it('включённая федерация сама по себе не открывает выключенные межинстансные ЛС', async () => {
    const gates = loadGates({ enabled: true, dmEnabled: false });
    await same404(gates.federationDmGate);
    const app = appWith(gates.federationGate);
    try {
      assert.equal((await app.inject({ method: 'POST', url })).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('контрфакт: пустой JSON вместо callNotFound разоблачает закрытый маршрут', async () => {
    const anchor = 'reply.callNotFound();';
    assert.equal(source.split(anchor).length - 1, 2, 'оба крючка проходят через not-found Fastify');
    // Меняем обе ветки, чтобы одинаковый контракт проверял и общий флаг, и ЛС.
    const mutant = loadGates({ enabled: false, dmEnabled: false }, source.replaceAll(anchor, 'reply.code(404).send({});'));
    const original = loadGates({ enabled: false, dmEnabled: false });
    for (const name of ['federationGate', 'federationDmGate'] as const) {
      await same404(original[name]);
      await assert.rejects(() => same404(mutant[name]), (e: unknown) => e instanceof assert.AssertionError
        && e.message.startsWith('закрытый маршрут не выдаёт наличие федерации телом ответа'));
    }
  });
});
