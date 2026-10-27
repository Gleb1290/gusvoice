import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';

const moduleUrl = new URL('./botDocs.ts', import.meta.url);
const source = readFileSync(moduleUrl, 'utf8').replace(/\r\n/g, '\n');
const docPath = url.fileURLToPath(new URL('../../../../docs/bots-llm.md', import.meta.url));
// Публичная документация той же версии, что сервер, а не похожая придуманная справка.
const docBody = readFileSync(docPath, 'utf8');
const expectedEtag = `"${createHash('sha256').update(docBody).digest('hex').slice(0, 32)}"`;
type Docs = typeof import('./botDocs.js');

function harness(raw = source, configuredPath?: string, initiallyMissing = false) {
  const reads: { name: string; encoding: string }[] = [];
  const warnings: unknown[][] = [];
  let missing = initiallyMissing, body = docBody;
  const module = { exports: {} };
  const deps: Record<string, unknown> = {
    'node:crypto': { createHash }, 'node:path': path, 'node:url': url,
    'node:fs/promises': { readFile: async (name: string, encoding: string) => {
      reads.push({ name, encoding });
      if (missing) throw Object.assign(new Error('synthetic missing document'), { code: 'ENOENT' });
      return body;
    } },
  };
  assert.equal(raw.split('import.meta.url').length - 1, 1, 'единственная мета-ссылка модуля');
  // Только адрес ESM-модуля передаётся как IO-граница; весь остальной настоящий модуль остаётся целым.
  const compiled = ts.transpileModule(raw.replace('import.meta.url', '__moduleUrl'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { module, exports: module.exports, __moduleUrl: moduleUrl.href,
    process: { env: configuredPath === undefined ? {} : { BOT_LLM_DOC: configuredPath } }, Error,
    console: { warn: (...args: unknown[]) => { warnings.push(args); } },
    require: (name: string) => { assert.ok(Object.hasOwn(deps, name), `R300 справка: явный импорт ${name}`); return deps[name]; },
  });
  return { docs: module.exports as Docs, reads, warnings,
    restore: () => { missing = false; }, replaceBody: () => { body = 'not the cached document'; } };
}
async function fixture(check: (app: ReturnType<typeof Fastify>, h: ReturnType<typeof harness>) => Promise<void>, raw = source, configured?: string, missing = false) {
  const h = harness(raw, configured, missing), app = Fastify();
  try {
    assert.equal(h.reads.length, 0, 'импорт не читает файл справки');
    app.get('/api/bot/v1/:method', (_req, reply) => reply.code(401).send({ error: 'generic Bot API needs token' }));
    await app.register(h.docs.botDocsRoutes, { prefix: '/api' });
    assert.equal(h.reads.length, 0, 'регистрация не читает файл справки');
    await check(app, h);
  } finally { await app.close(); }
}

it('R300 справка загружается лениво из корня репозитория, без IO на импорте и регистрации', async () => {
  await fixture(async (app, h) => {
    assert.equal(h.docs.botLlmDocPath, docPath);
    await app.inject('/api/bot/v1/llms.txt');
    assert.deepEqual(h.reads, [{ name: docPath, encoding: 'utf8' }]);
    assert.deepEqual(h.warnings, []);
  });
});
async function contentProbe(raw = source) {
  await fixture(async app => {
    const reply = await app.inject('/api/bot/v1/llms.txt'); // Намеренно БЕЗ токена.
    assert.equal(reply.statusCode, 200);
    assert.equal(reply.headers['content-type'], 'text/markdown; charset=utf-8', 'R300-docs-markdown');
    assert.equal(reply.headers['cache-control'], 'public, max-age=3600');
    assert.equal(reply.headers.etag, expectedEtag);
    assert.equal(reply.body, docBody);
  }, raw);
}
it('R300 анонимный GET отдаёт реальную справку Markdown с ETag и кешем на час', () => contentProbe());

async function conditionalProbe(raw = source) {
  await fixture(async (app, h) => {
    const first = await app.inject('/api/bot/v1/llms.txt');
    assert.equal(first.statusCode, 200);
    const second = await app.inject({ url: '/api/bot/v1/llms.txt', headers: { 'if-none-match': String(first.headers.etag) } });
    assert.equal(second.statusCode, 304, 'R300-docs-conditional-304');
    assert.equal(second.body, ''); assert.equal(second.headers.etag, expectedEtag);
    assert.equal(second.headers['cache-control'], 'public, max-age=3600');
    assert.equal(h.reads.length, 1);
  }, raw);
}
it('R300 совпавший If-None-Match даёт 304 без тела и повторного чтения файла', () => conditionalProbe());
it('R300 другой ETag получает полный 200, а не ложный 304', async () => {
  await fixture(async app => {
    const reply = await app.inject({ url: '/api/bot/v1/llms.txt', headers: { 'if-none-match': '"a-different-version"' } });
    assert.equal(reply.statusCode, 200); assert.equal(reply.body, docBody);
  });
});
it('R300 документ в памяти не перечитывается и не меняет ETag между запросами', async () => {
  await fixture(async (app, h) => {
    await app.inject('/api/bot/v1/llms.txt'); h.replaceBody();
    const second = await app.inject('/api/bot/v1/llms.txt');
    assert.equal(second.body, docBody); assert.equal(second.headers.etag, expectedEtag); assert.equal(h.reads.length, 1);
  });
});
it('R300 отсутствующий документ даёт 404, но появившийся файл доступен со следующего запроса', async () => {
  await fixture(async (app, h) => {
    const missing = await app.inject('/api/bot/v1/llms.txt');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(missing.body, 'Not Found: llms.txt is not bundled with this instance');
    assert.equal(missing.headers.etag, undefined); assert.equal(missing.headers['cache-control'], undefined);
    assert.equal(h.warnings.length, 1);
    h.restore(); const found = await app.inject('/api/bot/v1/llms.txt');
    assert.equal(found.statusCode, 200); assert.equal(found.body, docBody); assert.equal(h.reads.length, 2);
  }, source, undefined, true);
});
it('R300 путь BOT_LLM_DOC в образе имеет приоритет над репозиторной копией', async () => {
  const configured = '/synthetic-image-docs/bots-llm.md';
  await fixture(async (app, h) => {
    assert.equal(h.docs.botLlmDocPath, configured);
    assert.equal((await app.inject('/api/bot/v1/llms.txt')).statusCode, 200);
    assert.deepEqual(h.reads, [{ name: configured, encoding: 'utf8' }]);
  }, source, configured);
});
it('R300 статическая справка доступна без токена рядом с защищённым универсальным Bot API', async () => {
  await fixture(async app => {
    assert.equal((await app.inject('/api/bot/v1/llms.txt')).statusCode, 200);
    assert.equal((await app.inject('/api/bot/v1/getMe')).statusCode, 401);
  });
});
function changed(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'уникальный якорь botDocs'); return source.replace(from, to);
}
function killed(e: unknown, label: string, actual: unknown, expected: unknown) {
  return e instanceof assert.AssertionError && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual'
    && e.message.split(/\r?\n/, 1)[0] === label && e.actual === actual && e.expected === expected;
}
it('R300 контрфакт без If-None-Match возвращает 200 вместо условного 304', async () => {
  await conditionalProbe();
  const mutant = changed("if (req.headers['if-none-match'] === doc.etag)", 'if (false)');
  await assert.rejects(conditionalProbe(mutant), e => killed(e, 'R300-docs-conditional-304', 200, 304));
});
it('R300 контрфакт text/plain теряет Markdown MIME настоящего документа', async () => {
  await contentProbe();
  const mutant = changed("return reply.type('text/markdown; charset=utf-8').send(doc.body);", "return reply.type('text/plain; charset=utf-8').send(doc.body);");
  await assert.rejects(contentProbe(mutant), e => killed(e, 'R300-docs-markdown', 'text/plain; charset=utf-8', 'text/markdown; charset=utf-8'));
});
