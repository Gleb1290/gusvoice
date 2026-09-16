// Импорт из emojiAliases, а НЕ из emojiShortcodes: последний сам тянет этот модуль, и цикл
// сломал бы инициализацию (ALIASES читается на верхнем уровне, до присваивания).
import { EMOJI_SHORTCODES } from './emojiAliases';
import { type Emoji, mergeAliases, rankEmoji, stripVs } from './emojiSearch';

/**
 * Полная таблица эмодзи — ЛЕНИВО (#68).
 *
 * 1914 эмодзи с русскими названиями весят ~200 КБ исходником. Класть их в стартовый бандл ради
 * пикера, который открывают не в каждой сессии, — плохой размен: чат должен открываться быстро.
 * Поэтому таблица живёт отдельным чанком и подтягивается при первом обращении к пикеру или
 * к автодополнению `:код:`.
 *
 * До загрузки поиск работает по рукописному набору (~200 штук с русскими алиасами) — то есть
 * самые ходовые эмодзи находятся МГНОВЕННО, ещё до сетевого запроса. Полный набор просто
 * расширяет выдачу, когда приедет.
 */

/** Рукописные алиасы: эмодзи → коды. Приоритетны над английскими из датасета. */
const ALIASES = new Map(EMOJI_SHORTCODES.map((e) => [stripVs(e.emoji), e.codes]));

/** Запасной набор до загрузки таблицы: то же, что было раньше, без групп и тегов. */
const FALLBACK: Emoji[] = EMOJI_SHORTCODES.map((e) => ({
  emoji: e.emoji,
  label: e.codes[0],
  group: 0,
  tags: [],
  codes: e.codes,
}));

export type EmojiIndex = {
  groups: string[];
  all: Emoji[];
  /** Эмодзи по группам, в порядке групп. */
  byGroup: Emoji[][];
};

let cache: EmojiIndex | null = null;
let inflight: Promise<EmojiIndex> | null = null;

/** Уже загруженная таблица или null. Для синхронных мест, которым нельзя ждать. */
export function loadedIndex(): EmojiIndex | null {
  return cache;
}

/** Загрузить таблицу (идемпотентно, параллельные вызовы делят один запрос). */
export function loadEmojiIndex(): Promise<EmojiIndex> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = import('./emojiData')
    .then((m) => {
      const all = mergeAliases(
        m.EMOJI_DATA.map(([emoji, label, group, tags, codes, skins]) => ({
          emoji,
          label,
          group,
          tags,
          codes,
          ...(skins ? { skins } : {}),
        })),
        ALIASES,
      );
      const byGroup = m.EMOJI_GROUPS.map((_, i) => all.filter((e) => e.group === i));
      cache = { groups: m.EMOJI_GROUPS, all, byGroup };
      return cache;
    })
    .catch((e) => {
      // Не кэшируем провал: сеть могла моргнуть, следующая попытка должна пойти заново.
      inflight = null;
      throw e;
    });
  return inflight;
}

/**
 * Поиск по тому, что доступно ПРЯМО СЕЙЧАС, плюс фоновая догрузка полной таблицы.
 *
 * Возвращает синхронно — потому что вызывается из обработчика ввода: ждать сеть, пока человек
 * печатает, значит показывать пустой список на каждое нажатие. Как только таблица приедет,
 * следующий же вызов отдаст полную выдачу.
 */
export function searchEmojiNow(query: string, limit = 40): Emoji[] {
  void loadEmojiIndex().catch(() => {});
  return rankEmoji(cache?.all ?? FALLBACK, query, limit);
}
