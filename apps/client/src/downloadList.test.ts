import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as downloads from './downloadList';

function load(source: string): { api: typeof downloads; revoked: string[] } {
  const module = { exports: {} as Record<string, unknown> };
  const revoked: string[] = [];
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, URL: { revokeObjectURL: (href: string) => revoked.push(href) } });
  return { api: module.exports as typeof downloads, revoked };
}

function mutant(from: string, to: string): typeof downloads {
  const source = readFileSync(new URL('./downloadList.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  return load(source.replace(from, to)).api;
}

it('«Открыть» разрешено безопасным растром и документами, но не SVG/HTML даже как image/*', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/avif', 'video/mp4', 'audio/ogg', 'application/pdf', 'text/plain'])
    assert.equal(downloads.opensInBrowser(type), true, `${type} открывается в браузере`);
  for (const type of ['image/svg+xml', 'text/html', 'application/xml', 'application/octet-stream'])
    assert.equal(downloads.opensInBrowser(type), false, `${type} не исполняется из нашей blob-ссылки`);
  assert.equal(downloads.opensInBrowser(' IMAGE/PNG ; charset=binary '), true);
  const broken = mutant('/^image\\/(png|jpeg|gif|webp|avif|bmp)$/', '/^image\\/.+$/');
  assert.throws(() => assert.equal(broken.opensInBrowser('image/svg+xml'), false), assert.AssertionError,
    'мутант раскрывает SVG из собственного blob-origin');
});

it('очистка удаляет завершённые записи и освобождает их blob, а загрузку оставляет активной', () => {
  const { api, revoked } = load(readFileSync(new URL('./downloadList.ts', import.meta.url), 'utf8'));
  const active = api.addDownload({ key: 'active', url: '/a', name: 'a', type: 'text/plain', total: 1 });
  const done = api.addDownload({ key: 'done', url: '/b', name: 'b', type: 'image/png', total: 2 });
  api.patchDownload(done, { state: 'done', href: 'blob:done' });
  api.clearDownloads();
  assert.equal(JSON.stringify(api.downloadsSnapshot().map(e => e.key)), JSON.stringify(['active']));
  assert.deepEqual(revoked, ['blob:done']);
  assert.equal(api.downloadsSnapshot()[0]?.id, active);
  const mutant = mutantApi('const keep = list.filter((e) => e.state === \'loading\');', 'const keep = [];');
  assert.throws(() => assert.deepEqual(mutant.downloadsSnapshot().map(e => e.key), ['active']), assert.AssertionError,
    'мутант очищает список и роняет активную загрузку с карточки');
});

function mutantApi(from: string, to: string): typeof downloads {
  const source = readFileSync(new URL('./downloadList.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from), 'точка мутации найдена');
  return load(source.replace(from, to)).api;
}

it('удалить можно только завершённую запись; удаление и вытеснение освобождают ссылки, лимит равен 50', () => {
  const { api, revoked } = load(readFileSync(new URL('./downloadList.ts', import.meta.url), 'utf8'));
  const loading = api.addDownload({ key: 'loading', url: '/', name: 'x', type: 'x', total: 1 });
  api.patchDownload(loading, { href: 'blob:loading' });
  api.removeDownload(loading);
  assert.equal(api.downloadsSnapshot().length, 1, 'незавершённую задачу нельзя удалить мимо отмены');
  api.patchDownload(loading, { state: 'done' }); api.removeDownload(loading);
  assert.deepEqual(revoked, ['blob:loading']); assert.equal(api.downloadsSnapshot().length, 0);

  const first = api.addDownload({ key: 'first', url: '/', name: 'x', type: 'x', total: 1 });
  api.patchDownload(first, { state: 'done', href: 'blob:first' });
  for (let i = 1; i < 50; i++) api.addDownload({ key: `k${i}`, url: '/', name: 'x', type: 'x', total: 1 });
  api.addDownload({ key: 'last', url: '/', name: 'x', type: 'x', total: 1 });
  assert.equal(api.downloadsSnapshot().length, 50);
  assert.equal(api.downloadsSnapshot().some(e => e.key === 'first'), false);
  assert.ok(revoked.includes('blob:first'), 'вытесненная blob-ссылка тоже закрыта');
});

it('сохранённая ссылка доступна только для готовой записи с тем же ключом', () => {
  const { api } = load(readFileSync(new URL('./downloadList.ts', import.meta.url), 'utf8'));
  const id = api.addDownload({ key: 'att', url: '/file', name: 'file', type: 'x', total: 1 });
  assert.equal(api.doneHrefOf('att'), undefined);
  api.patchDownload(id, { state: 'done', href: 'blob:att' });
  assert.equal(api.doneHrefOf('att'), 'blob:att');
  assert.equal(api.doneHrefOf('other'), undefined);
});
