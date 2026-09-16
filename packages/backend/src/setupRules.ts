/**
 * Чистые правила мастера первичной настройки и политики регистрации — БЕЗ env и базы (О2, #142).
 *
 * Как это выглядит для человека: `install.sh` печатает адрес и код установки → человек открывает
 * `https://voice.<домен>` → вводит код → создаёт супер-админа → проходит шаги (название, почта,
 * регистрация, первый сервер, проверка голоса). Решения и почему — `docs/open-source-plan.md` §3.1.1.
 *
 * 🔴 Главное правило: у уже работающего инстанса (прод, коробки у людей) не меняется НИЧЕГО. Нет записи
 * о политике — политика `open`, как было всегда; супер-админ пришёл не из мастера — мастера нет.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Ключи в `instance_settings` (та же таблица, что `smtp`, `economy`, `superadmin_user_id`). */
export const SETUP_KEY = 'setup';
export const REGISTRATION_KEY = 'registration';
export const INSTANCE_KEY = 'instance';

export const REGISTRATION_POLICIES = ['open', 'approval', 'invite'] as const;
export type RegistrationPolicy = (typeof REGISTRATION_POLICIES)[number];

/**
 * Политика из сохранённого значения. Нет значения или мусор → `open`.
 *
 * ⚠️ Мусор трактуем как «как было», а не как самое строгое: иначе битая запись у работающего инстанса
 * молча закрыла бы регистрацию всем. Строгую политику ставят осознанно — мастером или в админке.
 */
export function parseRegistrationPolicy(value: unknown): RegistrationPolicy {
  const p = (value as { policy?: unknown } | null | undefined)?.policy;
  return typeof p === 'string' && (REGISTRATION_POLICIES as readonly string[]).includes(p)
    ? (p as RegistrationPolicy)
    : 'open';
}

/** Код установки без оформления: регистр, пробелы и дефисы при вводе не важны. */
export function normalizeSetupToken(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** sha256 нормализованного кода — так гашёный код хранится в базе, а не сам код. */
export function hashSetupToken(raw: string): string {
  return createHash('sha256').update(normalizeSetupToken(raw)).digest('hex');
}

/**
 * Совпадает ли введённый код с кодом из `.env`. Сравнение в постоянное время по хешам: длина и
 * содержимое ввода не влияют на время ответа. Пустой код в `.env` не совпадает ни с чем.
 */
export function setupTokenMatches(given: string, expected: string): boolean {
  if (!normalizeSetupToken(expected) || !normalizeSetupToken(given)) return false;
  const a = createHash('sha256').update(normalizeSetupToken(given)).digest();
  const b = createHash('sha256').update(normalizeSetupToken(expected)).digest();
  return timingSafeEqual(a, b);
}

export type SetupAdminDecision = 'ok' | 'already-set-up' | 'no-token' | 'bad-token';

/**
 * Можно ли создать супер-админа мастером.
 *
 * Порядок проверок важен: привязанный супер-админ сильнее любого кода (иначе знающий старый код мог бы
 * «переустановить» живой инстанс); погашенный код не работает, даже если он всё ещё лежит в `.env`.
 */
export function decideSetupAdmin(input: {
  superAdminBound: boolean;
  expectedToken: string;
  givenToken: string;
  consumedTokenHash: string | null;
}): SetupAdminDecision {
  if (input.superAdminBound) return 'already-set-up';
  if (!normalizeSetupToken(input.expectedToken)) return 'no-token';
  if (input.consumedTokenHash && input.consumedTokenHash === hashSetupToken(input.expectedToken)) return 'bad-token';
  return setupTokenMatches(input.givenToken, input.expectedToken) ? 'ok' : 'bad-token';
}

/** Сохранённое состояние мастера (`instance_settings.setup`). */
export interface SetupState {
  adminCreatedAt: string | null;
  completedAt: string | null;
  consumedTokenHash: string | null;
}

export function parseSetupState(value: unknown): SetupState {
  const v = (value ?? {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
  return { adminCreatedAt: str(v.adminCreatedAt), completedAt: str(v.completedAt), consumedTokenHash: str(v.consumedTokenHash) };
}

/**
 * Показывать ли супер-админу шаги мастера после создания аккаунта. Только если админа создал САМ
 * мастер и мастер не завершён: у прода (супер-админ из `SUPERADMIN_*`) записи нет — мастера нет.
 */
export function wizardPending(state: SetupState, superAdminBound: boolean): boolean {
  return superAdminBound && !!state.adminCreatedAt && !state.completedAt;
}

export type InviteCheck = 'none' | 'valid' | 'invalid' | 'spent';

export type RegistrationDecision =
  | { ok: true; approved: boolean; emailCode: boolean }
  | { ok: false; status: 403 | 404 | 410; reason: 'invite_required' | 'invalid_invite' | 'invite_expired'; error: string };

/**
 * Можно ли зарегистрироваться и что дальше.
 *
 * - Код приглашения введён, но не подходит — отказ при любой политике: человек опечатался, пусть исправит.
 * - `invite` без кода — отказ.
 * - Одобрен сразу, если политика не `approval` (приглашение — уже одобрение того, кто пригласил).
 * - Письмо с кодом — если есть SMTP; без SMTP почту подтверждает админ, как и раньше.
 */
export function decideRegistration(input: {
  policy: RegistrationPolicy;
  smtpConfigured: boolean;
  invite: InviteCheck;
}): RegistrationDecision {
  if (input.invite === 'invalid') {
    return { ok: false, status: 404, reason: 'invalid_invite', error: 'Код приглашения не найден' };
  }
  if (input.invite === 'spent') {
    return { ok: false, status: 410, reason: 'invite_expired', error: 'Приглашение истекло или закончилось' };
  }
  if (input.policy === 'invite' && input.invite !== 'valid') {
    return {
      ok: false,
      status: 403,
      reason: 'invite_required',
      error: 'На этом сервере регистрация только по приглашению — попросите у друга код',
    };
  }
  return { ok: true, approved: input.policy !== 'approval', emailCode: input.smtpConfigured };
}

export const PENDING_APPROVAL_ERROR =
  'Аккаунт создан и ждёт одобрения администратора. Как только он одобрит — входите обычным логином и паролем.';

/**
 * Пускать ли в аккаунт. Почта проверяется первой: неподтверждённому сначала нужен код, и только потом
 * имеет смысл говорить про одобрение.
 */
export function loginGate(u: { verified: boolean; approvedAt: Date | null }): 'ok' | 'email_not_verified' | 'pending_approval' {
  if (!u.verified) return 'email_not_verified';
  if (!u.approvedAt) return 'pending_approval';
  return 'ok';
}

/** Название инстанса: обрезанное, без управляющих символов, 1–64 знака; иначе `null`. */
export function cleanInstanceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[ -]/g, '').trim();
  return s.length >= 1 && s.length <= 64 ? s : null;
}

/** Сохранённые название и иконка (`instance_settings.instance`); мусор → пусто. */
export function parseInstanceMeta(value: unknown): { name: string | null; iconUrl: string | null } {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    name: cleanInstanceName(v.name),
    iconUrl: typeof v.iconUrl === 'string' && v.iconUrl ? v.iconUrl : null,
  };
}
