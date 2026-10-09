import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as chunks from './chunkedUpload';
import type { Attachment } from '@gusvoice/shared';
import type { ChunkDeps, ChunkOpts } from './chunkedUpload';

const raw = readFileSync(new URL('./chunkedUpload.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const attachment = { id: 'attachment', name: 'data.bin', size: 17 } as Attachment;
function changed(from: string, to: string): typeof chunks {
  assert.ok(raw.includes(from), `якорь ${from}`); const module = { exports: {} };
  // Полный автономный модуль: ни одной функции не вырезаем и не исполняем отдельно.
  runInNewContext(ts.transpileModule(raw.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports,
    Blob, File, Response, AbortController, Error, TypeError, WeakMap, setTimeout, clearTimeout });
  return module.exports as typeof chunks;
}
const fileOf = (size = 17) => new File([new Uint8Array(size)], 'data.bin', { type: 'application/octet-stream' });
function error(status: number) { return Object.assign(new Error(`HTTP ${status}`), { status }); }
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function server(file: File, a: {
  part?: (n: number, attempt: number, body: Blob, opts: ChunkOpts) => Promise<Response>;
  request?: (method: string, path: string) => unknown | Promise<unknown>;
} = {}) {
  const calls: [string, string, unknown?][] = [], puts: number[] = [], done = new Set<number>(), attempts = new Map<number, number>();
  const sizes: number[] = [], sleeps: number[] = []; let starts = 0;
  const status = () => ({ uploadId: `u${starts}`, partSize: 4, parts: Math.ceil(file.size / 4), size: file.size, done: [...done] });
  const deps: ChunkDeps = {
    req: (async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (a.request) { const result = await a.request(method, path); if (result !== undefined) return result; }
      if (method === 'DELETE') return {};
      if (method === 'GET') return status();
      if (path.endsWith('/complete')) return attachment;
      starts++; done.clear(); return status();
    }) as ChunkDeps['req'],
    putPart: async (path, body, opts) => {
      const n = Number(path.split('/').at(-1)); puts.push(n); sizes.push(body.size);
      const attempt = (attempts.get(n) ?? 0) + 1; attempts.set(n, attempt);
      const response = a.part ? await a.part(n, attempt, body, opts) : new Response('{}', { status: 200 });
      if (response.ok) done.add(n);
      return response;
    },
    sleep: async ms => { sleeps.push(ms); },
  };
  return { deps, calls, puts, done, attempts, sizes, sleeps, status, starts: () => starts };
}

it('R127 номера недостающих кусков и границы последнего сохраняют порядок и остаток', () => {
  // Дубликат done не пропускает следующий кусок, последняя порция не читает за размером файла.
  assert.deepEqual(chunks.partsToSend(5, [4, 2, 2, 99, 0]), [1, 3, 5]);
  assert.deepEqual(chunks.partsToSend(0, []), []); assert.deepEqual(chunks.partsToSend(2, [1, 2]), []);
  assert.deepEqual(chunks.partRange(17, 4, 1), { start: 0, end: 4 });
  assert.deepEqual(chunks.partRange(17, 4, 5), { start: 16, end: 17 });
  assert.deepEqual(chunks.partRange(16, 4, 4), { start: 12, end: 16 });
});
it('R127 повторяются сеть, 408, 429, 5xx и зависание, остальные 4xx окончательные', () => {
  // Ошибка размера или прав не должна превращаться в серию повторных дорогих PUT.
  for (const value of [new TypeError('сеть'), new Error('сеть'), { stalled: true }, error(408), error(429), error(500), error(503)])
    assert.equal(chunks.retryablePartError(value), true);
  for (const status of [400, 401, 403, 404, 409, 413, 422]) assert.equal(chunks.retryablePartError(error(status)), false);
});

async function resumeCase(api = chunks) {
  const file = fileOf(); let offline = true;
  const s = server(file, { part: async n => { if (n === 2 && offline) throw new TypeError('сеть оборвалась'); return new Response('{}'); } });
  await assert.rejects(api.uploadInChunks(s.deps, 'chat', file), TypeError);
  assert.equal(s.attempts.get(2), chunks.RETRY_MS.length + 1, 'все попытки куска исчерпаны');
  const saved = [...s.done]; assert.ok(saved.length > 0 && !saved.includes(2));
  assert.equal(s.calls.some(([method]) => method === 'DELETE'), false, 'обрыв сохраняет сессию');
  offline = false; const firstCount = s.puts.length;
  assert.equal(await api.uploadInChunks(s.deps, 'chat', file), attachment);
  assert.equal(s.starts(), 1, 'тот же File продолжает прежнюю сессию');
  assert.ok(s.calls.some(([method, path]) => method === 'GET' && path.endsWith('/u1')));
  assert.deepEqual(s.puts.slice(firstCount), [2], 'доливается только недостающий кусок');
}
it('R127 после обрыва тот же File продолжает сессию только недостающим куском', async () => {
  // Пересоздание сессии теряло бы уже отправленные байты после краткого обрыва сети.
  await resumeCase();
  await assert.rejects(resumeCase(changed('    sessions.set(file, { convId, uploadId: r.uploadId });', '')), /продолжает прежнюю сессию/);
});
it('R131 404 статуса и сборки создают новую сессию, другой объект File не подхватывает чужую', async () => {
  // Забытый сервером upload и другой файл должны начать заново, а не доливаться в старый объект.
  for (const sameFile of [true, false]) {
    const file = fileOf(4); let offline = true;
    const s = server(file, { part: async () => { if (offline) throw new TypeError('сеть'); return new Response('{}'); },
      request: (method, path) => { if (method === 'GET' || (method === 'POST' && path.endsWith('/complete') && s.starts() === 1)) throw error(404); } });
    await assert.rejects(chunks.uploadInChunks(s.deps, 'chat', file), TypeError);
    offline = false;
    await chunks.uploadInChunks(s.deps, 'chat', sameFile ? file : fileOf(4));
    assert.equal(s.starts(), 2);
    assert.equal(s.calls.filter(([method]) => method === 'GET').length, sameFile ? 1 : 0);
    if (sameFile) {
      const at = s.calls.findIndex(([method]) => method === 'GET');
      assert.deepEqual(s.calls.slice(at, at + 3).map(([method,path]) => [method,path]), [
        ['GET','/conv/chat/uploads/u1'], ['POST','/conv/chat/uploads/u1/complete'], ['POST','/conv/chat/uploads'],
      ], 'новая загрузка только после попытки вернуть готовое вложение');
    }
  }
});

async function assemblyCase(api=chunks){
  const file=fileOf(4);let completed=0;
  const s=server(file,{request:(method,path)=>{
    if(method==='POST'&&path.endsWith('/complete')&&completed++<2)return{assembling:true};
  }});
  const result=await api.uploadInChunks(s.deps,'chat',file);
  assert.equal(result,attachment,'202 не выдаётся за готовое вложение');
  assert.equal(completed,3,'сборка опрашивается до готовности');
  assert.deepEqual(s.sleeps,[chunks.ASSEMBLY_POLL_MS,chunks.ASSEMBLY_POLL_MS]);
  assert.equal(s.starts(),1);assert.deepEqual(s.puts,[1]);
}
it('R131 202 сборки опрашивается с ASSEMBLY_POLL_MS до настоящего вложения',async()=>{
  // Ответ «собирается» не является вложением и не должен уходить в отправку сообщения.
  await assemblyCase();
  await assert.rejects(assemblyCase(changed('      if (!isAssembling(r)) return r;','      return r;')),/не выдаётся за готовое вложение/);
});
async function busyCase(api=chunks){
  const file=fileOf(4);const s=server(file,{part:async(_n,attempt)=>{
    if(attempt<=chunks.RETRY_MS.length+1)return new Response('{}',{status:attempt%2?429:503,headers:{'Retry-After':'2'}});
    if(attempt<=chunks.RETRY_MS.length+3)throw new TypeError('теперь обрыв');
    return new Response('{}');
  }});
  assert.equal(await api.uploadInChunks(s.deps,'chat',file),attachment);
  assert.equal(s.puts.length,chunks.RETRY_MS.length+4,'занятость не исчерпала обычные попытки');
  assert.deepEqual(s.sleeps,[...Array(chunks.RETRY_MS.length+1).fill(2000),chunks.RETRY_MS[0],chunks.RETRY_MS[1]]);
}
it('R131 429 и 503 с Retry-After ждут указанные секунды, не расходуя повторы обрыва',async()=>{
  // Шесть ответов «занят» должны оставить обычную сетевую квоту попыток нетронутой.
  await busyCase();
  await assert.rejects(busyCase(changed('          attempt--;','')),e=>e instanceof TypeError);
});
it('R131 BUSY_RETRIES ровно 60 дополнительных ожиданий, бесконечно занятый сервер не зависает',async()=>{
  // Дополнительные ожидания ограничены: очередь должна вернуть сетевую ошибку, а не крутиться вечно.
  assert.equal(chunks.BUSY_RETRIES,60);
  const file=fileOf(4);const s=server(file,{part:async()=>new Response('{}',{status:503,headers:{'Retry-After':'1'}})});
  await assert.rejects(chunks.uploadInChunks(s.deps,'chat',file),TypeError);
  assert.equal(s.puts.length,chunks.BUSY_RETRIES+chunks.RETRY_MS.length+1);
  assert.deepEqual(s.sleeps,[...Array(chunks.BUSY_RETRIES).fill(1000),...chunks.RETRY_MS]);
});
it('R131 429 и 503 без Retry-After используют обычную конечную квоту повторов',async()=>{
  // Один лишь статус «занят» не должен дарить 60 попыток без объявленной сервером паузы.
  for(const status of [429,503]){
    const file=fileOf(4);const s=server(file,{part:async()=>new Response('{}',{status})});
    await assert.rejects(chunks.uploadInChunks(s.deps,'chat',file),TypeError);
    assert.equal(s.puts.length,chunks.RETRY_MS.length+1);assert.deepEqual(s.sleeps,[...chunks.RETRY_MS]);
  }
});
async function recoverCase(api=chunks){
  const file=fileOf(4);let offline=true;
  const s=server(file,{part:async()=>{if(offline)throw new TypeError('ответ потерян');return new Response('{}');},
    request:(method)=>{if(method==='GET')throw error(404);}});
  await assert.rejects(api.uploadInChunks(s.deps,'chat',file),TypeError);
  offline=false;const before=s.puts.length,progress:unknown[]=[];
  assert.equal(await api.uploadInChunks(s.deps,'chat',file,{onProgress:(loaded,total)=>progress.push([loaded,total])}),attachment);
  assert.equal(s.starts(),1,'404 сначала восстанавливает готовое вложение, не создаёт новую сессию');
  assert.equal(s.puts.length,before,'восстановление не перезаливает файл');
  assert.equal(s.calls.filter(([method,path])=>method==='POST'&&path.endsWith('/complete')).length,1);
  assert.deepEqual(progress,[[4,4]]);
}
it('R131 потерянный ответ сборки после 404 статуса восстанавливается complete до нового POST',async()=>{
  // Повторный старт после уже оплаченной сборки создавал бы второй файл и повторно расходовал квоту.
  await recoverCase();
  await assert.rejects(recoverCase(changed(
    "      const att = await assemble(prevPath).catch((e: { status?: number }) => {\n        if (e?.status === 404) return null;\n        throw e;\n      });",
    '      const att = null;')),/не создаёт новую сессию/);
});
async function progressFailureCase(api=chunks){
  const file=fileOf(4);const s=server(file,{part:async(_n,attempt,_body,opts)=>{
    opts.onProgress!(attempt===1?2:4,4);if(attempt===1)throw new TypeError('половина куска оборвалась');return new Response('{}');
  }});
  const progress:number[]=[];
  await api.uploadInChunks(s.deps,'chat',file,{onProgress:(loaded,total)=>{assert.equal(total,4);progress.push(loaded);}});
  assert.equal(progress[0],0);assert.equal(progress.at(-1),4);
  assert.ok(progress.includes(2),'показана половина куска до обрыва');
  for(let i=1;i<progress.length;i++)assert.ok(progress[i]!>=progress[i-1]!,`полоса не идёт назад: ${progress.join(',')}`);
  assert.deepEqual(progress,[0,2,2,4,4,4]);
}
it('R131 половина оборванного куска не откатывает показанное назад, повтор догоняет прогресс',async()=>{
  // Репро R127 [0,2,0,…] теперь закреплён против возврата регрессии.
  await progressFailureCase();
  await assert.rejects(progressFailureCase(changed('shown = Math.max(shown, Math.min(sum, file.size));','shown = Math.min(sum, file.size);')),/полоса не идёт назад/);
});
it('R127 409 сборки перечитывает статус и доливает только исчезнувший кусок', async () => {
  // Ответ успешного PUT мог потеряться у сервера: нельзя собирать неполный файл или лить всё снова.
  const file = fileOf(9); let completed = 0;
  const s = server(file, { request: (method, path) => {
    if (method === 'POST' && path.endsWith('/complete') && completed++ === 0) { s.done.delete(2); throw error(409); }
  } });
  await chunks.uploadInChunks(s.deps, 'chat', file);
  assert.equal(completed, 2); assert.deepEqual(s.puts, [1, 2, 3, 2]);
  assert.equal(s.calls.filter(([method]) => method === 'GET').length, 1);
});

async function abortCase(api = chunks) {
  const file = fileOf(4), ctrl = new AbortController();
  const s = server(file, { part: async (_n, _attempt, _body, opts) => {
    ctrl.abort(); assert.equal(opts.signal?.aborted, true, 'отмена человека передана транспорту'); throw new Error('aborted transport');
  } });
  await assert.rejects(api.uploadInChunks(s.deps, 'chat', file, { signal: ctrl.signal }), (e: unknown) => (e as { aborted?: boolean }).aborted === true);
  assert.equal(s.calls.filter(([method]) => method === 'DELETE').length, 1, 'отменённая сессия удалена');
  assert.equal(s.puts.length, 1); assert.equal(s.sleeps.length, 0);
  await api.uploadInChunks(server(file).deps, 'chat', file);
}
it('R127 отмена обрывает транспорт, отдаёт aborted и удаляет сессию без повторов', async () => {
  // Закрытие отправки должно освобождать серверную multipart-загрузку, а не оставлять мусор.
  await abortCase();
  await assert.rejects(abortCase(changed("    void deps.req('DELETE', path).catch(() => {});", '')), /сессия удалена/);
});
it('R127 заранее отменённый сигнал не начинает ни сессию, ни PUT', async () => {
  // Отменённая ещё до старта очередь не должна расходовать серверный суточный бюджет.
  const file = fileOf(), ctrl = new AbortController(); ctrl.abort(); const s = server(file);
  await assert.rejects(chunks.uploadInChunks(s.deps, 'chat', file, { signal: ctrl.signal }), (e: unknown) => (e as { aborted?: boolean }).aborted === true);
  assert.equal(s.calls.length, 0); assert.equal(s.puts.length, 0);
});
async function rejectedPartCase(api = chunks) {
  const file = fileOf(4); const s = server(file, { part: async () => new Response(JSON.stringify({ error: 'слишком большой кусок' }), { status: 413 }) });
  await assert.rejects(api.uploadInChunks(s.deps, 'chat', file), (e: unknown) => (e as { status?: number }).status === 413);
  assert.equal(s.puts.length, 1, '413 не повторяется'); assert.equal(s.sleeps.length, 0);
  assert.equal(s.calls.filter(([method]) => method === 'DELETE').length, 1, 'невосстановимая сессия удалена');
}
it('R127 413 куска не повторяется и удаляет бесполезную сессию', async () => {
  // Неисправимый ответ 4xx должен закончить отправку немедленно, без пяти повторов.
  await rejectedPartCase();
  await assert.rejects(rejectedPartCase(changed('  return status === undefined || status === 408 || status === 429 || status >= 500;', '  return true;')));
});
it('R127 зависший кусок отменяется по STALL_MS и повторяется с нулевой реальной паузой', async t => {
  // Транспорт может молчать вечно: сторож должен оборвать попытку сам, без долгого тестового sleep.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = fileOf(4), entered = deferred<void>(); let firstSignal: AbortSignal | undefined;
  const s = server(file, { part: async (_n, attempt, _body, opts) => {
    if (attempt > 1) return new Response('{}'); firstSignal = opts.signal;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => opts.signal!.addEventListener('abort', () => reject(new Error('сторож оборвал')), { once: true }));
  } });
  const work = chunks.uploadInChunks(s.deps, 'chat', file); await entered.promise;
  t.mock.timers.tick(chunks.STALL_MS - 1); assert.equal(firstSignal!.aborted, false);
  t.mock.timers.tick(1); assert.equal(firstSignal!.aborted, true);
  await work; assert.equal(s.puts.length, 2); assert.deepEqual(s.sleeps, [chunks.RETRY_MS[0]]);
});
it('R127 прогресс успешной загрузки монотонный до размера и параллельность не больше трёх', async () => {
  // Предел воркеров бережёт мобильное соединение; остаточный кусок даёт только свой реальный размер.
  const file = fileOf(17), initial = deferred<void>(), release = deferred<void>();
  let active = 0, peak = 0, opened = 0;
  const s = server(file, { part: async (_n, _attempt, body, opts) => {
    active++; peak = Math.max(peak, active); if (++opened === chunks.CHUNK_PARALLEL) initial.resolve();
    opts.onProgress!(body.size / 2, body.size);
    await release.promise; opts.onProgress!(body.size, body.size); active--; return new Response('{}');
  } });
  const progress: [number, number][] = [];
  const work = chunks.uploadInChunks(s.deps, 'chat/id', file, { onProgress: (loaded, total) => progress.push([loaded, total]) });
  await initial.promise; assert.equal(active, chunks.CHUNK_PARALLEL); assert.equal(opened, chunks.CHUNK_PARALLEL);
  release.resolve(); await work;
  assert.equal(chunks.CHUNK_PARALLEL, 3); assert.equal(peak, 3);
  assert.deepEqual(s.sizes.sort((a,b) => a-b), [1,4,4,4,4]);
  assert.deepEqual(progress[0], [0,17]); assert.deepEqual(progress.at(-1), [17,17]);
  for (let i = 1; i < progress.length; i++) { assert.ok(progress[i]![0] >= progress[i-1]![0]); assert.equal(progress[i]![1],17); assert.ok(progress[i]![0] <=17); }
  assert.equal(s.calls[0]![1], '/conv/chat%2Fid/uploads', 'id беседы закодирован');
});
