import { mentionsMe, type GatewayServerMessage, type UnreadSummary, type User } from '@gusvoice/shared';
import { instances, rememberInstanceServers, type Instance } from './config';
import { PING_MS, socketStale } from './socketHealth';

/**
 * Одновременные шлюзы (#139, §5.7): соединения с инстансами, КУДА ЧЕЛОВЕК СЕЙЧАС НЕ СМОТРИТ.
 *
 * **Что это даёт.** До сих пор живым был ровно один инстанс — тот, на котором стоит человек. Серверы
 * остальных рейл показывал снимком, но без единого счётчика: пока ты гостишь у соседа, дома могли
 * написать, позвать по имени, позвать в голос — и узнать об этом можно было, только сходив туда.
 * Теперь шлюз каждой записи реестра открыт, и значки стоят там, где события происходят.
 *
 * 🔴 **Это НЕ второй экземпляр приложения.** Фоновый шлюз не трогает стор, не грузит истории, не
 * играет звуки и не знает ни про каналы, ни про людей. Он считает ровно то, что нужно значку:
 * сколько непрочитанного и сколько упоминаний на каждом сервере того инстанса. Всё остальное
 * появляется, когда человек туда переходит и шлюз становится основным.
 *
 * ⚠️ **Начальные числа берём у самого инстанса** (`GET /unread`), а не начинаем с нуля: иначе значок
 * показывал бы «что прилетело, пока приложение открыто», и человек, запустивший клиент утром, не
 * увидел бы ничего из вчерашнего.
 *
 * ⚠️ **Счётчики живут в памяти, а не в хранилище.** Пережившее перезапуск число врало бы: прочитать
 * сообщения могли с телефона, и восстановленный значок звал бы туда, где уже пусто. На старте
 * спрашиваем заново — это один лёгкий запрос на инстанс.
 *
 * ⚠️ Токен протух (401) — сокет не открываем вовсе: человек увидит экран входа, когда перейдёт туда
 * сам. Стучаться в инстанс, который нас больше не знает, бессмысленно.
 */

/** Что фоновый инстанс знает про непрочитанное. Ключи серверов — `serverId` ТОГО инстанса. */
export interface BgUnread {
  servers: Record<string, { unread: number; mentions: number }>;
  /** Сколько бесед в личке с непрочитанным. */
  dms: number;
}

/** Локальный id записи реестра → её счётчики. Записи без соединения здесь нет вовсе. */
export type BgUnreadMap = Record<string, BgUnread>;

let state: BgUnreadMap = {};
const listeners = new Set<(m: BgUnreadMap) => void>();

export function bgUnread(): BgUnreadMap {
  return state;
}

export function onBgUnread(fn: (m: BgUnreadMap) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(): void {
  state = { ...state };
  for (const fn of listeners) fn(state);
}

/** Одно живое фоновое соединение. */
interface BgLink {
  instanceId: string;
  socket: WebSocket | null;
  /** id человека на ТОМ инстансе — приходит в `ready`. Без него не отличить своё сообщение от чужого. */
  userId: string | null;
  /** Ник и домашний ник — по ним считаем упоминание (§5.5: гостя зовут `@ник@домен`). */
  me: { username: string | null; home: { username: string; domain: string } | null };
  lastRecv: number;
  ping: ReturnType<typeof setInterval> | null;
  retry: ReturnType<typeof setTimeout> | null;
  /** Сколько раз подряд не получилось: пауза растёт, чтобы мёртвый инстанс не молотил сеть. */
  fails: number;
  closed: boolean;
}

const links = new Map<string, BgLink>();

/** Запрос к ЧУЖОМУ инстансу его же токеном. Общий `api` тут не годится: он говорит с активным. */
async function ask<T>(inst: Instance, path: string): Promise<T> {
  const res = await fetch(`${inst.apiUrl}/api${path}`, {
    headers: inst.token ? { Authorization: `Bearer ${inst.token}` } : {},
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

function wsUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/gateway';
  u.search = '';
  return u.toString();
}

function bump(instanceId: string, serverId: string, mention: boolean): void {
  const cur = state[instanceId] ?? { servers: {}, dms: 0 };
  const s = cur.servers[serverId] ?? { unread: 0, mentions: 0 };
  state[instanceId] = {
    ...cur,
    servers: { ...cur.servers, [serverId]: { unread: s.unread + 1, mentions: s.mentions + (mention ? 1 : 0) } },
  };
  publish();
}

function bumpDm(instanceId: string): void {
  const cur = state[instanceId] ?? { servers: {}, dms: 0 };
  state[instanceId] = { ...cur, dms: cur.dms + 1 };
  publish();
}

function stop(link: BgLink): void {
  link.closed = true;
  if (link.ping) clearInterval(link.ping);
  if (link.retry) clearTimeout(link.retry);
  link.ping = null;
  link.retry = null;
  try {
    link.socket?.close();
  } catch {
    /* сокет уже мёртв — закрывать нечего */
  }
  link.socket = null;
}

function scheduleRetry(link: BgLink, inst: Instance): void {
  if (link.closed || link.retry) return;
  // 5 с, 10 с, 20 с… до минуты: фоновый инстанс не срочен, а сеть жалеть стоит — соединений
  // столько же, сколько записей в реестре.
  const wait = Math.min(60_000, 5_000 * 2 ** Math.min(link.fails, 4));
  link.retry = setTimeout(() => {
    link.retry = null;
    if (!link.closed) void open(inst, link);
  }, wait);
}

async function open(inst: Instance, link: BgLink): Promise<void> {
  if (!inst.token || link.closed) return;

  // Числа ДО сокета: так значок верен с первой секунды, а не «с момента, как мы подключились».
  // Вместе с ними — КТО Я НА ТОМ ИНСТАНСЕ: без ника упоминания считались бы только в стартовой
  // сводке, а живое «@ник, глянь» приходило бы обычным непрочитанным, без красной отметки. Гостя
  // при этом зовут `@ник@домен` (§5.5), и его домашние поля тоже здесь.
  try {
    const [sum, me] = await Promise.all([ask<UnreadSummary>(inst, '/unread'), ask<User>(inst, '/auth/me')]);
    if (link.closed) return;
    link.me = {
      username: me.homeInstance ? null : me.username,
      home: me.homeInstance ? { username: me.username, domain: me.homeInstance.domain } : null,
    };
    state[link.instanceId] = { servers: sum.servers, dms: sum.dms };
    publish();
  } catch (e) {
    // 🔴 401 — токен протух: сокет не открываем вовсе, иначе будем стучаться вечно. Счётчиков у
    // записи не будет, и это честно: мы про неё ничего не знаем.
    if ((e as { status?: number }).status === 401) {
      delete state[link.instanceId];
      publish();
      stop(link);
      return;
    }
    link.fails += 1;
    scheduleRetry(link, inst);
    return;
  }

  const socket = new WebSocket(wsUrl(inst.apiUrl));
  link.socket = socket;

  socket.onopen = () => {
    // Нас успели закрыть (человек перешёл на этот инстанс — шлюз ведёт `sockets.ts`).
    if (link.socket !== socket) {
      socket.close();
      return;
    }
    link.lastRecv = Date.now();
    socket.send(JSON.stringify({ t: 'identify', token: inst.token }));
    link.ping = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socketStale(link.lastRecv, Date.now())) {
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ t: 'ping' }));
    }, PING_MS);
  };

  socket.onmessage = (ev) => {
    if (link.socket !== socket) return;
    link.lastRecv = Date.now();
    let msg: GatewayServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as GatewayServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'ready': {
        link.userId = msg.userId;
        link.fails = 0;
        /**
         * Подписки — после `ready`, как и в основном шлюзе (#126: подписка раньше получала отказ
         * «identify first», и клиент молча оставался без серверных событий). Заодно обновляем снимок
         * серверов в реестре: рейл рисует неактивные инстансы именно по нему, а старел он до
         * следующего перехода туда.
         */
        void ask<{ id: string; name: string; iconUrl?: string | null }[]>(inst, '/servers')
          .then((list) => {
            if (link.socket !== socket) return;
            for (const s of list) socket.send(JSON.stringify({ t: 'subscribe', serverId: s.id }));
            rememberInstanceServers(
              link.instanceId,
              list.map((s) => ({ id: s.id, name: s.name, iconUrl: s.iconUrl ?? null })),
            );
          })
          .catch(() => {
            /* попробуем на следующем подключении — из-за списка сокет не рвём */
          });
        return;
      }
      case 'message.create': {
        if (link.userId && msg.message.author.id === link.userId) return;
        bump(link.instanceId, msg.serverId, mentionsMe(msg.message.content, link.me.username, link.me.home));
        return;
      }
      case 'dm.create': {
        if (link.userId && msg.message.author.id === link.userId) return;
        bumpDm(link.instanceId);
        return;
      }
      default:
        return;
    }
  };

  socket.onclose = () => {
    if (link.socket !== socket) return;
    link.socket = null;
    if (link.ping) clearInterval(link.ping);
    link.ping = null;
    link.fails += 1;
    scheduleRetry(link, inst);
  };
}

/**
 * Свериться с реестром: открыть шлюзы всем, кому положено, и закрыть лишние.
 *
 * Зовётся при запуске и на каждом переходе между инстансами. 🔴 Активная запись сюда не попадает
 * НИКОГДА: её шлюз ведёт `sockets.ts` — со стором, историями и звуками. Два сокета на один инстанс
 * означали бы двойной счёт и двойные уведомления.
 */
export function syncBgGateways(activeId: string | null): void {
  const want = new Map<string, Instance>();
  for (const inst of instances()) {
    if (inst.id === activeId) continue;
    if (!inst.token) continue;
    want.set(inst.id, inst);
  }

  for (const [id, link] of links) {
    if (want.has(id)) continue;
    stop(link);
    links.delete(id);
    // Счётчики закрытой записи убираем: для активной их показывает стор, а для записи без токена их
    // просто нет. Оставить старое число значило бы показывать вчерашнее.
    if (state[id]) {
      delete state[id];
      publish();
    }
  }

  for (const [id, inst] of want) {
    if (links.has(id)) continue;
    const link: BgLink = {
      instanceId: id,
      socket: null,
      userId: null,
      me: { username: null, home: null },
      lastRecv: 0,
      ping: null,
      retry: null,
      fails: 0,
      closed: false,
    };
    links.set(id, link);
    void open(inst, link);
  }
}

/**
 * Повторить действие на всех фоновых инстансах (§5.7: «клиент шлёт статус на каждый инстанс, где
 * открыт шлюз»).
 *
 * **Зачем.** Онлайн человек становится сам собой — по факту открытого шлюза. А вот «не беспокоить»,
 * своя подпись и «Играет в X» ставятся запросом, и уходил он только активному инстансу: у соседа,
 * где человек гость, он светился обычным зелёным «в сети», сколько бы раз ни ставил «не беспокоить»
 * дома. Для статуса это не косметика — он означает «ко мне сейчас не стучаться».
 *
 * ⚠️ Отправляем и забываем: инстанс может лежать, и из-за него не должно падать действие, которое
 * человеку УЖЕ удалось на его собственном. Не доехало — доедет при следующей смене статуса.
 */
export function mirrorToBg(method: 'PATCH' | 'POST', path: string, body: unknown): void {
  for (const [, link] of links) {
    const inst = instances().find((i) => i.id === link.instanceId);
    if (!inst?.token) continue;
    void fetch(`${inst.apiUrl}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inst.token}` },
      body: JSON.stringify(body),
    }).catch(() => {
      /* фоновый инстанс недоступен — статус доедет со следующей сменой */
    });
  }
}

/** Закрыть всё — выход из аккаунта и размонтирование приложения. */
export function stopBgGateways(): void {
  for (const [, link] of links) stop(link);
  links.clear();
  state = {};
  publish();
}

/**
 * Погасить счётчики записи, куда человек только что перешёл.
 *
 * ⚠️ Зовётся до того, как поднимется основной шлюз: иначе значок «5 непрочитанных» висел бы на
 * сервере, который человек уже открыл, — до следующего сообщения.
 */
export function clearBgUnread(instanceId: string): void {
  if (!state[instanceId]) return;
  delete state[instanceId];
  publish();
}
