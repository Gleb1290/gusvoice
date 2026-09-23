import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationAlerts, federationLinks, federationReports, users } from '../db/schema.js';
import { FED_PROTOCOL } from '@gusvoice/shared';
import { env } from '../env.js';
import { adminAlertEmail, readSetting, writeSetting } from '../instanceSetup.js';
import { sendFederationAlert } from '../mailer.js';
import {
  alertText,
  collapseReportAlerts,
  dueAlerts,
  LINK_DOWN_AFTER_MS_DEFAULT,
  SIGNATURE_STORM_WINDOW_MS,
  type AlertKind,
  type AlertLinkInput,
  type AlertRecord,
  type DueAlert,
} from './alertRules.js';
import { federation } from './instance.js';
import { listLinks } from './links.js';
import { fetchPeerDocument } from './peerClient.js';

/**
 * Оповещения держателю (#139, F5, §5.10) — рантайм: собрать поводы, разослать, записать.
 *
 * Правила «что считать поводом и когда повторять» лежат в `alertRules.ts` и проверяются тестами без
 * базы и почты. Здесь — только добыча данных и доставка.
 *
 * 🔴 **Каналы независимы и оба необязательны.** Почта может быть не настроена (коробка без SMTP),
 * ntfy — не заведён. Оповещение при этом всё равно записывается в журнал и показывается баннером в
 * админке: интерфейс — канал, который есть всегда, и именно поэтому он основной, а письмо и пуш —
 * способ узнать, не заходя.
 */

const SETTINGS_KEY = 'federation_alerts';

export interface AlertSettings {
  /** Тема ntfy для оповещений держателя. Пусто — пушей нет. */
  ntfyTopic: string;
  /** Слать ли письма (адрес — `ADMIN_EMAIL` или почта супер-админа). */
  email: boolean;
  /** Сколько минут молчания соседа считать падением связки. */
  linkDownAfterMinutes: number;
}

const DEFAULTS: AlertSettings = {
  ntfyTopic: '',
  email: true,
  linkDownAfterMinutes: LINK_DOWN_AFTER_MS_DEFAULT / 60_000,
};

export async function alertSettings(): Promise<AlertSettings> {
  const raw = ((await readSetting(SETTINGS_KEY)) ?? {}) as Partial<AlertSettings>;
  return {
    ntfyTopic: typeof raw.ntfyTopic === 'string' ? raw.ntfyTopic : DEFAULTS.ntfyTopic,
    email: typeof raw.email === 'boolean' ? raw.email : DEFAULTS.email,
    linkDownAfterMinutes:
      typeof raw.linkDownAfterMinutes === 'number' && raw.linkDownAfterMinutes > 0
        ? raw.linkDownAfterMinutes
        : DEFAULTS.linkDownAfterMinutes,
  };
}

export async function saveAlertSettings(patch: Partial<AlertSettings>): Promise<AlertSettings> {
  const next = { ...(await alertSettings()), ...patch };
  await writeSetting(SETTINGS_KEY, next as unknown as Record<string, unknown>);
  return next;
}

/**
 * Отказы подписи по связкам — в ПАМЯТИ процесса.
 *
 * ⚠️ Намеренно не в базе: всплеск — это «много за десять минут», и запись каждой неудачной подписи
 * в базу превратила бы попытку подделки (или сломанные часы соседа, что случается чаще) в нагрузку
 * на диск. Перезапуск обнуляет счёт — и это правильно: окно всё равно десятиминутное.
 */
const signatureFailures = new Map<string, number[]>();

export function noteSignatureFailure(instanceId: string, now = Date.now()): void {
  const arr = signatureFailures.get(instanceId) ?? [];
  const fresh = arr.filter((t) => now - t < SIGNATURE_STORM_WINDOW_MS);
  fresh.push(now);
  signatureFailures.set(instanceId, fresh);
}

function failuresWithin(instanceId: string, now: number): number {
  const arr = signatureFailures.get(instanceId) ?? [];
  return arr.filter((t) => now - t < SIGNATURE_STORM_WINDOW_MS).length;
}

/** Отправить в ntfy. Тема — настройка держателя, хост — наш собственный шлюз (тот же, что у пушей). */
async function pushToNtfy(topic: string, title: string, body: string): Promise<void> {
  if (!topic || !env.ntfy.baseUrl) return;
  try {
    await fetch(`${env.ntfy.baseUrl}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        ...(env.ntfy.token ? { Authorization: `Bearer ${env.ntfy.token}` } : {}),
        Title: encodeURIComponent(title),
        Priority: 'default',
      },
      body,
    });
  } catch (e) {
    // Оповещение о поломке не должно ломаться само: канал недоступен — остаются письмо и баннер.
    console.warn('[federation] ntfy недоступен:', e instanceof Error ? e.message : e);
  }
}

async function deliver(a: DueAlert, settings: AlertSettings): Promise<void> {
  const { title, body } = alertText(a);
  if (settings.ntfyTopic) await pushToNtfy(settings.ntfyTopic, title, body);
  if (settings.email) {
    const to = await adminAlertEmail();
    if (to) await sendFederationAlert(to, title, body);
  }
}

async function readJournal(): Promise<AlertRecord[]> {
  const rows = await db.select().from(federationAlerts);
  return rows.map((r) => ({
    kind: r.kind as AlertKind,
    instanceId: r.instanceId || null,
    lastSentAt: r.lastSentAt,
    resolvedAt: r.resolvedAt,
    detail: r.detail || null,
  }));
}

/**
 * Один круг проверки: собрать поводы, отправить назревшие, снять исчезнувшие.
 *
 * Зовётся по расписанию (и при старте). ⚠️ Круг не должен падать целиком из-за одного канала или
 * одной связки: инстанс, который не может отправить письмо, обязан хотя бы записать повод.
 */
export async function runFederationAlerts(now = new Date()): Promise<void> {
  if (!env.federation.enabled) return;
  const settings = await alertSettings();
  const links = await listLinks();
  const ms = now.getTime();

  /**
   * 🔴 **Молчание — не падение.** Найдено на живом стенде в первый же час работы оповещений: прод
   * сказал «связка с соседом не отвечает», хотя оба инстанса были подняты и исправны. Причина в том,
   * что `last_seen_at` обновляется, только когда сосед ПРИХОДИТ к нам или принимает наше событие, — а
   * между двумя спокойными инстансами событий может не быть сутками. То есть без этой проверки
   * оповещение срабатывало бы на КАЖДОЙ связке, где просто нет трафика, и держатель перестал бы
   * читать письма ровно так, как описано выше.
   *
   * Поэтому перед тем как звать связку лежащей, мы к ней СТУЧИМСЯ: запрашиваем визитку. Ответил —
   * связка жива, отмечаем это и молчим. Не ответил — повод настоящий.
   *
   * ⚠️ Стучимся только к подозреваемым, а не ко всем подряд: круг проверки ходит каждые пять минут,
   * и опрашивать здоровые связки значило бы устроить соседям постоянный фоновый трафик ни за чем.
   */
  for (const l of links) {
    if (l.state !== 'active') continue;
    const since = l.lastSeenAt ?? l.confirmedAt;
    if (!since || ms - since.getTime() < settings.linkDownAfterMinutes * 60_000) continue;
    let host: string;
    try {
      host = new URL(l.apiBase).host;
    } catch {
      continue;
    }
    const probe = await fetchPeerDocument({ apiBase: l.apiBase, allowHosts: new Set([host]), now: ms });
    if (!probe.ok) continue;
    // Сосед жив — как будто он только что к нам приходил. Иначе следующий круг спросил бы снова.
    await db.update(federationLinks).set({ lastSeenAt: new Date(ms) }).where(eq(federationLinks.instanceId, l.instanceId));
    l.lastSeenAt = new Date(ms);
  }

  const linkInputs: AlertLinkInput[] = links.map((l) => ({
    instanceId: l.instanceId,
    name: l.localName || l.theirName || l.domain,
    state: l.state,
    lastSeenAt: l.lastSeenAt,
    confirmedAt: l.confirmedAt,
    // Отказ по версии протокола сосед называет при обмене документами; он же виден по тому, что мы
    // знаем его версию и она несовместима с нашей.
    versionProblem: versionProblemOf(l.protocolVersion),
    signatureFailures: failuresWithin(l.instanceId, ms),
    trustLost: l.state === 'trust-lost',
  }));

  // Жалобы соседей на НАШИХ людей: каждая входящая — повод, пока о ней не оповестили.
  const reports = await db
    .select({
      id: federationReports.id,
      instanceId: federationReports.instanceId,
      about: federationReports.reportedUserId,
      evidenceAt: federationReports.evidenceAt,
    })
    .from(federationReports)
    .where(eq(federationReports.direction, 'in'));
  const names = new Map<string, string>();
  if (reports.length) {
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(sql`${users.id} IN (${sql.join(reports.map((r) => sql`${r.about}`), sql`, `)})`);
    for (const r of rows) names.set(r.id, r.username);
  }

  const expiry = federation.keyExpiry();
  const { send, resolve } = dueAlerts({
    now,
    links: linkInputs,
    ownKeyExpiresAt: expiry ? new Date(expiry.notAfter) : null,
    ownKeyRotated: expiry?.rotated ?? false,
    pendingReports: reports.map((r) => ({
      // Ключ записи журнала — жалоба + отметка последнего изменения улик (#196 п. 13, #197 п. 4):
      // дополнение с новыми уликами — новый повод, смена причины и ответ держателя — нет. Старые
      // записи переведены на этот ключ миграцией 0073, повторно они не приходят.
      reportId: `${r.id}#${r.evidenceAt.getTime()}`,
      instanceId: r.instanceId,
      about: names.get(r.about) ? `@${names.get(r.about)}` : r.about,
    })),
    linkDownAfterMs: settings.linkDownAfterMinutes * 60_000,
    existing: await readJournal(),
  });

  for (const rec of resolve) {
    await db
      .update(federationAlerts)
      .set({ resolvedAt: now })
      .where(
        and(
          eq(federationAlerts.kind, rec.kind),
          eq(federationAlerts.instanceId, rec.instanceId ?? ''),
          eq(federationAlerts.detail, rec.detail ?? ''),
        ),
      );
  }

  for (const a of send) {
    // Запись ДО отправки: письмо может не уйти, но повод уже случился, и баннер обязан его показать.
    await db
      .insert(federationAlerts)
      .values({ kind: a.kind, instanceId: a.instanceId ?? '', detail: a.detail ?? '', lastSentAt: now, resolvedAt: null })
      .onConflictDoUpdate({
        target: [federationAlerts.kind, federationAlerts.instanceId, federationAlerts.detail],
        set: { lastSentAt: now, resolvedAt: null },
      });
  }
  // Доставка — сводкой по жалобам: одно письмо на связку за круг, а не по письму на жалобу (F-08).
  for (const a of collapseReportAlerts(send)) {
    try {
      await deliver(a, settings);
    } catch (e) {
      console.warn('[federation] оповещение не доставлено:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * «Восстановилась» — событие: его строку в журнале держать незачем, иначе следующее падение той же
   * связки будет спорить с записью о восстановлении.
   */
  await db.delete(federationAlerts).where(eq(federationAlerts.kind, 'link-restored'));
}

/**
 * Несовместимость версии протокола — по тому, что сосед объявил в своём документе.
 *
 * ⚠️ Знаем мы её только после обмена: пока `protocolVersion` пуст, сказать нечего.
 */
function versionProblemOf(theirVersion: number | null): string | null {
  if (theirVersion === null) return null;
  if (theirVersion > FED_PROTOCOL.max) return `сосед говорит на версии ${theirVersion}, мы понимаем до ${FED_PROTOCOL.max}`;
  if (theirVersion < FED_PROTOCOL.min) return `сосед говорит на версии ${theirVersion}, мы понимаем от ${FED_PROTOCOL.min}`;
  return null;
}

/** Открытые поводы — баннер во вкладке «Федерация». */
export async function openAlerts(): Promise<{ kind: AlertKind; instanceId: string | null; title: string; body: string }[]> {
  const rows = await db.select().from(federationAlerts).where(isNull(federationAlerts.resolvedAt));
  const links = await listLinks();
  return rows.map((r) => {
    const link = links.find((l) => l.instanceId === r.instanceId);
    const a: DueAlert = {
      kind: r.kind as AlertKind,
      instanceId: r.instanceId || null,
      // У жалобы `detail` — идентификатор жалобы, в заголовок он не идёт (там место числу, см. правила).
      detail: r.kind === 'report-received' ? null : r.detail || null,
      subject: link ? link.localName || link.theirName || link.domain : r.instanceId || 'ключ подписи',
    };
    const { title, body } = alertText(a);
    return { kind: a.kind, instanceId: a.instanceId, title, body };
  });
}
