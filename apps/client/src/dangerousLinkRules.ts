import { FEATURE_LINKTHREATS1 } from '@gusvoice/shared';

/**
 * Чистые правила «Опасной ссылки» (gitea #218 п.5, признак сервера `linkthreats1`). Сервер сверяет ссылки сообщения с
 * локальным списком угроз и кладёт в `Message.dangerousLinks` хосты; клиент только сопоставляет хост ссылки со списком
 * сообщения и показывает плашку. Вид и окно — `dangerousLink.tsx`. Текст — как предупреждение у Telegram («This link may
 * be dangerous»), по-русски.
 */

export const DANGEROUS_LINK_LABEL = 'Опасная ссылка';
export const DANGEROUS_LINK_TITLE = 'Опасная ссылка';
export const DANGEROUS_LINK_CONFIRM = 'Всё равно открыть';
export const DANGEROUS_LINK_CANCEL = 'Отмена';

/** Сервер умеет помечать опасные ссылки. Без признака (старый сервер, проверка выключена) плашки нет. */
export function serverLinkThreats(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_LINKTHREATS1);
}

/** Хост ссылки в виде, который отдаёт сервер (`URL.hostname`, нижний регистр); `null` — не http(s)-ссылка. */
export function dangerousLinkHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.+$/, '') || null;
  } catch {
    return null;
  }
}

/** Ссылка помечена сервером как опасная: её хост есть в `dangerousLinks` сообщения. */
export function isDangerousLink(url: string, dangerousLinks: readonly string[] | null | undefined): boolean {
  if (!dangerousLinks?.length) return false;
  const host = dangerousLinkHost(url);
  return !!host && dangerousLinks.some((h) => h.toLowerCase().replace(/\.+$/, '') === host);
}

/** Текст окна подтверждения: что случится и почему не стоит. */
export function dangerousLinkBody(host: string): string {
  return `Адрес ${host} есть в списках мошеннических и вредоносных сайтов. Такая ссылка может украсть пароль, деньги или установить вирус. Открывать её не стоит.`;
}
