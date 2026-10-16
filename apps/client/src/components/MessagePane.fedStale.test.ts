import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, createElement } from 'react';
import { setupHarness } from './MessagePane.behavior.harness';
import { FED_VIA_TEXT_ONLY } from '../convSyncRules';

const h = setupHarness(import.meta.url);
const notice = createElement('div', { className: 'composer-blocked fed-archive fed-stale', role: 'status' }, 'Сообщения ждут, пока «Сосед» их заберёт');
const replacement = createElement('div', { 'data-composer-replacement': true }, 'Переписка закрыта');
it('R200 настоящий MessagePane показывает fed-via-bar над полем и не открывает скрепку текстового обхода', async () => {
  h.desktop(); const restore = h.pointerLayout(false, 1280);
  try {
    await h.mount({ filesBlocked: FED_VIA_TEXT_ONLY, composerNote: createElement('div', { className: 'fed-via-bar', role: 'status' }, 'Инстанс «Дом» недоступен — пишем через «Сосед»') });
    assert.equal(h.host.querySelector('.fed-via-bar')?.textContent, 'Инстанс «Дом» недоступен — пишем через «Сосед»');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'текстовый обход оставляет поле');
    const attach = h.host.querySelector<HTMLButtonElement>('.att-btn.attach'); assert.equal(!!attach, true);
    assert.equal(attach?.getAttribute('aria-disabled'), 'true'); assert.equal(attach?.title, FED_VIA_TEXT_ONLY);
    await act(async () => { attach!.click(); await h.flush(); });
    assert.equal(!!document.querySelector('.ctx-menu,.sheet-scrim,.sfb'), false, 'скрепка обхода не предлагает отправку файлов');
    assert.equal(!!h.host.querySelector('.pending-atts'), false);
  } finally { h.unmount(); restore(); }
});
async function replacementScene(component = h.Pane) {
  h.desktop(); const restore = h.pointerLayout(false, 1280);
  try {
    await h.mount({ composerNotice: notice }, component);
    assert.equal(!!h.host.querySelector('.fed-stale'), true, 'обычная лента показывает notice');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'notice оставляет поле ввода');
    await h.rerender({ composerNotice: notice, composerReplacement: replacement }, component);
    assert.equal(!!h.host.querySelector('[data-composer-replacement]'), true);
    assert.equal(!!h.host.querySelector('.fed-stale'), false, 'замена поля убирает отдельную notice');
    assert.equal(!!h.host.querySelector('.composer textarea'), false);
  } finally { h.unmount(); restore(); }
}
it('R201 настоящий MessagePane показывает fedStale рядом с доступным полем, composerReplacement подавляет notice', () => replacementScene());
async function searchScene(phone: boolean, component = h.Pane) {
  if (phone) h.mobile(); else h.desktop(); const restore = h.pointerLayout(phone, phone ? 390 : 1280);
  try {
    await h.mount({ composerNotice: notice, chatSearch: { open: true, setOpen() {}, search: async () => ({ total: 0, hits: [], next: null }), jumpToDate: async () => null } }, component);
    assert.equal(!!h.host.querySelector('.chat-search-foot'), phone, 'нижний поиск заменяет поле только на телефоне');
    assert.equal(!!h.host.querySelector('.fed-stale'), !phone, 'поиск на телефоне скрывает notice, ПК сохраняет');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'поиск прячет, но не размонтирует поле');
  } finally { h.unmount(); h.desktop(); restore(); }
}
it('R201 телефонный поиск убирает fedStale над заменённым полем, ПК-поиск сохраняет notice и поле', async () => {
  await searchScene(true); await searchScene(false);
});
async function selectionScene(component = h.Pane) {
  h.mobile(); const restore = h.pointerLayout(true, 390);
  try {
    await h.mount({ composerNotice: notice, messages: [h.msg('fed-stale-select')], batch: {
      forward: async () => {}, deleteMany: async () => {}, peerName: () => 'Собеседник', open: () => {},
    } }, component);
    assert.equal(!!h.host.querySelector('.fed-stale'), true);
    const row = h.host.querySelector<HTMLElement>('[data-mid="fed-stale-select"]'); assert.equal(!!row, true);
    const event = new Event('contextmenu', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'pointerType', { value: 'touch' });
    await act(async () => { row!.dispatchEvent(event); await h.flush(); });
    const choose = [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu button')].find(b => b.textContent?.trim() === 'Выбрать');
    assert.equal(!!choose, true, 'касательное меню позволяет настоящее выделение');
    await act(async () => { choose!.click(); await h.flush(); });
    assert.equal(!!h.host.querySelector('.sel-head'), true, 'сообщение действительно выбрано');
    assert.equal(!!h.host.querySelector('.fed-stale'), false, 'выделение скрывает notice');
    assert.equal(!!h.host.querySelector('.composer textarea'), true, 'выделение не теряет черновое поле');
  } finally { h.unmount(); h.desktop(); restore(); }
}
it('R201 настоящее выделение сообщения убирает fedStale, не размонтируя поле черновика', () => selectionScene());
function change(source: string, condition: string) {
  const anchor = '!composerReplacement && !selecting && !searchFoot && composerNotice';
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь notice');
  return source.replace(anchor, condition);
}
h.mutantTest('R201 мутант notice поверх composerReplacement ловится настоящей заменой поля', async () => {
  await h.rejectMutant(source => change(source, '!selecting && !searchFoot && composerNotice'),
    async component => replacementScene(component), 'замена поля убирает отдельную notice');
});
h.mutantTest('R201 мутант notice при поиске ловится телефонным searchFoot', async () => {
  await h.rejectMutant(source => change(source, '!composerReplacement && !selecting && composerNotice'),
    async component => searchScene(true, component), 'поиск на телефоне скрывает notice');
});
h.mutantTest('R201 мутант notice в выделении ловится настоящим выбором строки', async () => {
  await h.rejectMutant(source => change(source, '!composerReplacement && !searchFoot && composerNotice'),
    async component => selectionScene(component), 'выделение скрывает notice');
});
