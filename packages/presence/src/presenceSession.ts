import type { PresenceServerMessage } from '@gusvoice/shared';

/**
 * Жизнь одного сокета presence — БЕЗ fetch, jwt, Redis и LiveKit (#143).
 *
 * Здесь решается, что делать с представившимся клиентом: пускать или закрыть, когда слать снимок и
 * когда молчать. Раньше это лежало двумя кусками прямо в `index.ts` (обработчик `identify` и
 * двадцатисекундный цикл), и проверить «отозванную посреди сессии сессию» можно было только живым
 * бэкендом.
 */

/** Что ответил бэкенд на вопрос «какие каналы этому человеку видно». */
export type VisibilityOutcome = 'ok' | 'revoked' | 'unavailable';

/**
 * Ответ целиком: исход И набор каналов, когда он вообще есть.
 *
 * 🔴 Почему не «просто набор» (#147): пустым набором нельзя обозначать «бэкенд не ответил» — он
 * неотличим от честного «этому человеку не видно ни одного канала». Раньше оба случая приезжали
 * сюда пустым `Set`, `refresh` считал это изменением состава и гасил человеку всю картину
 * голосовых каналов на всё время выкатки. Исход теперь назван явно, и пустой набор снова значит
 * ровно то, что написано.
 */
export type VisibilityFetch =
  | { outcome: 'ok'; visible: Set<string> }
  | { outcome: 'revoked' }
  | { outcome: 'unavailable' };

/**
 * Как понимать ответ бэкенда (`null` — до бэкенда вовсе не достучались).
 *
 * 🔴 Разница принципиальная: 401/403 — сессию отозвали («выйти везде», смена пароля), сокет
 * бесполезен и его надо закрыть. Всё остальное — бэкенд недоступен (выкатка, 5xx, оборванная сеть):
 * выкидывать из-за этого всех, кто сидит в голосе, нельзя, поэтому видимость просто не меняется.
 */
export function classifyVisibility(status: number | null): VisibilityOutcome {
  if (status === 401 || status === 403) return 'revoked';
  if (status === null || status < 200 || status >= 300) return 'unavailable';
  return 'ok';
}

/** Изменился ли состав видимых каналов (порядок неважен). */
export function visibleChanged(before: Set<string>, after: Set<string>): boolean {
  if (before.size !== after.size) return true;
  for (const id of after) if (!before.has(id)) return true;
  return false;
}

export interface PresenceSessionDeps {
  /** Разобрать токен. `null` — подпись не сошлась; объект — полезные поля (`typ`). */
  verifyToken(token: string): { typ?: string } | null;
  /** Спросить бэкенд о видимых каналах — вместе с исходом (`revoked` / `unavailable`). */
  fetchVisible(token: string): Promise<VisibilityFetch>;
  /** Собрать снимок под этот набор видимых каналов. */
  snapshot(visible: Set<string>): Promise<PresenceServerMessage>;
  send(msg: PresenceServerMessage): void;
  close(): void;
}

export type IdentifyResult = 'ok' | 'invalid-token';
export type RefreshResult = 'not-identified' | 'revoked' | 'unavailable' | 'unchanged' | 'changed';

export interface PresenceSession {
  /** Каналы, которые этому человеку видно (пустой набор, пока не представился). */
  readonly visible: Set<string>;
  /** Токен сессии или `null`. */
  readonly token: string | null;
  identify(token: string): Promise<IdentifyResult>;
  refresh(): Promise<RefreshResult>;
}

export function createPresenceSocketSession(deps: PresenceSessionDeps): PresenceSession {
  let token: string | null = null;
  let visible = new Set<string>();

  function reject(): IdentifyResult {
    deps.send({ t: 'error', message: 'invalid token' });
    deps.close();
    return 'invalid-token';
  }

  return {
    get visible() {
      return visible;
    },
    get token() {
      return token;
    },

    async identify(candidate) {
      const claims = deps.verifyToken(candidate);
      if (!claims) return reject();
      // Токен-вызов второго фактора сессию не открывает (P3-7): он только для /auth/login/totp.
      if (claims.typ === '2fa') return reject();

      const fetched = await deps.fetchVisible(candidate);
      // Отозванный токен: держать сокет открытым — значит раз в 20 секунд бить бэкенд мёртвым токеном.
      if (fetched.outcome === 'revoked') return reject();

      token = candidate;
      // Бэкенд недоступен именно в момент подключения — показать нечего в любом случае: сохранять
      // тут нечего, прежней видимости у этого сокета ещё не было. Снимок уйдёт пустой, а первое же
      // обновление через 20 секунд наполнит его.
      visible = fetched.outcome === 'ok' ? fetched.visible : new Set();
      deps.send(await deps.snapshot(visible));
      return 'ok';
    },

    /**
     * Права и каналы меняются посреди сессии — перечитать видимость и прислать снимок, ЕСЛИ состав
     * изменился (иначе каждые 20 секунд всем летел бы одинаковый снимок).
     */
    async refresh() {
      if (!token) return 'not-identified';
      const fetched = await deps.fetchVisible(token);
      if (fetched.outcome === 'revoked') {
        deps.close();
        return 'revoked';
      }
      // 🔴 Бэкенд не ответил — прежняя видимость остаётся лучшим, что у нас есть (#147). Затереть её
      // значит на всё время выкатки погасить человеку, кто где сидит и какие каналы заняты.
      if (fetched.outcome === 'unavailable') return 'unavailable';
      const changed = visibleChanged(visible, fetched.visible);
      visible = fetched.visible;
      if (!changed) return 'unchanged';
      deps.send(await deps.snapshot(visible));
      return 'changed';
    },
  };
}
