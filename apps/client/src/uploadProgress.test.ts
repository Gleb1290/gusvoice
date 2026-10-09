import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as progress from './uploadProgress';

it('прогресс, завершение и удаление уведомляют только подписчиков своей строки', () => {
  // Частые события загрузки не должны перерисовывать соседние сообщения; повтор одинаковых байтов тоже лишний.
  let a = 0; let b = 0;
  const offA = progress.subscribeUpload('p-a', () => a++);
  const offB = progress.subscribeUpload('p-b', () => b++);
  try {
    assert.equal(progress.uploadOf('p-a', 0), null);
    progress.setUploadProgress('p-a', 0, 3, 10);
    const snapshot = progress.uploadOf('p-a', 0);
    assert.deepEqual(snapshot, { loaded: 3, total: 10, done: false });
    progress.setUploadProgress('p-a', 0, 3, 10);
    assert.equal(progress.uploadOf('p-a', 0), snapshot);
    assert.equal(a, 1); assert.equal(b, 0);
    progress.setUploadDone('p-a', 0);
    assert.deepEqual(progress.uploadOf('p-a', 0), { loaded: 10, total: 10, done: true });
    progress.setUploadProgress('p-a', 0, 5, 10);
    assert.equal(a, 2, 'поздние байты не воскрешают завершённое кольцо');
    progress.clearUploadProgress('p-a');
    assert.equal(a, 3); assert.equal(progress.uploadOf('p-a', 0), null);
    progress.clearUploadProgress('p-a'); assert.equal(a, 3);
    offA(); progress.setUploadProgress('p-a', 0, 0, 0); assert.equal(a, 3);
  } finally { offA(); offB(); progress.clearUploadProgress('p-a'); progress.clearUploadProgress('p-b'); }
});

it('индексы файлов независимы, signal снимается, отмена узнаётся без маскировки обычной ошибки', () => {
  // Завершение первого файла не должно скрывать второй, а отмену нельзя выдавать за failed.
  try {
    progress.setUploadDone('p-files', 0);
    progress.setUploadProgress('p-files', 1, 2, 0);
    assert.deepEqual(progress.uploadOf('p-files', 0), { loaded: 0, total: 0, done: true });
    assert.deepEqual(progress.uploadOf('p-files', 1), { loaded: 2, total: 0, done: false });
    const ctrl = new AbortController(); progress.setUploadSignal('p-files', ctrl.signal);
    assert.equal(progress.uploadSignal('p-files'), ctrl.signal);
    progress.setUploadSignal('p-files', null); assert.equal(progress.uploadSignal('p-files'), undefined);
    assert.equal(progress.isUploadAborted(progress.uploadAborted()), true);
    assert.equal(progress.isUploadAborted({ name: 'AbortError' }), true);
    for (const e of [null, undefined, new Error('network'), { aborted: false }]) assert.equal(progress.isUploadAborted(e), false);
  } finally { progress.clearUploadProgress('p-files'); progress.setUploadSignal('p-files', null); }
});

it('Ctrl+Q блокируется только пока остался незавершённый файл', () => {
  // Завершённое кольцо не должно удерживать выход, но второй файл той же строки ещё обязан его блокировать.
  try {
    assert.equal(progress.hasActiveUploads(), false);
    progress.setUploadProgress('quit-check', 0, 1, 5);
    assert.equal(progress.hasActiveUploads(), true);
    progress.setUploadDone('quit-check', 0);
    assert.equal(progress.hasActiveUploads(), false);
    progress.setUploadProgress('quit-check', 1, 1, 5);
    assert.equal(progress.hasActiveUploads(), true);
    progress.clearUploadProgress('quit-check');
    assert.equal(progress.hasActiveUploads(), false);
  } finally { progress.clearUploadProgress('quit-check'); }
});
