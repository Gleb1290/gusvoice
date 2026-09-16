import { checkAnimatedAvatar, isAnimatedImage } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { allActivities, clearActivity, setActivity } from '../activity.js';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { broadcastUserProfile, broadcastUserStatus } from '../gateway.js';
import { getVisibleVoiceChannelIds } from '../permissions.js';
import { publishToUser } from '../realtime.js';
import { serializeUser } from '../serialize.js';
import { isSupportedImage, uploadAvatar } from '../storage.js';
import { avatarRentalActive } from '../shopRules.js';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Voice channels the caller may VIEW — the presence service calls this (with the user's
  // own token) to filter who-is-where so private channels don't leak.
  app.get('/me/voice-visibility', async (req) => {
    return { channelIds: await getVisibleVoiceChannelIds(req.user!.sub) };
  });

  // Update own profile: display name and/or the "show my game activity" master switch (#40).
  app.patch('/users/me', async (req) => {
    const body = z
      .object({
        displayName: z.string().min(1).max(64).optional(),
        showGameActivity: z.boolean().optional(),
        // Только `true`: «развидеть» приветствие экономики нельзя, оно и так открывается из кошелька.
        economyWelcomeSeen: z.literal(true).optional(),
      })
      .parse(req.body);
    const patch: Partial<{ displayName: string; showGameActivity: boolean; economyWelcomeSeenAt: Date }> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.showGameActivity !== undefined) patch.showGameActivity = body.showGameActivity;
    if (body.economyWelcomeSeen) patch.economyWelcomeSeenAt = new Date();
    const [row] = Object.keys(patch).length
      ? await db.update(users).set(patch).where(eq(users.id, req.user!.sub)).returning()
      : await db.select().from(users).where(eq(users.id, req.user!.sub));
    const serialized = serializeUser(row);
    // Turning game activity OFF clears any game we're currently showing (both sources) for everyone.
    if (body.showGameActivity === false) clearActivity(req.user!.sub);
    // Tell every client about the new name so member lists / chat authors update live (no re-login).
    broadcastUserProfile(serialized.id, serialized.displayName, serialized.avatarUrl, serialized.animatedAvatarUrl);
    return serialized;
  });

  // Set presence state and/or custom status (P2). `customStatus: null` clears it; an object sets
  // emoji/text with an optional auto-clear (clearAfterMinutes). Broadcasts so every client updates
  // the colored dot + custom-status line.
  app.patch('/users/me/status', async (req) => {
    const body = z
      .object({
        status: z.enum(['online', 'dnd', 'away', 'invisible']).optional(),
        /**
         * Смену делает автоматика (авто-«отошёл»), а не человек. Умолчание `false` — то есть любой
         * запрос БЕЗ этого поля считается ручным и снимает признак.
         *
         * 🔴 Так и задумано: ручной статус — это заявление, и после него автоматика теряет право
         * его перетирать. Признак хранится здесь, а не у клиента, потому что статус общий для всех
         * его клиентов: иначе снять авто-«отошёл» может только тот клиент, который его поставил
         * (#118).
         */
        auto: z.boolean().optional(),
        customStatus: z
          .object({
            emoji: z.string().max(16).nullable().optional(),
            text: z.string().max(128).nullable().optional(),
            clearAfterMinutes: z.number().int().positive().max(7 * 24 * 60).nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .parse(req.body);

    const patch: Partial<{
      presenceStatus: string;
      presenceAuto: boolean;
      customStatusEmoji: string | null;
      customStatusText: string | null;
      customStatusExpiresAt: Date | null;
    }> = {};
    if (body.status !== undefined) {
      patch.presenceStatus = body.status;
      // Одним UPDATE со статусом: разъехаться им негде. Прежняя схема ставила клиентский признак ДО
      // сетевого вызова и глотала его ошибку — упавший запрос оставлял «мы увели» при статусе
      // `online`, и авто-«отошёл» в том клиенте умирал насовсем (#118).
      patch.presenceAuto = body.auto === true;
    }
    if (body.customStatus !== undefined) {
      if (body.customStatus === null) {
        patch.customStatusEmoji = null;
        patch.customStatusText = null;
        patch.customStatusExpiresAt = null;
      } else {
        const emoji = body.customStatus.emoji?.trim() || null;
        const text = body.customStatus.text?.trim() || null;
        patch.customStatusEmoji = emoji;
        patch.customStatusText = text;
        patch.customStatusExpiresAt =
          body.customStatus.clearAfterMinutes != null && (emoji || text)
            ? new Date(Date.now() + body.customStatus.clearAfterMinutes * 60_000)
            : null;
      }
    }

    const [row] =
      Object.keys(patch).length > 0
        ? await db.update(users).set(patch).where(eq(users.id, req.user!.sub)).returning()
        : await db.select().from(users).where(eq(users.id, req.user!.sub));
    const serialized = serializeUser(row);
    broadcastUserStatus(serialized.id, serialized.status, serialized.customStatus);
    // Остальным клиентам ЭТОГО человека — ещё и признак «поставила автоматика»: без него второй
    // клиент видит `away`, но не знает, что его можно снять активностью (#118). Другим участникам
    // этот признак не уходит — им хватает `user.status` выше.
    void publishToUser(serialized.id, {
      t: 'self.status',
      status: serialized.status,
      statusAuto: serialized.statusAuto ?? false,
    });
    return serialized;
  });

  // Report what game the caller is currently playing (issue #40, Phase 1A — desktop local process
  // detection; also the sink for Steam later). `game: null` clears it. Ephemeral + broadcast; the
  // in-memory store TTLs it so a crashed/closed client's activity self-clears. Clients re-send
  // periodically (heartbeat) which just refreshes the TTL (no re-broadcast unless the game changed).
  app.patch('/users/me/activity', async (req) => {
    const body = z
      .object({
        game: z
          .object({
            name: z.string().min(1).max(64),
            appId: z.number().int().positive().optional(),
          })
          .nullable(),
      })
      .parse(req.body);
    setActivity(req.user!.sub, body.game);
    return { ok: true };
  });

  // Snapshot of everyone's current game activity (userId -> game), so a freshly-loaded client can
  // seed its presence without waiting for each player's next report.
  app.get('/users/activities', async () => {
    return { activities: allActivities() };
  });

  // Upload an avatar image (multipart) -> MinIO -> set avatarUrl.
  app.post('/users/me/avatar', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    if (!isSupportedImage(file.mimetype)) return reply.code(400).send({ error: 'unsupported image type (png/jpeg/webp/gif)' });

    const buffer = await file.toBuffer();
    if (buffer.length > MAX_AVATAR_BYTES) return reply.code(413).send({ error: 'image too large (max 5 MB)' });
    /**
     * 🔴 Анимация здесь НЕ принимается — и это закрытая дыра, а не новое ограничение ради покупки.
     *
     * До сих пор маршрут брал анимированные GIF как есть, без единой проверки: ни числа кадров
     * (бомба распаковки — тысячи кадров в сотне килобайт, и каждый зритель раскрывает их у себя в
     * памяти), ни того, что такой аватар крутится во ВСЕХ списках у всех участников постоянно.
     * Проверять по содержимому обязательно: тип файла про анимацию не говорит ничего.
     *
     * ⚠️ Уже загруженные раньше аватары остаются как есть. Переписывать людям аватарки задним
     * числом мы не будем — это их вещи, а не наши.
     */
    if (isAnimatedImage(new Uint8Array(buffer), file.mimetype)) {
      return reply.code(400).send({
        error: 'анимированный аватар — отдельная награда за монеты; обычным можно поставить статичную картинку',
      });
    }

    let url: string;
    try {
      url = await uploadAvatar(req.user!.sub, buffer, file.mimetype, Date.now());
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'upload failed' });
    }

    const [row] = await db.update(users).set({ avatarUrl: url }).where(eq(users.id, req.user!.sub)).returning();
    const serialized = serializeUser(row);
    // Same live broadcast as the name change — everyone's avatar of this user refreshes at once.
    broadcastUserProfile(serialized.id, serialized.displayName, serialized.avatarUrl, serialized.animatedAvatarUrl);
    return serialized;
  });

  /**
   * Анимированный аватар (#117, этап 4) — ОТДЕЛЬНЫМ маршрутом, а не флагом у обычного.
   *
   * 🔴 Отдельный маршрут потому, что и правила приёма другие, и результат другой: обычный аватар
   * проверяется на тип и размер, анимированный — ещё и на «а анимирован ли», на пропорции и на
   * ЧИСЛО КАДРОВ (бомба распаковки: тысячи кадров в сотне килобайт, и каждый зритель раскрывает их
   * у себя в памяти). Смешай мы их в одном маршруте, часть проверок пришлось бы включать условно —
   * а условно включаемая защита рано или поздно оказывается выключенной.
   *
   * ⚠️ Статичный `avatarUrl` НЕ трогается: он остаётся кадром для списков и оверлея. Человек без
   * обычного аватара, поставивший анимацию, увидит её только там, где она показывается, — и это
   * правильнее, чем молча вырезать ему кадр из гифки.
   */
  app.post('/users/me/avatar/animated', async (req, reply) => {
    const [me] = await db
      .select({ until: users.animatedAvatarUntil })
      .from(users)
      .where(eq(users.id, req.user!.sub))
      .limit(1);
    // ⚠️ Проверяем СРОК, а не факт покупки: аренда истекла — заливать новую анимацию нельзя, но
    // ранее залитый файл мы не трогаем (см. сериализатор), и продление вернёт его без перезаливки.
    if (!avatarRentalActive(me?.until ?? null, new Date())) {
      return reply.code(403).send({ error: 'аренда анимированного аватара не действует' });
    }

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const buffer = await file.toBuffer();
    const check = checkAnimatedAvatar(file.mimetype, new Uint8Array(buffer));
    if (!check.ok) return reply.code(400).send({ error: check.error });

    let url: string;
    try {
      url = await uploadAvatar(`${req.user!.sub}-anim`, buffer, file.mimetype, Date.now());
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'upload failed' });
    }

    const [row] = await db
      .update(users)
      .set({ animatedAvatarUrl: url })
      .where(eq(users.id, req.user!.sub))
      .returning();
    const serialized = serializeUser(row);
    // 🔴 Рассылка тут ОБЯЗАТЕЛЬНА, и её не было (#129): человек покупал анимацию, видел её у себя в
    // профиле, а остальные — прежнюю картинку до полного перезахода на сервер. Обычный аватар
    // рассылался с самого начала; про этот маршрут забыли, когда заводили аренду.
    broadcastUserProfile(serialized.id, serialized.displayName, serialized.avatarUrl, serialized.animatedAvatarUrl);
    return serialized;
  });

  /** Снять анимацию, оставив обычный аватар. Право покупки при этом НЕ отбирается. */
  app.delete('/users/me/avatar/animated', async (req, reply) => {
    const [row] = await db
      .update(users)
      .set({ animatedAvatarUrl: null })
      .where(eq(users.id, req.user!.sub))
      .returning();
    const serialized = serializeUser(row);
    // Снятие — такое же изменение профиля, как и установка: без рассылки у остальных крутилась бы
    // анимация, которой у человека уже нет.
    broadcastUserProfile(serialized.id, serialized.displayName, serialized.avatarUrl, serialized.animatedAvatarUrl);
    return reply.send(serialized);
  });
}
