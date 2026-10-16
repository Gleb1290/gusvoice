import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import type { ViteDevServer } from 'vite';
import { setupHarness } from './MessagePane.behavior.harness';
const h = setupHarness(import.meta.url);
async function scene(component = h.Pane, server: ViteDevServer = h.server) {
  h.round12(); h.desktop();
  const { resetAutoDownload } = await server.ssrLoadModule('/src/autoDownload.ts') as typeof import('../autoDownload'); resetAutoDownload();
  const photo = (id: string, copying = false, sort = 1) => ({ ...h.msg(id, 'peer', 0, sort), content: '',
    attachments: [{ id, url: `/${id}.png`, name: `${id}.png`, contentType: 'image/png', size: 12, width: 100, height: 80, ...(copying ? { fedState: 'copying' as const } : {}) }] });
  const open = async () => {
    const button = h.host.querySelector<HTMLButtonElement>('[data-mid="ready-first"] .att-img-link'); assert.equal(!!button, true);
    await act(async () => { button!.click(); await h.flush(); }); assert.equal(!!document.querySelector('.lightbox'), true);
  };
  try {
    await h.mount({ messages: [photo('ready-first'), photo('copying', true, 2), photo('ready-last', false, 3)] }, component);
    await open();
    assert.equal(document.querySelector('.lb-sub')?.textContent?.includes('1 из 2'), true, 'просмотр считает только готовые картинки');
    assert.equal([...document.querySelectorAll('.lightbox img')].some(node => node.getAttribute('src') === '/copying.png'), false);
    h.unmount();
    await h.mount({ messages: [photo('ready-first'), photo('copying', false, 2), photo('ready-last', false, 3)] }, component);
    await open();
    assert.equal(document.querySelector('.lb-sub')?.textContent?.includes('1 из 3'), true, 'готовая копия возвращается в просмотр');
  } finally { h.unmount(); }
}
it('R194 настоящий просмотр ленты исключает copying и возвращает файл после готовности', async () => {
  // Класс ошибки: стрелки просмотра предлагают ещё отсутствующие байты.
  await scene();
});
h.mutantTest('R194 снятый copying-фильтр allImages ловится числом картинок настоящего просмотрщика', async () => {
  // Класс ошибки: скрытая в ленте копия остаётся в коллекции Lightbox.
  await h.rejectMutant(source => {
    const anchor = "if (!a.asFile && a.fedState !== 'copying' && (isImage(a.contentType) || video))";
    assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь коллекции');
    return source.replace(anchor, 'if (!a.asFile && (isImage(a.contentType) || video))');
  }, async (component, _confirm, _answer, server) => scene(component, server!), 'просмотр считает только готовые картинки');
});
