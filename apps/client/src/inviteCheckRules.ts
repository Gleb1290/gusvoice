import { parseInviteInput, type InvitePreviewView } from '@gusvoice/shared';
import { fedErrorText, isFedErrorCode } from './fedErrorText';

/**
 * Что показать человеку после вставки ссылки-приглашения (#139, F4, план §4.2.1).
 *
 * 🔴 **Каждый отказ обязан называть, к кому идти.** Это не вежливость: причины здесь принципиально
 * разные — «ссылка протухла» чинит тот, кто её прислал; «нет связки» — держатель СВОЕГО инстанса;
 * «сервер закрыт для чужих» — держатель ЧУЖОГО. Свернув их в одно «не получилось», мы отправили бы
 * человека по кругу спрашивать всех троих.
 *
 * 🔴 **Как назвать чужой инстанс.** Есть связка — есть и название, данное держателем («Друзья»); нет
 * связки — названия взять НЕГДЕ, и тогда говорим доменом из самой ссылки. Ровно на этом я и
 * обжёгся, увидев на стенде «С «другом инстансе» у вашего инстанса нет федерации»: подстановка
 * общего слова в предложение, рассчитанное на имя, даёт мусор. Общее слово оставлено только там,
 * где подставлять нечего вовсе.
 *
 * ⚠️ Коды приходят от ЧУЖОГО инстанса и могут быть незнакомыми (он новее нас). Незнакомый код
 * показывается общим текстом — правило `docs/federation-compat.md`: неизвестное игнорируем, а не
 * ломаемся. Поэтому здесь `switch` без `never`-ловушки, в отличие от журнала действий.
 */
export type InviteAction =
  /** Войти — обычным путём (свой инстанс) или гостем (чужой). */
  | 'join'
  /** Уже участник: открыть у себя. */
  | 'open'
  /** Сосед не ответил — стоит попробовать ещё раз. */
  | 'retry'
  /** Ничего сделать нельзя, окно просто закрывается. */
  | 'ok';

export interface InviteCheck {
  action: InviteAction;
  /** Показывать ли карточку сервера (имя, число участников, срок). */
  card: boolean;
  /**
   * Информатор «это сервер на другом инстансе». Только когда войти МОЖНО: рядом с отказом он был бы
   * объяснением того, чего не случится.
   */
  informer: boolean;
  /** Текст отказа. `null` — отказа нет. */
  problem: string | null;
  /** Показывать ли контакты держателя (их присылает бэкенд вместе с причиной). */
  contacts: boolean;
}

/** Домен из того, что человек вставил, — запасное имя, когда связки (а значит и названия) нет. */
export function domainFromInput(raw: string): string | null {
  const parsed = parseInviteInput(raw);
  if (!parsed?.origin) return null;
  try {
    return new URL(parsed.origin).host;
  } catch {
    return null;
  }
}

/**
 * Как назвать чужой инстанс в тексте: название от держателя → домен связки → домен из ссылки.
 *
 * ⚠️ Возвращает `null`, когда не знает НИЧЕГО. Звать его «другим инстансом» внутри предложения
 * нельзя — вызывающий обязан в этом случае построить фразу без имени.
 */
export function instanceLabel(inst: InvitePreviewView['instance'], fallbackDomain?: string | null): string | null {
  const named = inst?.name?.trim();
  if (named) return named;
  if (inst?.domain) return inst.domain;
  return fallbackDomain?.trim() || null;
}

const ACTION_LABELS: Record<InviteAction, string> = {
  join: 'Войти',
  open: 'Открыть',
  retry: 'Повторить',
  ok: 'Понятно',
};

export function inviteActionLabel(a: InviteAction): string {
  return ACTION_LABELS[a];
}

/**
 * Разложить ответ дома в то, что видит человек.
 *
 * ⚠️ Порядок проверок значим: отказ важнее карточки (её при отказе и не присылают), а «уже участник»
 * важнее обычного входа — ему предлагают «Открыть», а не «Войти».
 */
export function inviteCheck(view: InvitePreviewView, fallbackDomain?: string | null): InviteCheck {
  if (view.problem) {
    return {
      action: view.problem === 'unreachable' || view.problem === 'unavailable' ? 'retry' : 'ok',
      card: false,
      informer: false,
      problem: refusalText(view.problem, instanceLabel(view.instance, fallbackDomain)),
      contacts: view.contacts.length > 0,
    };
  }

  // Своя ссылка — ровно то, что было до федерации: карточки от своего инстанса мы не просим (лишний
  // поход к себе же), просто пускаем по обычному пути.
  if (view.scope === 'local') {
    return { action: 'join', card: false, informer: false, problem: null, contacts: false };
  }

  if (view.alreadyMember) {
    return { action: 'open', card: true, informer: false, problem: null, contacts: false };
  }

  return { action: 'join', card: true, informer: true, problem: null, contacts: false };
}

/**
 * Отказы маршрута `POST /invites/:code` — по-русски. Бэкенд отвечает служебной строкой, и окно до
 * 23.09 показывало её как есть: человек видел «invalid invite» под полем, куда только что вставил
 * ссылку.
 */
const INVITE_ERROR_TEXT: Record<string, string> = {
  'invalid invite': 'Такого приглашения нет — проверьте ссылку или код.',
  'invite expired': 'Приглашение больше не действует: истёк срок или кончились входы. Попросите новое.',
};

/**
 * Текст причины.
 *
 * ⚠️ Слово «инстанс» человеку ничего не говорит, поэтому в текстах — название или адрес; само слово
 * встречается ровно там, где без него не обойтись (формулировки — §4.2.1 плана).
 * ⚠️ `who === null` — имени нет вовсе; тогда фраза строится без него, а не с затычкой.
 */
export function refusalText(problem: string, who: string | null): string {
  const named = who ? `«${who}»` : null;
  // Тексты кодов федерации живут ОДНОЙ таблицей (`fedErrorText`): тот же «сервер закрыт» человек
  // встречает и в окне входа, и тостом изнутри, и два набора формулировок однажды разошлись бы.
  const fed = fedErrorText(problem, who);
  if (fed) return fed;
  switch (problem) {
    case 'unreachable':
      return named ? `Инстанс ${named} сейчас не отвечает. Попробуйте позже.` : 'Инстанс сейчас не отвечает. Попробуйте позже.';
    case 'unavailable':
      return 'Федерация на вашем инстансе сейчас не работает. Позовите админа своего инстанса.';
    case 'wrong-host':
      // По домену из ссылки ответил не тот инстанс, к которому мы шли: подмена адреса, ошибка DNS
      // или прокси. Поручительство дома туда не отправляем (#152).
      return named
        ? `По адресу ${named} ответил другой инстанс. Входить туда небезопасно — проверьте ссылку.`
        : 'По этому адресу ответил другой инстанс. Входить туда небезопасно — проверьте ссылку.';
    case 'no-home':
      // Гостевая запись без своей домашней: ручаться за человека некому (#205).
      return 'Не нашли в приложении ваш домашний инстанс — войдите в него заново.';
    default:
      // Отказ маршрута приглашений (он приходит кодом и от хоста, через `hostFetch`) — по таблице выше.
      // Незнакомый код — сосед новее нас. Говорим честно «не получилось» и не выдумываем причину.
      return INVITE_ERROR_TEXT[problem] ?? `Войти по этой ссылке не получилось (${problem}).`;
  }
}

/**
 * Ошибка, пришедшая от хоста обычным путём (не `GuestJoinError`): код федерации — словами, отказ
 * приглашения — по таблице выше, всё остальное — как есть.
 *
 * ⚠️ Нужна именно тут, а не только в `toastError`: окно приглашения показывает отказ у себя, внутри
 * формы, — тост увёл бы глаза от поля, в котором как раз и надо поменять ссылку.
 */
export function refusalOrMessage(err: unknown, who: string | null): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (isFedErrorCode(msg) && fedErrorText(msg, who)) || INVITE_ERROR_TEXT[msg] || msg;
}
