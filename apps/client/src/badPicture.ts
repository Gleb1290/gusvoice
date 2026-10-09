/**
 * «Плохая картинка» у зрителя (06.10, #207): отметить момент и отправить статистику приёма. Правила —
 * `badPictureRules.ts`; здесь только LiveKit, таймер, сеть и тосты.
 *
 * ⚠️ Отправка — разовая, по нажатию, и только числа приёма (без кадров, без системы): поэтому не ждём
 * общего согласия на диагностику (#113) — нажатие и есть согласие на эту одну отметку. Кнопку же
 * показываем только там, где инстанс принимает диагностику (`diagVisible`), иначе маршрута нет.
 */
import type { RemoteTrackPublication } from 'livekit-client';
import {
  BAD_PICTURE_COOLDOWN_MS,
  BAD_PICTURE_WINDOW_MS,
  buildBadPictureReport,
  inboundSnapshot,
  type InboundSnap,
} from './badPictureRules';
import { config } from './config';
import { appVersion } from './desktopWindow';
import { diagVisible } from './diagVisible';
import { isAndroid, isDesktop } from './hotkeys';
import { useStore, voiceApiOf } from './store';
import { toast } from './toast';

let lastAt = 0;

/** Показывать ли пункт «Плохая картинка»: только там, где инстанс принимает диагностику (иначе маршрута нет). */
export function useBadPictureAvailable(): boolean {
  const preview = useStore((s) => s.user?.diagPreview);
  return diagVisible(preview, config.diagEnabled);
}

async function snap(pub: RemoteTrackPublication): Promise<InboundSnap | null> {
  try {
    const report = await pub.videoTrack?.getRTCStatsReport();
    if (!report) return null;
    const entries: Record<string, unknown>[] = [];
    report.forEach((r: unknown) => entries.push(r as Record<string, unknown>));
    return inboundSnapshot(entries, Date.now());
  } catch {
    return null;
  }
}

/**
 * Отметить «плохую картинку» у этого показа. `identity` — участник, который показывает (`<id>#screen` у
 * нативного показа), `want` — что зритель выбрал в меню качества.
 */
export async function reportBadPicture(pub: RemoteTrackPublication | undefined, identity: string, want: string): Promise<void> {
  const now = Date.now();
  if (now - lastAt < BAD_PICTURE_COOLDOWN_MS) {
    toast('info', 'Уже отмечено', 'Одной отметки на момент достаточно — статистика этих секунд уже ушла.');
    return;
  }
  if (!pub?.videoTrack) {
    toast('warn', 'Не отмечено', 'Картинка показа ещё не пришла — отметить нечего.');
    return;
  }
  lastAt = now;
  toast('info', 'Отмечаем момент', 'Пару секунд собираем статистику приёма…');
  const a = await snap(pub);
  await new Promise((r) => setTimeout(r, BAD_PICTURE_WINDOW_MS));
  const b = await snap(pub);
  if (!b) {
    toast('warn', 'Не отмечено', 'Браузер не отдал статистику приёма.');
    return;
  }
  const voice = useStore.getState().voice;
  const body = buildBadPictureReport({
    at: now,
    identity,
    channelId: voice?.channelId ?? null,
    platform: isDesktop() ? 'desktop' : isAndroid() ? 'android' : 'web',
    version: (await appVersion()) ?? 'web',
    want,
    layers: pub.trackInfo?.layers,
    a,
    b,
  });
  try {
    // В инстанс ГОЛОСА: показ идёт там, и срезы показывающего лежат там же.
    await voiceApiOf(voice).sendDiagReport(body);
    toast('info', 'Отмечено', 'Момент и статистика приёма отправлены — разберём вместе со статистикой показывающего.');
  } catch {
    lastAt = 0; // не ушло — пусть можно будет нажать снова
    toast('warn', 'Не отправлено', 'Сервер не принял отметку. Попробуйте ещё раз чуть позже.');
  }
}
