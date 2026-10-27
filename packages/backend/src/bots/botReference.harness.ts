import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { buildBotOpenApi, botOpenApiBreaks } from './botOpenApi.js';

export const repo = url.fileURLToPath(new URL('../../../../', import.meta.url));
export const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
export type Texts = Record<string, string | string[]>;
export interface Reference {
  REF_BEGIN: string; REF_END: string;
  botTextErrors(doc: any, texts: { en: Texts; ru: Texts }): string[];
  renderBotReference(doc: any, lang: 'en' | 'ru', texts: Texts): string;
  renderBotReferenceLlm(doc: any, texts: Texts): string;
  spliceBotReference(file: string, block: string): string;
}
export const referenceSource = read('scripts/gen-bot-api-docs.mts');
export const cliSource = read('scripts/gen-bot-api.mts');
export function loadPure<T>(raw: string): T {
  // Исполняется целый чистый модуль, а не регуляркой вырезанное тело функции.
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Error, require(id: string) { throw new Error(`R307 pure: неожиданный импорт ${id}`); } });
  return module.exports as T;
}
export const reference = () => loadPure<Reference>(referenceSource);
export const texts = (): { en: Texts; ru: Texts } => ({ en: JSON.parse(read('docs/bot-api/text.en.json')), ru: JSON.parse(read('docs/bot-api/text.ru.json')) });
export const document = () => buildBotOpenApi();
export function replaceOnce(raw: string, from: string, to: string): string {
  assert.equal(raw.split(from).length - 1, 1, `R307 единственный якорь ${from}`);
  return raw.replace(from, to);
}
const files = ['docs/bot-api/openapi.json', 'docs/bot-api/text.en.json', 'docs/bot-api/text.ru.json',
  'docs/bots.md', 'docs/bots.ru.md', 'docs/bots-llm.md', 'packages/bot-sdk-py/gusvoice_bot/_generated.py'];
class Exit extends Error { constructor(readonly status: number) { super(`exit ${status}`); } }
export interface Copy {
  root: string; writes: string[]; errors: string[]; imports: string[];
  read(rel: string): string; write(rel: string, value: string): void;
  cli(args: string[], raw?: string): Promise<number>;
}
export async function withCopy(check: (copy: Copy) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'gv-r307-reference-'));
  const writes: string[] = [], errors: string[] = [], imports: string[] = [];
  const abs = (p: string) => {
    const resolved = path.resolve(p), rel = path.relative(root, resolved);
    assert.ok(!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`), 'IO только внутри тестовой копии');
    return resolved;
  };
  const write = (rel: string, value: string) => { const p = abs(path.join(root, rel)); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); };
  try {
    for (const rel of files) write(rel, read(rel));
    write('scripts/gen-bot-api.mts', cliSource);
    write('scripts/gen-bot-api-docs.mts', referenceSource);
    write('scripts/gen-bot-api-py.mts', read('scripts/gen-bot-api-py.mts'));
    const copy: Copy = {
      root, writes, errors, imports,
      read: rel => fs.readFileSync(abs(path.join(root, rel)), 'utf8'), write,
      async cli(args, raw = fs.readFileSync(path.join(root, 'scripts/gen-bot-api.mts'), 'utf8')) {
        const module = { exports: {} };
        const deps: Record<string, unknown> = {
          'node:path': path, 'node:url': url,
          'node:fs': {
            existsSync: (p: string) => fs.existsSync(abs(p)),
            mkdirSync: (p: string, opts: fs.MakeDirectoryOptions) => fs.mkdirSync(abs(p), opts),
            readFileSync: (p: string, encoding: BufferEncoding) => fs.readFileSync(abs(p), encoding),
            writeFileSync: (p: string, body: string) => { writes.push(path.relative(root, abs(p))); fs.writeFileSync(abs(p), body); },
          },
          [url.pathToFileURL(path.join(root, 'scripts/gen-bot-api-docs.mts')).href]: loadPure<Reference>(fs.readFileSync(path.join(root, 'scripts/gen-bot-api-docs.mts'), 'utf8')),
          [url.pathToFileURL(path.join(root, 'scripts/gen-bot-api-py.mts')).href]: loadPure(read('scripts/gen-bot-api-py.mts')),
          [url.pathToFileURL(path.join(root, 'packages/backend/src/bots/botOpenApi.ts')).href]: { buildBotOpenApi, botOpenApiBreaks },
        };
        // Единственная подстановка — ESM-адрес копии; import/await и все ветви CLI остаются настоящими.
        const compiled = ts.transpileModule(replaceOnce(raw, 'import.meta.url', '__moduleUrl'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText;
        try {
          await runInNewContext(`(async () => {\n${compiled}\n})()`, {
            module, exports: module.exports, __moduleUrl: url.pathToFileURL(path.join(root, 'scripts/gen-bot-api.mts')).href,
            process: { argv: ['node', 'gen-bot-api.mts', ...args], exit: (code: number) => { throw new Exit(code); } },
            console: { log: () => {}, error: (...args: unknown[]) => { errors.push(args.map(String).join(' ')); } }, Error,
            require(id: string) { assert.ok(Object.hasOwn(deps, id), `R307 CLI: закрытая граница ${id}`); if (id.startsWith('file:')) imports.push(id); return deps[id]; },
          });
          throw new Error('R307 CLI не завершился через process.exit');
        } catch (e) { if (e instanceof Exit) return e.status; throw e; }
      },
    };
    await check(copy);
  } finally {
    // root создан mkdtemp ровно для этого сценария, чужие пути cleanup не принимает.
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.equal(path.basename(root).startsWith('gv-r307-reference-'), true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
