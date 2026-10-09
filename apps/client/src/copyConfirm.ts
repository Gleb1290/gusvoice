import { toast } from './toast';

/**
 * Подтверждение «скопировано» после записи в буфер обмена.
 *
 * Android 13+ сам показывает подтверждение на ЛЮБУЮ запись в буфер — плашку системы внизу экрана (у Samsung — своя, на том
 * же месте). Наш тост там же, внизу, и выходило два подтверждения подряд поверх поля ввода (приёмка телефона 05.10:
 * «вылазит иконка „текст скопирован“, которая перекрывает поле ввода»). Совет Android для приложений — на 13+ своё
 * подтверждение не показывать (developer.android.com, «Copy and paste»: «avoid duplicate notifications»); так делает и
 * Telegram для Android. Версию берём из строки агента: у WebView приложения она полная («Android 15; SM-S938B …»); Chrome
 * на телефоне пишет урезанное «Android 10; K» — там наш тост остаётся, как было.
 */
export function systemConfirmsCopy(userAgent: string): boolean {
  const m = /Android (\d+)/.exec(userAgent);
  return !!m && Number(m[1]) >= 13;
}

/** Тост «скопировано» — только там, где система не показывает своё подтверждение (`systemConfirmsCopy`). */
export function toastCopied(title: string): void {
  if (systemConfirmsCopy(typeof navigator === 'undefined' ? '' : navigator.userAgent || '')) return;
  toast('success', title);
}
