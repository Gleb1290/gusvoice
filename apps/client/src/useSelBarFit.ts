import { useLayoutEffect, type RefObject } from 'react';

/**
 * Панель выбора сообщений (`.composer.sel-bar`): подписи кнопок не должны обрезаться многоточием, при каком бы системном
 * кегле ни открыли приложение.
 *
 * Почему не хватает CSS (замер на S20+, WebView 111, `font_scale` 1.3, 09.10): Android-«textZoom» растит кегль текста
 * (`font-size: 15px` → вычисленные 19,5 px), а `em` в условиях `@container` считается от НЕрастянутого 15 px. Ширина панели
 * 347 px = 23 em, и порогов 22,5 / 20,5 em она не достигает, хотя три подписи с числом уже не помещаются. Из CSS кегль
 * после textZoom не прочитать, поэтому тесноту меряем по факту: у подписи с `text-overflow: ellipsis` `scrollWidth` больше
 * `clientWidth`, когда текст обрезан.
 *
 * Ступени (`data-fit`): без атрибута — как решил CSS (окно / контейнер); `n` — число «1» прячется (счёт и так в шапке «Выбрано
 * N»); `col` — значок над подписью, подпись переносится (те же правила, что `@container (max-width: 20.5em)`). Берётся
 * первая ступень, на которой ничего не обрезано.
 */
export function selBarCut(bar: HTMLElement): boolean {
  for (const label of Array.from(bar.querySelectorAll<HTMLElement>('.sel-bar-label'))) {
    if (label.scrollWidth > label.clientWidth) return true;
  }
  return false;
}

export function fitSelBar(bar: HTMLElement): void {
  bar.removeAttribute('data-fit');
  if (!selBarCut(bar)) return;
  bar.setAttribute('data-fit', 'n');
  if (!selBarCut(bar)) return;
  bar.setAttribute('data-fit', 'col');
}

/** Подгоняет панель при показе, смене подписей (`key`) и смене её ширины (поворот, клавиатура, масштаб окна). */
export function useSelBarFit(ref: RefObject<HTMLElement | null>, key: string): void {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return undefined;
    fitSelBar(bar);
    let width = bar.clientWidth;
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (bar.clientWidth === width) return;
        width = bar.clientWidth;
        fitSelBar(bar);
      });
      observer.observe(bar);
    }
    // Шрифт приложения мог догрузиться уже после первой подгонки — ширина подписей другая.
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive && bar.isConnected) fitSelBar(bar);
    });
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [ref, key]);
}
