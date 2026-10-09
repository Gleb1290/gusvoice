import { isVoiceMessage, type Attachment } from '@gusvoice/shared';
import { api } from './api';
import { attachmentKey, filesViaNative, startFileJob } from './fileActions';
import { canSaveFileNative, canSaveImageNative, canShareFileNative } from './nativeMedia';

/**
 * Пункты меню сообщения у файла, видео и голосового (07.10, сверка с Telegram 1.13 / 2.23 / 2.24 / 2.26 / 10.05 / 10.06 /
 * 10.10): какое вложение под курсором или пальцем, какие пункты на этой платформе и что они делают. Загрузки в
 * приложении Android — общие с карточкой файла (`fileActions.ts`: кольцо прогресса, «Загрузки», натив).
 */

/** Пункт меню сообщения у вложения: «Сохранить как…» (ПК), «Сохранить в загрузки» / «в галерею», «Поделиться» (Android). */
export type FileMenuAction = 'save-as' | 'downloads' | 'gallery' | 'share';

/**
 * Вложение (файл, видео, голосовое — не фото: у него свои пункты, `imageActions`), на которое указывает правый клик или
 * палец: ближайший `[data-att]` (ставят `FileCard`, `VideoAttachment`, `VoiceMessage`) — вложение с тем же ключом
 * (`attachmentKey`). `fallback` (телефон: тап по подписи или времени, указания нет) — единственное такое вложение
 * сообщения; несколько — `undefined`, какое из них, не угадать. Вложение без ссылки (ещё грузится закрытый файл ЛС) не в счёт.
 */
export function fileFromTarget(
  attachments: readonly Attachment[] | undefined,
  target: Element | null,
  fallback = false,
): Attachment | undefined {
  const list = (attachments ?? []).filter((a) => a.url && !a.contentType.startsWith('image/'));
  const el = target?.closest('[data-att]');
  if (el) {
    const key = el.getAttribute('data-att');
    return list.find((a) => attachmentKey(a) === key);
  }
  return fallback && list.length === 1 ? list[0] : undefined;
}

/**
 * Какие пункты у вложения в меню сообщения — как у Telegram. ПК (`mobile` — нет): «Сохранить как…» у файла, видео и
 * голосового (10.05). Приложение Android (`mobile`): файл — «Сохранить в загрузки» и «Поделиться» (2.24), видео — «Сохранить
 * в галерею» и «Поделиться» (2.23), голосовое — только «Поделиться» (2.26: у Telegram оно из панели выделения, своего
 * пункта «Сохранить» нет). Пункт есть, только пока его может натив (Android 10+ для «Загрузок» и галереи; «Поделиться» —
 * сборка с `canShare`). Без моста (старая сборка) — ничего.
 */
export function fileMenuActions(a: Pick<Attachment, 'contentType' | 'waveform'>, mobile: boolean): FileMenuAction[] {
  if (!mobile) return ['save-as'];
  if (!filesViaNative()) return [];
  const out: FileMenuAction[] = [];
  const voice = isVoiceMessage(a);
  if (!voice && a.contentType.startsWith('video/')) {
    if (canSaveImageNative()) out.push('gallery');
  } else if (!voice && canSaveFileNative()) {
    out.push('downloads');
  }
  if (canShareFileNative()) out.push('share');
  return out;
}

/** Подпись пункта (`fileMenuActions`). */
export function fileMenuLabel(action: FileMenuAction): string {
  switch (action) {
    case 'save-as':
      return 'Сохранить как…';
    case 'downloads':
      return 'Сохранить в загрузки';
    case 'gallery':
      return 'Сохранить в галерею';
    case 'share':
      return 'Поделиться';
  }
}

/**
 * Выполнить пункт меню у вложения. Android — та же загрузка с кольцом на карточке, что у «⬇» (`startFileJob`); уже идёт загрузка
 * этого вложения — пункт её не отменяет (отмена — повторным нажатием на карточку), а ничего не делает. ПК — ссылка
 * «Скачать» с `download` (веб — загрузка браузера, десктоп — загрузки оболочки: окна «Сохранить как» у неё нет, файл
 * уходит в папку из настроек), следующей задачей — как `imageActions.saveImage`: перехват «щелчка мимо» меню у пузыря
 * гасил синхронный щелчок.
 */
export function runFileMenuAction(a: Attachment, action: FileMenuAction): void {
  if (action === 'save-as') {
    const href = api.attachmentDownloadUrl(a);
    window.setTimeout(() => {
      const link = document.createElement('a');
      link.href = href;
      link.download = a.name;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }, 0);
    return;
  }
  startFileJob(a, action === 'downloads' ? 'save' : action);
}

/**
 * «Копировать название» в меню (ПК, tdesktop `AddCopyFilename`, FD-03): у файла — да; у голосового, видео и картинки,
 * показанных кадром, — нет (у Telegram так же: кроме голосовых, видео, GIF и стикеров). Отправленное «как файл» — файл.
 */
export function canCopyFileName(a: Pick<Attachment, 'contentType' | 'waveform' | 'asFile' | 'name'>): boolean {
  if (!a.name || isVoiceMessage(a)) return false;
  if (a.asFile) return true;
  return !a.contentType.startsWith('video/') && !a.contentType.startsWith('image/');
}
