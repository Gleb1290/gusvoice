import { FED_CLOSE_REASONS } from '@gusvoice/shared';
/**
 * «Сервер закрыт держателем» (#139, F4, план §5.3.1, требование 16).
 *
 * 🔴 Закрывать НЕ молча — в этом весь смысл. Человек сидит в канале чужого инстанса; держатель
 * снимает галочку федеративного доступа — и без окна у гостя просто пропадает сервер. Он решит, что
 * сломалось приложение, и пойдёт чинить не то. Поэтому отказ несёт причину и контакты того, кто
 * это решение принял: отменить его может только он.
 *
 * ⚠️ Причина — стабильная строка ПРОТОКОЛА (`CLOSE_REASONS` на бэкенде), а текст пишет клиент.
 * Незнакомая причина показывается общим текстом: сосед может быть новее нас
 * (`docs/federation-compat.md`).
 */

export interface AccessNotice {
  serverId: string;
  /** Имя сервера на момент закрытия: после него сервер уже не открыть и имя взять неоткуда. */
  serverName: string;
  reason: string;
  contacts: { kind: string; label: string; value: string }[];
}

/**
 * Причины закрытия — те же строки, что шлёт хост, и берутся они ИЗ `shared`: своя копия здесь уже
 * была третьей, а разойдясь, она оставила бы окно без объяснения (§5.3.1).
 */
export const CLOSE_REASON = FED_CLOSE_REASONS;

/**
 * Заголовок и объяснение окна.
 *
 * 🔴 Три причины — три РАЗНЫХ разговора, и сводить их в одну фразу нельзя:
 *  - держатель закрыл сервер для чужих — решение про сервер, к нему и идти;
 *  - человеку закрыт вход на весь инстанс — решение про человека, и серверов там больше нет ни
 *    одного;
 *  - связка разорвана — решение приняли АДМИНЫ ИНСТАНСОВ, а не держатель сервера, и идти надо к
 *    своему.
 * Человек по тексту должен понять, к кому идти, а не только что «не пускают».
 */
export function accessClosedText(notice: AccessNotice): { title: string; body: string; showContacts: boolean } {
  switch (notice.reason) {
    case CLOSE_REASON.bannedByInstance:
      return {
        title: 'Вход на этот инстанс закрыт',
        body: `Держатель инстанса закрыл вам вход. Все его серверы, включая «${notice.serverName}», для вас недоступны. Ваша переписка там осталась, но зайти нельзя.`,
        showContacts: true,
      };
    case CLOSE_REASON.linkGone:
      return {
        title: 'Инстансы больше не связаны',
        body: `Связь между вашим инстансом и тем, где живёт «${notice.serverName}», разорвана. Ваше участие сохранено: свяжут инстансы заново — вернётесь с историей, ролями и монетами. Это решают админы инстансов.`,
        showContacts: false,
      };
    case CLOSE_REASON.federationDisabled:
      return {
        title: 'Сервер закрыт держателем',
        body: `Держатель закрыл «${notice.serverName}» для людей с других инстансов. Ваше участие сохранено: откроет обратно — вернётесь с историей, ролями и монетами.`,
        showContacts: true,
      };
    default:
      // Причина от инстанса новее нашего. Честное «вас закрыли» лучше выдуманной причины.
      return {
        title: 'Сервер закрыт держателем',
        body: `Доступ к «${notice.serverName}» для вас закрыт. Ваше участие сохранено.`,
        showContacts: true,
      };
  }
}

/**
 * Собрать окно из отказа HTTP (`403 federation.server_closed`).
 *
 * ⚠️ Отдельно от события по сокету намеренно: событие застаёт человека ВНУТРИ сервера, а этот путь
 * — когда он жмёт на сервер после того, как его закрыли в офлайне. Оба обязаны привести к одному и
 * тому же окну, иначе про второй случай однажды забудут.
 */
export function noticeFromRefusal(
  err: unknown,
  server: { id: string; name: string },
): AccessNotice | null {
  const e = err as { status?: number; message?: string; reason?: string; contacts?: AccessNotice['contacts'] };
  if (e?.status !== 403 || e.message !== 'federation.server_closed') return null;
  return {
    serverId: server.id,
    serverName: server.name,
    reason: e.reason ?? CLOSE_REASON.federationDisabled,
    contacts: e.contacts ?? [],
  };
}
