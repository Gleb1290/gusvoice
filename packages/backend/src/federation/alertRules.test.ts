import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALERT_REPEAT_MS,
  KEY_EXPIRY_WARN_DAYS,
  REPORT_ALERT_NAMES_MAX,
  SIGNATURE_STORM_COUNT,
  alertText,
  collapseReportAlerts,
  dueAlerts,
  linkIsDown,
  shouldSend,
  type AlertInput,
  type AlertLinkInput,
  type AlertRecord,
  type DueAlert,
} from './alertRules.js';

const now = new Date('2026-09-22T12:00:00Z');
const link = (patch: Partial<AlertLinkInput> = {}): AlertLinkInput => ({
  instanceId: 'peer', name: 'Соседи', state: 'active', lastSeenAt: now, confirmedAt: now,
  versionProblem: null, signatureFailures: 0, trustLost: false, ...patch,
});
const input = (patch: Partial<AlertInput> = {}): AlertInput => ({
  now, links: [], ownKeyExpiresAt: null, ownKeyRotated: false, pendingReports: [],
  linkDownAfterMs: 30 * 60_000, existing: [], ...patch,
});

describe('поводы оповещений федерации', () => {
  it('активная связка падает ровно на пороге молчания, остальные состояния не падают', () => {
    // Ловит ошибку на границе и ложную тревогу по ещё не принятой заявке.
    const atThreshold = new Date(now.getTime() - 30 * 60_000);
    assert.equal(linkIsDown(link({ lastSeenAt: atThreshold }), now, 30 * 60_000), true);
    assert.equal(linkIsDown(link({ lastSeenAt: new Date(atThreshold.getTime() + 1) }), now, 30 * 60_000), false);
    assert.equal(linkIsDown(link({ state: 'pending', lastSeenAt: atThreshold }), now, 30 * 60_000), false);
  });

  it('до первого ответа падение считается от подтверждения, а без него тревоги нет', () => {
    // Ловит вечное молчание новой связки и тревогу по незавершённой заявке.
    assert.equal(linkIsDown(link({ lastSeenAt: null, confirmedAt: new Date(now.getTime() - 30 * 60_000) }), now, 30 * 60_000), true);
    assert.equal(linkIsDown(link({ lastSeenAt: null, confirmedAt: null }), now, 30 * 60_000), false);
  });

  it('повторяемый повод ждёт свой интервал включительно, одноразовый не повторяется', () => {
    // Ловит спам раньше срока и повтор одноразового уведомления о версии.
    const rec = (kind: AlertRecord['kind'], age: number): AlertRecord => ({
      kind, instanceId: 'peer', detail: null, lastSentAt: new Date(now.getTime() - age), resolvedAt: null,
    });
    assert.equal(shouldSend(rec('link-down', ALERT_REPEAT_MS['link-down']! - 1), 'link-down', now), false);
    assert.equal(shouldSend(rec('link-down', ALERT_REPEAT_MS['link-down']!), 'link-down', now), true);
    assert.equal(shouldSend(rec('version-needed', 365 * 86_400_000), 'version-needed', now), false);
  });

  it('возникший заново снятый повод отправляется сразу', () => {
    // Ловит шестичасовое молчание после краткого восстановления и нового падения.
    const rec: AlertRecord = {
      kind: 'link-down', instanceId: 'peer', detail: null, lastSentAt: now, resolvedAt: now,
    };
    assert.equal(shouldSend(rec, 'link-down', now), true);
  });

  it('шторм начинается ровно с десятого отказа подписи', () => {
    // Ловит ошибку на единицу в пороге сигнала возможной атаки или разъехавшихся часов.
    assert.equal(dueAlerts(input({ links: [link({ signatureFailures: SIGNATURE_STORM_COUNT - 1 })] })).send.length, 0);
    assert.deepEqual(dueAlerts(input({ links: [link({ signatureFailures: SIGNATURE_STORM_COUNT })] })).send[0]?.kind, 'signature-storm');
  });

  it('предупреждение о ключе приходит на семидневной границе и исчезает после ротации', () => {
    // Ловит пропущенную подготовку нового ключа и ложную тревогу после его выпуска.
    const expires = new Date(now.getTime() + KEY_EXPIRY_WARN_DAYS * 86_400_000);
    assert.equal(dueAlerts(input({ ownKeyExpiresAt: expires })).send[0]?.kind, 'key-expiring');
    assert.equal(dueAlerts(input({ ownKeyExpiresAt: expires, ownKeyRotated: true })).send.length, 0);
  });

  it('восстановление отправляется один раз и снимает старое падение', () => {
    // Ловит как молчаливое восстановление, так и повтор письма на каждом проходе.
    const down: AlertRecord = { kind: 'link-down', instanceId: 'peer', detail: null, lastSentAt: now, resolvedAt: null };
    const result = dueAlerts(input({ links: [link()], existing: [down] }));
    assert.deepEqual(result.resolve, [down]);
    assert.equal(result.send.filter((a) => a.kind === 'link-restored').length, 1);
    assert.equal(dueAlerts(input({ links: [link()], existing: [{ ...down, resolvedAt: now }] })).send.length, 0);
  });

  it('жалобы одного соседа схлопываются, имена дедуплицируются и обрезаются', () => {
    // Ловит почтовый шторм и повтор одного имени в сводной теме.
    const reports: DueAlert[] = Array.from({ length: REPORT_ALERT_NAMES_MAX + 2 }, (_, i) => ({
      kind: 'report-received', instanceId: 'peer', detail: `r${i}`, subject: i === 1 ? 'user-0' : `user-${i}`,
    }));
    const collapsed = collapseReportAlerts(reports);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]?.detail, String(reports.length));
    assert.match(collapsed[0]?.subject ?? '', /и ещё 1$/);
  });

  it('единичная жалоба сохраняет имя без числовой детали, а текст различает сводку', () => {
    // Ловит заголовок «(1)» у одиночного письма и потерю числа у пачки.
    const one = collapseReportAlerts([{ kind: 'report-received', instanceId: 'peer', detail: 'id', subject: '@ivan' }]);
    assert.deepEqual(one, [{ kind: 'report-received', instanceId: 'peer', detail: null, subject: '@ivan' }]);
    assert.equal(alertText(one[0]!).title, 'Жалоба на вашего человека: @ivan');
    assert.match(alertText({ ...one[0]!, detail: '3' }).title, /\(3\)/);
  });
});
