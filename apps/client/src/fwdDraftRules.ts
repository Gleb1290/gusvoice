/**
 * Черновик пересылки (08.10, решение владельца п.9, #211): чистые правила полосы «Пересылка» над полем.
 * Источник — Telegram Desktop `history/view/controls/history_view_forward_panel.cpp` (`ForwardPanel::updateTexts`).
 */

/** Сообщение черновика — ровно то, что нужно для имён: автор и «переслано от» (у пересланного — автор оригинала). */
export interface FwdSenderSource {
  author: { id: string; displayName: string };
  forwardedFrom?: { userId: string; displayName: string } | null;
}

/**
 * Имена отправителей черновика — как у Telegram (`lng_forwarding_from*`): один — «Имя», двое — «Имя и Имя», больше —
 * «Имя и ещё N». Каждый человек — один раз, по порядку первого появления; у пересланного — автор оригинала. Имя
 * автора — через `nameOf` (имя на сервере, как в ленте); имя из «переслано от» — снимок, как есть.
 */
export function fwdSenders(list: readonly FwdSenderSource[], nameOf: (userId: string, fallback: string) => string): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const m of list) {
    const id = m.forwardedFrom ? m.forwardedFrom.userId : m.author.id;
    if (seen.has(id)) continue;
    seen.add(id);
    names.push(m.forwardedFrom ? m.forwardedFrom.displayName : nameOf(m.author.id, m.author.displayName));
  }
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} и ${names[1]}`;
  return `${names[0]} и ещё ${names.length - 1}`;
}
