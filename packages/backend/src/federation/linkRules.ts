/**
 * Состояния связки между инстансами и что в каждом разрешено (#139, F1, §5.1).
 *
 * Связка — не «настройка», а отношение двух держателей, и оно ломается по-разному: сосед может
 * разорвать её сам, ключ может смениться (потеря или кража, §5.1.3), держатель может нажать
 * аварийную паузу. Каждая причина ведёт себя иначе, и путать их нельзя: «мы на паузе» временно и
 * лечится кнопкой, «доверие потеряно» — только перепривязкой, «заблокировано» — решение человека.
 *
 * Здесь чистые правила: никакой базы и сети, только состояния и переходы.
 */

import { FED_ERRORS, type FedErrorCode } from '@gusvoice/shared';

export type LinkState =
  /** Мы отправили заявку соседу и ждём, пока его держатель подтвердит. */
  | 'requested'
  /** Сосед прислал заявку по нашему коду — ждём, пока НАШ держатель подтвердит. */
  | 'pending'
  /** Обе стороны подтвердили: связка работает. */
  | 'active'
  /** Держатель приостановил эту связку (или всю федерацию) — временно и обратимо. */
  | 'paused'
  /** Разорвана или заблокирована нами: решение человека, само не восстановится. */
  | 'blocked'
  /** Ключ соседа перестал сходиться: потеря или кража. Лечится только перепривязкой. */
  | 'trust-lost';

export type LinkEvent =
  | 'request-sent'
  | 'request-received'
  | 'confirmed'
  | 'paused'
  | 'resumed'
  | 'blocked'
  | 'trust-broken'
  | 'rebound';

/**
 * Переход связки. `null` — такого перехода нет, и это НЕ ошибка вызывающего: события приходят от
 * соседа и по кнопкам держателя, порядок никто не гарантирует. Невозможный переход надо записать в
 * аудит и оставить состояние как есть, а не «поправить» его на что-то похожее.
 */
export function nextLinkState(state: LinkState, event: LinkEvent): LinkState | null {
  switch (event) {
    // 🔴 Потеря доверия перебивает ЛЮБОЕ состояние: подписи не сходятся, значит дальше по этой связке
    // нельзя ни принимать, ни слать — даже если минуту назад она была активной.
    case 'trust-broken':
      return 'trust-lost';
    // Блокировка — решение человека, её тоже можно применить из любого состояния.
    case 'blocked':
      return 'blocked';
    case 'request-sent':
      return state === 'blocked' || state === 'trust-lost' ? null : 'requested';
    case 'request-received':
      return state === 'blocked' || state === 'trust-lost' ? null : 'pending';
    // Подтверждать можно только то, что кто-то запрашивал: иначе чужой «подтверждаю» поднимал бы
    // связку, которой не было.
    case 'confirmed':
      return state === 'requested' || state === 'pending' ? 'active' : null;
    case 'paused':
      return state === 'active' ? 'paused' : null;
    case 'resumed':
      return state === 'paused' ? 'active' : null;
    // Перепривязка — единственный путь обратно из «доверие потеряно» (§5.1.3).
    // ⚠️ Рабочая связка её тоже принимает и остаётся как была: при ПОТЕРЕ ключа (без отзыва) у
    // потерявшего связки в базе по-прежнему `active` — он о своей беде по ним не узнаёт, — и отказ
    // здесь означал бы, что после потери ключа перепривязка невозможна вовсе (F-20). Заявка,
    // разрыв и ожидание подтверждения сюда не входят: там переносить нечего.
    case 'rebound':
      return state === 'trust-lost' || state === 'active' ? 'active' : state === 'paused' ? 'paused' : null;
    default:
      return null;
  }
}

/**
 * Что ответить соседу, который постучался по этой связке.
 *
 * 🔴 Коды отказов — часть протокола: по ним клиент соседа показывает человеку, что произошло.
 * Никогда не переименовывать и не менять смысл (`docs/federation-compat.md`).
 *
 * ⚠️ «Ещё не подтверждена» и «заблокирована» отвечают ОДИНАКОВО (`server_closed`) намеренно: иначе
 * по разнице ответов посторонний узнавал бы, есть ли у нас заявка от этого инстанса и не забанили ли
 * его персонально.
 */
export function linkVerdict(link: { state: LinkState }, globalPaused: boolean): FedErrorCode | null {
  if (globalPaused) return FED_ERRORS.paused;
  switch (link.state) {
    case 'active':
      return null;
    case 'paused':
      return FED_ERRORS.paused;
    case 'trust-lost':
      return FED_ERRORS.trustLost;
    default:
      return FED_ERRORS.serverClosed;
  }
}

/** Можно ли слать соседу исходящее: в паузе копим в очереди, в остальных нерабочих — не копим вовсе. */
export function canSendTo(state: LinkState): boolean {
  return state === 'active';
}

/** Стоит ли копить события для этой связки, пока она не работает (пауза временна, остальное — нет). */
export function shouldQueueFor(state: LinkState): boolean {
  return state === 'paused';
}

/**
 * Имя связки, которое увидит человек.
 *
 * 🔴 Защита от подмены (§5.1.2): сосед может назваться так же, как мы или как другая наша связка —
 * случайно или чтобы человек спутал инстансы. Совпало — показываем имя вместе с доменом, чтобы
 * различие было видно. Сравнение без учёта регистра и пробелов по краям; о похожих буквах разных
 * алфавитов — ниже.
 */
export function displayLinkName(input: {
  /** Как назвал себя сосед. */
  theirName: string | null;
  /** Как назвал его НАШ держатель у себя (перебивает имя соседа). */
  localName: string | null;
  domain: string;
  /** Название нашего инстанса и всех остальных связок — с чем нельзя совпадать. */
  taken: string[];
}): string {
  const name = (input.localName ?? input.theirName ?? '').trim();
  if (!name) return input.domain;
  const collides = input.taken.some((t) => sameLooking(t, name));
  // Своё имя для соседа держатель задал сам — ему и решать; но домен всё равно дописываем,
  // если имя с чем-то совпало.
  return collides ? `${name} (${input.domain})` : name;
}

/**
 * Похожи ли названия НАСТОЛЬКО, что человек их спутает.
 *
 * Не просто `toLowerCase()`: латинская `a` и кириллическая `а` выглядят одинаково, и на этом
 * строится подмена. Приводим заведомо похожие буквы к одному виду, а уж потом сравниваем.
 */
export function sameLooking(a: string, b: string): boolean {
  return foldLookalikes(a) === foldLookalikes(b);
}

const LOOKALIKES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', к: 'k', в: 'b', н: 'h', м: 'm', т: 't',
  ѕ: 's', і: 'i', ј: 'j', ԁ: 'd', ɡ: 'g', '０': '0', '１': '1',
};

function foldLookalikes(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .split('')
    .map((ch) => LOOKALIKES[ch] ?? ch)
    .join('');
}

/**
 * Имена всех связок разом — с защитой от одноимённых (аудит 19.09, F-11: правило было написано, но
 * нигде не вызывалось). «Занятые» имена для каждой связки — наше собственное и имена остальных
 * связок; совпало — к имени дописывается домен. `null` — имени нет вовсе (интерфейс покажет домен).
 */
export function linkDisplayNames(
  links: readonly { instanceId: string; theirName: string | null; localName: string | null; domain: string }[],
  ownName: string | null,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const nameOf = (l: { theirName: string | null; localName: string | null }) => (l.localName ?? l.theirName ?? '').trim();
  for (const link of links) {
    if (nameOf(link).length === 0) {
      out.set(link.instanceId, null);
      continue;
    }
    const taken = [ownName ?? '', ...links.filter((o) => o.instanceId !== link.instanceId).map(nameOf)].filter(
      (s) => s.length > 0,
    );
    out.set(link.instanceId, displayLinkName({ theirName: link.theirName, localName: link.localName, domain: link.domain, taken }));
  }
  return out;
}
