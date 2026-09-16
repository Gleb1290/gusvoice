/**
 * «Сколько времени прошло» словами — ОДНА функция на приложение.
 *
 * 🔴 Заведена 06.09 потому, что расчёт уже жил в двух местах: в журнале действий и в полоске о
 * прошлой аварии. Считали они почти одинаково, и Codex справедливо заметил, что границы у них
 * разъедутся при первой же правке. Плюс обе версии брали `Date.now()` внутри, из-за чего тест на
 * границу был бы недетерминированным.
 *
 * ⚠️ Решения по краям приняты явно, а не достались по недосмотру:
 * - **мусор и невалидная дата** — пустая строка, а не «Invalid Date». Подпись «2 мин назад» здесь
 *   украшение; сказать бессмыслицу хуже, чем не сказать ничего;
 * - **будущее** — тоже «только что». Часы у людей врут на минуты, и обещать «через 3 минуты» из-за
 *   расхождения часов глупее, чем округлить к настоящему моменту.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(at: number | string | null | undefined, now: number): string {
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const diff = now - ms;
  if (diff < MIN) return 'только что'; // сюда же попадает будущее — см. комментарий выше
  if (diff < HOUR) return `${Math.floor(diff / MIN)} мин назад`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} ч назад`;
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
