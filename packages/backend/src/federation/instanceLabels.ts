import { FED_FEATURES } from '@gusvoice/shared';
import { listLinks, listVouchedInstances, onVouchedChanged } from './links.js';
import { linkDisplayNames } from './linkRules.js';
import { readInstanceMeta } from './instanceMeta.js';

/**
 * Название и домен связанного инстанса — для значка «гость с «Друзья»» (#139, F4, §5.7).
 *
 * 🔴 **Кеш в памяти, а не запрос на каждого человека.** Значок нужен в РОСТЕРЕ: список участников
 * сервера сериализуется целиком и часто, и поход в базу за именем инстанса на каждую строку
 * превратил бы открытие сервера в десятки лишних запросов. Связки меняются руками держателя — раз
 * в недели, — поэтому минутной свежести тут с запасом.
 *
 * ⚠️ Чтение СИНХРОННОЕ намеренно: `serializeUser` и сборка ростера синхронные, и делать их
 * асинхронными ради подписи под ником значило бы переписать половину маршрутов. Кеш холодный
 * (первые секунды после старта) — отдаём голый `instanceId`: клиент покажет значок без названия, а
 * не соврёт именем.
 */

export interface InstanceLabel {
  instanceId: string;
  name: string | null;
  domain: string;
  /** Принимает ли сосед жалобы (§5.11) — по этому признаку клиент гасит галочку «Пожаловаться». */
  reports: boolean;
}

const TTL_MS = 60_000;
let cache = new Map<string, InstanceLabel>();
let filledAt = 0;
let filling: Promise<void> | null = null;

/** Перечитать связки, если кеш устарел. Зовётся из фона — ответа никто не ждёт. */
/** Слова хоста о чужих инстансах (Э7 часть 3); ошибка чтения не должна ронять подписи по связкам. */
function vouchedRows(): ReturnType<typeof listVouchedInstances> {
  return typeof listVouchedInstances === 'function' ? listVouchedInstances().catch(() => []) : Promise.resolve([]);
}

export function refreshInstanceLabels(): Promise<void> {
  if (filling) return filling;
  filling = Promise.all([listLinks(), readInstanceMeta(), vouchedRows()])
    .then(([links, meta, vouched]) => {
      // 🔴 Имя — через защиту от одноимённых (F-11): сосед, назвавшийся как мы или как другая связка,
      // получает в значке гостя имя с доменом, и подмена видна.
      const names = linkDisplayNames(links, meta.name);
      cache = new Map(
        links.map((l) => [
          l.instanceId,
          {
            instanceId: l.instanceId,
            name: names.get(l.instanceId) ?? null,
            domain: l.domain,
            reports: l.features.includes(FED_FEATURES.reports),
          },
        ]),
      );
      // Э7 часть 3 (D): инстансы без связки — со слов дома группы; связка старше. Имя, совпавшее с нашим или с именем связки, не берём.
      const taken = new Set([...names.values(), meta.name ?? ''].map((n) => (n ?? '').trim().toLowerCase()).filter(Boolean));
      for (const v of vouched) {
        if (cache.has(v.instanceId)) continue;
        const nm = v.name?.trim() ?? '';
        cache.set(v.instanceId, { instanceId: v.instanceId, name: nm && !taken.has(nm.toLowerCase()) ? nm : null, domain: v.domain, reports: false });
      }
      filledAt = Date.now();
    })
    .catch(() => {
      /* база недоступна — оставляем прежний кеш, значок переживёт */
    })
    .finally(() => {
      filling = null;
    });
  return filling;
}

/**
 * Подпись инстанса по его id. Никогда не `null` при заданном id: незнакомый инстанс — это связка,
 * которую только что завели или уже удалили, и человек всё равно ГОСТЬ, значок ему полагается.
 */
export function instanceLabel(instanceId: string): InstanceLabel {
  if (Date.now() - filledAt > TTL_MS) void refreshInstanceLabels();
  return cache.get(instanceId) ?? { instanceId, name: null, domain: '', reports: false };
}

/**
 * Инстанс по ДОМЕНУ — для упоминаний `@ник@домен` (§5.5).
 *
 * ⚠️ Сравнение без учёта регистра: домен человек пишет руками, и `@vasya@Voice.Friend.org` обязан
 * найтись так же, как строчный.
 */
export function instanceIdByDomain(domain: string): string | null {
  if (Date.now() - filledAt > TTL_MS) void refreshInstanceLabels();
  const want = domain.trim().toLowerCase();
  for (const label of cache.values()) {
    if (label.domain.toLowerCase() === want) return label.instanceId;
  }
  return null;
}

// Э7 часть 3 (D): дом группы назвал нам чужой инстанс (`links.saveVouchedInstance`) — подпись значка обновляется сразу, до сводки.
if (typeof onVouchedChanged === 'function') {
  onVouchedChanged(() => {
    filledAt = 0;
    return refreshInstanceLabels();
  });
}
