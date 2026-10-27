/**
 * Разбор ссылки на закрытый файл ЛС (аудит ЛС #236, п.6) — чистые правила для `attLinks.ts`.
 * Вид: `<API>/api/att/<id вложения, UUID>/<смотрящий>/<подпись>` (подпись — 32 знака, с аудита ещё `.<срок>`).
 */
const ATT_PATH = /\/api\/att\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9_.-]{32,43}(?:[?#]|$)/;

/** Ссылка — на закрытый файл ЛС. */
export function isAttLink(url: string | null | undefined): boolean {
  return !!url && ATT_PATH.test(url);
}

/** id вложения из ссылки; не ссылка на файл ЛС — `null`. */
export function attIdOfLink(url: string): string | null {
  return ATT_PATH.exec(url)?.[1] ?? null;
}
