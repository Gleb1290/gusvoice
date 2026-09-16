import { firstPlaceholderSecret, parsePreviewList } from '@gusvoice/shared';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Заглушка из .env.example вместо секрета = подпись токенов известна всем (shared/secretRules.ts). Не стартуем.
const placeholder = firstPlaceholderSecret({
  JWT_SECRET: process.env.JWT_SECRET,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
});
if (placeholder) {
  throw new Error(`${placeholder} is a placeholder from .env.example — generate a real one: openssl rand -hex 32`);
}

export const env = {
  port: Number(process.env.BACKEND_PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  jwtSecret: required('JWT_SECRET'),
  livekit: {
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
    urlInternal: process.env.LIVEKIT_URL_INTERNAL ?? 'http://livekit:7880',
    urlExternal: required('LIVEKIT_URL_EXTERNAL'),
  },
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:8080',
  // Логин для ПЕРВОЙ привязки супер-админа (#140): при старте без привязки ищется пользователь с этим
  // логином и его id записывается в instance_settings. Дальше права — только по id; смена значения
  // в .env после привязки прав не переносит (seed.ts → bindSuperAdmin, superAdminRules.ts).
  superAdminUsername: process.env.SUPERADMIN_USERNAME ?? '',
  // First-boot bootstrap: when ALL three are set (install.sh collects them), the backend seeds a
  // PRE-VERIFIED super-admin account on startup so a fresh instance is usable with no web signup /
  // e-mail code. Idempotent (skips if the user exists); empty on existing deployments => no-op.
  superAdmin: {
    username: process.env.SUPERADMIN_USERNAME ?? '',
    email: process.env.SUPERADMIN_EMAIL ?? '',
    password: process.env.SUPERADMIN_PASSWORD ?? '',
  },
  // Where operational alerts (brute-force lockouts) are emailed. Empty => the super-admin's own address
  // (instanceSetup.ts adminAlertEmail); no super-admin either => alerts are logged, not sent.
  adminEmail: process.env.ADMIN_EMAIL ?? '',
  // Код установки (мастер первичной настройки, #142): `install.sh` генерирует и печатает его. Пока супер-админа
  // нет, мастер в вебе открывается только по этому коду — иначе свежий инстанс угонит первый, кто откроет
  // страницу. Пусто (прод, старые коробки, установка через SUPERADMIN_*) => мастера нет, всё как раньше.
  setupToken: process.env.SETUP_TOKEN ?? '',
  // Anti-bot registration guards. A bot that registers but never verifies leaves a users row forever
  // (squatting the username/email + bloating the DB). unverifiedTtlDays: abandoned unverified accounts
  // with zero footprint are purged after this many days (0 = never). registerGlobalMax: instance-wide
  // signups per hour on top of the per-IP ceiling — an IP-rotating botnet slips past register:<ip> but
  // every signup still hits this single global window.
  unverifiedTtlDays: Number(process.env.UNVERIFIED_TTL_DAYS ?? 7), // NaN/empty => cleanup treats as disabled
  // `|| 100` (not `??`) so an empty/garbage value can't parse to 0 and lock everyone out of signup.
  registerGlobalMax: Number(process.env.REGISTER_GLOBAL_MAX) || 100,
  /**
   * Собирает ли этот инстанс диагностику с машин своих людей (#113).
   *
   * 🔴 **Умолчание — ВЫКЛЮЧЕНО, и направление тут принципиально.** Отчёт уезжает на сервер того
   * инстанса, к которому человек подключён: у наших друзей это наш сервер, у самохостера — его
   * собственный. То есть владелец чужого инстанса иначе начинал бы собирать данные о машинах своих
   * людей, ничего об этом не зная. Забытая переменная должна означать «сбора нет», а не наоборот:
   * обратное умолчание однажды протечёт, и узнаем мы об этом от чужих людей.
   *
   * Выключено => маршруты `/diag/*` не регистрируются вовсе (404), и тот же флаг едет клиенту, чтобы
   * он не собирал впустую.
   */
  diagEnabled: (process.env.DIAG_ENABLED ?? 'false') === 'true',
  // Экономика ГусКоинов (#117). Выключено => маршруты `/servers/:id/economy/*` НЕ регистрируются, и
  // вкладку «Монеты» не видит никто, включая владельца сервера.
  // 🔴 Это не косметика: тумблер «включить экономику» боевой, и без флага любой владелец чужого
  // сервера на этом инстансе мог бы запустить у себя недоделанную экономику — без тестов на
  // арифметику, без журнала в интерфейсе и с необратимым ретроначислением рядом.
  // ⚠️ Сбор сырой статистики живёт ОТДЕЛЬНО на `ECONOMY_STATS_ENABLED` и этим флагом не гасится:
  // прогон должен копить секунды, пока экономика ещё выключена, — на них и назначаются числа.
  economyEnabled: (process.env.ECONOMY_ENABLED ?? 'false') === 'true',
  /**
   * ЗАКРЫТЫЙ ПОКАЗ: кому экономика видна на включённом инстансе (идентификаторы через запятую).
   *
   * 🔴 Флага инстанса и выключателя сервера для обкатки вдвоём НЕ хватает: первый открывает вкладку
   * «Монеты» каждому владельцу сервера (владельцу выдаются все права разом), второй открывает
   * кошелёк всем участникам сервера. Этот список — третья, самая узкая мера, поимённо.
   * ⚠️ Пусто = ограничения нет (см. `previewAllows`): забытая переменная должна означать «как
   * было», иначе обновление отняло бы экономику там, где её уже открыли людям.
   */
  economyPreviewUsers: parsePreviewList(process.env.ECONOMY_PREVIEW_USERS),
  /**
   * Копит ли инстанс сырую статистику присутствия в голосе — ШАГ 0 экономики GusCoins
   * (`docs/guscoins-plan.md`).
   *
   * 🔴 Умолчание — ВЫКЛЮЧЕНО, по той же причине, что и у диагностики выше: это данные о том, кто
   * сколько часов сидит в голосе, и владелец чужого инстанса не должен начать их собирать, просто
   * обновившись. Забытая переменная обязана означать «сбора нет».
   *
   * Выключено => сборщик не запускается вовсе, таблица `voice_activity` остаётся пустой.
   */
  economyStatsEnabled: (process.env.ECONOMY_STATS_ENABLED ?? 'false') === 'true',
  // Tauri updater feed — holds the current desktop installer URL; the public /download endpoints read
  // it so a fresh user can grab the newest signed installer. Empty => /download returns 503 (no feed).
  updateFeedUrl: process.env.UPDATE_FEED_URL ?? '',
  // Кнопка «Обновить инстанс» (О2б, instanceUpdate.ts). gvVersion — версия, вшитая в образ при сборке (Dockerfile
  // `GV_VERSION`): `vX.Y.Z` у выпусков, `master-<коммит>` у CI, `dev` у локальной сборки — не выпуск => сравнения и
  // кнопки нет. gvReleasesUrl — где узнать свежий выпуск (GitHub API `releases/latest`); пусто => не проверяем.
  // gvRunDir — каталог с `request/` (пишем запрос) и `status/` (читаем ход обновления), подмонтированы из хоста.
  gvVersion: (process.env.GV_VERSION ?? '').trim() || 'dev',
  gvReleasesUrl: (process.env.GV_RELEASES_URL ?? '').trim(),
  gvRunDir: process.env.GV_RUN_DIR ?? '/app/run',
  minio: {
    endpoint: process.env.MINIO_ENDPOINT ?? '', // empty => avatar upload disabled
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: (process.env.MINIO_USE_SSL ?? 'false') === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? '',
    secretKey: process.env.MINIO_SECRET_KEY ?? '',
    bucket: process.env.MINIO_BUCKET ?? 'gusvoice',
    publicUrl: (process.env.MINIO_PUBLIC_URL ?? '').replace(/\/+$/, ''),
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '', // empty => codes are logged instead of emailed
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: (process.env.SMTP_SECURE ?? 'false') === 'true', // true for port 465 (implicit TLS)
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'GusVoice <noreply@localhost>',
  },
  // Self-hosted F-Droid repo (our private Android app store). Served ONLY to authed clients via
  // GET /app/fdroid (never baked into the public JS bundle) so the repo's basic-auth password stays
  // gated. addUrl is the FULL credentialed add-link, URL-encoded (so no literal `$` that docker-compose
  // .env interpolation would mangle). Empty addUrl => the endpoint 503s and the client hides the tab.
  fdroid: {
    repoUrl: (process.env.FDROID_REPO_URL ?? '').replace(/\/+$/, ''),
    fingerprint: process.env.FDROID_FINGERPRINT ?? '',
    addUrl: process.env.FDROID_ADD_URL ?? '',
  },
  // Self-hosted ntfy push gateway (VM 118). baseUrl gates which endpoints we'll POST to (SSRF guard);
  // token authorizes publishing (ntfy is read-only for anon, write-only for this token). Empty => push off.
  ntfy: {
    baseUrl: (process.env.NTFY_BASE_URL ?? '').replace(/\/+$/, ''),
    token: process.env.NTFY_TOKEN ?? '',
  },
  // Steam game-activity source (#40 Phase 1B). apiKey = a Steam Web API key (steamcommunity.com/dev);
  // empty => the whole Steam feature is OFF (no link button, no poller). apiPublicUrl is where Steam's
  // OpenID assertion returns (the API's own public origin — the realm/return_to base).
  steam: {
    apiKey: process.env.STEAM_API_KEY ?? '',
    apiPublicUrl: (process.env.STEAM_API_PUBLIC_URL ?? process.env.VITE_API_URL ?? '').replace(/\/+$/, ''),
  },
  // Импорт стикеров из Telegram (#68). Токен бота от @BotFather; пустой => импорт выключен
  // целиком (вкладка в настройках скажет, что не настроено). Бот нужен ЛЮБОЙ — набор он читает
  // публичным методом getStickerSet, состоять в чатах и что-то принимать ему не требуется.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
};
