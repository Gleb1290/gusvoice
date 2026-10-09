import {
  CAP_CONV1,
  FEATURE_CONV2,
  FEATURE_CONV3,
  FEATURE_CONV4,
  FEATURE_CONV5,
  FEATURE_CONV6,
  FEATURE_CONV7,
  FEATURE_CONV8,
  FEATURE_CONV9,
  FEATURE_CONV10,
  FEATURE_CONV11,
  FEATURE_VOICE1,
  FEATURE_VOICE3,
  FEATURE_CIRCLES1,
  FEATURE_CONV12,
  FEATURE_CONV13,
  FEATURE_USERS1,
  FEATURE_STICKERS2,
  FEATURE_STICKERS3,
  FEATURE_FOLDERS1,
  FEATURE_ARCHIVE1,
  FEATURE_STRANGER1,
  FEATURE_SEARCH1,
  FEATURE_REACTUNREAD1,
  FEATURE_GSEARCH1,
  FEATURE_LASTSEEN1,
  FEATURE_LASTSEEN2,
  FEATURE_LASTSEEN3,
  FEATURE_PRESENCE4,
  FEATURE_PINS2,
  FEATURE_LINKPREV1,
  FEATURE_GROUPS1,
  FEATURE_SAVED1,
  FEATURE_FWD2,
  FEATURE_GROUPS2,
  FEATURE_GIFS1,
  FEATURE_GROUPS3,
  FEATURE_MEDIA1,
  FEATURE_PUSH2,
  FEATURE_PUSH3,
  FEATURE_CALLS1,
  FEATURE_CALLS2,
  FEATURE_MEDIA2,
  FEATURE_QUOTE1,
  FEATURE_SRVSEARCH1,
  FEATURE_FREQ1,
  FEATURE_FREQ2,
  FEATURE_CONTACTS1,
  FEATURE_BIGREACT1,
  FEATURE_PUSH4,
  FEATURE_PINORDER1,
  FEATURE_PINORDER2,
  FEATURE_PINSET1,
  FEATURE_TYPING2,
  FEATURE_BIGFILE1,
} from '@gusvoice/shared';

/**
 * Возможности инстанса, которые клиент включает только по объявлению — поле `features` в `GET /auth/me`
 * (ЛС этап 1, шаг 0.5, `docs/dm/STAGE1.md`).
 *
 * 🔴 Строка появляется здесь, когда возможность РАБОТАЕТ целиком, а не когда появился её код. `conv1` (беседы
 * `/api/conv/*`) — только после шага 1б: в 1а новые таблицы пустые, а живые ЛС ещё пишутся в `dm_*`, и клиент,
 * поверивший объявлению раньше, увидел бы пустой список переписок. `conv2` (30.09) — `created` в `conv.change` и старая
 * рассылка из `/api/conv/*` (`dmLegacyEvents.ts`): без них клиент на беседах терял бы звук/счётчик новых ЛС, а старые
 * клиенты собеседника — живую доставку. `conv3` (01.10, Р7) — черновики между устройствами: `draft` в сводке,
 * `PUT /conv/:id/draft`. `conv4` (03.10, Р6) — «прочитано собеседником»: `peerReadKey` в сводке и `conv.change`
 * собеседнику при сдвиге моего «прочитано до»; клиенту признак нужен, чтобы отличить сводку из кеша, снятую до
 * обновления сервера, от сервера без ✓✓. `conv5` (04.10, действия с сообщением как в Telegram, шаг 1) — пересылка
 * ЛС → ЛС (`POST /conv/:id/forward`, `forwardedFrom`) и удаление пачкой (`POST /conv/:id/messages/delete`): без него
 * клиент не показывает «Переслать» и удаление выделенного. `conv6` (04.10, С1) — в беседе 1:1 чужое сообщение
 * удаляется «у обоих» (одиночно и пачкой, ручки `/api/conv/*`): без него клиент не показывает у чужого галочку «Также
 * удалить для собеседника». `conv7` (05.10, С2) — закреп в беседе «для меня»/«для обоих»: `GET /conv/:id/pins`,
 * `PUT|DELETE /conv/:id/messages/:mid/pin`, `pins` в `conv.change` и в догонке; без него клиент не показывает «Закрепить»
 * в ЛС и полосу закрепа. `conv8` (05.10, С3) — «Отправить без звука»: `silent` в отправке и пересылке `/api/conv/*`,
 * `silent: true` в DTO и в нагрузке пуша; без него клиент не показывает «Отправить без звука» (старый сервер поле
 * молча отбросит, и сообщение прозвенит). `conv9` (05.10, С4) — отложенные сообщения: «Отправить позже» и «Когда будет
 * в сети», ручки `/conv/:id/scheduled*`, `scheduledCount` в сводке, `scheduled` в `conv.change` и в догонке (только автору),
 * планировщик `scheduled.ts`; без него клиент не показывает эти пункты и вход «Отложенные». `conv10` (06.10) — отложенные
 * С ВЛОЖЕНИЯМИ: `attachments` в `POST /conv/:id/scheduled` (файлы ждут вместе с отложенным — миграция 0087, уходят с ним,
 * удаляются с ним), `ConvScheduled.attachments` в списке; без него клиент держит «Отправить позже» и «Когда будет в сети»
 * серыми, пока выбраны файлы (старый сервер ответит 400). `conv11` (07.10) — закреп беседы наверху своего списка
 * (`PUT /conv/:id/pinned`, `pinnedAt` в сводке, миграция 0088) и заглушка со сроком (`seconds` в `POST /push/mute`,
 * `until` в списке заглушек, `muted` в сводке); без него клиент не показывает закреп, колокольчик глушит навсегда. `conv12` (07.10) — «Очистить историю» и «Удалить чат» (`POST /conv/:id/clear`,
 * `POST /conv/:id/hide`, миграция 0089); без него клиент этих пунктов меню строки не показывает. `users1` (05.10) — поиск людей
 * инстанса по @имени (`GET /users/search`, `routes/users.ts`), беседа у получателя только после первого сообщения
 * (`conversation_members.pending`, миграция 0086) и предел новых переписок без общего сервера (`dmRules.DM_NEW_LIMIT`); без
 * него клиент не ищет на сервере. `voice1` (07.10) — «не прослушано» у голосовых (`POST /conv/:id/messages/:mid/listened`, `ConvMessage.voiceListened`, миграция 0090); без него клиент точек не рисует. `conv13` (07.10) — «Пометить как непрочитанное» (`PUT /conv/:id/unread-mark`, `ConvSummary.markedUnread`, миграция 0091), «Прочитать все» (`POST /conv/read-all`) и «Выключить звук» (`soundOnly` у заглушки: пуш уходит с `silent`); без него клиент этих пунктов меню не показывает. Признаки только добавляются (правило 11).
 *
 * `folders1` (07.10, #211, G40, Р-8) — папки бесед ЛС: `/api/dm-folders*` и событие `dmFolders.update` моим устройствам.
 * `archive1` (07.10, #211, G41) — архив бесед: `PUT /conv/:id/archived`, `ConvSummary.archived`, миграция 0096.
 * `reactunread1` (07.10, #211, G24) — непрочитанные реакции на мои сообщения: `ConvSummary.unreadReactions`, `ConvMessage.reactionUnread`, `GET /conv/:id/unread-reactions`, `POST /conv/:id/reactions-read`, миграция 0102. `gsearch1` (G35) — поиск по тексту во всех моих беседах: `GET /conv/search`.
 *
 * `linkprev1` (07.10, #211, G19 + G48) — флаги отправки: `noPreview` у сообщения (миграция 0101) и `asFile` у вложения (`FEATURE_LINKPREV1`).
 * `groups1` (07.10, #211, С4) — групповые ЛС до 5 человек (`routes/convGroups.ts`, миграция 0099); группы — только клиенту,
 * который их просит (`?groups=1`, `identify.caps`).
 *
 * `saved1` (08.10, #211, С6, G72) — «Избранное»: беседа с самим собой (`POST /conv/saved`, `ConvSummary.saved`, миграции нет); как группы, видна только клиенту с `groups1` (`FEATURE_SAVED1`).
 *
 * `fwd2` (07.10, #211, G71) — «скрыть имя отправителя» и «скрыть подписи» у пересылки (`FEATURE_FWD2`).
 *
 * `lastseen1` (07.10, #211, С1) — «был(а) в сети» с приватностью «Время захода» и «Прочитано в …» (`FEATURE_LASTSEEN1`).
 *
 * `stranger1` (08.10, #211, С7, G30, Р-10) — плашка незнакомца и жалоба из ЛС: `ConvSummary.stranger`, `POST /conv/:id/stranger/hide`, `POST /conv/:id/report`, `GET /admin/dm-reports`, миграция 0107.
 *
 * `lastseen2` (08.10, #211, Р-2) — скрытое «Время захода» прячет и «в сети»; пачка `POST /users/last-seen` (`FEATURE_LASTSEEN2`).
 *
 * `lastseen3` (08.10, #211, G07) — исключения «Времени захода» по людям (`GET`/`PUT /users/me/last-seen-exceptions`, миграция 0120, `FEATURE_LASTSEEN3`).
 *
 * `presence4` (08.10, #211, решения владельца) — «в сети» в ЛС по факту (время прячет приватность, «Невидимый» — только серверы,
 *   событие `online.dm`), «Кто может звонить» (`callPrivacy`, `/users/me/call-exceptions`, `canCall`, миграция 0122, `FEATURE_PRESENCE4`).
 *
 * `media1` (08.10, #211, G29) — общие медиа беседы в профиле: `GET /conv/:id/media`, `GET /conv/:id/media/counts`, миграция 0108 (`FEATURE_MEDIA1`).
 *
 * `push2` (08.10, #211, G38) — настройки уведомлений как у Telegram: `notifyView` / `notifyGroups` в профиле, кадр шлюза
 * `active` и отложенный пуш на телефон, пока человек за ПК (`pushDefer.ts`), миграция 0111 (`FEATURE_PUSH2`).
 *
 * `push3` (08.10, #211, G38 остаток) — «Личные сообщения» (`notifyDm`) и «Повторять уведомления» (`notifyRepeat`) в профиле, повтор пуша
 * висящей беседы (`pushDefer.ts`), экран «Исключения» на заглушках `GET /push/mutes`, миграция 0118 (`FEATURE_PUSH3`).
 *
 * `calls1` (08.10, #211, С5, G73 + G68) — звонки 1:1 в ЛС: `routes/calls.ts`, звонок в памяти (`calls.ts`), запись — служебная строка `call`; миграции нет (`FEATURE_CALLS1`).
 *
 * `calls2` (08.10, #211, С5, G73) — видео в звонке: камера и показ экрана в пропуске, `ping { video }`, запись «Видеозвонок» (`FEATURE_CALLS2`).
 *
 * `media2` (08.10, #211, G48) — окно отправки файлов до Telegram: `spoiler` у вложения и `captionAbove` у сообщения (миграция 0112, `FEATURE_MEDIA2`).
 *
 * `quote1` (08.10, #211, G55) — цитата фрагмента (`replyQuote` отправки) и «Ответить в другом чате» (`replyToId` чужой беседы), миграция 0117 (`FEATURE_QUOTE1`).
 *
 * `srvsearch1` (08.10, #211, G35) — вкладка «Серверы» в поиске из списка ЛС: `GET /search/servers` по моим серверам, миграция 0121 (`FEATURE_SRVSEARCH1`).
 * `freq1` (09.10, #211, G35) — «Частые» в поиске из списка ЛС: `GET /conv/frequent` (мои сообщения за 90 дней с затуханием); миграции нет (`FEATURE_FREQ1`).
 * `contacts1` (08.10, #211, решение владельца п.7) — контакты: `GET/POST /contacts`, `PATCH/DELETE /contacts/:userId`, событие `contacts.update`, миграция 0126 (`FEATURE_CONTACTS1`).
 *
 * `bigreact1` (08.10, #211, G43) — «большая» реакция удержанием: `big` в теле реакции беседы и событие `reaction.big` соединениям с этим
 *   caps (`convRules.bigReactionTargets`); миграции нет (`FEATURE_BIGREACT1`).
 *
 * `push4` (08.10, #211, решение владельца 38) — исключение «Уведомления включены» при выключенных «Личных» / группах:
 *   `GET|POST|DELETE /push/always`, таблица `push_always`, миграция 0127 (`FEATURE_PUSH4`).
 *
 * `pinorder1` (08.10, #211, G02/G42) — ручной порядок закреплённых бесед: `PUT /conv/pinned-order` `{ ids }`, порядок в
 *   `conversation_members.pinned_at`, события — обычные `conv.change` со сводкой; миграции нет (`FEATURE_PINORDER1`).
 * `freq2` (09.10, #211, G35) — «Убрать из частых» на сервере: `POST /conv/frequent/hide`, `conversation_members.frequent_hidden_at`,
 *   миграция 0130 (`FEATURE_FREQ2`).
 * `pinorder2` (09.10, #211) — свой порядок закреплённых в каждой папке: `PUT /dm-folders/:id/pinned-order`, `dm_folders.pinned_ids`,
 *   миграция 0131 (`FEATURE_PINORDER2`).
 * `pinset1` (09.10, #211) — свой набор закреплённых в папке: `dm_folders.pinned_own` (миграция 0133), `POST /dm-folders/pinned-own`,
 *   `PUT /dm-folders/:id/pinned/:convId`; у папки со своим набором `pinned_ids` — набор и порядок (`FEATURE_PINSET1`).
 * `typing2` (09.10, сверка с Telegram п.6) — вид действия `round` («записывает видеосообщение») в кадре `typing`; шлюз отдаёт его только
 *   соединениям с caps `typing2`, остальным `voice`; миграции нет (`FEATURE_TYPING2`, `typingAction.typingActionFor`).
 * `bigfile1` (09.10, решение владельца: файл ЛС до 500 МБ+) — загрузка кусками `/conv/:id/uploads*` (`routes/uploads.ts`,
 *   миграции 0132 и 0134), предел файла — `dmFileMaxBytes` в `/auth/me` (`attachmentRules.BIGFILE_MAX_BYTES`) (`FEATURE_BIGFILE1`).
 */
export const INSTANCE_FEATURES: readonly string[] = [
  CAP_CONV1,
  FEATURE_CONV2,
  FEATURE_CONV3,
  FEATURE_CONV4,
  FEATURE_CONV5,
  FEATURE_CONV6,
  FEATURE_CONV7,
  FEATURE_CONV8,
  FEATURE_CONV9,
  FEATURE_CONV10,
  FEATURE_CONV11,
  FEATURE_VOICE1,
  FEATURE_VOICE3,
  FEATURE_CIRCLES1,
  FEATURE_CONV12,
  FEATURE_CONV13,
  FEATURE_USERS1,
  FEATURE_STICKERS2,
  FEATURE_STICKERS3,
  FEATURE_FOLDERS1,
  FEATURE_ARCHIVE1,
  FEATURE_STRANGER1,
  FEATURE_SEARCH1,
  FEATURE_REACTUNREAD1,
  FEATURE_GSEARCH1,
  FEATURE_LASTSEEN1,
  FEATURE_LASTSEEN2,
  FEATURE_LASTSEEN3,
  FEATURE_PRESENCE4,
  FEATURE_PINS2,
  FEATURE_LINKPREV1,
  FEATURE_GROUPS1,
  FEATURE_SAVED1,
  FEATURE_FWD2,
  FEATURE_GROUPS2,
  FEATURE_GIFS1,
  FEATURE_GROUPS3,
  FEATURE_MEDIA1,
  FEATURE_PUSH2,
  FEATURE_PUSH3,
  FEATURE_CALLS1,
  FEATURE_CALLS2,
  FEATURE_MEDIA2,
  FEATURE_QUOTE1,
  FEATURE_SRVSEARCH1,
  FEATURE_FREQ1,
  FEATURE_FREQ2,
  FEATURE_CONTACTS1,
  FEATURE_BIGREACT1,
  FEATURE_PUSH4,
  FEATURE_PINORDER1,
  FEATURE_PINORDER2,
  FEATURE_PINSET1,
  FEATURE_TYPING2,
  FEATURE_BIGFILE1,
];
