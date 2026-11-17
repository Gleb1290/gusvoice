interface ConvUnread {
  id: string;
  unread?: number;
}

/** Непрочитанные по беседам (только с непрочитанными). */
export function unreadByConv(dms: readonly ConvUnread[]): Record<string, number> {
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
