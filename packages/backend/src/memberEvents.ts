/**
 * Членство на сервере изменилось (#231) — единственный вход для событий членства. Зовётся ПОСЛЕ фиксации во всех местах, где
 * меняется `server_members` (вход по ссылке и повторный вход, кик, выход, бан, снятие бана, удаление аккаунта, закрытие и
 * открытие сервера для гостей, запрет инстанса, отзыв гостя, добавление и снятие бота).
 *
 * Людям ничего нового: ростер у них обновляет прежний `server.invalidate` (его шлют сами входы). Боты — крючок
 * `configureMemberBots` (по образцу `configureBotConv`): модуль ботов отсюда не импортируется. Крючок идёт в фоне, сбой — в лог.
 *
 * Страж Codex (ТЗ этапа 3 §7 п.6): каждый файл с `insert|delete|update(serverMembers)` зовёт `memberChanged` или стоит в
 * белом списке с причиной (создание сервера — владелец не событие; ник; монеты).
 */
export type MemberStatus = 'creator' | 'member' | 'left' | 'kicked';

export interface MemberChange {
  serverId: string;
  /** С кем случилось. */
  userId: string;
  /** Кто сделал (сам человек при входе/выходе; модератор при кике/бане; `null` — система: запрет инстанса, сверка). */
  actorId: string | null;
  from: MemberStatus;
  to: MemberStatus;
}

export interface MemberBotsHooks {
  changed(c: MemberChange): Promise<void>;
}

let hooks: MemberBotsHooks | null = null;

/** Подключает Bot API (`routes/botApi.ts`). */
export function configureMemberBots(next: MemberBotsHooks | null): void {
  hooks = next;
}

/** Сообщить об изменении членства (одном или пачке — закрытие сервера для гостей). Не ждёт крючка ботов. */
export function memberChanged(change: MemberChange | readonly MemberChange[]): void {
  const h = hooks;
  if (!h) return;
  const list = Array.isArray(change) ? (change as readonly MemberChange[]) : [change as MemberChange];
  if (list.length === 0) return;
  void (async () => {
    for (const c of list) {
      if (c.from === c.to) continue;
      try {
        await h.changed(c);
      } catch (err) {
        console.warn('[bots] членство:', err instanceof Error ? err.message : err);
      }
    }
  })();
}
