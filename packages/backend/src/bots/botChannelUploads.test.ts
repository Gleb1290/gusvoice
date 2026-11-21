import assert from 'node:assert/strict';
import { it } from 'node:test';
import { WEBHOOK_FILE_MAX_BYTES, WEBHOOK_FILES_MAX } from '../webhookRules.js';
import { sendWithChannelUploads, validateChannelFiles } from './botChannelUploads.js';

const image = { name: 'image.png', mime: 'image/png', buffer: { length: WEBHOOK_FILE_MAX_BYTES } };

it('канальное сообщение принимает ровно допустимое число файлов предельного размера', () => {
  assert.doesNotThrow(() => validateChannelFiles(Array.from({ length: WEBHOOK_FILES_MAX }, () => image)));
});

it('отклоняются лишний файл и превышение размера на один байт', () => {
  assert.throws(() => validateChannelFiles(Array.from({ length: WEBHOOK_FILES_MAX + 1 }, () => image)), { code: 413 });
  assert.throws(() => validateChannelFiles([{ ...image, buffer: { length: WEBHOOK_FILE_MAX_BYTES + 1 } }]), { code: 413 });
});

it('запрещённый тип в конце пачки отклоняет всю пачку', () => {
  assert.throws(() => validateChannelFiles([image, { ...image, name: 'file.svg' }]), { code: 415 });
});

it('сбой второй записи запускает удаление обоих начатых объектов и сохраняет исходную ошибку', async () => {
  const writes: string[] = [];
  const removals: string[] = [];
  const logged: unknown[] = [];
  const putError = new Error('хранилище не подтвердило запись');
  const removeError = new Error('временный сбой удаления');
  const uploads = ['первый', 'второй', 'третий'].map((name, index) => ({
    put: async () => {
      writes.push(name);
      if (index === 1) throw putError;
    },
    remove: async () => {
      removals.push(name);
      if (index === 0) throw removeError;
    },
  }));
  await assert.rejects(sendWithChannelUploads(uploads, async () => assert.fail(), async () => assert.fail(), (err) => logged.push(err)), (err) => err === putError);
  assert.deepEqual(writes, ['первый', 'второй']);
  assert.deepEqual(removals, ['первый', 'второй']);
  assert.deepEqual(logged, [removeError]);
});

it('вложение остаётся после успешной отправки', async () => {
  const upload = { put: async () => {}, remove: async () => assert.fail() };
  const result = await sendWithChannelUploads([upload], async (onPersistence) => {
    onPersistence('inserting');
    onPersistence('stored');
    return 'сообщение';
  }, async () => assert.fail(), () => assert.fail());
  assert.equal(result, 'сообщение');
});

it('отказ до записи сообщения откатывает загруженное вложение', async () => {
  const failure = new Error('сообщение отклонено');
  let removed = false;
  const upload = { put: async () => {}, remove: async () => { removed = true; } };
  await assert.rejects(sendWithChannelUploads([upload], async () => { throw failure; }, async () => assert.fail(), () => assert.fail()), (err) => err === failure);
  assert.equal(removed, true);
});

it('сбой после подтверждённой записи сообщения сохраняет вложение', async () => {
  const failure = new Error('рассылка события недоступна');
  const upload = { put: async () => {}, remove: async () => assert.fail() };
  await assert.rejects(sendWithChannelUploads([upload], async (onPersistence) => {
    onPersistence('inserting');
    onPersistence('stored');
    throw failure;
  }, async () => assert.fail(), () => assert.fail()), (err) => err === failure);
});

for (const stored of [true, false, undefined]) {
  it(stored === undefined ? 'при неизвестном результате записи вложение сохраняется' :
    stored ? 'при найденном сообщении вложение сохраняется' : 'при подтверждённом откате записи вложение удаляется', async () => {
    const failure = new Error('ответ базы потерян');
    const readError = new Error('база недоступна');
    const logged: unknown[] = [];
    let removed = false;
    const upload = { put: async () => {}, remove: async () => { removed = true; } };
    await assert.rejects(sendWithChannelUploads([upload], async (onPersistence) => {
      onPersistence('inserting');
      throw failure;
    }, async () => {
      if (stored === undefined) throw readError;
      return stored;
    }, (err) => logged.push(err)), (err) => err === failure);
    assert.equal(removed, stored === false);
    assert.deepEqual(logged, stored === undefined ? [readError] : []);
  });
}
