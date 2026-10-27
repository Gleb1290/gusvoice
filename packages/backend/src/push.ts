import {
  BROADCAST_MENTIONS,
  canMentionRole,
  mentionedHandles,
  mentionedRoleIds,
  normalizeNotifyRepeat,
  normalizeNotifyView,
  notifyRepeatAllowed,
  notifyRepeatInWindow,
  notifyRepeatWaitMs,
  validTimeZone,
  type NotifyView,
} from '@gusvoice/shared';
import { instanceIdByDomain } from './federation/instanceLabels.js';
import { getChannelAudience } from './permissions.js';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { memberRoles, pushAlways, pushDevices, pushMutes, roles, serverMembers, users } from './db/schema.js';
import { env } from './env.js';
import { encryptWebPush, type WebPushKeys } from './pushCrypto.js';
import { deferPush, postponeRepeatPush, recipientActive, scheduleRepeatPush } from './pushDefer.js';
import { endpointAllowed, maskPushPayload, redactPushPayload, shouldDeferPush } from './pushRules.js';
import { id } from './util.js';

// Чистые правила — в `pushRules.ts`. Реэкспорт, чтобы роуты продолжали брать `contentPreview`
// из `push.js` (там же рядом `sendPushToUsers`, который они и зовут).
export { contentPreview, forwardPreview, pushThrottleSource, stickerPushText, withSilent } from './pushRules.js';

/**
 * A background-wake push payload. Delivered as the raw POST body to a device's UnifiedPush endpoint;
 * the Android receiver parses this JSON and builds the local notification (so it works even when the
 * app process is dead). Web/desktop already notify in-app via the Notification path — this is Android.
 */
export interface PushPayload {
  /**
   * `call` (08.10, #211, `calls3`) — входящий звонок 1:1: `title` — звонящий (по настройке показа), `body` — «Входящий
   * звонок» / «Входящий видеозвонок». Уходит сразу и с высоким приоритетом, без отсрочки `pushDefer`; снимается тихим
   * `type: "read"` (`calls.ts`). Старое приложение строит по нему обычное уведомление по `title`/`body` с переходом в беседу.
   */
  type: 'dm' | 'mention' | 'call';
  title: string;
  body: string;
  dmId?: string;
  channelId?: string;
  serverId?: string;
  /**
   * На каком инстансе это случилось (#139, F5, требование 33) — `instance_id` федерации.
   *
   * Пусто — у нас же, как было всегда. Заполнено — пуш приехал с ЧУЖОГО инстанса через дом, и по
   * тапу приложение обязано перейти туда: серверов и каналов с такими идентификаторами у дома нет,
   * и без этого поля тап привёл бы в пустоту.
   */
  instanceId?: string;
  /**
   * ЛС отправлено «без звука» (С3, признак `conv8`, `pushRules.withSilent`): уведомление показать, но без звука и
   * вибрации. Есть только у таких пушей (у обычного ключа нет). Едет внутри шифра; дому гостя не уходит (`guestPush`
   * берёт свои поля). Старое приложение поле не знает и звенит.
   */
  silent?: true;
  /**
   * Уведомление беседы как у Telegram (07.10, #211, Р1, G17; источник — `NotificationsController.java`: MessagingStyle,
   * Person с аватаром, ответ из шторки). Только добавления: старое приложение их не знает и строит уведомление по
   * `title`/`body`, как раньше. `author`/`authorId`/`avatar` — автор сообщения (Person); `group` — название группы
   * (заголовок беседы; `title` у группы остаётся «Имя в «Название»» для старых); `key` — порядковый ключ сообщения (им
   * «Пометить прочитанным» зовёт `POST /conv/:id/read`); `mid` — id сообщения; `ts` — время, мс.
   */
  author?: string;
  authorId?: string;
  avatar?: string;
  group?: string;
  key?: number;
  mid?: string;
  ts?: number;
  /**
   * Входящий звонок (`calls3`, только у `type: "call"`): id звонка (им будущий нативный экран звонка зовёт
   * `/calls/:id/answer` / `decline`) и `video` — звонок с видео. Только добавления: нынешнее приложение их не читает.
   */
  callId?: string;
  video?: true;
  /**
   * Номер повтора «Повторять уведомления» (D10, 08.10; G38, `push3`): есть только у пуша из очереди повторов
   * (`sendPushToUsers` `opts.repeat`). Повтор несёт то же сообщение (`mid`), и приложение считало его повторной доставкой и
   * молча отбрасывало (`ConversationNotifier.onMessage`); с этим полем оно снимает уведомление беседы и показывает его снова
   * со звуком, как Telegram (`NotificationsController.repeatNotificationMaybe`). Только добавление: старое приложение поле не знает.
   */
  repeat?: number;
}

/** Признаки приложения на устройстве пуша (`push_devices.caps`, миграция 0102). */
export const PUSH_CAPS = ['read1', 'reply1'] as const;
export type PushCap = (typeof PUSH_CAPS)[number];

/** Разбор `caps` из регистрации: только известные, без повторов; пусто — `null` (как у старого приложения). */
export function normalizePushCaps(caps: readonly string[] | null | undefined): string | null {
  const known = new Set<string>(PUSH_CAPS);
  const list = [...new Set((caps ?? []).filter((c) => known.has(c)))];
  return list.length > 0 ? list.join(',') : null;
}

export type PushMuteScope = 'server' | 'dm_user';

/**
 * Where a push originates, so recipients who muted that source get filtered out before we wake their
 * phone. `server` => the @mention's server; `dm_user` => the DM author. See sendPushToUsers.
 */
export interface PushSource {
  scope: PushMuteScope;
  targetId: string;
}

/**
 * Пуш без имени и текста устройствам БЕЗ ключей шифрования (#213; аудит ЛС #236, п.1, решение владельца 26.10).
 *
 * Включено: ntfy отдаёт тему на чтение без входа, и открытый JSON с текстом ЛС лежал бы там. Устройство без ключей
 * получает то же, что при настройке показа «ничего» (`maskPushPayload(…, 'nothing')`): заголовок «GusVoice», «Новое
 * сообщение», без автора, аватара и названия группы. Беседа, ключ и время остаются — тап открывает беседу.
 */
const REDACT_KEYLESS = true;

const NTFY_BASE = env.ntfy.baseUrl; // e.g. https://ntfy.example.com
const NTFY_TOKEN = env.ntfy.token;

/** `endpointAllowed` с нашей базой ntfy — единственный заслон от SSRF (endpoint приходит с устройства). */
export function pushEndpointAllowed(endpoint: string): boolean {
  return endpointAllowed(endpoint, NTFY_BASE);
}

/**
 * Upsert a device's UnifiedPush endpoint for a user (one row per user+device).
 * `keys` — ключи шифрования пуша (#213). Нет — строка их теряет: устройство, которое перестало их
 * слать (откат версии), должно получать пуш без текста, а не шифр, который не прочтёт.
 */
export async function registerPushDevice(
  userId: string,
  deviceId: string,
  endpoint: string,
  platform: string | null,
  keys: WebPushKeys | null = null,
  capsIn: readonly string[] | null = null,
  tzIn: string | null = null,
): Promise<void> {
  const p256dh = keys?.p256dh ?? null;
  const auth = keys?.auth ?? null;
  // Перерегистрация старым приложением (откат APK) сбрасывает признаки в NULL — сигналы «прочитано» ему не нужны.
  const caps = normalizePushCaps(capsIn);
  // Пояс (IANA): непонятное имя — как «не прислал»; прежний пояс при перерегистрации без него остаётся.
  const tz = validTimeZone(tzIn) ? tzIn : null;
  await db
    .insert(pushDevices)
    .values({ id: id(), userId, deviceId, endpoint, platform, p256dh, auth, caps, tz, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [pushDevices.userId, pushDevices.deviceId],
      set: { endpoint, platform, p256dh, auth, caps, tz: sql`coalesce(${tz}, ${pushDevices.tz})`, updatedAt: new Date() },
    });
}

export async function unregisterPushDevice(userId: string, deviceId: string): Promise<void> {
  await db.delete(pushDevices).where(and(eq(pushDevices.userId, userId), eq(pushDevices.deviceId, deviceId)));
}

/**
 * Best-effort: POST a wake payload to every registered device of each recipient, REGARDLESS of whether
 * they're online elsewhere — so a DM/@mention still buzzes your phone while you sit at the desktop.
 * Fire-and-forget — never blocks or throws into the message path. (Per-device foreground suppression —
 * so the phone doesn't double-notify while you're actively in the app on it — is a device-side follow-up.)
 *
 * `source` (optional) lets recipients opt out per-source: any recipient with a matching push_mute row
 * (e.g. muted this server, or muted DMs from this person) is dropped before their phone is woken.
 *
 * G38 (08.10, `push2`): тело — по «Показывать имя / текст» получателя (`users.notify_view`, `pushRules.maskPushPayload`);
 * получателю, который прямо сейчас за другим устройством (`pushDefer.recipientActive`), пуш ЛС откладывается на 30 с и
 * не уходит, если сообщение прочитали (`pushDefer.ts`).
 */
export async function sendPushToUsers(
  recipientIds: string[],
  payload: PushPayload,
  source?: PushSource,
  /**
   * `noDefer` — пуш из очереди отложенных (`pushDefer.ts`): второй раз не откладывать. `private` (G38, `push3`) — пуш
   * личной беседы 1:1: чтит «Личные сообщения» получателя и ставит повтор («Повторять уведомления»); `repeat` — сколько раз
   * этот пуш уже повторён (из очереди повторов); `firstAt` — когда ушёл первый пуш этой цепочки повторов (мс; у записи
   * очереди без него — от текущего такта). `burst` (решение владельца 39) — тихая досылка пачки (`authGuard.pushBurst`): тело
   * уже с `silent: true`; гостю через дом не уходит (дом будит телефон своим пушем без текста — досылка там лишний звонок).
   */
  opts: { noDefer?: boolean; private?: boolean; repeat?: number; firstAt?: number; burst?: boolean } = {},
): Promise<void> {
  let ids = [...new Set(recipientIds)];
  if (ids.length === 0) return;
  /**
   * Окно повторов «сутки от первого пуша» (`notifyRepeatInWindow`) — по настоящему времени, до отправки и до переноса за ПК:
   * перенос номер не растит, и без этой проверки повтор, просроченный на 48 ч, всё равно уходил (ревью Codex 08.10).
   */
  const now = Date.now();
  const firstAt = opts.repeat && typeof opts.firstAt === 'number' ? opts.firstAt : now;
  if (opts.repeat && !notifyRepeatInWindow(firstAt, now)) return;
  /** «Выключить звук» (07.10, `conv13`): им пуш уходит, но с `silent` — уведомление без звука и вибрации. */
  const quiet = new Set<string>();
  if (source) {
    const muted = await db
      .select({ userId: pushMutes.userId, soundOnly: pushMutes.soundOnly })
      .from(pushMutes)
      .where(
        and(
          inArray(pushMutes.userId, ids),
          eq(pushMutes.scope, source.scope),
          eq(pushMutes.targetId, source.targetId),
          activeMute(),
        ),
      );
    for (const m of muted) if (m.soundOnly) quiet.add(m.userId);
    const full = muted.filter((m) => !m.soundOnly);
    if (full.length > 0) {
      const drop = new Set(full.map((m) => m.userId));
      ids = ids.filter((uid) => !drop.has(uid));
      if (ids.length === 0) return;
    }
  }
  /**
   * 🔴 Гостей будим ЧЕРЕЗ ИХ ДОМ (требование 33). Устройство гостя зарегистрировано в пушах дома, а
   * не у нас: своей рассылкой мы до его телефона не достучимся в принципе — раньше он просто не
   * узнавал, что его позвали, пока сам не открывал приложение.
   *
   * ⚠️ Содержимое сообщения дому НЕ уходит: он получает «вашего человека позвали там-то» и будит
   * телефон своим пушем. Текст клиент забирает у нас, когда человек откроет приложение.
   */
  const allRows = await db
    .select({
      id: users.id,
      homeInstanceId: users.homeInstanceId,
      homeUserId: users.homeUserId,
      notifyView: users.notifyView,
      notifyDm: users.notifyDm,
      notifyRepeat: users.notifyRepeat,
    })
    .from(users)
    .where(inArray(users.id, ids));
  // «Личные сообщения» выключены (G38, `push3`): пуш личной беседы 1:1 такому получателю не уходит (группы — `notifyGroups`).
  // Повтор из очереди (`opts.repeat`), а человек уже выключил «Повторять уведомления» — не шлём (ревью 08.10: стоявший в
  // очереди повтор уходил после выключения).
  // Исключение «Уведомления включены» (решение владельца 38, `push4`, `push_always`): эта беседа уведомляет и при выключенных
  // «Личных» — как Telegram `notify2_<did>` = 0 поверх выключенных «Личные чаты». Запрос — только если кто-то выключил «Личные».
  const always =
    opts.private && source && allRows.some((r) => r.notifyDm === false)
      ? await pushAlwaysUsers(
          allRows.filter((r) => r.notifyDm === false).map((r) => r.id),
          source.targetId,
        )
      : new Set<string>();
  const rows = allRows.filter(
    (r) =>
      (!opts.private || r.notifyDm !== false || always.has(r.id)) && (!opts.repeat || normalizeNotifyRepeat(r.notifyRepeat) > 0),
  );
  if (rows.length < allRows.length) {
    const keep = new Set(rows.map((r) => r.id));
    ids = ids.filter((uid) => keep.has(uid));
    if (ids.length === 0) return;
  }
  /** «Показывать имя / текст» (G38, `push2`) каждого получателя: тело пуша собирается по ней. */
  const viewOf = new Map<string, NotifyView>(rows.map((r) => [r.id, normalizeNotifyView(r.notifyView)]));
  const guests = rows.filter((r) => r.homeInstanceId && r.homeUserId);
  // Звонок гостю через дом не будим (`calls3`): у протокола федерации нет вида «звонок», а «вас упомянули» вместо
  // звонка — ложь; гость слышит звонок по сокету, пропущенный придёт обычным пушем ЛС.
  if (guests.length > 0 && payload.type !== 'call' && !opts.burst) {
    void import('./federation/guestPush.js')
      .then(({ notifyGuestHomes }) =>
        notifyGuestHomes(
          guests.map((g) => ({ instanceId: g.homeInstanceId!, homeUserId: g.homeUserId! })),
          payload,
        ),
      )
      .catch(() => {
        /* дом недоступен — событие осталось в очереди и уедет само */
      });
  }
  if (guests.length > 0) {
    const guestIds = new Set(guests.map((g) => g.id));
    ids = ids.filter((uid) => !guestIds.has(uid));
    if (ids.length === 0) return;
  }

  // Своим — как раньше, напрямую через наш ntfy. ⚠️ Проверка настройки стоит ЗДЕСЬ, а не в начале:
  // инстанс без своих пушей всё равно обязан разбудить гостя через его дом.
  if (!NTFY_BASE || !NTFY_TOKEN) return;
  /**
   * Отложенный пуш (G38, `push2`, `pushDefer.ts`): получатель сейчас за другим устройством (кадр шлюза `active`) — пуш
   * ЛС ждёт 30 с и уходит, только если сообщение не прочитали. Redis не ответил — шлём сразу, как раньше.
   */
  if (!opts.noDefer) {
    const later = ids.filter((uid) => shouldDeferPush(payload, recipientActive(uid)));
    if (later.length > 0) {
      const deferred = new Set<string>();
      await Promise.all(
        later.map((uid) =>
          deferPush({ uid, payload, ...(source ? { source } : {}), ...(opts.private ? { private: true as const } : {}) }).then(
            () => void deferred.add(uid),
            () => {},
          ),
        ),
      );
      ids = ids.filter((uid) => !deferred.has(uid));
      if (ids.length === 0) return;
    }
  }
  /**
   * Повтор «Повторять уведомления» не уходит, пока человек за ПК (решение владельца 08.10, вопрос 14): телефон не звенит
   * повтором, когда беседа открыта на соседнем экране. Повтор ждёт, как первый пуш при живом ПК (`PUSH_DEFER_MS`), и
   * проверяется снова; номер повтора при этом не растёт. Redis не ответил — повтор уходит как раньше.
   */
  if (opts.repeat) {
    const atPc = ids.filter((uid) => recipientActive(uid));
    if (atPc.length > 0) {
      const held = new Set<string>();
      await Promise.all(
        atPc.map((uid) =>
          postponeRepeatPush({ uid, payload, ...(source ? { source } : {}), private: true, repeat: opts.repeat, firstAt }).then(
            () => void held.add(uid),
            () => {},
          ),
        ),
      );
      ids = ids.filter((uid) => !held.has(uid));
      if (ids.length === 0) return;
    }
  }
  let all = await db.select().from(pushDevices).where(inArray(pushDevices.userId, ids));
  /**
   * Повтор — только днём (09.10, сверка с Telegram: `repeatNotificationMaybe`, часы 11..22 по местному времени). Получателю,
   * у которого сейчас ночь по поясу его устройства (`push_devices.tz`), повтор не уходит: встаёт в очередь на начало окна (тот
   * же ключ, не перезаписывая более свежий; номер повтора и `firstAt` прежние — сутки от первого пуша не продлеваются).
   * Пояса нет (старое приложение) — окна нет, как раньше.
   */
  if (opts.repeat && all.length > 0) {
    const night = new Set<string>();
    for (const uid of new Set(all.map((d) => d.userId))) {
      const mine = all.filter((d) => d.userId === uid && d.tz);
      const tz = mine.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]?.tz;
      const wait = notifyRepeatWaitMs(tz, now);
      if (wait <= 0) continue;
      night.add(uid);
      if (notifyRepeatInWindow(firstAt, now + wait)) {
        void postponeRepeatPush(
          { uid, payload, ...(source ? { source } : {}), private: true, repeat: opts.repeat, firstAt },
          now,
          wait,
        ).catch(() => {});
      }
    }
    if (night.size > 0) {
      all = all.filter((d) => !night.has(d.userId));
      if (all.length === 0) return;
    }
  }
  /*
   * Входящий звонок (`calls3`) — только приложениям, которые умеют его снять (`read1`, тот же признак, что у
   * `sendReadSyncPush`; снятие шлёт `calls.unringPush`). Ревью 08.10: приложение без `read1` (все выпущенные APK по v0.8.21)
   * строило из него обычное уведомление «Входящий звонок», и после ответа на ПК или отклонения оно оставалось висеть —
   * снятия ему не приходит. Пропущенный звонок такое приложение по-прежнему узнаёт обычным пушем ЛС.
   */
  const devices = payload.type === 'call' ? all.filter((d) => (d.caps ?? '').includes('read1')) : all;
  if (devices.length === 0) return;
  /**
   * «Повторять уведомления» (G38, `push3`): пуш личной беседы с ключом сообщения уходит — если человек выбрал интервал,
   * повтор встаёт в очередь (`pushDefer.scheduleRepeatPush`) и уйдёт, пока беседа не прочитана (как Telegram), в пределах
   * защитного потолка `notifyRepeatAllowed` (24 раза и сутки от первого пуша по плану) и окна `notifyRepeatInWindow` (те же
   * сутки по настоящему времени: срок следующего повтора за окном — не ставим). Беззвучный пуш («без звука» отправителя, «Выключить звук» беседы) не повторяется.
   */
  if (opts.private && payload.type === 'dm' && payload.dmId && typeof payload.key === 'number' && !payload.silent) {
    const n = (opts.repeat ?? 0) + 1;
    const minutesOf = new Map(rows.map((r) => [r.id, normalizeNotifyRepeat(r.notifyRepeat)]));
    for (const uid of new Set(devices.map((d) => d.userId))) {
      const min = minutesOf.get(uid) ?? 0;
      if (notifyRepeatAllowed(n, min) && notifyRepeatInWindow(firstAt, now + min * 60_000) && !quiet.has(uid)) {
        void scheduleRepeatPush({ uid, payload, ...(source ? { source } : {}), private: true, repeat: n, firstAt }, min);
      }
    }
  }
  /**
   * Входящий звонок (`calls3`) — высокий приоритет: `Urgency: high` (RFC 8030, Web Push) и `Priority: 5` (ntfy, «срочно»),
   * чтобы телефон в доze получил его сразу, как `phoneCallRequested` у Telegram через FCM. Остальным пушам — как было.
   */
  const urgent: Record<string, string> = payload.type === 'call' ? { Urgency: 'high', Priority: '5' } : {};
  // Повтор из очереди (D10): номер повтора — в тело пуша, чтобы приложение не приняло его за повторную доставку того же сообщения.
  // В очередь (`scheduleRepeatPush` выше) уходит исходная нагрузка без поля: номер ставится заново на каждой отправке.
  const sent: PushPayload = opts.repeat ? { ...payload, repeat: opts.repeat } : payload;
  const variant = (p: PushPayload) => ({
    payload: p,
    plain: Buffer.from(JSON.stringify(p), 'utf8'),
    redacted: JSON.stringify(REDACT_KEYLESS ? maskPushPayload(redactPushPayload(p), 'nothing') : p),
  });
  // Вариант тела на пару «настройка показа × без звука» — шифр и JSON собираются один раз на пару, не на устройство.
  const variants = new Map<string, ReturnType<typeof variant>>();
  const variantFor = (uid: string) => {
    const view = viewOf.get(uid) ?? 'all';
    const q = quiet.has(uid);
    const k = `${view}|${q ? 1 : 0}`;
    let v = variants.get(k);
    if (!v) {
      v = variant(maskPushPayload(q ? { ...sent, silent: true as const } : sent, view));
      variants.set(k, v);
    }
    return v;
  };
  await Promise.all(
    devices.map(async (d) => {
      const v = variantFor(d.userId);
      if (!pushEndpointAllowed(d.endpoint)) return;
      /**
       * 🔴 Текст сообщения — только шифром (#213). Устройство прислало ключи → тело aes128gcm (RFC 8291),
       * `X-UnifiedPush: 1` велит ntfy принять двоичное тело (он кладёт его base64 с `encoding`, а
       * приложение ntfy и наш встроенный распространитель раскодируют). Ключей нет или они кривые —
       * пуш без имени и текста (`maskPushPayload(…, 'nothing')`), `REDACT_KEYLESS` включён с аудита #236.
       */
      let wire: { body: string | Buffer; headers: Record<string, string> } = {
        body: v.redacted,
        headers: { 'Content-Type': 'application/json' },
      };
      if (d.p256dh && d.auth) {
        try {
          wire = {
            // `uid` (Р1, G17) — получатель: им приложение выбирает инстанс и токен для «Ответить» / «Прочитано» из
            // шторки. Только внутри шифра и только приложению с `reply1`; остальным тело прежнее, байт в байт.
            body: encryptWebPush(
              d.caps?.split(',').includes('reply1')
                ? Buffer.from(JSON.stringify({ ...v.payload, uid: d.userId }), 'utf8')
                : v.plain,
              { p256dh: d.p256dh, auth: d.auth },
            ),
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Encoding': 'aes128gcm',
              'X-UnifiedPush': '1',
            },
          };
        } catch {
          /* 🔴 Шифр не вышел (ключ не на кривой, слишком длинно) — пуш БЕЗ текста, независимо от
             `REDACT_KEYLESS` (найдено Codex 28.09). Раньше здесь оставалось запасное тело, а пока флаг выключен,
             это открытый JSON с текстом ЛС: устройство прислало ключи ради шифра и получало открытым. Новое
             приложение без шифра покажет «Новое сообщение». */
          wire = {
            body: JSON.stringify(maskPushPayload(redactPushPayload(v.payload), 'nothing')),
            headers: { 'Content-Type': 'application/json' },
          };
        }
      }
      try {
        const res = await fetch(d.endpoint, {
          method: 'POST',
          headers: { ...wire.headers, ...urgent, Authorization: `Bearer ${NTFY_TOKEN}` },
          body: wire.body,
          redirect: 'manual', // SSRF (P2-5): NEVER follow a 3xx into the internal network
        });
        // A redirect (3xx) from a push endpoint is anomalous/malicious — don't follow it, drop the
        // device. Topic gone / payload too large (404/413) => stale registration, also drop.
        const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
        if (redirected || res.status === 404 || res.status === 413) {
          await db.delete(pushDevices).where(eq(pushDevices.id, d.id)).catch(() => {});
        }
      } catch {
        /* best-effort; the message itself already delivered over the gateway */
      }
    }),
  );
}

/**
 * «Беседу прочитали на другом устройстве» (07.10, #211, Р1, G17): тихий пуш моим телефонам, приложение снимает
 * уведомление беседы (у Telegram — `updateReadHistoryInbox` → `NotificationsController.processReadMessages`).
 *
 * 🔴 Только устройствам с признаком `read1` и ключами шифра: старое приложение нагрузку без текста показало бы как
 * «Новое сообщение». Гостям через дом не шлём (их телефон — у дома; протокол федерации не трогаем). Ошибки глотаются:
 * само «прочитано» уже записано и разослано по сокетам.
 */
export async function sendReadSyncPush(userId: string, conversationId: string, key: number | null): Promise<void> {
  if (!NTFY_BASE || !NTFY_TOKEN) return;
  const devices = await db
    .select()
    .from(pushDevices)
    .where(and(eq(pushDevices.userId, userId), sql`${pushDevices.caps} LIKE '%read1%'`));
  const payload = { type: 'read', title: '', body: '', dmId: conversationId, ...(key !== null ? { key } : {}), uid: userId };
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  await Promise.all(
    devices.map(async (d) => {
      if (!d.p256dh || !d.auth || !pushEndpointAllowed(d.endpoint)) return;
      try {
        const res = await fetch(d.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            'X-UnifiedPush': '1',
            Authorization: `Bearer ${NTFY_TOKEN}`,
          },
          body: encryptWebPush(plain, { p256dh: d.p256dh, auth: d.auth }),
          redirect: 'manual', // SSRF (P2-5), как у `sendPushToUsers`
        });
        const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
        if (redirected || res.status === 404 || res.status === 413) {
          await db.delete(pushDevices).where(eq(pushDevices.id, d.id)).catch(() => {});
        }
      } catch {
        /* best-effort */
      }
    }),
  );
}

/**
 * Какие роли сообщение РЕАЛЬНО зовёт (#76, `@Модераторы`): названия ролей сервера в тексте, отфильтрованные по праву
 * автора (`canMentionRole`: роль «можно упоминать» либо у автора право `MENTION_EVERYONE`). Результат кладётся в
 * `messages.mention_roles` при отправке и дальше НЕ пересчитывается — бейдж и пуш не зависят от последующих правок
 * роли и прав. `@everyone` — не роль, его разбирает `resolveMentionedMembers`.
 */
export async function resolveRoleMentions(content: string, serverId: string, authorPerms: bigint): Promise<string[]> {
  if (!content.includes('@')) return [];
  const rows = await db
    .select({ id: roles.id, name: roles.name, mentionable: roles.mentionable })
    .from(roles)
    .where(and(eq(roles.serverId, serverId), eq(roles.isEveryone, false)));
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return mentionedRoleIds(content, rows).filter((rid) => canMentionRole(byId.get(rid)!, authorPerms));
}

/**
 * Resolve @username mentions in `content` to member userIds of `serverId` (excluding the author).
 *
 * ⚠️ Имена достаёт ОБЩЕЕ правило (`shared/mentions.ts`), то же самое, по которому клиент решает
 * звенеть ли звуком. Своя регулярка тут была и расходилась с клиентской: `@super.` в конце
 * предложения превращалось в имя «super.», такого пользователя в базе нет, и пуш не уходил —
 * при том что на десктопе упоминание отрабатывало.
 */
export async function resolveMentionedMembers(
  content: string,
  serverId: string,
  authorId: string,
  /** Канал сообщения — по нему считается, кого будит `@everyone`. Без него `@everyone` пуш не шлёт. */
  channelId?: string,
  /** Роли, которые сообщение позвало (`resolveRoleMentions`, #76): их участники, видящие канал, — тоже адресаты. */
  mentionRoleIds: readonly string[] = [],
  /** `false` — автору не хватило `MENTION_EVERYONE` (#76): `@everyone`/`@here` в тексте никого не будят. Вебхуки не передают (у них своя политика). */
  allowBroadcast = true,
): Promise<string[]> {
  const handles = mentionedHandles(content);
  if (handles.length === 0 && mentionRoleIds.length === 0) return [];
  const isBroadcast = (name: string) => (BROADCAST_MENTIONS as readonly string[]).includes(name);
  const names = handles.filter((h) => h.domain === null && !isBroadcast(h.name)).map((h) => h.name);
  const guests = handles.filter((h) => h.domain !== null);

  const found: string[] = [];

  /**
   * `@everyone` (#76, мегаприёмка 23.09): раньше уходил в поиск пользователя с именем «everyone» и не
   * будил никого, хотя звук и значок у людей в приложении срабатывали. Будим всех, кто ВИДИТ канал, —
   * ту же аудиторию, что получает само сообщение (`getChannelAudience`), и только настоящих участников:
   * супер-админ входит в аудиторию любого канала виртуально, и пуш с чужих серверов ему не нужен.
   *
   * ⚠️ `@here` пуш не шлёт намеренно: он про тех, кто сейчас в приложении, а они получают звук и значок
   * живьём. Разбудить телефон спящему — ровно то, чем `@here` отличается от `@everyone`.
   */
  const everyone = allowBroadcast && handles.some((h) => h.domain === null && h.name === 'everyone');
  /**
   * Роль (#76, `@Модераторы`): участники роли ∩ те, кто ВИДИТ канал (`getChannelAudience`) — человек без доступа к
   * каналу не должен узнавать о сообщении. Тот же набор, что у `@everyone`; тех, кто назван и лично, и ролью, склеивает
   * `Set` внизу — уведомление одно. Настройки «только упоминания» уже учтены у получателя: роль для него = упоминание.
   */
  if (channelId && mentionRoleIds.length > 0) {
    const audience = await getChannelAudience(channelId);
    if (audience && audience.serverId === serverId && audience.userIds.length > 0) {
      const rows = await db
        .select({ id: memberRoles.userId })
        .from(memberRoles)
        .innerJoin(serverMembers, and(eq(serverMembers.userId, memberRoles.userId), eq(serverMembers.serverId, serverId)))
        .where(
          and(
            eq(memberRoles.serverId, serverId),
            inArray(memberRoles.roleId, [...mentionRoleIds]),
            inArray(memberRoles.userId, audience.userIds),
          ),
        );
      found.push(...rows.map((r) => r.id));
    }
  }
  if (channelId && everyone) {
    const audience = await getChannelAudience(channelId);
    if (audience && audience.serverId === serverId && audience.userIds.length > 0) {
      const rows = await db
        .select({ id: serverMembers.userId })
        .from(serverMembers)
        .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, audience.userIds)));
      found.push(...rows.map((r) => r.id));
    }
  }
  if (names.length > 0) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, serverId)))
      .where(inArray(sql`lower(${users.username})`, names));
    found.push(...rows.map((r) => r.id));
  }

  /**
   * Гость (#139, F4, §5.5): к нему обращаются `@ник@домен`, и найти его можно только по ПАРЕ.
   *
   * 🔴 По одному нику искать нельзя: на сервере бывает свой Вася и Вася с соседнего инстанса, и
   * поиск по имени позвонил бы не тому — ровно поэтому домен в обращении и появился.
   * ⚠️ Домен → инстанс берём из кеша связок: имя инстанса меняется раз в недели, а сообщения идут
   * потоком, и лишний запрос в базу на каждое упоминание тут ни к чему.
   */
  for (const h of guests) {
    const instanceId = instanceIdByDomain(h.domain!);
    if (!instanceId) continue;
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, serverId)))
      .where(and(eq(users.homeInstanceId, instanceId), eq(sql`lower(${users.homeUsername})`, h.name)));
    found.push(...rows.map((r) => r.id));
  }

  return [...new Set(found)].filter((uid) => uid !== authorId);
}

/**
 * Заглушка действует (07.10, `conv11`): без срока (`until IS NULL` — все прежние строки) или срок ещё не вышел.
 * Истёкшая строка = не заглушено: пуш уходит, в списке её нет. Удалять её не нужно — следующая заглушка перепишет срок.
 */
function activeMute() {
  return or(isNull(pushMutes.until), gt(pushMutes.until, sql`now()`))!;
}

/**
 * List a user's active push-mute rules (for bootstrap / settings UI). Истёкших нет; `until` (07.10, `conv11`,
 * добавлением) — только у заглушки со сроком: старый клиент поле не знает и видит её «навсегда», пока срок не выйдет.
 */
export async function listPushMutes(
  userId: string,
): Promise<{ scope: PushMuteScope; targetId: string; until?: string; soundOnly?: true }[]> {
  const rows = await db
    .select({ scope: pushMutes.scope, targetId: pushMutes.targetId, until: pushMutes.until, soundOnly: pushMutes.soundOnly })
    .from(pushMutes)
    .where(and(eq(pushMutes.userId, userId), activeMute()));
  return rows.map((r) => ({
    scope: r.scope as PushMuteScope,
    targetId: r.targetId,
    ...(r.until ? { until: r.until.toISOString() } : {}),
    ...(r.soundOnly ? { soundOnly: true as const } : {}),
  }));
}

/**
 * Mute pushes from a source (server or DM-person) for this user. Idempotent. `seconds` (07.10, `conv11`) — на
 * сколько от часов СЕРВЕРА (часы клиента не нужны); без него — навсегда, как у старых клиентов. Повтор переписывает
 * срок: «навсегда» поверх срока и срок поверх «навсегда».
 */
export async function setPushMute(
  userId: string,
  scope: PushMuteScope,
  targetId: string,
  seconds?: number,
  soundOnly = false,
): Promise<void> {
  const until = seconds ? sql`now() + make_interval(secs => ${seconds})` : null;
  await db
    .insert(pushMutes)
    .values({ userId, scope, targetId, until, soundOnly })
    .onConflictDoUpdate({ target: [pushMutes.userId, pushMutes.scope, pushMutes.targetId], set: { until, soundOnly } });
  // Полная заглушка снимает исключение «Уведомления включены» той же беседы (`push4`): у беседы одна своя настройка.
  if (scope === 'dm_user' && !soundOnly) await removePushAlways(userId, targetId);
}

/**
 * «Исключения: уведомления включены» (решение владельца 38, `push4`, таблица `push_always`, миграция 0127). У беседы одна
 * своя настройка, как у Telegram (`notify2_<did>`): полная заглушка снимает «включено», «включено» снимает полную заглушку;
 * «Выключить звук» (`sound_only`) живёт рядом — беседа уведомляет, но без звука.
 */
export async function listPushAlways(userId: string): Promise<{ scope: 'dm_user'; targetId: string }[]> {
  const rows = await db.select({ targetId: pushAlways.targetId }).from(pushAlways).where(eq(pushAlways.userId, userId));
  return rows.map((r) => ({ scope: 'dm_user' as const, targetId: r.targetId }));
}

export async function setPushAlways(userId: string, targetId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(pushAlways).values({ userId, scope: 'dm_user', targetId }).onConflictDoNothing();
    await tx
      .delete(pushMutes)
      .where(
        and(
          eq(pushMutes.userId, userId),
          eq(pushMutes.scope, 'dm_user'),
          eq(pushMutes.targetId, targetId),
          eq(pushMutes.soundOnly, false),
        ),
      );
  });
}

export async function removePushAlways(userId: string, targetId: string): Promise<void> {
  await db
    .delete(pushAlways)
    .where(and(eq(pushAlways.userId, userId), eq(pushAlways.scope, 'dm_user'), eq(pushAlways.targetId, targetId)));
}

/** Кто из `ids` включил уведомления этой беседы исключением (`push_always`, `dm_user` + `targetId`). */
export async function pushAlwaysUsers(ids: readonly string[], targetId: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ userId: pushAlways.userId })
    .from(pushAlways)
    .where(and(inArray(pushAlways.userId, [...ids]), eq(pushAlways.scope, 'dm_user'), eq(pushAlways.targetId, targetId)));
  return new Set(rows.map((r) => r.userId));
}

/** Un-mute a previously muted source. */
export async function removePushMute(userId: string, scope: PushMuteScope, targetId: string): Promise<void> {
  await db
    .delete(pushMutes)
    .where(and(eq(pushMutes.userId, userId), eq(pushMutes.scope, scope), eq(pushMutes.targetId, targetId)));
}
