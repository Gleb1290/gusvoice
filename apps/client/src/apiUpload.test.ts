import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import { isUploadAborted } from './uploadProgress';

function fixture() {
  // Не импортируем api со стором: исполняем неизменённые реальные функции транспорта, а не их переписанную копию.
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const pick = (name: string) => {
    const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, `найден ${name}`);
    const end = source.indexOf('\n}', start); assert.ok(end > start, `найден конец ${name}`);
    return source.slice(start, end + 2);
  };
  const instances: FakeXHR[] = [];
  class FakeXHR {
    upload: { onprogress?: (e: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
    onload?: () => void; onerror?: () => void; onabort?: () => void;
    status = 201; responseText = '{"id":"file"}';
    headers = new Map<string, string>(); address = ''; body: unknown;
    constructor() { instances.push(this); }
    open(method: string, url: string) { assert.equal(method, 'POST'); this.address = url; }
    setRequestHeader(key: string, value: string) { this.headers.set(key, value); }
    getAllResponseHeaders() { return 'content-type: application/json\r\nx-refresh-token: fresh:token\r\n'; }
    send(body: unknown) { this.body = body; }
    abort() { this.onabort?.(); }
  }
  const module = { exports: {} };
  const code = ts.transpileModule(`${pick('uploadAborted')}\n${pick('xhrUpload')}\nexport { xhrUpload };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports, XMLHttpRequest: FakeXHR, Headers, Response, TypeError });
  return { instances, upload: (module.exports as { xhrUpload: (url: string, headers: Record<string, string>, body: FormData, opts: import('./uploadProgress').UploadOpts) => Promise<Response> }).xhrUpload };
}

it('XHR отдаёт статус, тело, заголовок продления и реальные байты прогресса', async () => {
  // Прогресс не должен ломать общий транспорт обновления токена или превращать HTTP-отказ в сетевой.
  const f = fixture(); const progress: number[][] = []; const body = new FormData();
  const result = f.upload('/api/upload', { Authorization: 'test-authorization' }, body, { onProgress: (a, b) => progress.push([a, b]) });
  const xhr = f.instances[0]; assert.equal(xhr.address, '/api/upload'); assert.equal(xhr.body, body);
  assert.equal(xhr.headers.get('Authorization'), 'test-authorization');
  xhr.upload.onprogress?.({ loaded: 3, total: 10, lengthComputable: true });
  xhr.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: false });
  xhr.status = 403; xhr.onload?.(); const response = await result;
  assert.equal(response.status, 403); assert.equal(response.headers.get('x-refresh-token'), 'fresh:token');
  assert.equal(await response.text(), '{"id":"file"}'); assert.deepEqual(progress, [[3, 10], [5, 0]]);
});

it('сигнал отменяет XHR, заранее отменённый не начинает запрос, сеть даёт TypeError', async () => {
  // Отказ человека не считается потерей сети и не запускает автоматический повтор отправки.
  const f = fixture(); const ctrl = new AbortController();
  const pending = f.upload('/upload', {}, new FormData(), { signal: ctrl.signal });
  ctrl.abort(); await assert.rejects(pending, isUploadAborted);
  const already = f.upload('/upload', {}, new FormData(), { signal: ctrl.signal });
  await assert.rejects(already, isUploadAborted); assert.equal(f.instances.length, 1);
  const network = f.upload('/upload', {}, new FormData(), {});
  f.instances[1].onerror?.(); await assert.rejects(network, TypeError);
});

it('XHR без тела возвращает 204 без ошибки Response, завершённый запрос больше не отменяется', async () => {
  // Response запрещает тело у 204; снятый abort-listener не должен повторно трогать уже успешный XHR.
  const f = fixture(); const ctrl = new AbortController();
  const result = f.upload('/upload', {}, new FormData(), { signal: ctrl.signal });
  const xhr = f.instances[0]; let aborted = 0; xhr.onabort = () => { aborted++; };
  xhr.status = 204; xhr.onload?.(); const response = await result;
  assert.equal(response.status, 204); assert.equal(await response.text(), '');
  ctrl.abort(); assert.equal(aborted, 0);
});
