import type { ConvMute } from '@gusvoice/shared';
import { muteActive } from './dmListRules';

/**
 * Число на значке панели задач и в трее десктопа (07.10, #211, Р1, G39) — как у Telegram Desktop: сумма непрочитанных
 * сообщений в беседах, заглушенные не считаются (настройка Telegram «Учитывать беседы без звука» по умолчанию выключена).
 * «Выключить звук» (`soundOnly`) — не заглушка, такие считаются (`dmListRules.muteActive`).
 */
export interface BadgeDm {
  id: string;
  unread?: number;
  muted?: ConvMute | null;
}

export function unreadBadgeCount(dms: readonly BadgeDm[], now: number): number {
  let n = 0;
  for (const d of dms) {
    const u = d.unread ?? 0;
    if (u > 0 && !muteActive(d.muted, now)) n += u;
  }
  return n;
}

/** Непрочитанные по беседам (только с непрочитанными). */
export function unreadByConv(dms: readonly BadgeDm[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dms) if ((d.unread ?? 0) > 0) out[d.id] = d.unread ?? 0;
  return out;
}

/**
 * Беседы, которые только что стали прочитанными (были с непрочитанными, стали без них или пропали из списка) — их тосты
 * десктоп снимает из Центра уведомлений (`gv_notify_remove`), как Telegram снимает уведомления прочитанной беседы.
 */
export function convsJustRead(prev: Readonly<Record<string, number>>, cur: Readonly<Record<string, number>>): string[] {
  return Object.keys(prev).filter((id) => (prev[id] ?? 0) > 0 && !((cur[id] ?? 0) > 0));
}
