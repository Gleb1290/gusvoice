import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const messagePane = readFileSync(new URL('./components/MessagePane.tsx', import.meta.url), 'utf8');
const voiceConnection = readFileSync(new URL('./components/VoiceConnection.tsx', import.meta.url), 'utf8');
const streamQuality = readFileSync(new URL('./components/StreamQualityPanel.tsx', import.meta.url), 'utf8');
const shareDialog = readFileSync(new URL('./components/ScreenShareDialog.tsx', import.meta.url), 'utf8');
const voicePanel = readFileSync(new URL('./components/VoicePanel.tsx', import.meta.url), 'utf8');
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const gameActivity = readFileSync(new URL('./gameActivity.ts', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('./overlay.ts', import.meta.url), 'utf8');
const settingsSnapshot = readFileSync(new URL('./settingsSnapshot.ts', import.meta.url), 'utf8');
const windowCovered = readFileSync(new URL('./windowCovered.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const sockets = readFileSync(new URL('./sockets.ts', import.meta.url), 'utf8');
const dmChat = readFileSync(new URL('./components/DmChatView.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('./components/ChatView.tsx', import.meta.url), 'utf8');
const channelVisit = readFileSync(new URL('./channelVisit.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
const nativePush = readFileSync(new URL('./nativeUnifiedPush.ts', import.meta.url), 'utf8');
const pushKeysSource = readFileSync(new URL('./pushKeys.ts', import.meta.url), 'utf8');
const notifications = readFileSync(new URL('./notifications.ts', import.meta.url), 'utf8');
const androidBack = readFileSync(new URL('./androidBack.ts', import.meta.url), 'utf8');
const mainLayout = readFileSync(new URL('./components/MainLayout.tsx', import.meta.url), 'utf8');
const dmSidebar = readFileSync(new URL('./components/DmSidebar.tsx', import.meta.url), 'utf8');

describe('провода компонентов, не требующие React-окружения', () => {
  it('правка из телефонной шторки переходит в композер, а кнопки сохраняют фокус поля', () => {
    // Ловит исчезновение клавиатуры при отправке и маленький редактор вместо полноразмерного поля.
    const edit = messagePane.match(/label="Изменить"[\s\S]{0,230}?close\(\)/)?.[0] ?? '';
    assert.match(edit, /startComposerEdit\(m\)/);
    assert.doesNotMatch(edit, /setEditingId/);
    for (const title of ['Отменить правку', 'Отменить ответ']) {
      const button = messagePane.match(new RegExp(`title="${title}"[\\s\\S]{0,150}?onClick=`))?.[0] ?? '';
      assert.match(button, /onPointerDown=\{keepFocus\}/);
      assert.match(button, /onMouseDown=\{keepFocus\}/);
    }
    const send = messagePane.match(/className="send-btn"[\s\S]{0,180}?<Icon/)?.[0] ?? '';
    assert.match(send, /onPointerDown=\{keepFocus\}/);
    assert.match(send, /onMouseDown=\{keepFocus\}/);
    assert.match(messagePane, /const keepFocus[^\n]*preventDefault\(\)/);
  });

  it('телефон скрывает вкладки в переписке и гасит число только у действительно показанной беседы', () => {
    // Ловит панель вкладок поверх чата и исчезновение непрочитанного при просмотре другого раздела.
    assert.match(mainLayout, /mobilePane === 'content'[\s\S]{0,150}?appClass\.push\('m-chat'\)/);
    assert.match(dmSidebar, /const shownDmId\s*=[\s\S]*?isFeedOnScreen/);
    assert.match(dmSidebar, /unreadDms\.includes\(d\.id\)\s*&&\s*d\.id\s*!==\s*shownDmId/);
  });
  it('кнопка обычной отправки не блокируется полётом предыдущего сообщения', () => {
    // Регрессия с прода: disabled на submit заодно блокирует Enter и превращает очередь в одиночный запрос.
    const button = messagePane.match(/<button\s+type="submit"\s+className="send-btn"[\s\S]*?<\/button>/)?.[0];
    assert.ok(button, 'не найдена кнопка send-btn');
    assert.doesNotMatch(button, /\bdisabled\s*=/);
  });

  it('комната включает dynacast, чтобы невостребованный слой не кодировался', () => {
    // Ловит постоянную работу всех NVENC-сеансов, даже когда зрители просят один слой.
    assert.match(voiceConnection, /new Room\(\{[\s\S]*?dynacast:\s*true[,\s]/);
  });

  it('панель качества накладывает патч на свежие настройки, а не возвращает старую копию', () => {
    // Ловит возврат cursor:false к старому значению при смене разрешения после монтирования панели.
    const update = streamQuality.match(/function update\([^)]*\)\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? '';
    assert.match(update, /getStreamSettings\(\)/);
    assert.doesNotMatch(streamQuality, /update\(\{\s*\.\.\.s\s*,/);
  });

  it('тумблер курсора показывается только в десктопном показе не-камеры', () => {
    // Ловит бессмысленную настройку в вебе/камере и потерю подписей доступности.
    assert.match(shareDialog, /isDesktop\(\)\s*&&\s*tab\s*!==\s*['"]camera['"]\s*&&\s*\([\s\S]*?id="ss-cursor-label"/);
  });

  it('LiveKit-правка ставится до первого React-root и остаётся привязана к установленному методу', () => {
    // Ловит подключение комнаты до отключения вечного rAF и тихое исчезновение метода после обновления SDK.
    assert.ok(main.indexOf('installLivekitTweaks();') < main.indexOf('createRoot('));
    const livekit = readFileSync(new URL('../node_modules/livekit-client/dist/livekit-client.esm.mjs', import.meta.url), 'utf8');
    assert.match(livekit, /registerTimeSyncUpdate/);
  });

  it('статистика голоса разрежается без наведения и ускоряется только над статусом', () => {
    // Ловит постоянный двухсекундный setState в скрытой панели.
    assert.match(voicePanel, /hot\s*\?\s*2_?000\s*:\s*10_000/);
    assert.match(voicePanel, /className="vp-status"[\s\S]*?onMouseEnter=[\s\S]*?onMouseLeave=/);
  });

  it('опрос игры перечисляет окна без дорогих иконок', () => {
    // Ловит возврат PNG-извлечения для каждого окна раз в 30 секунд.
    assert.match(gameActivity, /listOverlayApps\(\{\s*icons:\s*false\s*\}\)/);
  });

  it('перечисление окон явно проводит оба значения icons в нативную команду', () => {
    // Ловит возврат дорогих PNG-иконок для фонового опроса и их потерю в ручном пикере.
    const fn = overlay.match(/export async function listOverlayApps[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /invoke\(['"]gv_list_apps['"],\s*\{\s*icons:\s*opts\?\.icons\s*\?\?\s*true\s*\}\)/);
  });

  it('живой и заводской снимки настроек оба содержат оптимизированный режим', () => {
    // Ловит точку «изменено», которая сравнивает режим с отсутствующим заводским значением.
    assert.match(settingsSnapshot, /liteMode:\s*liteModeEnabled\(\)/);
    assert.match(settingsSnapshot, /liteMode:\s*liteModeDefault\(\)/);
  });

  it('снимок движения окна стабилен числом, оба признака будят подписчиков, а hook отписывается', () => {
    // Ловит бесконечный React-render от нового объекта snapshot и молча застывшие GIF после события оболочки.
    const hook = windowCovered.match(/export function useWindowMotion[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(hook, /\(covered\s*\?\s*1\s*:\s*0\)\s*\|\s*\(gameFg\s*\?\s*2\s*:\s*0\)/);
    assert.match(hook, /motionSubs\.add\(fn\)[\s\S]*?motionSubs\.delete\(fn\)/);
    const applyGame = windowCovered.match(/function applyGame[\s\S]*?\n\}/)?.[0] ?? '';
    const apply = windowCovered.match(/function apply\(v[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(applyGame, /notifyMotion\(\)/);
    assert.match(apply, /notifyMotion\(\)/);
  });

  it('композер остаётся многострочным и отправляет Enter через единое правило после нормального layout', () => {
    // Ловит возврат однострочного input, обход touch/IME-правил и раздувание пустого поля при узком монтаже.
    assert.match(messagePane, /<textarea[\s\S]*?className="composer-input"/);
    assert.match(messagePane, /onKeyDown=\{\(e\) => \{[\s\S]*?enterSends\([\s\S]*?requestSubmit\(\)/);
    assert.match(messagePane, /fitComposer[\s\S]*?clientWidth\s*<\s*40/);
    assert.doesNotMatch(styles, /\.composer\s+input(?:\W|$)/);
  });

  it('отложенная отметка прочитанного заменяет функцию до проверки уже заведённого таймера', () => {
    // Ловит выполнение первого upTo из пачки вместо последнего сообщения, которое человек уже увидел.
    const fn = sockets.match(/function scheduleRead[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fn.indexOf('readLatest.set(key, fn)') < fn.indexOf('readTimers.has(key)'));
    assert.match(fn, /const latest = readLatest\.get\(key\)[\s\S]*?latest\?\.\(\)/);
  });

  it('шлюз объявляет bigreact1 и принимает только чужую реакцию для эффекта', () => {
    // Эффект не нужен собственному отправителю, а старый сервер не должен получать неизвестную возможность.
    assert.match(sockets, /FEATURE_BIGREACT1/);
    const identify = sockets.match(/JSON\.stringify\(\{ t: 'identify',[^\n]+/)?.[0] ?? '';
    assert.match(identify, /caps: \[\.\.\.caps, FEATURE_GROUPS1, FEATURE_PRESENCE4, FEATURE_BIGREACT1\]/);
    const event = sockets.slice(sockets.indexOf("case 'reaction.big':"), sockets.indexOf("case 'read.channel':"));
    assert.match(event, /if \(msg\.userId === store\.user\?\.id\) return/);
    assert.match(event, /fireEffect\(\{ kind: 'bigReaction', conversationId: msg\.conversationId, messageId: msg\.messageId, emoji: msg\.emoji \}\)/);
  });

  it('обе ленты показывают ошибку вместо вечного скелетона, а ЛС умеют грузить старую порцию', () => {
    // Ловит тупик после сетевого сбоя и исчезнувшую прокрутку истории личной беседы.
    for (const source of [chat, dmChat]) {
      assert.match(source, /loading=\{[^}]*===\s*undefined\s*&&\s*!failed\}/);
      assert.match(source, /emptyState=\{failed\s*\?/);
    }
    assert.match(dmChat, /onLoadOlder=\{\(\)\s*=>\s*loadOlderDmMessages\(dm\.id\)\}/);
  });

  it('визит в ЛС читает её при входе и симметрично снимает обе оконные подписки', () => {
    // Ловит лишнюю отметку канала как ЛС и утечку слушателей при каждом переходе между лентами.
    assert.match(channelVisit, /if \(kind === 'dm' && windowFocused\(\)\) readDmNow\(id\)/);
    assert.match(channelVisit, /addEventListener\('focus', onBack\)[\s\S]*?removeEventListener\('focus', onBack\)/);
    assert.match(channelVisit, /addEventListener\('visibilitychange', onBack\)[\s\S]*?removeEventListener\('visibilitychange', onBack\)/);
  });

  it('ошибка блокировки откатывает оптимистичный список, а push-ключи безопасно разбираются', () => {
    // Ловит застрявшего в UI человека после 5xx и отказ всей регистрации из-за старого/битого нативного моста.
    const setBlocked = store.match(/setBlocked:\s*async[\s\S]*?\n\s*},/)?.[0] ?? '';
    assert.match(setBlocked, /const prev = get\(\)\.blockedUsers/);
    assert.match(setBlocked, /catch \(e\) \{[\s\S]*?set\(\{ blockedUsers: prev \}\)[\s\S]*?throw e/);
    const pushKeys = nativePush.match(/function pushKeys[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(pushKeys, /typeof b\.pushKeys !== 'function'\) return null/);
    assert.match(pushKeys, /parsePushKeys\(b\.pushKeys\(\)\)/);
    assert.match(pushKeysSource, /JSON\.parse\(raw\)/);
    assert.match(pushKeysSource, /typeof k\.p256dh === 'string' && typeof k\.auth === 'string'/);
    assert.match(pushKeys, /catch \{\s*return null/);
  });

  it('уведомление ЛС мигает окном, а отказ нативной команды явно падает на plugin fallback', () => {
    // Ловит тост, незаметный в игре, и полную потерю уведомления на старой desktop-сборке.
    const dmCreate = sockets.match(/case 'dm\.create':[\s\S]*?return store\.appendDmMessage/)?.[0] ?? '';
    assert.match(dmCreate, /if \(d\.osNotify\)[\s\S]*?osNotify\([\s\S]*?flashWindow\(\)/);
    assert.match(notifications, /core\.invoke\('gv_notify_clickable'[\s\S]*?\.catch\(\(\) => \{[\s\S]*?deliverViaPlugin/);
  });

  it('браузерное тихое уведомление сохраняет показ, добавляя silent только по true', () => {
    // Иначе тихая отправка теряет само уведомление или обычные нотификации получают новую опцию.
    assert.match(notifications, /new Notification\(title, silent \? \{ body, silent: true \} : \{ body \}\)/);
    assert.match(sockets, /silent: m\.silent === true/);
    const legacy = sockets.slice(sockets.indexOf("case 'dm.create':"), sockets.indexOf("case 'conv.change':"));
    const fresh = sockets.slice(sockets.indexOf("case 'conv.change':"), sockets.indexOf("case 'dm.update':"));
    for (const source of [legacy, fresh]) {
      assert.match(source, /dmSilentDecision\(/);
      assert.match(source, /if \(d\.sound\) playSound\('dm'\)/);
      assert.match(source, /if \(d\.osNotify\)[\s\S]*osNotify\([\s\S]*silent:[\s\S]*flashWindow\(\)/);
    }
  });

  it('Android-назад знает верхние просмотрщики, но не перехватывает общую подложку настроек', () => {
    // Ловит уход к списку под открытым lightbox/emoji-picker и закрытие всего окна мимо его внутренних шагов.
    const layers = androidBack.match(/export const TOP_LAYERS\s*=\s*([^;]+);/)?.[1] ?? '';
    assert.match(layers, /\.lightbox/);
    assert.match(layers, /\.emoji-backdrop/);
    assert.doesNotMatch(layers, /\.modal-overlay/);
  });
});
