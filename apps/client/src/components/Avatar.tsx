/**
 * Renders an avatar image when available, otherwise a fallback:
 *  - `fallback="letter"` (default): a coloured initial circle.
 *  - `fallback="icon"`: a grey person silhouette (matches the voice stage placeholder).
 *
 * 🔴 **Анимация (#117) показывается ВСЕГДА и всем, кому её передали (решение 01.09).**
 * Первая версия крутила её только по наведению — из осторожности к слабым машинам. Решение
 * развернули, и по сути верно: человек, купивший движущийся аватар, покупал его чтобы его видели,
 * а не чтобы на него наводили мышь.
 *
 * ⚠️ Решение «показывать ли» принимается НЕ здесь, а у вызывающего: `animatedUrl` приходит из
 * `useAnimatedAvatarUrl`, и при выключенной у зрителя настройке он просто `undefined` — то есть
 * компонент даже не узнаёт про ссылку и не грузит её. Выключатель обязан экономить трафик, а не
 * только прятать движение.
 *
 * ⚠️ В ОВЕРЛЕЕ анимации нет: он висит поверх чужой игры, и движущаяся аватарка там — помеха
 * человеку в бою. Граница держится структурно — оверлей просто не передаёт `animatedUrl`.
 */
export function Avatar({
  url,
  animatedUrl,
  name,
  size = 38,
  fallback = 'letter',
}: {
  url?: string | null;
  /** Анимация. Не передана — обычное поведение, как и было. */
  animatedUrl?: string | null;
  name: string;
  size?: number;
  fallback?: 'letter' | 'icon';
}) {
  const style: React.CSSProperties = { width: size, height: size, borderRadius: size / 2, flex: '0 0 auto' };
  // Анимация ПОВЕРХ обычной: если её не окажется (файл удалён, сеть отвалилась), браузер покажет
  // сломанную картинку — поэтому `url` остаётся запасным на случай, когда анимации нет вовсе.
  const src = animatedUrl || url;
  if (src) return <img className="avatar-img" style={style} src={src} alt={name} />;
  if (fallback === 'icon') {
    return (
      <span className="avatar-icon" style={style} role="img" aria-label={name}>
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="9" r="4" />
          <path d="M4 20c0-3.6 3.6-5.6 8-5.6s8 2 8 5.6z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="avatar-letter" style={{ ...style, fontSize: Math.round(size * 0.42) }}>
      {name[0]?.toUpperCase()}
    </span>
  );
}
