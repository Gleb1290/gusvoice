/**
 * Код связки — как два держателя договариваются, что их инстансы доверяют друг другу (#139, F1, §5.1).
 *
 * Почему код, а не сверка отпечатка глазами: на сверке длинных отпечатков люди ошибаются — смотрят
 * первые и последние символы, середину пропускают. Тем же путём пошли Syncthing и Tailscale. Держатель A
 * создаёт код и передаёт его держателю B **вне приложения** (мессенджер, голос, лично), B вставляет —
 * и приложение само знает, к какому домену идти и какой ключ там обязан оказаться.
 *
 * Что внутри кода: домен инстанса A, отпечаток его корневого ключа и одноразовый секрет. Первые два —
 * чтобы B пришёл туда, куда надо, и узнал ключ; секрет — доказательство, что заявка пришла от того,
 * кому A этот код дал, а не от случайного прохожего, узнавшего домен.
 *
 * 🔴 Секрет у себя мы храним ТОЛЬКО хешем (`hashLinkSecret`), как пароль: дамп базы не должен давать
 * возможность завести связку от нашего имени.
 *
 * Здесь чистые правила — ни базы, ни часов, ни сети.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Lower } from './instanceIdentity.js';

/** Префикс, по которому код узнаётся при вставке, и версия формата. */
export const LINK_CODE_PREFIX = 'GVLINK1';

/** Сколько живёт код (план §5.1: 24 часа). */
export const LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** 160 бит случайности: подобрать за сутки невозможно, а строка остаётся терпимой для пересылки. */
const SECRET_BYTES = 20;

export interface LinkCodePayload {
  /** Домен инстанса, который выдал код, — по нему человек узнаёт, с кем связывается. */
  domain: string;
  /**
   * Адрес API выдавшего — туда вторая сторона идёт за визиткой.
   *
   * 🔴 Отдельно от `domain`, потому что у GusVoice веб и API живут на РАЗНЫХ хостах
   * (`voice.example` и `api.voice.example`) — так делает и коробка «под ключ». Раньше визитку
   * искали по `https://<domain>`, то есть стучались в веб-клиент и получали HTML вместо JSON:
   * связка не заводилась НИ НА ОДНОМ развёрнутом инстансе (#151).
   *
   * Необязательное: код без него разбирается по-старому (правило совместимости — только добавления).
   */
  apiBase?: string;
  /** Отпечаток корневого ключа выдавшего: сверяется с тем, что реально отдаст его документ. */
  fingerprint: string;
  /** Одноразовый секрет. У выдавшего хранится только хеш. */
  secret: string;
  /** Когда код перестаёт действовать, миллисекунды эпохи. */
  expiresAt: number;
  /** `link` — обычная связка, `rebind` — перепривязка после потери или кражи ключа (§5.1.3). */
  purpose: 'link' | 'rebind';
  /** Для перепривязки: какой `instance_id` был раньше, чтобы сосед нашёл у себя старую связку. */
  previousInstanceId?: string;
}

/** Свежий секрет для нового кода. */
export function newLinkSecret(): string {
  return base32Lower(randomBytes(SECRET_BYTES));
}

/**
 * Хеш секрета для хранения.
 *
 * Без «соли» и медленных функций намеренно: секрет не выбирает человек, в нём 160 бит случайности,
 * перебирать нечего. Медленный хеш здесь дал бы только ложное чувство основательности.
 */
export function hashLinkSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/**
 * Сверка секрета с хранимым хешем — постоянным временем.
 *
 * Обычное `===` на строках выходит раньше на первом же несовпавшем символе, и по времени ответа
 * секрет подбирается посимвольно.
 */
export function linkSecretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashLinkSecret(secret), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Собрать код для передачи человеку. */
export function encodeLinkCode(payload: LinkCodePayload): string {
  const body = {
    d: payload.domain,
    a: payload.apiBase,
    f: payload.fingerprint,
    s: payload.secret,
    e: payload.expiresAt,
    p: payload.purpose,
    ...(payload.previousInstanceId ? { o: payload.previousInstanceId } : {}),
  };
  return `${LINK_CODE_PREFIX}:${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`;
}

/**
 * Разобрать вставленный код.
 *
 * ⚠️ Терпимость к тому, КАК человек его вставил (пробелы, перенос строки, лишний текст вокруг —
 * мессенджеры любят добавлять своё), и полная нетерпимость к содержимому: не разобралось или не
 * хватает поля — `null`, а не объект с дырками. Дальше по этому объекту устанавливается доверие.
 */
export function decodeLinkCode(raw: string): LinkCodePayload | null {
  const match = new RegExp(`${LINK_CODE_PREFIX}:([A-Za-z0-9_-]+)`).exec(raw.trim());
  if (!match) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const domain = typeof body.d === 'string' ? body.d : null;
  const fingerprint = typeof body.f === 'string' ? body.f : null;
  const secret = typeof body.s === 'string' ? body.s : null;
  const expiresAt = typeof body.e === 'number' && Number.isFinite(body.e) ? body.e : null;
  const purpose = body.p === 'rebind' ? 'rebind' : body.p === 'link' ? 'link' : null;
  if (!domain || !fingerprint || !secret || expiresAt === null || !purpose) return null;
  return {
    domain,
    fingerprint,
    secret,
    expiresAt,
    purpose,
    // Нет поля — код от инстанса прежней версии: разбираем без него, дальше сработает запасной путь.
    ...(typeof body.a === 'string' ? { apiBase: body.a } : {}),
    ...(typeof body.o === 'string' ? { previousInstanceId: body.o } : {}),
  };
}

export type LinkCodeProblem = 'expired' | 'self' | 'fingerprint-mismatch';

/**
 * Можно ли пустить этот код в дело.
 *
 * 🔴 `fingerprint-mismatch` — главная проверка всей связки: документ забирается по домену ИЗ кода, и
 * если ключ там не тот, что держатель записал в код, значит между нами кто-то встал (перехваченный
 * домен, поддельный ответ) либо код от другого инстанса. Молча продолжать нельзя ни в одном случае.
 * 🔴 `self` — связка с самим собой не безобидна: инстанс стал бы соседом себе, и дальше по всем
 * правилам «чужой» пошёл бы он сам.
 */
export function checkLinkCode(
  code: LinkCodePayload,
  ctx: { now: number; myInstanceId: string; theirFingerprint: string; theirInstanceId: string },
): LinkCodeProblem | null {
  if (code.expiresAt <= ctx.now) return 'expired';
  if (ctx.theirInstanceId === ctx.myInstanceId) return 'self';
  if (code.fingerprint !== ctx.theirFingerprint) return 'fingerprint-mismatch';
  return null;
}
