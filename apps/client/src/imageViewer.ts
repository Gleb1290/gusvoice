/**
 * Одна картинка, открытая на весь экран, — просмотрщик уровня приложения.
 *
 * Вложения в чате открывает `MessagePane` собственным `Lightbox`: там есть весь набор картинок
 * вида, переходы между ними и лента миниатюр. Аватар в карточке профиля — другой случай: картинка
 * ровно одна, а карточка живёт в контекстном меню, которое закрывается по клику МИМО себя. Отрисуй
 * просмотрщик внутри карточки — первый же клик по нему считался бы кликом снаружи меню, меню
 * закрылось бы и утащило картинку за собой.
 *
 * Поэтому картинка живёт выше: стор здесь, единственный `ImageViewerHost` — у корня приложения.
 * Карточка может исчезнуть, картинка останется.
 */
import { create } from 'zustand';

export interface ViewedImage {
  url: string;
  /** Заголовок сверху — имя человека для аватара. */
  name: string;
  /** Подпись под заголовком («Аватар»). */
  sub?: string;
}

interface ImageViewerState {
  image: ViewedImage | null;
  open: (image: ViewedImage) => void;
  close: () => void;
}

export const useImageViewer = create<ImageViewerState>((set) => ({
  image: null,
  open: (image) => set({ image }),
  close: () => set({ image: null }),
}));

/** Открыть картинку на весь экран откуда угодно (компонент или нет). */
export function viewImage(image: ViewedImage): void {
  useImageViewer.getState().open(image);
}

/** Открыт ли просмотрщик прямо сейчас — для тех, кто обязан уступить ему Esc и клик мимо. */
export function useImageViewerOpen(): boolean {
  return useImageViewer((s) => s.image !== null);
}
