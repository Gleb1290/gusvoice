import { Goose } from './Goose';

/**
 * Аватар «Избранного» (08.10, #211, С6, G72): круг цвета акцента с закладкой вместо фото и буквы — Telegram рисует
 * `Ui::EmptyUserpic` «Saved Messages» (круг акцента, белая закладка). Размер кратен круглым аватарам списка: 40/48/28/36.
 * Закладка — контур Tabler `bookmark`, как остальные значки (`Icon.tsx`); своего значка в ядре дизайн-системы нет,
 * поэтому рисуется здесь, а не правкой `Icon`.
 */
export function SavedAvatar({ size = 40 }: { size?: number }) {
  return (
    <span className="avatar-saved" style={{ width: size, height: size, borderRadius: size / 2 }} role="img" aria-label="Избранное">
      <svg
        viewBox="0 0 24 24"
        width={Math.round(size * 0.5)}
        height={Math.round(size * 0.5)}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 7v14l-6-4-6 4V7a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4z" />
      </svg>
    </span>
  );
}

/**
 * Пустая лента «Избранного» (Telegram Web K: `ChatYourSelfTitle` + `ChatYourSelfDescription1–4`): что это за беседа и чем
 * полезна. Тот же гусь и те же классы `.empty-goose`, что у пустой ленты обычной беседы — свой вид не выдумываем.
 */
export function SavedEmpty() {
  return (
    <div className="empty-goose saved-empty">
      <Goose pose="head-sleepy" size={120} />
      <div className="eg-title">Ваше облачное хранилище</div>
      <ul className="eg-sub saved-empty-list">
        <li>Пересылайте сюда сообщения, чтобы сохранить их</li>
        <li>Отправляйте фото и файлы — они будут храниться здесь</li>
        <li>Беседа доступна на всех ваших устройствах</li>
        <li>Найти нужное поможет поиск</li>
      </ul>
    </div>
  );
}
