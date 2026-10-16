import type { MessagePrivacy } from '@gusvoice/shared';

/**
 * «Кто может мне писать» (13.10, #218, решение владельца, `msgpriv1`) — ЧИСТОЕ правило. Образец — Telegram:
 * `GlobalPrivacySettings.new_noncontact_peers_require_premium` (tdesktop `api_global_privacy.cpp`, Android
 * `PrivacyControlActivity` `PRIVACY_RULES_TYPE_MESSAGES`), пояснение Web K `Privacy.MessagesInfo`: ограничиваются люди «not in your
 * contacts and whom you haven't messaged first». Premium у нас нет — остаются контакты и «я писал первым». Поверх — исключения
 * «Всегда разрешать» (как у «Кто может звонить»). Политика инстанса (`dmPolicy`) и блокировка — отдельно, это ДОПОЛНИТЕЛЬНОЕ
 * ограничение. База — `messagePrivacy.ts`.
 */

/** Значение из базы/запроса → правило; мусор и пусто — `everyone` (как было до настройки). */
export function normalizeMessagePrivacy(v: unknown): MessagePrivacy {
  return v === 'contacts' ? 'contacts' : 'everyone';
}

/** Что известно о паре «получатель — отправитель» для правила. */
export interface MessageAllowedInput {
  privacy: MessagePrivacy;
  /** Отправитель — в контактах получателя (`user_contacts`: владелец — получатель). */
  isContact: boolean;
  /** Получатель сам писал отправителю в их беседе 1:1 (не служебное, не удалённое). */
  wroteFirst: boolean;
  /** Отправитель — в «Всегда разрешать» получателя. */
  alwaysAllowed: boolean;
}

/** Может ли отправитель написать получателю по его настройке. */
export function messageAllowed(i: MessageAllowedInput): boolean {
  if (i.privacy === 'everyone') return true;
  return i.alwaysAllowed || i.isContact || i.wroteFirst;
}
