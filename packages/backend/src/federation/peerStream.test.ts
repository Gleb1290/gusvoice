import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PassThrough, Readable, Transform } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as safeFetch from '../safeFetch.js';

type FakeReply = { body: Buffer; contentLength?: string };

function loadPeerStream(
  nextReply: () => FakeReply,
  calls: Record<string, unknown>[],
  sourceOverride?: string,
  bodyDelivered?: () => void,
): typeof import('./peerStream.js') {
  const fakeRequest = (options: Record<string, unknown>) => {
    calls.push(options);
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (_error?: Error) => void;
      setTimeout: (ms: number) => void;
    };
    request.destroy = () => {};
    request.setTimeout = () => {};
    request.end = () => {
      const reply = nextReply();
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
        complete: boolean;
      };
      response.statusCode = 200;
      response.headers = {
        'content-type': 'application/octet-stream',
        ...(reply.contentLength !== undefined ? { 'content-length': reply.contentLength } : {}),
      };
      response.complete = true;
      request.emit('response', response);
      queueMicrotask(() => {
        if (response.destroyed) return;
        bodyDelivered?.();
        response.end(reply.body);
      });
    };
    return request;
  };
  const source = sourceOverride ?? readFileSync(new URL('./peerStream.ts', import.meta.url), 'utf8');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module,
    exports: module.exports,
    Buffer,
    URL,
    URLSearchParams,
    setTimeout: (_fn: () => void, _ms: number) => ({ unref: () => {} }),
    clearTimeout: (_handle: unknown) => {},
    require: (name: string) => {
      if (name === 'node:http' || name === 'node:https') return { request: fakeRequest };
      if (name === 'node:stream') return { Transform, Readable };
      if (name === '../safeFetch.js') return safeFetch;
      if (name === './httpSignature.js') return { signRequest: () => ({ authorization: 'fixture' }) };
      throw new Error(`неожиданный импорт peerStream: ${name}`);
    },
  });
  return module.exports as typeof import('./peerStream.js');
}

const lookup = (() => {}) as unknown as NonNullable<Parameters<typeof safeFetch.resolvePeerTarget>[2]>;

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('поток вложения от соседа', () => {
  it('ровно maxBytes проходит, а следующий байт обрывает поток', async () => {
    // Класс ошибки: тихое обрезание потока превращает вложение в повреждённый файл без признака ошибки.
    let body = Buffer.from('1234');
    const calls: Record<string, unknown>[] = [];
    const source = readFileSync(new URL('./peerStream.ts', import.meta.url), 'utf8');
    const original = loadPeerStream(() => ({ body }), calls, source);
    const request = (api: typeof original) => api.safePeerStream({
      url: 'https://peer.example/att', allowHosts: new Set(['peer.example']), maxBytes: 4,
    }, lookup);
    const exact = await request(original);
    assert.deepEqual(await streamBytes(exact.body), Buffer.from('1234'));
    assert.equal(calls[0]?.lookup, lookup, 'поток использует только переданный fake DNS lookup');

    body = Buffer.from('12345');
    const over = await request(original);
    await assert.rejects(() => streamBytes(over.body), /ответ соседа больше предела/);
  });

  it('общий потолок не подменяет меньший лимит вызывающей стороны', async () => {
    // Класс ошибки: потоковый предел конкретного вложения теряется из-за общего потолка.
    let body = Buffer.from('1234');
    const calls: Record<string, unknown>[] = [];
    const source = readFileSync(new URL('./peerStream.ts', import.meta.url), 'utf8');
    const original = loadPeerStream(() => ({ body }), calls, source);
    const request = (api: typeof original) => api.safePeerStream({
      url: 'https://peer.example/att', allowHosts: new Set(['peer.example']), maxBytes: 4,
    }, lookup);
    const exact = await request(original);
    assert.deepEqual(await streamBytes(exact.body), Buffer.from('1234'));
    body = Buffer.from('12345');
    const over = await request(original);
    await assert.rejects(() => streamBytes(over.body), /ответ соседа больше предела/);

    const anchor = 'if (size > maxBytes) {';
    assert.equal(source.split(anchor).length - 1, 1, 'якорь ограничения потока должен быть уникальным');
    const mutant = loadPeerStream(() => ({ body }), [], source.replace(anchor, 'if (size > PEER_MAX_STREAM_BYTES) {'));
    const mustRejectOversize = async (api: typeof original) => {
      const result = await request(api);
      try {
        await streamBytes(result.body);
      } catch (error) {
        assert.ok(error instanceof safeFetch.BlockedTargetError, 'отказ должен быть именно лимитом размера');
        assert.match(error.message, /ответ соседа больше предела/);
        return;
      }
      assert.fail('пятый байт должен отвергаться при maxBytes=4');
    };
    await mustRejectOversize(original);
    await assert.rejects(
      () => mustRejectOversize(mutant),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes('пятый байт должен отвергаться при maxBytes=4'),
      'мутант общего потолка не заменяет меньший лимит вызывающей стороны',
    );
  });

  it('Content-Length больше предела отклоняется до чтения тела', async () => {
    // Класс ошибки: сосед навязывает заведомо слишком большой ответ ещё до первого байта.
    let bodyStarts = 0;
    const calls: Record<string, unknown>[] = [];
    const api = loadPeerStream(() => ({ body: Buffer.from('12345'), contentLength: '5' }), calls, undefined, () => { bodyStarts += 1; });
    await assert.rejects(() => api.safePeerStream({
      url: 'https://peer.example/att', allowHosts: new Set(['peer.example']), maxBytes: 4,
    }, lookup), /ответ соседа больше предела/);
    assert.equal(calls.length, 1);
    assert.equal(bodyStarts, 0, 'ответный заголовок проверен до передачи тела в поток');
  });

  it('хост вне списка отклоняется до транспорта', async () => {
    // Класс ошибки: сосед может превратить потоковую загрузку в SSRF по URL из чужой визитки.
    const calls: Record<string, unknown>[] = [];
    const api = loadPeerStream(() => ({ body: Buffer.from('unused') }), calls);
    await assert.rejects(() => api.safePeerStream({
      url: 'https://peer.example/att', allowHosts: new Set(['other.example']), maxBytes: 10,
    }, lookup), /не в списке/);
    assert.deepEqual(calls, []);
  });

  it('loopback без dev-peer исключения отклоняется до транспорта', async () => {
    // Класс ошибки: локальный адрес не должен становиться доступен только от подмены allowlist.
    const calls: Record<string, unknown>[] = [];
    const api = loadPeerStream(() => ({ body: Buffer.from('unused') }), calls);
    await assert.rejects(() => api.safePeerStream({
      url: 'https://127.0.0.1/att', allowHosts: new Set(['127.0.0.1']), maxBytes: 10,
    }), /127\.0\.0\.1/);
    assert.deepEqual(calls, []);
  });
});
