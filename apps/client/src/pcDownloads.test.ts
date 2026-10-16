import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type * as pcDownloads from './pcDownloads';
import * as toastRuntime from './toast';

interface Harness {
  api: typeof pcDownloads;
  fetches: number;
  saved: string[];
  toasts: string[];
  errorToasts: Array<{ title: string; subtitle?: string }>;
  records: Array<{ key: string; state?: string; href?: string }>;
  jobs: Map<string, { aborted: boolean }>;
  resolveFetch: ((blob: { size: number; type: string }) => void) | null;
  rejectFetch: ((error: Error) => void) | null;
  setDone: (key: string, href: string) => void;
  sharedFiles: string[];
  setShareError: (name: string | null) => void;
  legacyCalls: Array<{ url: string; name: string; mime: string; then: string }>;
}

function harness(
  source = readFileSync(new URL('./pcDownloads.ts', import.meta.url), 'utf8'),
  options: { filesViaNative?: boolean; bridgeResult?: string; legacyBridge?: boolean } = {},
): Harness {
  const state: Harness = {
    api: {} as typeof pcDownloads, fetches: 0, saved: [], toasts: [], errorToasts: [], records: [], jobs: new Map(),
    resolveFetch: null, rejectFetch: null, setDone: () => undefined, sharedFiles: [], setShareError: () => undefined, legacyCalls: [],
  };
  const done = new Map<string, string>();
  let shareError: string | null = null;
  state.setDone = (key, href) => done.set(key, href);
  state.setShareError = name => { shareError = name; };
  let recId = 0;
  const fileActions = {
    attachmentKey: (a: { id?: string; url?: string }) => a.id || a.url || 'att',
    attachmentMime: (a: { contentType?: string }) => a.contentType || 'application/octet-stream',
    filesViaNative: () => options.filesViaNative ?? false,
    progressRatio: (loaded: number, total: number) => total ? loaded / total : 0,
    trackFileJob: (key: string) => {
      if (state.jobs.has(key)) return null;
      const ctrl = { aborted: false }; state.jobs.set(key, ctrl);
      return { live: () => !ctrl.aborted, signal: { get aborted() { return ctrl.aborted; } }, progress: () => undefined, end: () => state.jobs.delete(key) };
    },
    cancelFileJob: (key: string) => { const job = state.jobs.get(key); if (!job) return false; job.aborted = true; return true; },
    fetchWithProgress: () => {
      state.fetches++;
      return new Promise((resolve, reject) => { state.resolveFetch = resolve; state.rejectFetch = reject; });
    },
  };
  const downloadList = {
    addDownload: (d: { key: string }) => { const id = ++recId; state.records.push({ key: d.key, state: 'loading' }); return id; },
    patchDownload: (id: number, patch: { state?: string; href?: string }) => { Object.assign(state.records[id - 1]!, patch); },
    doneHrefOf: (key: string) => done.get(key),
  };
  class MockFile {
    name: string; type: string; size = 1;
    constructor(_parts: unknown[], name: string, opts: { type: string }) { this.name = name; this.type = opts.type; }
  }
  const navigator = {
    canShare: () => true,
    share: async ({ files }: { files: MockFile[] }) => {
      state.sharedFiles.push(files[0]!.name);
      if (shareError) { const e = new Error(shareError); e.name = shareError; throw e; }
    },
  };
  const document = {
    body: { appendChild: () => undefined },
    createElement: () => ({ href: '', download: '', rel: '', click: () => state.saved.push('click'), remove: () => undefined }),
  };
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      if (id === './api') return { api: { attachmentDownloadUrl: (a: { url?: string }) => a.url } };
      if (id === './fileActions') return fileActions;
      if (id === './downloadList') return downloadList;
      if (id === './toast') return { toast: (_kind: string, text: string) => state.toasts.push(text), toastError: (e: unknown, title?: string) => {
        const prior = toastRuntime.useToasts.getState();
        try { toastRuntime.toastError(e, title); const last = toastRuntime.useToasts.getState().toasts.at(-1)!; state.toasts.push(last.title); state.errorToasts.push({ title: last.title, subtitle: last.subtitle }); }
        finally { toastRuntime.useToasts.setState(prior, true); }
      } };
      throw new Error(`неожиданный импорт ${id}`);
    }, navigator, File: MockFile, ReadableStream: function ReadableStream() {}, URL: { createObjectURL: () => 'blob:new' },
      window: {
        setTimeout: (fn: () => void) => fn(),
        GusVoiceNative: options.legacyBridge ? {
          downloadFile: (json: string) => { state.legacyCalls.push(JSON.parse(json)); return options.bridgeResult ?? 'ok'; },
        } : undefined,
      }, document, Error });
  state.api = module.exports as typeof pcDownloads;
  return state;
}

const target = { key: 'file-1', url: '/download', name: 'file.bin', size: 12, type: 'application/octet-stream' };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

for (const who of ['Гусь', null]) it(`R195 ПК скачивание недоступного дома ${who ? 'с именем' : 'без имени'} сообщает восстановление связи`, async () => {
  // Класс ошибки: общий загрузчик ПК теряет маркированный федеративный отказ.
  const h = harness(); h.api.startDownload(target);
  assert.equal(!!h.rejectFetch, true);
  h.rejectFetch!(Object.assign(new Error('federation.att_unavailable'), { fedFile: true, fedWho: who }));
  await tick();
  assert.equal(h.records.at(-1)?.state, 'failed');
  assert.equal(h.errorToasts.length, 1); assert.equal(h.errorToasts[0].title, target.name);
  assert.equal(h.errorToasts[0].subtitle, who ? 'Файл появится, когда «Гусь» снова будет на связи' : 'Файл появится, когда инстанс собеседника снова будет на связи');
  assert.equal(h.saved.length, 0); assert.equal(h.jobs.size, 0);
});

it('повторный щелчок отменяет текущую загрузку без ошибки или тоста', async () => {
  const h = harness();
  h.api.toggleDownload(target);
  assert.equal(h.fetches, 1);
  h.api.toggleDownload(target);
  assert.equal(h.jobs.get(target.key)?.aborted, true);
  h.resolveFetch!({ size: 12, type: target.type }); await tick();
  assert.equal(h.records[0]?.state, 'cancelled');
  assert.deepEqual(h.toasts, []);
});

it('готовый файл повторно сохраняется из сохранённого blob без второго fetch', () => {
  const h = harness(); h.setDone(target.key, 'blob:ready');
  h.api.startDownload(target);
  assert.equal(h.fetches, 0); assert.deepEqual(h.saved, ['click']);
  const source = readFileSync(new URL('./pcDownloads.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('if (done) {'));
  const mutant = harness(source.replace('if (done) {', 'if (done && false) {'));
  mutant.setDone(target.key, 'blob:ready'); mutant.api.startDownload(target);
  assert.equal(mutant.fetches, 1, 'мутант снова идёт в сеть вместо готового объекта');
});

it('ошибка HTTP помечает запись failed и показывает причину, а не успех', async () => {
  const h = harness(); h.api.startDownload(target);
  h.rejectFetch!(new Error('HTTP 500')); await tick();
  assert.equal(h.records[0]?.state, 'failed');
  assert.deepEqual(h.toasts, ['Не удалось скачать файл']);
});

it('после NotAllowedError «Поделиться» оставляет файл готовым для повтора без сети', async () => {
  const h = harness(); const notes: Array<{ text: string; final: boolean }> = [];
  h.setShareError('NotAllowedError');
  const first = h.api.shareDownload(target, n => notes.push(n));
  h.resolveFetch!({ size: 12, type: target.type }); await first;
  assert.equal(h.fetches, 1); assert.equal(JSON.stringify(notes.at(-1)), JSON.stringify({ text: 'Файл готов — нажмите «Поделиться» ещё раз', final: true }));
  h.setShareError(null);
  await h.api.shareDownload(target, n => notes.push(n));
  assert.equal(h.fetches, 1); assert.deepEqual(h.sharedFiles, ['file.bin', 'file.bin']);
  assert.equal(JSON.stringify(notes.at(-1)), JSON.stringify({ text: '', final: true }));
});

it('старый WebView сохраняет через мост, не скачивая blob; отказ показывает ошибку', () => {
  const check = (h: Harness) => {
    h.api.startDownload(target);
    assert.deepEqual(h.legacyCalls, [{ url: target.url, name: target.name, mime: target.type, then: 'save' }], 'мост получает save');
    assert.equal(h.fetches, 0, 'страница не качает blob, который старый WebView не умеет сохранять');
    assert.ok(h.toasts.includes('Файл скачивается'), 'успешная постановка показывает ход');
  };
  const h = harness(undefined, { legacyBridge: true }); check(h);
  const denied = harness(undefined, { legacyBridge: true, bridgeResult: 'denied' }); denied.api.startDownload(target);
  assert.ok(denied.toasts.includes('Не удалось скачать файл'), 'отказ моста не выглядит как успешное скачивание');

  const alwaysOpen = readFileSync(new URL('./pcDownloads.ts', import.meta.url), 'utf8')
    .replace("legacyDownloadWithToast(t.url, t.name, t.type, 'save');", "legacyDownloadWithToast(t.url, t.name, t.type, 'open');");
  assert.notEqual(alwaysOpen, readFileSync(new URL('./pcDownloads.ts', import.meta.url), 'utf8'), 'мутант меняет then');
  assert.throws(() => check(harness(alwaysOpen, { legacyBridge: true })), assert.AssertionError, 'тест ловит мутант then=open');
});

it('современный WebView не вызывает устаревший мост, даже если тот объявлен', () => {
  const check = (h: Harness) => {
    h.api.startDownload(target);
    assert.deepEqual(h.legacyCalls, [], 'при нативной передаче файлов строковый мост не нужен');
    assert.equal(h.fetches, 1, 'остаётся обычный поток загрузки современного WebView');
  };
  check(harness(undefined, { filesViaNative: true, legacyBridge: true }));

  const source = readFileSync(new URL('./pcDownloads.ts', import.meta.url), 'utf8');
  const withoutGate = source.replace('  if (filesViaNative()) return false;\n', '');
  assert.notEqual(withoutGate, source, 'мутант убирает проверку filesViaNative');
  assert.throws(() => check(harness(withoutGate, { filesViaNative: true, legacyBridge: true })), assert.AssertionError, 'тест ловит удалённую проверку');
});
