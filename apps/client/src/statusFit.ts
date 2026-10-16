import { useLayoutEffect, type RefObject } from 'react';
import type { UserLastSeen } from '@gusvoice/shared';
import { dayDiff, hhmm, lastSeenLabel } from './lastSeenText';

/**
 * Формы строки статуса шапки беседы от ПОЛНОЙ к самой короткой — для тесной шапки телефона (Telegram Android: `ChatActivity.java:4163`
 * `allowShorterStatus` → `LocaleController.formatDateOnline(date, madeShorter)` `LocaleController.java:2622-2631`: «вчера» теряет «был(а)» —
 * «вчера в 03:53»; ночью (до 6 ч), если заходил после 18 ч, — одно время «был(а) 23:30»). У нас то же + «сегодня» → «был(а) в 03:53» (день и так
 * понятен) + «N минут/часов назад» → «N мин / N ч назад» без «был(а)». Первая форма всегда равна `lastSeenLabel(v, now)`; «в сети», «давно»,
 * дата, «недавно» и т. п. — единственная форма. Какая из форм влезет — решает измерение шапки (`useStatusFit`), не эта функция.
 */
export function lastSeenForms(v: Pick<UserLastSeen, 'online' | 'at' | 'approx'>, now: Date): string[] {
  const full = lastSeenLabel(v, now);
  if (v.online || !v.at) return [full];
  const at = new Date(v.at);
  if (Number.isNaN(at.getTime())) return [full];
  const secs = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  const minutes = Math.floor(secs / 60);
  if (minutes === 0) return [full, 'только что'];
  if (minutes < 60) return [full, `был(а) ${minutes} мин назад`, `${minutes} мин назад`];
  const hours = Math.floor(secs / 3600);
  if (hours < 12) return [full, `был(а) ${hours} ч назад`, `${hours} ч назад`];
  const days = dayDiff(at, now);
  if (days <= 0) return [full, `был(а) в ${hhmm(at)}`];
  if (days === 1) {
    const forms = [full, `вчера в ${hhmm(at)}`];
    if (now.getHours() <= 6 && at.getHours() > 18) forms.push(`был(а) ${hhmm(at)}`);
    return forms;
  }
  return [full];
}

/**
 * Выбор формы: индекс первой формы, которая НЕ обрезается (`cutAt(i)` — «форма `i` показана и обрезана»), иначе последней (самой короткой).
 * Чистая: настоящую обрезку мерит `useStatusFit` на раскладке; число проб ограничено числом форм.
 */
export function pickStatusForm(count: number, cutAt: (idx: number) => boolean): number {
  const last = Math.max(0, count - 1);
  for (let i = 0; i < last; i++) if (!cutAt(i)) return i;
  return last;
}

/**
 * Строка статуса в шапке беседы на телефоне («был(а) сегодня в 03:53» на 360 резалась на ~20 px): формы строки (`lastSeenForms`) лежат в
 * `.dm-who-status` соседними `[data-form]`, показана одна. Тесноту меряем по факту, как `useSelBarFit`: у строки `text-overflow:
 * ellipsis`, а плашка шапки (`.topbar-title`, `flex: 0 1 auto`) сжимается до доступного места, поэтому `scrollWidth > clientWidth` —
 * «не влезло». Берётся первая форма без обрезки (`pickStatusForm`), иначе самая короткая. Telegram: `ChatAvatarContainer.allowShorterStatus`.
 * Скрытие — атрибутом `hidden` в обход React: строка-обёртка и её дети не пересоздаются, перемер — только при смене форм (`key`),
 * ширины шапки или её кнопок, без цикла перерисовок.
 */
function forms(status: HTMLElement): HTMLElement[] {
  return Array.from(status.querySelectorAll<HTMLElement>(':scope > [data-form]'));
}

export function fitStatusForms(status: HTMLElement): void {
  const list = forms(status);
  if (list.length < 2) return;
  const show = (idx: number) => list.forEach((el, i) => { el.hidden = i !== idx; });
  const idx = pickStatusForm(list.length, (i) => {
    show(i);
    return status.scrollWidth > status.clientWidth;
  });
  show(idx);
}

export function useStatusFit(ref: RefObject<HTMLElement | null>, key: string): void {
  useLayoutEffect(() => {
    const status = ref.current;
    if (!status) return undefined;
    fitStatusForms(status);
    const bar = status.closest<HTMLElement>('.channel-topbar');
    let observer: ResizeObserver | undefined;
    if (bar && typeof ResizeObserver !== 'undefined') {
      const widths = () => `${bar.clientWidth}|${bar.querySelector<HTMLElement>('.topbar-actions')?.offsetWidth ?? 0}`;
      let seen = widths();
      observer = new ResizeObserver(() => {
        const now = widths();
        if (now === seen) return;
        seen = now;
        fitStatusForms(status);
      });
      observer.observe(bar);
      const actions = bar.querySelector('.topbar-actions');
      if (actions) observer.observe(actions);
    }
    // Шрифт приложения мог догрузиться уже после первой подгонки — ширина строки другая.
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive && status.isConnected) fitStatusForms(status);
    });
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [ref, key]);
}
