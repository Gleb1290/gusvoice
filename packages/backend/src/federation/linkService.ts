/**
 * Заведение связки между инстансами (#139, F1, план §5.1) — сам порядок шагов.
 *
 * Как это выглядит для двух людей:
 *  1. держатель A создаёт код и передаёт его держателю B **вне приложения** — в мессенджере, голосом;
 *  2. B вставляет код у себя: инстанс B идёт по домену из кода, забирает визитку A, сверяет отпечаток
 *     ключа с тем, что записан в коде, и шлёт A подписанную заявку с одноразовым секретом;
 *  3. A видит заявку во вкладке «Федерация» и подтверждает её кнопкой — только после этого связка
 *     становится рабочей у обоих.
 *
 * 🔴 Подтверждают ОБЕ стороны, и это не формальность: код мог утечь из переписки, а заявка приходит
 * по сети от кого угодно. Секрет доказывает, что заявку прислал тот, кому код дали; кнопка у A
 * доказывает, что держатель этого действительно хочет.
 *
 * Здесь порядок шагов и решения; база, сеть и часы приходят зависимостями.
 */

import { FED_ERRORS, type FedInstanceDocument } from '@gusvoice/shared';
import {
  LINK_CODE_TTL_MS,
  checkLinkCode,
  decodeLinkCode,
  encodeLinkCode,
  hashLinkSecret,
  newLinkSecret,
  type LinkCodePayload,
} from './linkCode.js';
import { nextLinkState, type LinkState } from './linkRules.js';
import type { PeerDocument, PeerProblem } from './peerClient.js';

export interface StoredLink {
  instanceId: string;
  domain: string;
  apiBase: string;
  clientOrigin: string;
  rootKey: string;
  theirName: string | null;
  state: LinkState;
  protocolVersion: number | null;
  features: string[];
  /**
   * Наше «подтверждено» соседу ещё не доставлено (#199): кнопка держателя сделала связку рабочей у
   * нас, а сосед не ответил 2xx — сеть, срок, его сбой. Пока отметка стоит, плановый проход и кнопка
   * «синхронизировать сейчас» досылают подтверждение (`resendConfirmation`). Нет поля — `false`.
   */
  confirmPending?: boolean;
}

export interface StoredCode {
  id: string;
  secretHash: string;
  purpose: 'link' | 'rebind';
  previousInstanceId: string | null;
  expiresAt: number;
  usedAt: number | null;
}

export interface LinkDeps {
  now(): number;
  /** Наша личность и чем подписывать. `null` — федерация не поднялась. */
  self(): { instanceId: string; fingerprint: string; domain: string; apiBase: string; name: string | null } | null;
  signing(): { keyid: string; privateKeyDer: Uint8Array } | null;
  /** Забрать визитку соседа. Хосты разрешает вызывающий — см. `linkRequest`. */
  fetchDocument(apiBase: string, allowHosts: ReadonlySet<string>): Promise<
    { ok: true; value: PeerDocument } | { ok: false; problem: PeerProblem; detail?: string }
  >;
  /**
   * Доказать домен визитки походом на `https://<domain>/config.json` (#197 п. 1; F-11). Нет — домен
   * принимается на слово (только проверки без сети, для подставных зависимостей).
   */
  proveDomain?(
    doc: Pick<PeerDocument['doc'], 'domain' | 'apiBase' | 'rootKey'>,
  ): Promise<{ ok: true; value: true } | { ok: false; problem: PeerProblem; detail?: string }>;
  postToPeer(input: { apiBase: string; path: string; payload: unknown; allowHosts: ReadonlySet<string> }): Promise<
    { ok: true; value: { status: number; body: string } } | { ok: false; problem: PeerProblem; detail?: string }
  >;
  saveCode(code: Omit<StoredCode, 'usedAt'>): Promise<void>;
  findCodeByHash(secretHash: string): Promise<StoredCode | null>;
  /**
   * Погасить код. `false` — его уже погасили (гонка двух заявок с одним кодом, F-22). Старые
   * реализации ничего не возвращают — это считается «погашен».
   */
  markCodeUsed(id: string, byInstanceId: string): Promise<boolean | void>;
  /** Отозвана ли эта личность (сосед сообщал, что ключ украден, §5.1.3; F-19). */
  isRevoked?(instanceId: string): Promise<boolean>;
  /**
   * Занят ли домен — нашим инстансом или другой связкой (F-11), не считая перечисленных личностей.
   * Домен — то, что человек видит «всегда»; двум инстансам с одним доменом здесь не место.
   */
  domainTaken?(domain: string, except: string[]): Promise<boolean>;
  getLink(instanceId: string): Promise<StoredLink | null>;
  upsertLink(link: StoredLink & { confirmed: boolean }): Promise<void>;
  setLinkState(instanceId: string, state: LinkState, confirmed: boolean): Promise<void>;
  /** Поставить или снять отметку «подтверждение соседу не доставлено» (#199). Нет — досылки нет. */
  setConfirmPending?(instanceId: string, pending: boolean): Promise<void>;
  /** Аварийная пауза федерации у держателя: в неё мы соседям ничего не шлём (#199 п. 3). */
  paused?(): Promise<boolean>;
  newId(): string;
  /**
   * Перенести связку со старой личности соседа на новую (перепривязка, §5.1.3). `false` — старой
   * связки нет, значит это не перепривязка, а обычное первое знакомство.
   */
  rebind(fromInstanceId: string, to: StoredLink): Promise<boolean>;
  audit(event: string, detail: Record<string, unknown>): void;
}

export type LinkProblem =
  | 'federation-off'
  /** Сосед ответил отказом — его причина, а не наша поломка связи. */
  | 'peer-rejected'
  | 'bad-code'
  | 'code-expired'
  | 'code-used'
  | 'self-link'
  | 'fingerprint-mismatch'
  | 'already-linked'
  | 'unknown-link'
  | 'wrong-state'
  /** Код перепривязки вставлен в общее поле «Связаться» — ему место только на карточке связки (F-01). */
  | 'rebind-code'
  /** На карточке перепривязки вставлен обычный код связки. */
  | 'not-rebind-code'
  /** Новая личность отвечает НЕ с того адреса, где жила прежняя: это не перепривязка, а другой инстанс. */
  | 'host-mismatch'
  /** По адресу соседа отвечает та же личность, что и в связке: ключ не менялся, переносить нечего. */
  | 'same-identity'
  /** Личность соседа числится отозванной: её ключ объявлен украденным (§5.1.3, F-19). */
  | 'revoked-identity'
  /** Домен из визитки уже наш или другой связки (F-11): двум инстансам с одним доменом здесь не место. */
  | 'domain-taken'
  | PeerProblem;

export type LinkOutcome<T> = { ok: true; value: T } | { ok: false; problem: LinkProblem; detail?: string };

/**
 * Вытащить причину отказа из ответа соседа.
 *
 * ⚠️ Терпимо: сосед другой версии может ответить чем угодно, вплоть до страницы прокси. Не разобрали —
 * `null`, и дальше покажем общий текст, а не выдуманную причину.
 */
export function peerRejectionReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' && REFUSAL_CODE_RE.test(parsed.error) ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * 🔴 Только машинный код (#199 п. 10): латиница в нижнем регистре, цифры, точка, дефис, подчёркивание.
 * Причина соседа показывается держателю в панели федерации и в журнале как системная — и строка вроде
 * «свяжитесь t.me/fake-support» выглядела бы там сообщением от нас. Наши коды (`federation.server_closed`,
 * `wrong-state`, `domain-unproven`) под это правило подходят все.
 */
const REFUSAL_CODE_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/** Что значит ответ соседа на наше «подтверждено» (#199). */
export type ConfirmDelivery =
  /** Сосед принял — связка рабочая с обеих сторон. */
  | 'delivered'
  /** Сосед уже не ждёт: не в `requested` (рабочая, на паузе, ждёт своей кнопки), не знает нас или отрезал. */
  | 'not-waiting'
  /** Сеть, срок, подпись, домен не доказан, сбой у соседа — стоит попробовать позже. */
  | 'retry';

export function confirmDeliveryOf(
  sent: { ok: true; value: { status: number; body: string } } | { ok: false },
): ConfirmDelivery {
  if (!sent.ok) return 'retry';
  const { status, body } = sent.value;
  if (status >= 200 && status < 300) return 'delivered';
  const code = peerRejectionReason(body);
  // Связка у соседа не в `requested` (уже рабочая, разорвана, на паузе, ждёт своей кнопки) — ждать нечего.
  if (status === 400 && (code === 'wrong-state' || code === 'unknown-link')) return 'not-waiting';
  // Сосед нас не знает: `/link/confirmed` идёт через `admitPeer`, и пропавшая у него строка связки — это
  // `401 unknown`, а не 400 (ревью своей правки #199). Подпись не сошлась — другие коды, их повторяем.
  if (status === 401 && code === 'unknown') return 'not-waiting';
  if (status === 409 && (code === FED_ERRORS.serverClosed || code === FED_ERRORS.trustLost)) return 'not-waiting';
  return 'retry';
}

/**
 * Через сколько повторять досылку: 10 мин, 20, 40 … но не реже раза в 6 часов. Сосед, лежащий неделю,
 * не должен получать запрос каждые десять минут, а поднявшийся — ждать подтверждения сутки.
 */
export function confirmRetryDelayMs(attempts: number): number {
  const base = 10 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
}

export function createLinkService(deps: LinkDeps) {
  /**
   * Пока связки нет, единственное разрешение идти на этот хост — код, который держатель ввёл руками.
   * Поэтому список разрешённых хостов на время связывания состоит ровно из одного адреса из кода.
   */
  const hostsOf = (apiBase: string): Set<string> => {
    try {
      return new Set([new URL(apiBase).host]);
    } catch {
      return new Set();
    }
  };

  /**
   * Доказать домен и записать отказ в журнал — одно место на все шаги связывания (#198 п. 13; прежде
   * блок был скопирован четыре раза, и копии разошлись именами событий). Без `proveDomain` в deps
   * домен принимается на слово (подставные зависимости).
   */
  const proveDomainOf = async (
    doc: Pick<FedInstanceDocument, 'domain' | 'apiBase' | 'rootKey'>,
    step: 'request' | 'rebind' | 'receive' | 'confirm' | 'confirmed',
    instanceId: string,
  ): Promise<LinkOutcome<true>> => {
    if (!deps.proveDomain) return { ok: true, value: true };
    const proof = await deps.proveDomain(doc);
    if (proof.ok) return { ok: true, value: true };
    deps.audit('federation.link_domain_unproven', { instanceId, domain: doc.domain, step, detail: proof.detail ?? null });
    return proof;
  };

  /** Досылки подтверждения: сколько попыток, когда следующая и чем кончилась прошлая (для журнала). */
  const resends = new Map<string, { attempts: number; nextAt: number; last: string }>();
  /**
   * Досылка, которая идёт прямо сейчас. Отметка ставится ДО первого ожидания: плановый проход и кнопка
   * (или двойной клик) иначе оба проходили проверку и слали соседу два «подтверждено» разом.
   */
  const resending = new Set<string>();

  /** Одна попытка досылки — под отметкой `resending` (см. `resendConfirmation`). */
const sendConfirmationOnce = async (
    instanceId: string,
    selfId: string,
    now: number,
    mark: { attempts: number; nextAt: number; last: string } | undefined,
  ): Promise<ConfirmDelivery | 'skipped'> => {
    const link = await deps.getLink(instanceId);
    if (!link || link.state !== 'active' || !link.confirmPending) {
      resends.delete(instanceId);
      return 'skipped';
    }
    if (deps.paused && (await deps.paused())) return 'skipped';

    const sent = await deps.postToPeer({
      apiBase: link.apiBase,
      path: '/api/fed/v1/link/confirmed',
      payload: { instance_id: selfId },
      allowHosts: hostsOf(link.apiBase),
    });
    const outcome = confirmDeliveryOf(sent);
    const status = sent.ok ? sent.value.status : null;
    const reason = sent.ok ? peerRejectionReason(sent.value.body) : sent.problem;
    const attempts = (mark?.attempts ?? 0) + 1;
    const summary = `${outcome}:${status ?? ''}:${reason ?? ''}`;
    if (summary !== mark?.last) {
      deps.audit('federation.link_confirm_resent', {
        instanceId,
        outcome,
        status,
        reason,
        attempts,
        detail: sent.ok ? null : (sent.detail ?? null),
      });
    }
    if (outcome === 'retry') {
      resends.set(instanceId, { attempts, nextAt: now + confirmRetryDelayMs(attempts), last: summary });
    } else {
      resends.delete(instanceId);
      await deps.setConfirmPending?.(instanceId, false);
    }
    return outcome;
  };


  return {
    /** Шаг 1: держатель A создаёт код. Секрет возвращается ОДИН раз — у нас остаётся только хеш. */
    async issueCode(input: {
      issuedBy: string;
      purpose?: 'link' | 'rebind';
      previousInstanceId?: string | null;
    }): Promise<LinkOutcome<{ code: string; expiresAt: number }>> {
      const self = deps.self();
      if (!self) return { ok: false, problem: 'federation-off' };
      const secret = newLinkSecret();
      const expiresAt = deps.now() + LINK_CODE_TTL_MS;
      const id = deps.newId();
      await deps.saveCode({
        id,
        secretHash: hashLinkSecret(secret),
        purpose: input.purpose ?? 'link',
        previousInstanceId: input.previousInstanceId ?? null,
        expiresAt,
      });
      const payload: LinkCodePayload = {
        domain: self.domain,
        apiBase: self.apiBase,
        fingerprint: self.fingerprint,
        secret,
        expiresAt,
        purpose: input.purpose ?? 'link',
        ...(input.previousInstanceId ? { previousInstanceId: input.previousInstanceId } : {}),
      };
      deps.audit('federation.code_issued', { id, issuedBy: input.issuedBy, purpose: payload.purpose });
      return { ok: true, value: { code: encodeLinkCode(payload), expiresAt } };
    },

    /**
     * Шаг 2: держатель B вставил код. Идём к соседу, сверяем ключ и отправляем заявку.
     *
     * ⚠️ Адрес берётся из ВИЗИТКИ соседа (`api_base`), а не из кода: в коде только домен, по которому
     * мы визитку и нашли. Так сосед может держать API на другом поддомене, не переделывая коды.
     */
    async requestLink(
      rawCode: string,
      opts: { rebindOf?: string } = {},
    ): Promise<LinkOutcome<{ instanceId: string; state: LinkState }>> {
      const self = deps.self();
      const signing = deps.signing();
      if (!self || !signing) return { ok: false, problem: 'federation-off' };

      const code = decodeLinkCode(rawCode);
      if (!code) return { ok: false, problem: 'bad-code' };
      if (code.expiresAt <= deps.now()) return { ok: false, problem: 'code-expired' };

      /**
       * 🔴 КАКУЮ связку перепривязывать, решает держатель кликом по её карточке, а не код (аудит
       * 19.09, F-01). Поля `p` и `o` в коде пишет тот, кто его выдал, — то есть посторонний. Раньше
       * они исполнялись как есть: код с `p:"rebind"` и чужим `o`, вставленный в обычное поле
       * «Связаться», удалял РАБОЧУЮ связку с третьим инстансом и переносил всех её гостей на автора
       * кода. Теперь общее поле такие коды не берёт вовсе, а `o` из кода не читается нигде.
       */
      if (code.purpose === 'rebind' && !opts.rebindOf) return { ok: false, problem: 'rebind-code' };
      if (opts.rebindOf && code.purpose !== 'rebind') return { ok: false, problem: 'not-rebind-code' };

      /**
       * За визиткой идём по АДРЕСУ API из кода, а не по домену.
       *
       * 🔴 У GusVoice веб и API — разные хосты (`voice.example` / `api.voice.example`), так делает и
       * коробка «под ключ». Запрос на `https://<domain>/api/fed/v1/instance` попадает в веб-клиент и
       * возвращает HTML: разбор падает, держатель видит `bad-document`, и связка не заводится ни на
       * одном реально развёрнутом инстансе (#151, поймано на стенде 17.09).
       *
       * Запасной путь по домену оставлен для кодов от инстансов прежней версии: у них поля нет, и
       * для однодоменной установки старое поведение верно.
       */
      const probe = code.apiBase ?? `https://${code.domain}`;
      const doc = await deps.fetchDocument(probe, hostsOf(probe));
      if (!doc.ok) return doc;

      const problem = checkLinkCode(code, {
        now: deps.now(),
        myInstanceId: self.instanceId,
        theirFingerprint: doc.value.fingerprint,
        theirInstanceId: doc.value.instanceId,
      });
      if (problem === 'self') return { ok: false, problem: 'self-link' };
      if (problem === 'fingerprint-mismatch') return { ok: false, problem: 'fingerprint-mismatch' };
      if (problem === 'expired') return { ok: false, problem: 'code-expired' };

      // 🔴 Личность из отозванных не принимаем (F-19): её ключ объявлен украденным, и код, выданный
      // «ею», мог выдать вор. Раньше `isRevoked` не вызывался нигде.
      if (deps.isRevoked && (await deps.isRevoked(doc.value.instanceId))) return { ok: false, problem: 'revoked-identity' };

      const existing = await deps.getLink(doc.value.instanceId);
      if (existing && existing.state === 'active') return { ok: false, problem: 'already-linked' };
      const fromDoc = (state: LinkState): StoredLink => ({
        instanceId: doc.value.instanceId,
        domain: doc.value.doc.domain,
        apiBase: doc.value.doc.apiBase,
        clientOrigin: doc.value.doc.clientOrigin,
        rootKey: doc.value.doc.rootKey,
        theirName: doc.value.doc.name,
        state,
        protocolVersion: doc.value.protocolVersion,
        features: doc.value.doc.features,
      });

      if (opts.rebindOf) {
        /**
         * Перепривязка с карточки связки (§5.1.3). Это ПЕРЕНОС, а не новая связка: у соседа сменился
         * ключ, но наши люди, их сообщения и наше имя для него остались прежними. Заведи мы новую
         * строку — всё это осталось бы висеть на мёртвой личности.
         *
         * 🔴 Четыре условия, и все обязательны:
         *  - связка была рабочей хоть когда-то (`active`/`paused`/`trust-lost`): у заявки и у
         *    разорванной человеком связки переносить нечего и незачем;
         *  - по адресу соседа отвечает ДРУГАЯ личность — иначе ключ не менялся;
         *  - новая личность живёт на ТОМ ЖЕ хосте API, что и прежняя: с него мы забрали визитку, и его
         *    же она называет своим. Сменился ключ, а адрес нет — это и отличает перепривязку от
         *    знакомства с посторонним, принёсшим код;
         *  - сосед принял наш секрет. Поэтому запрос к нему уходит ДО переноса: не ответил или
         *    отказал — у нас ничего не изменилось, и попытку можно повторить тем же кодом.
         */
        const old = await deps.getLink(opts.rebindOf);
        if (!old) return { ok: false, problem: 'unknown-link' };
        if (old.state !== 'trust-lost' && old.state !== 'active' && old.state !== 'paused') {
          return { ok: false, problem: 'wrong-state', detail: old.state };
        }
        if (doc.value.instanceId === old.instanceId) return { ok: false, problem: 'same-identity' };
        // Домен новой личности не должен быть занят кем-то третьим (F-11); старая связка — не третий.
        if (deps.domainTaken && (await deps.domainTaken(doc.value.doc.domain, [doc.value.instanceId, old.instanceId]))) {
          return { ok: false, problem: 'domain-taken' };
        }
        const hostOf = (url: string): string | null => [...hostsOf(url)][0]?.toLowerCase() ?? null;
        const oldHost = hostOf(old.apiBase);
        if (!oldHost || hostOf(probe) !== oldHost || hostOf(doc.value.doc.apiBase) !== oldHost) {
          return { ok: false, problem: 'host-mismatch', detail: oldHost ?? undefined };
        }

        /**
         * 🔴 Домен визитки ДОКАЗЫВАЕТСЯ походом на веб соседа (#197 п. 1, F-11) — ПОСЛЕДНИМ из проверок
         * (#198 п. 4): «не та связка», «домен занят», «другой хост» выясняются мгновенно, и ждать ради
         * них похода в сеть незачем. Но до всего, что пишет в базу: имя, которое мы запишем в связку и
         * покажем людям в `@ник@домен`, должен подтвердить владелец домена, а не сама визитка.
         */
        const proven = await proveDomainOf(doc.value.doc, 'rebind', doc.value.instanceId);
        if (!proven.ok) return proven;

        const asked = await deps.postToPeer({
          apiBase: doc.value.doc.apiBase,
          path: '/api/fed/v1/link/request',
          payload: {
            secret: code.secret,
            instance_id: self.instanceId,
            api_base: self.apiBase,
            domain: self.domain,
            name: self.name,
          },
          allowHosts: hostsOf(doc.value.doc.apiBase),
        });
        if (!asked.ok) return asked;
        if (asked.value.status < 200 || asked.value.status >= 300) {
          const reason = peerRejectionReason(asked.value.body);
          deps.audit('federation.rebind_rejected', { from: old.instanceId, to: doc.value.instanceId, reason });
          return { ok: false, problem: 'peer-rejected', detail: reason ?? `ответ ${asked.value.status}` };
        }

        const moved = await deps.rebind(old.instanceId, fromDoc('active'));
        if (!moved) return { ok: false, problem: 'unknown-link' };
        deps.audit('federation.link_rebound', {
          from: old.instanceId,
          to: doc.value.instanceId,
          domain: doc.value.doc.domain,
        });
        return { ok: true, value: { instanceId: doc.value.instanceId, state: 'active' } };
      }

      const state = nextLinkState(existing?.state ?? 'requested', 'request-sent');
      if (!state) return { ok: false, problem: 'wrong-state', detail: existing?.state };
      /**
       * 🔴 Домен из визитки — не наш и не другой связки (аудит 19.09, F-11). Домен «виден всегда» и
       * идёт в значок гостя и в `@ник@домен`; сосед, написавший в визитке чужой домен, выдавал бы себя
       * за него. Совпадение с самим собой (та же личность заводит связку заново) — не совпадение.
       */
      if (deps.domainTaken && (await deps.domainTaken(doc.value.doc.domain, [doc.value.instanceId]))) {
        return { ok: false, problem: 'domain-taken' };
      }
      // Дорогая проверка — последней (#198 п. 4): «уже связаны», «домен занят», негодное состояние
      // выясняются мгновенно. Но до записи в базу — см. перепривязку выше.
      const proven = await proveDomainOf(doc.value.doc, 'request', doc.value.instanceId);
      if (!proven.ok) return proven;
      const next = fromDoc(state);
      await deps.upsertLink({ ...next, confirmed: false });

      const sent = await deps.postToPeer({
        apiBase: doc.value.doc.apiBase,
        path: '/api/fed/v1/link/request',
        payload: {
          secret: code.secret,
          instance_id: self.instanceId,
          api_base: self.apiBase,
          domain: self.domain,
          name: self.name,
        },
        allowHosts: hostsOf(doc.value.doc.apiBase),
      });
      if (!sent.ok) return sent;
      if (sent.value.status < 200 || sent.value.status >= 300) {
        // 🔴 Отказ соседа — это ЕГО причина, а не наша поломка связи. Смешивать их нельзя: держатель
        // увидел бы «инстанс недоступен» там, где на самом деле «код уже использован», и пошёл бы
        // чинить сеть вместо того, чтобы попросить новый код.
        const reason = peerRejectionReason(sent.value.body);
        deps.audit('federation.link_request_rejected', {
          instanceId: doc.value.instanceId,
          status: sent.value.status,
          reason,
        });
        return { ok: false, problem: 'peer-rejected', detail: reason ?? `ответ ${sent.value.status}` };
      }

      deps.audit('federation.link_requested', { instanceId: doc.value.instanceId, domain: doc.value.doc.domain });
      return { ok: true, value: { instanceId: doc.value.instanceId, state } };
    },

    /**
     * Шаг 2 со стороны A: пришла заявка. Подпись к этому моменту УЖЕ проверена маршрутом — здесь
     * решается, годится ли секрет и что делать со связкой.
     *
     * 🔴 Код одноразовый: использованный не принимается, даже если срок ещё не вышел. Иначе утёкшая
     * переписка давала бы третьей стороне возможность завести связку вслед за первой.
     */
    async receiveRequest(input: {
      secret: string;
      peer: PeerDocument;
    }): Promise<LinkOutcome<{ state: LinkState }>> {
      const self = deps.self();
      if (!self) return { ok: false, problem: 'federation-off' };
      if (input.peer.instanceId === self.instanceId) return { ok: false, problem: 'self-link' };
      // Заявитель из отозванных — отказ (F-19): его ключ объявлен украденным.
      if (deps.isRevoked && (await deps.isRevoked(input.peer.instanceId))) return { ok: false, problem: 'revoked-identity' };

      const code = await deps.findCodeByHash(hashLinkSecret(input.secret));
      if (!code) return { ok: false, problem: 'bad-code' };
      if (code.usedAt !== null) return { ok: false, problem: 'code-used' };
      if (code.expiresAt <= deps.now()) return { ok: false, problem: 'code-expired' };

      const existing = await deps.getLink(input.peer.instanceId);
      // Перепривязка: связка у нас в «доверие потеряно», и ЕДИНСТВЕННЫЙ выход оттуда — сюда. Человек
      // уже сверил код вне приложения, второго подтверждения не требуем: иначе после смены ключа обе
      // стороны ждали бы друг друга.
      const event = code.purpose === 'rebind' ? 'rebound' : 'request-received';
      // 🔴 Код перепривязки выдан на карточке ОДНОЙ связки и годится только ей (F-01): иначе утёкший
      // код возвращал бы к жизни любую другую связку, потерявшую доверие. Личность предъявителя к
      // этому моменту доказана подписью — её и сверяем с той, для кого код выдавали.
      if (event === 'rebound' && code.previousInstanceId !== input.peer.instanceId) {
        return { ok: false, problem: 'bad-code' };
      }
      const state = nextLinkState(existing?.state ?? 'pending', event);
      if (!state) return { ok: false, problem: 'wrong-state', detail: existing?.state };
      if (deps.domainTaken && (await deps.domainTaken(input.peer.doc.domain, [input.peer.instanceId, code.previousInstanceId ?? '']))) {
        return { ok: false, problem: 'domain-taken' };
      }
      // Домен заявителя доказывается ДО того, как сгорит код (#197 п. 1): недоказанный домен — не повод
      // тратить код, сосед поправит визитку и попробует тем же.
      const proven = await proveDomainOf(input.peer.doc, 'receive', input.peer.instanceId);
      if (!proven.ok) return proven;

      /**
       * 🔴 Код гасится ПЕРВЫМ действием и атомарно (аудит 19.09, F-22): «проверили» и «погасили» были
       * разными запросами, и две одновременные заявки с одним утёкшим кодом обе проходили проверку
       * «не использован» — заводились две связки. Теперь гасит база одним `UPDATE … WHERE used_at IS
       * NULL`: ноль строк — код уже сработал у другого. Связка заводится только после этого.
       */
      const burned = await deps.markCodeUsed(code.id, input.peer.instanceId);
      if (burned === false) return { ok: false, problem: 'code-used' };

      await deps.upsertLink({
        instanceId: input.peer.instanceId,
        domain: input.peer.doc.domain,
        apiBase: input.peer.doc.apiBase,
        clientOrigin: input.peer.doc.clientOrigin,
        rootKey: input.peer.doc.rootKey,
        theirName: input.peer.doc.name,
        state,
        protocolVersion: input.peer.protocolVersion,
        features: input.peer.doc.features,
        confirmed: event === 'rebound',
      });
      deps.audit('federation.link_request_received', {
        instanceId: input.peer.instanceId,
        domain: input.peer.doc.domain,
      });
      return { ok: true, value: { state } };
    },

    /** Шаг 3: держатель A нажал «Подтвердить». Связка становится рабочей и об этом узнаёт сосед. */
    async confirmLink(instanceId: string): Promise<LinkOutcome<{ state: LinkState; peerNotified: boolean }>> {
      const self = deps.self();
      if (!self) return { ok: false, problem: 'federation-off' };
      const link = await deps.getLink(instanceId);
      if (!link) return { ok: false, problem: 'unknown-link' };
      const state = nextLinkState(link.state, 'confirmed');
      if (!state) return { ok: false, problem: 'wrong-state', detail: link.state };
      // 🔴 Домен перепроверяется в момент, когда связка СТАНОВИТСЯ рабочей (#196 п. 5): заявка и
      // ожидание домен не держат, и две заявки с одним доменом иначе обе стали бы `active`.
      if (deps.domainTaken && (await deps.domainTaken(link.domain, [instanceId]))) {
        deps.audit('federation.link_confirm_refused', { instanceId, domain: link.domain, reason: 'domain-taken' });
        return { ok: false, problem: 'domain-taken' };
      }
      // И доказывается заново (#197 п. 1): между заявкой и кнопкой могли пройти дни. Здесь это
      // безопасно — до смены состояния, и держатель просто нажмёт ещё раз, если сеть моргнула.
      const proven = await proveDomainOf(link, 'confirm', instanceId);
      if (!proven.ok) return proven;

      await deps.setLinkState(instanceId, state, true);
      // Отметка «не доставлено» — ДО отправки, снимается по ответу: перезапуск (автодеплой) посреди
      // отправки иначе оставлял связку рабочей у нас и без единого повода досылать.
      await deps.setConfirmPending?.(instanceId, true);
      resends.delete(instanceId);
      const sent = await deps.postToPeer({
        apiBase: link.apiBase,
        path: '/api/fed/v1/link/confirmed',
        payload: { instance_id: self.instanceId },
        allowHosts: hostsOf(link.apiBase),
      });
      /**
       * ⚠️ Связка у нас уже активна, даже если сосед сейчас недоступен: иначе решение держателя
       * зависело бы от чужой сети. «Извещён» — только ответ 2xx (#198 п. 2): отказ соседа — не
       * доставка. Не дошло по причине, которая может пройти (сеть, срок, сбой у соседа), — ставим
       * отметку `confirmPending` (#199), и досылка идёт, пока сосед не ответит. Раньше досылку
       * угадывали по отказу соседа в сверке каталога — и соседа без каталога, и кнопку она не видела.
       */
      const delivery = confirmDeliveryOf(sent);
      const peerNotified = delivery === 'delivered';
      if (delivery !== 'retry') await deps.setConfirmPending?.(instanceId, false);
      deps.audit('federation.link_confirmed', {
        instanceId,
        peerNotified,
        status: sent.ok ? sent.value.status : null,
        reason: sent.ok ? peerRejectionReason(sent.value.body) : (sent.detail ?? sent.problem),
      });
      return { ok: true, value: { state, peerNotified } };
    },

    /** Шаг 3 со стороны B: сосед сообщил, что подтвердил нашу заявку. Подпись проверил маршрут. */
    async receiveConfirmed(instanceId: string): Promise<LinkOutcome<{ state: LinkState }>> {
      const link = await deps.getLink(instanceId);
      if (!link) return { ok: false, problem: 'unknown-link' };
      /**
       * 🔴 Сосед вправе подтвердить только НАШУ заявку — связку в `requested` (аудит 19.09, F-02).
       *
       * Событие `confirmed` одно на два случая: «наш держатель нажал кнопку» (`pending` → `active`) и
       * «сосед сообщил, что подтвердил» (`requested` → `active`). Без этой строки сосед, приславший
       * заявку по утёкшему коду, следом сам слал `/link/confirmed` — и его `pending` становилась
       * рабочей без кнопки держателя, то есть двойное подтверждение из шапки файла не работало.
       */
      if (link.state !== 'requested') return { ok: false, problem: 'wrong-state', detail: link.state };
      const state = nextLinkState(link.state, 'confirmed');
      if (!state) return { ok: false, problem: 'wrong-state', detail: link.state };
      // Тот же рубеж по домену, что и у кнопки держателя (#196 п. 5): пока мы ждали, домен мог занять
      // другой сосед, и вторая рабочая связка с тем же доменом заводиться не должна.
      if (deps.domainTaken && (await deps.domainTaken(link.domain, [instanceId]))) {
        deps.audit('federation.link_confirm_refused', { instanceId, domain: link.domain, reason: 'domain-taken' });
        return { ok: false, problem: 'domain-taken' };
      }
      // И доказываем заново (#199 п. 7): между нашей заявкой и кнопкой соседа могли пройти недели, как и
      // в `confirmLink`. Сбой сети здесь больше не вешает связку: сосед получает не-2xx, ставит у себя
      // `confirmPending` и досылает подтверждение, пока не пройдёт (`resendConfirmation`).
      const proven = await proveDomainOf(link, 'confirmed', instanceId);
      if (!proven.ok) return proven;
      await deps.setLinkState(instanceId, state, true);
      deps.audit('federation.link_active', { instanceId });
      return { ok: true, value: { state } };
    },

    /**
     * Дослать соседу «подтверждено», если первое извещение не дошло (#198 п. 2, #199 пп. 2, 3, 5, 6).
     *
     * 🔴 Связка и пауза перечитываются ПРЯМО перед отправкой (#199 п. 3): проход синхронизации длится
     * минуты, и по снимку из его начала «подтверждено» уходило соседу, от которого держатель только что
     * отрезался. Подпись — временем отправки (`postToPeer`), а не началом прохода (#199 п. 2): подпись
     * живёт ~120 с, и досылка в конце долгого прохода уходила уже просроченной.
     * Повтор — с нарастающей паузой (`confirmRetryDelayMs`); «сосед уже не ждёт» снимает отметку сразу.
     * В журнал — только перемены исхода (#199 п. 6): одинаковые «не ответил» раз в 10 минут вытесняли
     * настоящие события со страницы журнала.
     */
    async resendConfirmation(instanceId: string, opts: { force?: boolean } = {}): Promise<ConfirmDelivery | 'skipped'> {
      const self = deps.self();
      if (!self) return 'skipped';
      const now = deps.now();
      const mark = resends.get(instanceId);
      // Кнопка держателя «синхронизировать сейчас» — прямая просьба попробовать СЕЙЧАС: пауза повтора
      // (до 6 ч) её не держит, иначе после починки сети держателю нечем было бы протолкнуть подтверждение.
      if (!opts.force && mark && now < mark.nextAt) return 'skipped';
      if (resending.has(instanceId)) return 'skipped';
      resending.add(instanceId);
      try {
        return await sendConfirmationOnce(instanceId, self.instanceId, now, mark);
      } finally {
        resending.delete(instanceId);
      }
    },

    /** Кнопки держателя: пауза, снятие паузы, разрыв. Всё — переходы того же автомата. */
    async applyAdminAction(
      instanceId: string,
      action: 'pause' | 'resume' | 'block',
    ): Promise<LinkOutcome<{ state: LinkState }>> {
      const link = await deps.getLink(instanceId);
      if (!link) return { ok: false, problem: 'unknown-link' };
      const event = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'blocked';
      const state = nextLinkState(link.state, event);
      if (!state) return { ok: false, problem: 'wrong-state', detail: link.state };
      await deps.setLinkState(instanceId, state, false);
      deps.audit(`federation.link_${action}`, { instanceId });
      return { ok: true, value: { state } };
    },
  };
}

export type LinkService = ReturnType<typeof createLinkService>;

/** Визитка соседа, приведённая к виду строки связки — чтобы не повторять сопоставление в трёх местах. */
export function linkFromDocument(doc: FedInstanceDocument, state: LinkState, protocolVersion: number): StoredLink {
  return {
    instanceId: doc.instanceId,
    domain: doc.domain,
    apiBase: doc.apiBase,
    clientOrigin: doc.clientOrigin,
    rootKey: doc.rootKey,
    theirName: doc.name,
    state,
    protocolVersion,
    features: doc.features,
  };
}
