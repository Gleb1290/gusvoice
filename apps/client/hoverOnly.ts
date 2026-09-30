/**
 * `:hover` — только там, где наведение вообще бывает (#212, 28.09, проход по касаниям на S25).
 *
 * 🔴 **Повод.** На сенсорном экране наведения нет, но браузер эмулирует его: после касания элемент считается
 * «под курсором» до следующего касания в другом месте. Строка сообщения оставалась подсвеченной, кнопка эмодзи —
 * тёмным кругом после закрытия выбора, строка списка — «наведённой» после возврата назад. В стилях ~200 правил с
 * `:hover` и ни одного под `@media (hover: hover)`, и чинить их руками по одному — значит забыть двести первое.
 *
 * Решение — на сборке: каждое правило с `:hover` уезжает под `@media (hover: hover)` (так же делает Tailwind 4 со
 * своим `hover:`). Мышь и тачпад (основной указатель умеет наводить) — всё как было; телефон — подсветки нет.
 * ⚠️ «Основной» указатель, как и у Enter (`messagePaneRules.enterSends`): у S25 Ultra есть стилус, `any-hover`
 * у него истинно, а пальцем человек всё равно тыкает.
 * ⚠️ Если правило подсветкой что-то ПОКАЗЫВАЕТ (кнопку, подсказку), на телефоне оно перестаёт показывать —
 * такому месту нужна своя ветка `@media (hover: none)` или `.app.m-content …` (так уже сделаны `.att-dl`,
 * `.stage-expand`, `.msg-actions`).
 *
 * Чистые части (`splitHoverSelectors`, `insideHoverQuery`) — без PostCSS, чтобы их можно было проверить тестом;
 * сам плагин только гуляет по дереву.
 */

export const HOVER_MEDIA = '(hover: hover)';

/**
 * Разделить селекторы правила на те, что с наведением, и остальные.
 * ⚠️ Делим ПО СЕЛЕКТОРАМ, а не правило целиком: в `.att-img-wrap:hover .att-dl, .att-dl:focus-visible` вторая
 * половина — фокус с клавиатуры, и на телефоне с клавиатурой он нужен как был.
 */
export function splitHoverSelectors(selectors: readonly string[]): { hover: string[]; rest: string[] } {
  const hover: string[] = [];
  const rest: string[] = [];
  for (const s of selectors) (/:hover\b/.test(s) ? hover : rest).push(s);
  return { hover, rest };
}

/** Правило уже стоит под условием про наведение (`hover:` / `any-hover:`) — его писали осознанно, не трогаем. */
export function insideHoverQuery(mediaParams: readonly string[]): boolean {
  return mediaParams.some((p) => /hover\s*:/.test(p));
}

/** Ровно то, чем плагин пользуется из узлов PostCSS, — без зависимости от самого пакета. */
interface CssNode {
  type: string;
  name?: string;
  params?: string;
  parent?: CssNode;
}
interface CssRule extends CssNode {
  selectors: string[];
  clone(overrides?: { selectors?: string[] }): CssRule;
  after(node: unknown): unknown;
  remove(): unknown;
}
interface CssHelpers {
  AtRule: new (defaults: { name: string; params: string }) => { append(node: unknown): unknown };
}

export function hoverOnly() {
  return {
    postcssPlugin: 'gv-hover-only',
    Rule(rule: CssRule, { AtRule }: CssHelpers) {
      const media: string[] = [];
      for (let p = rule.parent; p; p = p.parent) {
        if (p.type !== 'atrule') continue;
        // Кадры анимации (`0%`, `to`) — не селекторы, наведения там не бывает.
        if (/keyframes$/i.test(p.name ?? '')) return;
        if (p.name === 'media') media.push(p.params ?? '');
      }
      // Копия ниже сама попадёт сюда же — и здесь остановится: она уже под `(hover: hover)`.
      if (insideHoverQuery(media)) return;
      const { hover, rest } = splitHoverSelectors(rule.selectors);
      if (!hover.length) return;
      // Копия встаёт СРАЗУ за исходным правилом: порядок в каскаде тот же, условие вес не меняет.
      const wrap = new AtRule({ name: 'media', params: HOVER_MEDIA });
      wrap.append(rule.clone({ selectors: hover }));
      rule.after(wrap);
      if (rest.length) rule.selectors = rest;
      else rule.remove();
    },
  };
}
hoverOnly.postcss = true as const;
