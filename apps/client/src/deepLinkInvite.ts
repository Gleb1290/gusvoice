import { useSyncExternalStore } from 'react';
import { parseInviteInput } from '@gusvoice/shared';

/**
 * Ссылка-приглашение, пришедшая ИЗВНЕ приложения (#139, F4, план §4.2.2).
 *
 * Три двери ведут сюда: схема `gusvoice://join?invite=…` на десктопе, тот же `intent://` на Android
 * и открытая в браузере страница `/i/<код>`. Все три означают одно — «человек кликнул по ссылке, и
 * ему надо показать окно проверки», — поэтому дальше путь общий.
 *
 * 🔴 **Ссылка только ОТКРЫВАЕТ окно и никогда не входит сама.** Иначе любая страница в интернете могла бы дёрнуть
 * установленное приложение и втащить человека на чужой сервер одним кликом. Входит человек сам — кнопкой в окне
 * проверки, увидев карточку сервера.
 *
 * ⚠️ Что принимается (#200, решение — оставить как есть): всё, что принимает общий разбор `parseInviteInput`, —
 * ссылка `http(s)://<домен>/i/<код>` И короткий код (`Ab12`), в том числе внутри `gusvoice://join?invite=…`.
 * Короткий код — приглашение СВОЕГО инстанса: так же, как если бы человек вставил его в «Войти по приглашению» руками,
 * и проверяет его то же окно. Сужать дверь до одной полной ссылки не стали: дыры в коде нет (автовхода нет ни там,
 * ни там), а разбор у окна и у двери остаётся один — две копии разошлись бы на краю. Всё прочее
 * (`javascript:`, `data:`, адрес без `/i/`, другое действие схемы) игнорируется.
 *
 * ⚠️ Хранится В ПАМЯТИ: это намерение «прямо сейчас», а не настройка. Пережившее перезапуск
 * намерение однажды открыло бы окно приглашения человеку, который давно про эту ссылку забыл.
 */

let pending: string | null = null;
const subs = new Set<() => void>();

/**
 * Принять ссылку из внешнего мира. Возвращает `false`, если это не ссылка-приглашение, — вызывающий
 * по этому ответу решает, стоит ли вообще поднимать окно.
 */
export function offerInviteLink(raw: string): boolean {
  const url = extractInvite(raw);
  if (!url) return false;
  pending = url;
  for (const s of subs) s();
  return true;
}

/**
 * Достать из `gusvoice://join?invite=…` (или из самой ссылки) адрес приглашения — или короткий код.
 *
 * ⚠️ Проверяем ИМЕННО через `parseInviteInput`: из адресов он пропускает только `http(s)` с путём `/i/`, а кроме них —
 * только короткий код (буквы, цифры, `_` и `-`, 4–64 знака; см. шапку файла). Сравнение строк «начинается с https» тут
 * было бы дырой — `javascript:` и `data:` отсекает именно он.
 */
export function extractInvite(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  if (/^gusvoice:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    // Единственное действие схемы — `join`. Остальные пути игнорируем молча: расширять схему будем
    // осознанно, а не тем, что кто-то угадал слово.
    const action = `${url.host}${url.pathname}`.replace(/\/+$/, '');
    if (action !== 'join' && action !== '/join' && action !== 'join/') return null;
    const invite = url.searchParams.get('invite');
    if (!invite) return null;
    return parseInviteInput(invite) ? invite : null;
  }

  return parseInviteInput(text) ? text : null;
}

export function takeInviteLink(): string | null {
  const v = pending;
  if (v !== null) {
    pending = null;
    for (const s of subs) s();
  }
  return v;
}

/** Ждёт ли окно проверки ссылку. Рейл по этому признаку открывает окно сам. */
export function usePendingInviteLink(): string | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => pending,
    () => null,
  );
}
