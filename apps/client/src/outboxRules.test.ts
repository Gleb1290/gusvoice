import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  afterFailure, afterReconnect, isTransient, manualRetry, newOutboxItem, nextToSend, NO_CONNECTION_ERROR, OUTBOX_MAX_ATTEMPTS, OUTBOX_NET_ATTEMPTS,
  restoreItem, retryDelay, toPersisted, type OutboxItem,
} from './outboxRules';

const item = (key = 'one'): OutboxItem => newOutboxItem('c', { key, content: key, files: [], replyToId: null }, 100);

function mutateQuote(from: string, to: string): typeof import('./outboxRules') {
  const source = readFileSync(new URL('./outboxRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.includes(from), 'точка мутации найдена');
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports });
  return module.exports as typeof import('./outboxRules');
}

it('фрагмент ответа хранится только вместе с id цитируемого, без него не выдумывается replyQuote', () => {
  // Ловит отправку цитаты без исходного сообщения, которую сервер правильно отклонит.
  const quote = { text: 'кусок', offset: 4 };
  const withReply = newOutboxItem('c', { key: 'quoted', content: 'ответ', files: [], replyToId: 'parent', replyQuote: quote }, 10);
  const withoutReply = newOutboxItem('c', { key: 'plain', content: 'ответ', files: [], replyToId: null, replyQuote: quote }, 10);
  assert.deepEqual(withReply.replyQuote, quote);
  assert.equal(Object.hasOwn(withoutReply, 'replyQuote'), false);
  const mutant = mutateQuote('input.replyQuote && input.replyToId ?', 'input.replyQuote ?');
  assert.throws(() => assert.equal(Object.hasOwn(mutant.newOutboxItem('c', { key: 'plain', content: 'ответ', files: [], replyToId: null, replyQuote: quote }, 10), 'replyQuote'), false), assert.AssertionError,
    'мутант передаёт цитату без replyToId');
});

it('маркеры спойлера и подписи сверху встают только при включённых опциях', () => {
  // Ловит самопроизвольное размытие или перенос подписи у обычного сообщения.
  const marked = newOutboxItem('c', { key: 'marked', content: 'caption', files: [], replyToId: null, spoilers: [1], captionAbove: true }, 10);
  const plain = newOutboxItem('c', { key: 'plain', content: 'text', files: [], replyToId: null, spoilers: [], captionAbove: false }, 10);
  assert.deepEqual(marked.spoilers, [1]); assert.equal(marked.captionAbove, true);
  assert.equal(Object.hasOwn(plain, 'spoilers'), false); assert.equal(Object.hasOwn(plain, 'captionAbove'), false);
});

it('как файлы и без превью переживают запись на диск и восстановление только при true', () => {
  // Ловит возвращение альбома или превью после перезапуска и лишние флаги обычной отправки.
  for (const asFile of [false, true]) for (const noPreview of [false, true]) {
    const row = newOutboxItem('c', { key: 'k', content: 'x', files: [], replyToId: null, asFile, noPreview }, 100);
    for (const current of [row, toPersisted(row), restoreItem(toPersisted(row))]) {
      assert.equal(current.asFile, asFile ? true : undefined);
      assert.equal(current.noPreview, noPreview ? true : undefined);
      assert.equal(Object.hasOwn(current, 'asFile'), asFile);
      assert.equal(Object.hasOwn(current, 'noPreview'), noPreview);
    }
  }
});

describe('очередь отправки личной беседы', () => {
  it('сеть, таймаут, лимит и 5xx временные; содержательные 4xx окончательные', () => {
    // Ловит автоматический повтор отказа по правам или потерю отправки при сетевом сбое.
    for (const status of [undefined, 0, 408, 429, 500, 503]) assert.equal(isTransient(status), true);
    for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isTransient(status), false);
  });

  it('задержки растут по расписанию и ограничиваются последней ступенью', () => {
    // Ловит слишком частые запросы при долгом обрыве и бесконечный рост паузы.
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(retryDelay), [1000, 2000, 5000, 10000, 30000, 60000, 60000]);
  });

  it('ожидающая повтора голова блокирует следующую, но окончательно неушедшая не блокирует', () => {
    // Ловит перестановку сообщений в одной беседе и вечную остановку после 4xx.
    const waiting = { ...item(), retryAt: 300 };
    assert.deepEqual(nextToSend([waiting, item('two')], 200), { item: null, waitMs: 100 });
    assert.equal(nextToSend([waiting, item('two')], 300).item?.key, 'one');
    assert.equal(nextToSend([{ ...waiting, status: 'failed' }, item('two')], 200).item?.key, 'two');
    assert.deepEqual(nextToSend([], 200), { item: null, waitMs: 0 });
  });

  it('после пяти временных отказов ещё ждём, шестой окончательно останавливает', () => {
    // Ловит бесконечный автоповтор с одним и тем же id отправки.
    let current = item();
    for (let n = 1; n < OUTBOX_MAX_ATTEMPTS; n++) {
      current = afterFailure(current, 503, 'сеть', 1000);
      assert.equal(current.status, 'sending');
      assert.equal(current.attempts, n);
      assert.equal(current.retryAt, 1000 + retryDelay(n));
    }
    current = afterFailure(current, 503, 'сеть', 1000);
    assert.equal(current.status, 'failed');
    assert.equal(current.retryAt, 0);
    assert.equal(current.attempts, OUTBOX_MAX_ATTEMPTS);
  });

  it('отказ по существу не повторяется и ручной повтор сбрасывает счётчик и ошибку', () => {
    // Ловит повтор запрещённой отправки без действия человека.
    const failed = afterFailure(item(), 403, 'нет прав', 1000);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.deepEqual({ status: manualRetry(failed).status, attempts: manualRetry(failed).attempts, error: manualRetry(failed).error, retryAt: manualRetry(failed).retryAt },
      { status: 'sending', attempts: 0, error: null, retryAt: 0 });
  });

  it('на диск не попадают файлы, после перезапуска без потерь отправка возобновляется тем же ключом', () => {
    // Ловит утечку локальных файлов в кеш и повторную загрузку уже принятых вложений.
    const withFiles = { ...item(), files: [{ name: 'photo.png' }] as File[], fileNames: ['photo.png'],
      uploaded: [{ id: 'att', width: null, height: null, waveform: null, durationMs: null }], attempts: 3, retryAt: 9000 };
    const persisted = toPersisted(withFiles);
    assert.equal('files' in persisted, false);
    const restored = restoreItem(persisted);
    assert.equal(restored.key, withFiles.key);
    assert.deepEqual(restored.uploaded, withFiles.uploaded);
    assert.deepEqual(restored.files, []);
    assert.equal(restored.status, 'sending');
    assert.equal(restored.attempts, 0);
    assert.equal(restored.retryAt, 0);
  });

  it('незагруженный файл после перезапуска требует выбора заново, старый отказ остаётся отказом', () => {
    // Ловит молчаливую отправку без потерянного вложения и нежелательный автоповтор 4xx.
    const missing = { ...toPersisted(item()), fileNames: ['a.png'], uploaded: [] };
    assert.equal(restoreItem(missing).status, 'failed');
    assert.match(restoreItem(missing).error ?? '', /файл не загрузился/);
    const failed = { ...toPersisted(item()), status: 'failed' as const, error: 'нет прав', attempts: 1 };
    assert.equal(restoreItem(failed).status, 'failed');
    assert.equal(restoreItem(failed).error, 'нет прав');
    assert.equal(restoreItem(toPersisted(item())).status, 'sending');
  });

  it('silent существует только у тихой строки и переживает сохранение с восстановлением', () => {
    // Обычное сообщение после перезапуска не должно стать тихим, а выбранный беззвучный режим не должен потеряться.
    const ordinary = newOutboxItem('c', { key: 'ordinary', content: 'текст', files: [], replyToId: null }, 100);
    const falseFlag = newOutboxItem('c', { key: 'false', content: 'текст', files: [], replyToId: null, silent: false }, 100);
    const quiet = newOutboxItem('c', { key: 'quiet', content: 'текст', files: [], replyToId: null, silent: true }, 100);
    assert.ok(!Object.hasOwn(ordinary, 'silent') && !Object.hasOwn(falseFlag, 'silent'), 'обычные строки не несут лишний false-флаг');
    const persisted = toPersisted(quiet);
    assert.equal(persisted.silent, true, 'запись на диск сохраняет выбранный тихий режим');
    assert.equal(restoreItem(persisted).silent, true, 'восстановленная отправка остаётся беззвучной');
    assert.ok(!Object.hasOwn(restoreItem(toPersisted(ordinary)), 'silent'), 'обычная восстановленная строка остаётся обычной');
  });

  it('потеря сети завершает очередь сразу, а восстановление и диск оживляют только netFail', () => {
    // Offline-ошибка не должна держать очередь таймерами; отказ по существу не должен автоматически уйти при reconnect.
    const offlineNetwork = afterFailure(item(), undefined, 'Failed to fetch', 1000, true);
    const offlineServer = afterFailure(item('server'), 503, 'временная ошибка', 1000, true);
    const forbidden = afterFailure(item('forbidden'), 403, 'нет прав', 1000, true);
    assert.deepEqual([offlineNetwork.status, offlineNetwork.error, offlineNetwork.netFail, offlineNetwork.attempts],
      ['failed', NO_CONNECTION_ERROR, true, 1], 'сетевая ошибка без доступа немедленно помечает netFail');
    assert.deepEqual([offlineServer.status, offlineServer.netFail, offlineServer.retryAt],
      ['failed', true, 0], 'временный статус при offline тоже не запускает бесполезный таймер');
    assert.ok(forbidden.status === 'failed' && !forbidden.netFail, '403 остаётся содержательным отказом, а не временной потерей сети');
    const manuallyRetried = manualRetry(offlineNetwork);
    assert.ok(!Object.hasOwn(manuallyRetried, 'netFail'), 'ручной повтор тоже снимает сетевой маркер, а не только reconnect');
    assert.deepEqual([manuallyRetried.status, manuallyRetried.attempts, manuallyRetried.retryAt, manuallyRetried.error], ['sending', 0, 0, null]);
    for (const status of [undefined, 0]) {
      const first = afterFailure(item(), status, 'сеть', 1000);
      assert.equal(first.status, 'sending', 'первый сетевой отказ при доступной сети ещё можно повторить');
      assert.equal(first.retryAt, 1000 + retryDelay(1));
    }
    const reachedLimit = afterFailure(afterFailure(item(), undefined, 'сеть', 1000), undefined, 'сеть', 2000);
    assert.deepEqual([OUTBOX_NET_ATTEMPTS, reachedLimit.status, reachedLimit.netFail, reachedLimit.error],
      [2, 'failed', true, NO_CONNECTION_ERROR], 'два подряд не дошедших запроса помечаются как сетевой отказ и без offline-флага');

    const persisted = toPersisted(offlineNetwork);
    const restored = restoreItem(persisted);
    assert.equal(restored.netFail, true, 'маркер потери связи переживает перезапуск');
    const ordinaryFailure = { ...forbidden, convId: 'c' };
    const unchanged = [ordinaryFailure];
    const empty: OutboxItem[] = [];
    assert.equal(afterReconnect(empty), empty, 'пустой reconnect не создаёт новую ссылку');
    assert.equal(afterReconnect(unchanged), unchanged, 'если только содержательный отказ — reconnect сохраняет исходный список');
    const reconnected = afterReconnect([restored, ordinaryFailure]);
    assert.deepEqual(reconnected.map(x => x.key), ['one', 'forbidden'], 'возобновление сохраняет исходный порядок');
    assert.deepEqual([reconnected[0].status, reconnected[0].attempts, reconnected[0].retryAt, reconnected[0].error],
      ['sending', 0, 0, null], 'сетевой отказ возвращается к немедленной повторной отправке');
    assert.ok(!Object.hasOwn(reconnected[0], 'netFail'), 'оживающая строка теряет только временную метку сетевого отказа');
    assert.equal(reconnected[1].status, 'failed', '403 остаётся остановленным после возврата сети');
  });
});
