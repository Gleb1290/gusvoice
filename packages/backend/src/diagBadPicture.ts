/**
 * Отметка «Плохая картинка» от ЗРИТЕЛЯ (06.10, #207) — ЧИСТАЯ схема: только zod.
 *
 * Зритель нажимает пункт в меню качества показа; клиент (`badPictureRules.ts`) снимает статистику
 * приёма за 2 секунды после нажатия и шлёт её на тот же `POST /diag/report` с `kind: 'badpic'`. Кладём
 * в `diag_reports` рядом со срезами показывающего: строка зрителя (`user_id` — зритель), в ней — кто
 * показывал. Сводит обе стороны `scripts/ops/bad-picture.sh` (окружающие срезы показывающего и зрителя).
 *
 * ⚠️ Только числа приёма и идентификаторы: ни кадров, ни текста от человека — поле для комментария
 * не заводим сознательно, чтобы в базу диагностики не поехали личные слова.
 * ⚠️ Строки — с обрезкой, а не с отказом (урок `cappedString` в `diagSchema.ts`): длинное имя
 * декодера не должно стоить всей отметки.
 */
import { z } from 'zod';

const capped = (max: number) => z.string().transform((s) => s.slice(0, max));
const n = z.number().finite();

const Snap = z.object({
  w: n,
  h: n,
  fps: n,
  framesDecoded: n,
  keyFramesDecoded: n,
  framesDropped: n,
  qpSum: n,
  hasQp: z.boolean(),
  bytes: n,
  packetsReceived: n,
  packetsLost: n,
  nack: n,
  pli: n,
  fir: n,
  freezes: n,
  freezeS: n,
  pauses: n,
  pauseS: n,
  jitterMs: n,
  jbDelayS: n,
  jbEmitted: n,
  decodeS: n,
  decoder: capped(48),
  codec: capped(32),
  rttMs: n,
  availInKbps: n,
});

const Window = z.object({
  ms: n,
  kbps: n,
  fps: n,
  qp: n.nullable(),
  lossPct: n,
  nack: n,
  pli: n,
  freezes: n,
  freezeMs: n,
  dropped: n,
  keyFrames: n,
  jbMs: n,
});

const BadPicture = z.object({
  kind: z.literal('badpic'),
  at: n,
  sharer: z.object({ identity: capped(128), userId: capped(64), native: z.boolean() }),
  channelId: capped(64).nullable(),
  viewer: z.object({ platform: z.enum(['desktop', 'android', 'web']), version: capped(32) }),
  want: capped(8),
  layer: capped(8),
  layers: z.array(z.object({ w: n, h: n })).max(4),
  win: Window.nullable(),
  now: Snap,
});

export type BadPictureReport = z.infer<typeof BadPicture>;

/** Это отметка «Плохая картинка», а не срезы показа? По сырому телу, до разбора. */
export function isBadPictureBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'badpic';
}

/** Разобрать отметку. `null` — тело не подходит (роут отвечает 400). */
export function parseBadPicture(body: unknown): BadPictureReport | null {
  const r = BadPicture.safeParse(body);
  return r.success ? r.data : null;
}

/**
 * Сколько отметок человек может прислать за час. Кнопка на клиенте и так не чаще раза в 20 с, а это —
 * потолок на случай, если кто-то будет слать руками: база диагностики не должна пухнуть от одного.
 */
export const BAD_PICTURE_PER_HOUR = 30;
