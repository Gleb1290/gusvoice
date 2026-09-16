/**
 * Разбор и сохранение аварии интерфейса — то, что показывает и запоминает `ErrorBoundary`.
 *
 * 🔴 **Зачем вообще.** До 05.09 в клиенте не было ни одной границы ошибок: исключение при отрисовке
 * ЛЮБОГО компонента сносило всё дерево React. Человек получал голый фон, вылетал из голоса вместе с
 * размонтированным `VoiceConnection` — и ни строчки объяснения ни ему, ни мне. Молча гаснущий
 * интерфейс неотличим от зависшего приложения, и именно так его и описывают в жалобах.
 *
 * 🔴 **Текст аварии переживает перезагрузку.** Первое, что делает человек на экране ошибки, — жмёт
 * «Перезагрузить», и вместе со страницей исчезает единственный экземпляр стека. Поэтому авария
 * пишется в хранилище ДО того, как показана, и её можно достать потом.
 *
 * ⚠️ Хранилище тут — параметр, а не глобальный `localStorage`: в окне оверлея и в тестах он либо
 * недоступен, либо бросает (приватный режим, отключённые данные сайта). Всё общение с ним обёрнуто.
 */

/** Разобранная авария — ровно то, что показывается человеку и уезжает мне. */
export interface CrashReport {
  /** Время в миллисекундах — сравнивать с версией и логами. */
  at: number;
  /** Первая строка: «TypeError: Cannot read properties of undefined…». */
  message: string;
  /** Стек JS. Обрезан: в хранилище нельзя класть неограниченное. */
  stack: string;
  /** Стек компонентов React — говорит, ГДЕ в интерфейсе рвануло, чего стек JS часто не говорит. */
  component: string;
  /** Строка браузера: в десктопе это версия WebView2, а она у людей разная. */
  ua: string;
}

/** Ключ в хранилище. Один: нужна ПОСЛЕДНЯЯ авария, история тут ничего не добавляет. */
export const CRASH_KEY = 'gv_last_crash';

/** Потолок стека JS. Хватает на полсотни кадров — глубже смотреть всё равно нечего. */
export const STACK_MAX = 4000;
/** Потолок стека компонентов: он длиннее и полезен только верхушкой. */
export const COMPONENT_MAX = 2000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…обрезано`;
}

/**
 * Привести брошенное к разобранному виду.
 *
 * ⚠️ Бросить в JS можно ЧТО УГОДНО, не только `Error`: строку, объект, `undefined`. Поэтому здесь
 * нет ни одного обращения к `err.message` без проверки — иначе разбор аварии сам бы падал, а это
 * худший из возможных отказов: он прячет исходную ошибку.
 */
export function describeCrash(
  err: unknown,
  componentStack: string | null | undefined,
  now: number,
  ua: string,
): CrashReport {
  let message: string;
  let stack = '';
  // 🔴 Всё чтение брошенного — под `try` (находка Codex). Бросить можно ЧТО УГОДНО, в том числе
  // объект, у которого `message` — геттер, а геттер может сам бросить. Тогда разбор аварии падал
  // ровно там, где обязан был её описать, и настоящая причина терялась: человек видел «getter
  // boom» вместо своей поломки. Даже `err.stack` у Error бывает с ловушкой.
  try {
    if (err instanceof Error) {
      message = err.message ? `${err.name}: ${err.message}` : err.name;
      stack = err.stack ?? '';
    } else if (typeof err === 'string') {
      message = err;
    } else if (err && typeof err === 'object') {
      // Объект без прототипа Error: показываем его сериализацию, а не бесполезное «[object Object]».
      const m = (err as { message?: unknown }).message;
      message = typeof m === 'string' && m ? m : safeJson(err);
    } else {
      message = String(err);
    }
  } catch {
    // Само описание не удалось — но авария была, и молчать о ней нельзя.
    message = 'Ошибка, которую не удалось прочитать';
  }
  return {
    at: now,
    message: clip(message || 'Неизвестная ошибка', 500),
    stack: clip(stack, STACK_MAX),
    component: clip(componentStack ?? '', COMPONENT_MAX),
    ua,
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    // Циклическая ссылка — обычное дело у объектов React и WebRTC.
    return String(v);
  }
}

/** Текст для буфера обмена: человек не перепишет стек руками, он его копирует и присылает. */
export function crashText(r: CrashReport): string {
  const when = new Date(r.at).toISOString();
  return [
    `GusVoice — авария интерфейса`,
    `Время: ${when}`,
    `Ошибка: ${r.message}`,
    `Браузер: ${r.ua}`,
    '',
    'Стек:',
    r.stack || '(нет)',
    '',
    'Компоненты:',
    r.component || '(нет)',
  ].join('\n');
}

/** Минимальная часть `Storage`, которая тут нужна. Так функции проверяются без браузера. */
export interface CrashStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Сохранить аварию.
 *
 * ⚠️ Никогда не бросает. Хранилище может отказать (переполнено, выключено, приватный режим), и
 * падение ЗДЕСЬ означало бы, что экран ошибки не покажется вовсе — то есть ровно тот молчаливый
 * чёрный экран, ради которого всё это и написано.
 */
export function saveCrash(store: CrashStore | null | undefined, r: CrashReport): boolean {
  if (!store) return false;
  try {
    store.setItem(CRASH_KEY, JSON.stringify(r));
    return true;
  } catch {
    return false;
  }
}

/**
 * Годится ли число как отметка времени: `Date` принимает не любое конечное число, а только
 * ±8 640 000 000 000 000 мс (±273 тысячи лет). Всё, что дальше, даёт «Invalid Date».
 */
const DATE_MAX_MS = 8_640_000_000_000_000;
function isDateSafe(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= DATE_MAX_MS;
}

/** Прочитать последнюю аварию. Мусор в хранилище — это `null`, а не исключение. */
export function readCrash(store: CrashStore | null | undefined): CrashReport | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(CRASH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CrashReport> | null;
    if (!v || typeof v !== 'object' || typeof v.message !== 'string') return null;
    return {
      // ⚠️ Проверяем ГОДНОСТЬ ДЛЯ ДАТЫ, а не просто «число» и не просто «конечное».
      // Две находки Codex подряд: `1e309` даёт бесконечность (проходит проверку типа), а `1e16` —
      // обычное конечное число, которое всё равно вне диапазона `Date`. И то и другое роняло
      // `crashText` с `RangeError`, то есть отчёт об аварии сам становился аварией.
      at: isDateSafe(v.at) ? (v.at as number) : 0,
      message: v.message,
      stack: typeof v.stack === 'string' ? v.stack : '',
      component: typeof v.component === 'string' ? v.component : '',
      ua: typeof v.ua === 'string' ? v.ua : '',
    };
  } catch {
    return null;
  }
}

/**
 * Отдать человеку сохранённый отчёт: скопировать и забыть.
 *
 * ⚠️ Забываем ТОЛЬКО после успешного копирования (просьба Codex вынести это под тест). Отказ
 * буфера обмена — обычное дело в браузере без фокуса или без разрешения, и потерять единственную
 * улику из-за него нельзя: человеку тогда нечего будет прислать.
 */
export async function copySavedCrash(
  r: CrashReport,
  io: { writeText: (s: string) => Promise<void>; clear: () => void },
): Promise<boolean> {
  try {
    await io.writeText(crashText(r));
  } catch {
    return false;
  }
  io.clear();
  return true;
}

/** Забыть последнюю аварию — после того, как её забрали. */
export function clearCrash(store: CrashStore | null | undefined): void {
  try {
    store?.removeItem(CRASH_KEY);
  } catch {
    /* хранилище может отказать — это не повод падать */
  }
}
