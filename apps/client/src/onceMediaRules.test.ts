import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Attachment } from '@gusvoice/shared';
import { canSetOnce, clampTtl, isCustomTtl, isOnceAttachment, ONCE_TTL_CUSTOM_DEFAULT, ONCE_TTL_PRESETS, ONCE_VIEW,
  onceBadge, onceDeadline, onceRefFields, secondsLabel, secondsLeft, splitOncePlan } from './onceMediaRules';

it('R262 меню различает просмотр один раз, готовый таймер, своё время и не удалять', () => {
  // Ноль — отдельный режим без таймера, не null и не готовые три секунды.
  assert.equal(ONCE_VIEW, 0);
  assert.deepEqual(ONCE_TTL_PRESETS, [3, 10, 30]);
  assert.equal(ONCE_TTL_CUSTOM_DEFAULT, 10);
  for (const n of [null, 0, 3, 10, 30]) assert.equal(isCustomTtl(n), false);
  for (const n of [1, 2, 4, 29, 31, 60]) assert.equal(isCustomTtl(n), true);
  assert.equal(onceBadge(0), '1'); assert.equal(onceBadge(1), '1'); assert.equal(onceBadge(60), '60');
});

it('R262 таймер принимает обе границы 1 и 60, а вне диапазона и бесконечность не отправляет', () => {
  // Off-by-one здесь превращает безопасный таймер в вечное сообщение либо отвергает разрешённую минуту.
  for (const n of [0, 1, 60]) assert.equal(clampTtl(n), n);
  for (const n of [null, -1, 61, NaN, Infinity, -Infinity]) assert.equal(clampTtl(n), null);
  assert.equal(clampTtl(0.49), 0); assert.equal(clampTtl(0.5), 1);
  assert.equal(clampTtl(60.49), 60); assert.equal(clampTtl(60.5), null);
});

it('R262 подпись секунд учитывает 11–14 и возвращается к единственному числу после двадцати', () => {
  // Простое окончание по последней цифре неправильно подписывает 11, 12, 13, 14 секунд.
  for (const [n, text] of [[1, '1 секунда'], [2, '2 секунды'], [4, '4 секунды'], [5, '5 секунд'],
    [10, '10 секунд'], [11, '11 секунд'], [12, '12 секунд'], [14, '14 секунд'], [21, '21 секунда'],
    [22, '22 секунды'], [24, '24 секунды'], [25, '25 секунд'], [60, '60 секунд']] as const)
    assert.equal(secondsLabel(n), text);
});

it('R262 таймер предлагается фото и видео кадром, но не GIF, аудио и отправке как файл', () => {
  // Отказ должен иметь парный допуск: не скрываем меню у обычных JPEG/MP4.
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']) {
    assert.equal(canSetOnce({ type }, false), true, type);
    assert.equal(canSetOnce({ type }, true), false, type);
  }
  for (const type of ['image/gif', 'audio/ogg', 'application/pdf', '']) assert.equal(canSetOnce({ type }, false), false, type);
});

it('R262 пустой план пуст, обычные группы сохраняют состав, подпись и не получают onceTtl', () => {
  // Новая разбивка не должна менять старую отправку, когда таймеров не выбрано.
  assert.deepEqual(splitOncePlan([], new Map()), []);
  const files = ['a', 'b'];
  assert.deepEqual(splitOncePlan([{ files, content: 'подпись' }], new Map()), [{ files: ['a', 'b'], content: 'подпись' }]);
  assert.deepEqual(files, ['a', 'b']);
});

it('R262 одноразовые файлы становятся отдельными сообщениями, нулевой таймер не теряется', () => {
  // Проверка по truthy вместо Map.has молча оставит просмотр один раз внутри альбома.
  const first = { id: 'photo' }, second = { id: 'video' };
  assert.deepEqual(splitOncePlan([{ files: [first, second], content: 'подпись' }], new Map([[first, 0], [second, 60]])), [
    { files: [first], content: 'подпись', onceTtl: 0 }, { files: [second], content: '', onceTtl: 60 },
  ]);
});

it('R262 смешанный альбом оставляет подпись только первому сообщению и обычные файлы вместе', () => {
  // Повтор подписи на остатке либо её исчезновение при разрыве альбома меняет смысл отправки.
  const a = {}, b = {}, c = {}, d = {};
  const files = [a, b, c, d];
  assert.deepEqual(splitOncePlan([{ files, content: 'подпись' }], new Map([[b, 10], [d, 0]])), [
    { files: [b], content: 'подпись', onceTtl: 10 }, { files: [d], content: '', onceTtl: 0 }, { files: [a, c], content: '' },
  ]);
  assert.deepEqual(files, [a, b, c, d], 'план не переставляет исходный список');
});

it('R262 несколько групп сохраняют свои подписи, чужой объект в карте не отмечает похожий файл', () => {
  // Выбор относится к конкретному File, а не имени, и не должен протекать между группами.
  const a = { name: 'same.png' }, b = { name: 'same.png' }, stranger = { name: 'same.png' };
  assert.deepEqual(splitOncePlan([{ files: [a], content: 'первая' }, { files: [b], content: 'вторая' }], new Map([[a, 3], [stranger, 60]])), [
    { files: [a], content: 'первая', onceTtl: 3 }, { files: [b], content: 'вторая' },
  ]);
});

it('R262 поля запроса различают отсутствие настройки, просмотр один раз и таймер', () => {
  // onceTtl=0 по серверной схеме недопустим: одноразовый режим передаётся только once:true.
  assert.deepEqual(onceRefFields(undefined), {});
  assert.deepEqual(onceRefFields(0), { once: true });
  assert.deepEqual(onceRefFields(1), { once: true, onceTtl: 1 });
  assert.deepEqual(onceRefFields(60), { once: true, onceTtl: 60 });
});

it('R262 таймер фото считается от первого открытия и не продлевается чужой длительностью', () => {
  // У картинки ошибочные метаданные видео не должны отложить истечение.
  assert.equal(onceDeadline({ contentType: 'image/jpeg', onceTtl: 3, durationMs: 90_000 }, 10_000), 13_000);
  assert.equal(onceDeadline({ contentType: 'image/jpeg', onceTtl: 60 }, 10_000), 70_000);
  assert.equal(onceDeadline({ contentType: 'image/jpeg' }, 10_000), null);
  assert.equal(onceDeadline({ contentType: 'image/jpeg', onceTtl: 0 }, 10_000), null);
});

it('R262 видео не закрывается до конца ролика, но больший выбранный таймер сохраняется', () => {
  // min вместо max сожжёт видео на третьей секунде, не дав человеку досмотреть.
  assert.equal(onceDeadline({ contentType: 'video/mp4', onceTtl: 3, durationMs: 12_000 }, 10_000), 22_000);
  assert.equal(onceDeadline({ contentType: 'video/mp4', onceTtl: 30, durationMs: 12_000 }, 10_000), 40_000);
  assert.equal(onceDeadline({ contentType: 'video/mp4', onceTtl: 3, durationMs: 3000 }, 10_000), 13_000);
  assert.equal(onceDeadline({ contentType: 'video/mp4', onceTtl: 3, durationMs: null }, 10_000), 13_000);
  assert.equal(onceDeadline({ contentType: 'video/mp4', durationMs: 12_000 }, 10_000), null);
});

it('R262 отсчёт округляется вверх до срока, ровно на сроке и после него остаётся нулём', () => {
  // Последняя миллисекунда ещё доступна; отрицательных секунд человек видеть не должен.
  for (const [now, seconds] of [[0, 3], [999, 3], [1000, 2], [2999, 1], [3000, 0], [3001, 0]] as const)
    assert.equal(secondsLeft(3000, now), seconds);
});

it('R262 плитка использует серверную once-пометку только для поддерживаемого кадра', () => {
  // Незащищённая картинка не должна превращаться в заглушку только из-за MIME или таймера.
  const a: Attachment = { id: 'photo', url: '/fixture', name: 'Фото', contentType: 'image/jpeg', size: 1, once: true };
  assert.equal(isOnceAttachment(a), true);
  assert.equal(isOnceAttachment({ ...a, once: undefined, onceTtl: 3 }), false);
  assert.equal(isOnceAttachment({ ...a, asFile: true }), false);
  assert.equal(isOnceAttachment({ ...a, contentType: 'image/gif' }), false);
});
