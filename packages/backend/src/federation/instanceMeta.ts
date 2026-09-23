/**
 * Название и иконка инстанса (#139, F1, план §5.1.2).
 *
 * Людям домен ничего не говорит: «voice.example.org» не подскажет, что это инстанс друзей. Поэтому у
 * инстанса есть имя и картинка, а домен — вторым планом. Имя задаёт держатель, уходит в визитку и
 * рассылается связкам событием `instance.updated`.
 *
 * ⚠️ У события есть ВЕРСИЯ: сеть переставляет сообщения местами, и без неё старое «инстанс называется
 * Гуси» затирало бы более свежее «инстанс называется Гусиный дом». Версия — просто счётчик правок.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationLinks, instanceSettings } from '../db/schema.js';
import { FED_EVENTS } from '@gusvoice/shared';
import { FEDERATION_META_KEY } from './instance.js';
import { broadcastEvent, onFedEvent } from './eventStream.js';
import { parseContacts, type HolderContact } from './contacts.js';
import { hasHiddenChars } from './textGuards.js';

export interface InstanceMeta {
  name: string | null;
  iconHash: string | null;
  /** Счётчик правок: с ним сосед отличает свежее от догнавшего с опозданием. */
  version: number;
  /** Способы связаться с держателем (§5.1.1). Отдаются только связанным, не всем подряд. */
  contacts: HolderContact[];
  /**
   * Аварийная пауза ВСЕЙ федерации (требование 30).
   *
   * 🔴 Отдельно от паузы одной связки: это рубильник на случай «что-то происходит, разберусь потом».
   * Входящие запросы получают отказ `federation.paused`, исходящие копятся, а люди на своих серверах
   * видят понятное «федерация приостановлена держателем» вместо молчания.
   */
  paused: boolean;
}

/** Границы имени (§5.1.2). Пусто — не ошибка: тогда интерфейс показывает домен. */
export const INSTANCE_NAME_MIN = 2;
export const INSTANCE_NAME_MAX = 40;

export type NameProblem = 'too-short' | 'too-long' | 'control-chars';

/**
 * Проверить имя, которое ввёл держатель.
 *
 * 🔴 Управляющие символы и переводы строк отбиваются: имя показывается в рейле, в подсказках и в
 * карточке связки, а строка с `\n` или невидимыми символами ломает вёрстку и позволяет выдать одно
 * имя за другое.
 */
export function checkInstanceName(raw: string): NameProblem | null {
  const name = raw.trim();
  if (name.length < INSTANCE_NAME_MIN) return 'too-short';
  if (name.length > INSTANCE_NAME_MAX) return 'too-long';
  // Невидимые символы: ими подделывают вид имени и ломают вёрстку (общая проверка — textGuards).
  if (hasHiddenChars(name)) return 'control-chars';
  return null;
}

/**
 * Прочитать название, иконку и версию.
 *
 * ⚠️ Похожий запрос есть в `instance.ts`, и это не случайная копия: визитке нужны только имя и
 * иконка, и она читается на каждый запрос соседа, а здесь — ещё и версия, для правки держателем.
 * Сводить их в один модуль значило бы завести цикл импортов (визитка ← события ← визитка).
 */
export async function readInstanceMeta(): Promise<InstanceMeta> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, FEDERATION_META_KEY))
    .limit(1);
  const meta = (row?.value ?? {}) as Record<string, unknown>;
  return {
    name: typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : null,
    iconHash: typeof meta.iconHash === 'string' && meta.iconHash.length > 0 ? meta.iconHash : null,
    version: typeof meta.version === 'number' && Number.isInteger(meta.version) ? meta.version : 0,
    contacts: parseContacts(meta.contacts),
    paused: meta.paused === true,
  };
}

/** Сохранить название, иконку и контакты, поднять версию и разослать связкам. */
export async function writeInstanceMeta(next: {
  name: string | null;
  iconHash: string | null;
  contacts?: HolderContact[];
}): Promise<InstanceMeta> {
  const current = await readInstanceMeta();
  const meta: InstanceMeta = {
    name: next.name,
    iconHash: next.iconHash,
    contacts: next.contacts ?? current.contacts,
    // ⚠️ Пауза здесь НЕ трогается: это рубильник, а не часть визитки. Иначе правка названия молча
    // снимала бы аварийную паузу.
    paused: current.paused,
    version: current.version + 1,
  };
  await db
    .insert(instanceSettings)
    .values({ key: FEDERATION_META_KEY, value: meta as unknown as Record<string, unknown> })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: meta as unknown as Record<string, unknown>, updatedAt: new Date() },
    });
  // Рассылка — после записи: сосед, который тут же переспросит визитку, должен увидеть новое имя.
  await broadcastEvent(FED_EVENTS.instanceUpdated, { name: meta.name, icon_hash: meta.iconHash }, meta.version);
  return meta;
}

/**
 * Сосед сменил название или иконку.
 *
 * 🔴 Пишем в `their_name` — то, как сосед зовёт себя сам, — и НЕ трогаем `local_name`: имя, которое
 * наш держатель дал этой связке у себя, принадлежит ему, и сосед не может его переписать.
 */
export function registerInstanceMetaHandler(): void {
  onFedEvent(FED_EVENTS.instanceUpdated, async ({ instanceId, event }) => {
    const [link] = await db
      .select({ iconHash: federationLinks.iconHash, protocolVersion: federationLinks.protocolVersion })
      .from(federationLinks)
      .where(eq(federationLinks.instanceId, instanceId))
      .limit(1);
    if (!link) return;

    // ⚠️ Порядок здесь уже обеспечен номерами событий: `judgeEvent` отбросил всё, что старше
    // последнего принятого от этого соседа, так что догнавшее с опозданием сюда не попадёт. Версия
    // в событии понадобится, когда то же состояние начнёт приходить ВТОРЫМ путём — сверкой каталога
    // в F2; отдельный столбец под неё заведём там же, вместе с самой сверкой.
    const name = typeof event.payload.name === 'string' ? event.payload.name.trim() : null;
    const iconHash = typeof event.payload.icon_hash === 'string' ? event.payload.icon_hash : null;
    // Имя соседа проверяем теми же правилами, что своё: оно пришло снаружи и поедет в интерфейс.
    const problem = name === null || name.length === 0 ? null : checkInstanceName(name);
    await db
      .update(federationLinks)
      .set({
        theirName: problem === null && name ? name : null,
        iconHash: iconHash ?? link.iconHash,
        updatedAt: new Date(),
      })
      .where(eq(federationLinks.instanceId, instanceId));
  });
}

/**
 * Поставить или снять аварийную паузу всей федерации.
 *
 * ⚠️ Версию НЕ поднимаем и соседям не рассылаем: пауза — наше внутреннее состояние, и сосед узнаёт о
 * ней из отказа на свой же запрос. Рассылать «я на паузе» через канал, который сам на паузе, —
 * противоречие.
 */
export async function setFederationPaused(paused: boolean): Promise<InstanceMeta> {
  const current = await readInstanceMeta();
  const meta: InstanceMeta = { ...current, paused };
  await db
    .insert(instanceSettings)
    .values({ key: FEDERATION_META_KEY, value: meta as unknown as Record<string, unknown> })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: meta as unknown as Record<string, unknown>, updatedAt: new Date() },
    });
  return meta;
}
