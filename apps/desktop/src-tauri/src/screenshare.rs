//! Native screen-share (Plan B): capture a screen/window with libwebrtc's desktop_capturer and
//! publish it to the LiveKit room as a **companion participant** (`<userId>#screen`), entirely
//! bypassing WebView2's `getDisplayMedia` picker (which can't be intercepted). This gives us a
//! fully custom in-app source picker + real per-stream settings.
//!
//! Flow: the web client gets a companion token from the backend, then invokes `start` with the
//! chosen source + quality. We connect a second LiveKit Room from Rust, capture the source on a
//! dedicated thread (BGRA -> I420, scaled to the target), and publish it. `stop` tears it down.
#![cfg(target_os = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding, VideoPreset};
use livekit::prelude::*;
use livekit::webrtc::desktop_capturer::{
    DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};
use livekit::webrtc::video_frame::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::native::yuv_helper;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// Как часто проверять, что источник ещё существует (#99).
const SOURCE_CHECK: Duration = Duration::from_secs(10);

/// Сколько проверок ПОДРЯД должны промахнуться, чтобы счесть источник закрытым (#99).
///
/// Единственный промах — не доказательство. Перечисление отдаёт ОТФИЛЬТРОВАННЫЙ список, и окно
/// выпадает из него не только когда закрыто: скрытое, cloaked или подвисшее на секунду тоже
/// пропадает. Двумя проверками платим до 20 секунд задержки на настоящем закрытии (было 10) и
/// покупаем иммунитет к десятисекундному провалу — на фоне «замерший кадр навсегда», который был
/// до #99, обмен более чем выгодный.
const MISSES_TO_END: u32 = 2;

/// Событие в webview: показывать больше нечего, источник исчез.
pub const ENDED_EVENT: &str = "gv-screenshare-ended";

/// Событие в webview: показ залип и был пересобран сам (#111). Полезная нагрузка — какой это раз.
pub const HEALED_EVENT: &str = "gv-screenshare-healed";

/// Событие в webview: второй слой качества выключен за человека (#112). Нагрузка — причина.
pub const LAYERS_OFF_EVENT: &str = "gv-screenshare-layers-off";

// ─────────────── Второй слой качества: когда его НЕ просить (#112) ───────────────
//
// 🔴 На GTX 1060 приложение падало при старте показа. С выключенным вторым слоем падения
// прекратились, больше в настройках ничего не меняли. У владельцев свежих карт тот же слой работает без нареканий
// тысячами замеров.
//
// ⚠️ Механизм НЕ доказан. Первая версия («старый драйвер — мало сеансов NVENC») отпала: у неё
// драйвер 582.66, новее некуда. Поэтому здесь не лечение причины, а два предохранителя:
//   * по поколению карты — не просить второй слой там, где он уже ронял приложение;
//   * по факту падения — если показ с двумя слоями оборвался смертью приложения, следующий идёт
//     с одним, какова бы ни была причина. Этот работает и для случаев, о которых мы не догадываемся.
//
// И то и другое — с явным сообщением человеку и с возможностью включить обратно руками: тихо
// подменять выбранную настройку нельзя.

/// Файл живёт, ПОКА идёт показ. Уцелел к следующему запуску — значит показ оборвался смертью
/// приложения, а не кнопкой «Завершить».
const ACTIVE_MARKER: &str = "screenshare-active";

/// Отметка «мы уже сказали про старую карту». Без неё человек, осознанно включивший слой обратно,
/// получал бы принудительное выключение на каждом показе.
///
/// 🔴 Имя с `-2` (0.8.5): клиент один раз возвращает слои ВСЕМ (`returnLayersOnce` в
/// `streamSettings.ts` — до 06.09 одно падение выключало их навсегда). Под старым именем старая карта,
/// про которую уже говорили, получила бы слои обратно без предохранителя #112 и снова падала бы.
/// Новое имя = про карту скажем ещё раз и выключим снова.
const TOLD_MARKER: &str = "screenshare-layers-told-2";

/// Сколько показов с двумя слоями подряд оборвались падением. Растёт на каждом падении, обнуляется
/// показом с двумя слоями, дошедшим до кнопки «Завершить».
const STREAK_MARKER: &str = "screenshare-layers-crashes";

/// После скольких падений подряд слой выключается НАСОВСЕМ, а не на один показ.
///
/// 🔴 Одно падение слой больше не отбирает навсегда (#109, разбор 2026-09-06). Причина падения
/// временная — как правило, наш собственный баг, который мы через неделю чиним, — а расплата была
/// вечной, и платил за неё не упавший, а весь канал: без второго слоя один зритель с потерями
/// пульсирует картинку сразу всем. За сутки замера два слоя остались ровно у двоих из двадцати
/// с лишним показов. Три падения подряд — другое дело: это уже свойство машины, а не случайность.
const CRASH_LIMIT: u32 = 3;

/// Поколение, начиная с которого второй слой ведёт себя смирно. Turing = 7.5, Pascal = 6.1.
const MODERN_GPU_MAJOR: i32 = 7;

// ─────────────── Самолечение залипшего показа (#111) ───────────────
//
// 🔴 Что лечим. Когда видеокарта занята игрой под ноль, кодировщик не успевает, и WebRTC снижает
// частоту кадров — для показа он бережёт чёткость и жертвует именно кадрами. Когда видеокарта
// освобождается, частота НЕ возвращается: замерено — мы подаём 28 кадров/с, кодировщик выдаёт 4,
// процессор машины 23 %, блок кодирования простаивает 1 %, а `limitation` продолжает говорить
// «процессор». Человек видит 4 кадра в минуту, пока не перезапустит показ руками.
//
// ⚠️ Прямого рычага у нас нет: чем жертвовать под нагрузкой, решает библиотека, и в нативном пути
// это наружу не выведено (`degradation_preference` закрыт, в `TrackPublishOptions` его нет).
// Ограничение живёт в ОТПРАВИТЕЛЕ, а не в источнике, поэтому сдвинуть его можно только новым
// отправителем — ровно это и делает ручной перезапуск, и потому он помогает.
//
// Поэтому: распознаём состояние по числам и пересоздаём ПУБЛИКАЦИЮ, не трогая захват (см.
// `republish`). Поток захвата, выбор источника и WGC остаются на месте.

/// Окно замера сторожа. Считаем дельтами между соседними окнами, а не средним с начала показа:
/// после часа тяжёлой игры среднее останется высоким навсегда и залипание в нём утонет.
const STUCK_WINDOW: Duration = Duration::from_secs(5);

/// Сколько окон ПОДРЯД должны быть залипшими, прежде чем лечить. 5 × 5 с = 25 секунд.
///
/// ⚠️ Порог осознанно высокий: ложное срабатывание — моргание у всех зрителей на ровном месте.
/// Настоящее залипание держится минутами, лишние 25 секунд ничего не стоят.
const STUCK_WINDOWS: u32 = 5;

/// Пауза после лечения, прежде чем снова считать. Публикация должна успеть раскочегариться.
const HEAL_COOLDOWN: Duration = Duration::from_secs(90);

/// Больше трёх раз за показ не лечим. Если три пересоздания не помогли — мы ошиблись причиной, и
/// мигать показом дальше вредно. Счётчик уезжает в отчёт, так что молчания не будет.
const MAX_HEALS: u32 = 3;

/// Пауза между снятием и публикацией. Даёт старому кодировщику умереть до того, как новый попросит
/// сеансы у видеокарты (при двух слоях их два), и разводит две пересогласовки во времени.
const REPUBLISH_GAP: Duration = Duration::from_millis(400);

/// Дороже этого захват кадра означает «видеокарта занята» — лечить бесполезно, залипания нет.
/// Замерено: свободная карта — 3.8 мс, занятая игрой под ноль — 66 мс (экран) и 137 мс (окно).
const CAPTURE_FREE_MS: f64 = 15.0;

/// Ниже этой цели правило не работает: при 5 кадрах в секунду «вдвое меньше» ничего не значит.
const MIN_TARGET_FPS: f64 = 10.0;

/// Доля кадров, не уложившихся в бюджет. Косвенный признак «процессор реально забит» — тогда упор
/// в процессор честный, и пересоздание публикации не поможет.
const MAX_LATE_SHARE: f64 = 0.2;

/// Захват отдаёт не меньше этой доли цели — то есть кормим кодировщик нормально.
const CAP_OK_SHARE: f64 = 0.7;

/// Кодировщик отдаёт не больше этой доли цели — то есть заметно меньше, чем мог бы.
const ENC_BAD_SHARE: f64 = 0.5;

/// И при этом заметно меньше, чем МЫ ЕМУ ПОДАЁМ. Отделяет залипание от «источник сам молчит».
const ENC_VS_CAP_SHARE: f64 = 0.6;

/// Существует ли ещё источник с таким id. `want_pid` — процесс, которому окно принадлежало на
/// старте показа (только для окон; для экранов `None`).
///
/// 🔴 **Признак — отсутствие в СПИСКЕ источников, а не отсутствие кадров** (#99). Свёрнутое окно тоже
/// перестаёт отдавать кадры, а Alt+Tab из игры — обычное дело: гасить по «нет кадров» значило бы
/// убивать трансляцию при каждом сворачивании. Закрытое окно из перечисления пропадает, свёрнутое —
/// остаётся.
///
/// 🔴 **Но для ОКНА перечисление — не тот прибор** (приёмка #99, Dota 2). Вход в матч и выход из него
/// на секунды убирали окно из списка, и показ обрывался посреди игры. Идентификатор окна у libwebrtc
/// на Windows — это сам HWND (на том же равенстве стоит хоткей «стримить активное окно»:
/// `apps_enum` отдаёт HWND прямо в `source_id`), поэтому спрашиваем Win32 напрямую. `window_pid`
/// возвращает `None` для мёртвого дескриптора и чужой pid, если Windows успела выдать этот же номер
/// другому процессу, — то есть разом закрывает и «живо ли», и «то ли это самое окно».
///
/// ⚠️ **Fail-OPEN**, в отличие от почти всего остального в проекте: не смогли создать капчурер или
/// перечислить — считаем, что источник жив. Разовый сбой перечисления не повод обрывать живой стрим
/// у всех зрителей; худшее, что даёт ошибка в эту сторону, — проверим ещё раз через 10 секунд.
/// Экран с номером libwebrtc (индекс `EnumDisplayDevicesW`) ещё подключён к рабочему столу — ровно так
/// libwebrtc и строит список экранов (`GetScreenList`).
///
/// 🔴 Не через `DesktopCapturer::get_source_list`: для экрана тот поднимает СВОЁ дублирование DXGI всех
/// мониторов, а монитор, который показывает путь через видеокарту (#207, 4.2), уже продублирован нашим
/// захватом, и второе дублирование в том же процессе не создаётся. Список приходил пустым, сторож
/// считал экран пропавшим и через два промаха (~20 с) гасил показ с плашкой «окно закрылось» (26.09,
/// пробная 0.8.11 у владельца). Старому пути это не мешало: его захват и перечисление делили одно
/// дублирование libwebrtc.
fn screen_attached(id: u64) -> bool {
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW, DISPLAY_DEVICE_ATTACHED_TO_DESKTOP};
    let Ok(index) = u32::try_from(id) else {
        return false;
    };
    let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
    // SAFETY: `dd` — наша структура с верным `cb`, указатель живёт весь вызов.
    let found = unsafe { EnumDisplayDevicesW(windows::core::PCWSTR::null(), index, &mut dd, 0) }.as_bool();
    found && (dd.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP).0 != 0
}

fn source_exists(is_window: bool, id: u64, want_pid: Option<u32>) -> bool {
    // Окно с известным процессом: точный ответ Win32, перечисление даже не трогаем (заодно не
    // ходим каждые 10 секунд обходить все окна системы через COM).
    if is_window {
        if let Some(pid) = want_pid {
            return crate::apps_enum::window_pid(id) == Some(pid);
        }
    } else {
        return screen_attached(id);
    }
    let st = if is_window {
        DesktopCaptureSourceType::Window
    } else {
        DesktopCaptureSourceType::Screen
    };
    let Some(cap) = DesktopCapturer::new(DesktopCapturerOptions::new(st)) else {
        return true;
    };
    cap.get_source_list().into_iter().any(|s| s.id() == id)
}

/// One enumerated capture source for the picker grid. `id` is a stringified u64 (JS numbers can't
/// safely hold the full HWND/monitor id range).
#[derive(Serialize)]
pub struct ScreenSource {
    pub id: String,
    pub kind: String, // "screen" | "window"
    pub title: String,
    pub thumb: Option<String>, // data:image/png;base64,... (None → UI shows a monogram)
    /// Настоящий размер источника по кадру миниатюры (06.10): окно показа по нему считает «≈ N Мбит/с»
    /// для «Родного». 0 — кадра не было (свёрнутое окно).
    pub width: u32,
    pub height: u32,
}

/// Config the web client passes to `start`. Quality fields mirror `streamSettings.ts`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConfig {
    pub url: String,
    pub token: String,
    pub source_id: String,
    pub is_window: bool,
    pub fps: u32,
    /// Потолок кадра: больше — уменьшаем с сохранением пропорций. `0×0` — «Родное» (06.10): размер
    /// источника, вписанный в 4K (`native_dims`), а битрейт тогда считаем здесь (`share_bitrate`).
    pub width: u32,
    pub height: u32,
    /// Битрейт полного слоя, бит/с. У «Родного» клиент шлёт 0 — размер источника знает только Rust.
    pub max_bitrate: u64,
    pub codec: String, // "auto" | "vp9" | "h264" | "h265" | "av1"
    /// Захватывать ОКНО через Windows Graphics Capture. По умолчанию `true` — как было.
    ///
    /// 🔴 Выключается теми, у кого от показа окна пухнет проводник: WGC подтекает в `explorer.exe`
    /// (замерено: 150 → 750 МБ за два часа показа, три сессии подряд, рост прекращается вместе с
    /// показом), а когда проводнику плохо, отваливаются Alt+Tab, «Пуск» и панель задач — всё, что
    /// обслуживает он. Тот же баг с той же причиной известен у TeamSpeak 6.
    ///
    /// ⚠️ Не включено выключенным по умолчанию сознательно: без WGC libwebrtc падает на старый метод
    /// захвата, который плохо снимает окна игр с аппаратным рендерингом — вплоть до чёрного кадра.
    /// Показ ЭКРАНА этот флаг не касается вовсе (там DirectX, и утечки нет).
    #[serde(default = "default_true")]
    pub wgc_window: bool,
    /// Публиковать показ ДВУМЯ слоями качества вместо одного (#109).
    ///
    /// По умолчанию включено, см. подробный разбор у `simulcast` ниже. Выключатель нужен ровно на
    /// один случай: у видеокарты кончились сеансы кодирования, и показ перестал стартовать.
    #[serde(default = "default_true")]
    pub layers: bool,
    /// Показ ЭКРАНА с кадром внутри видеокарты (#207, шаг 4): DXGI → общая текстура → NVENC без
    /// оперативки (`webrtc_sys::gv_gpu_capture`). Замер под игрой в упоре видеокарты: рывки игры
    /// 15–18 → 0–2 за 90 с, показ 31 → 60 к/с, процессор в 13 раз меньше.
    ///
    /// Только экран, H.264 и NVIDIA; иначе — старый путь, причина уезжает в `pipeline_note`. По
    /// умолчанию включено; выключатель — на случай, если новый путь у кого-то подведёт.
    #[serde(default = "default_true")]
    pub gpu_pipeline: bool,
    /// Курсор в кадре показа (28.09). По умолчанию включено; отсутствие поля (клиент прошлой версии)
    /// = включено.
    ///
    /// Экран через видеокарту — рисуем сами (`gv_gpu_capture`); старый путь — обёртка libwebrtc
    /// (`desktop_capturer.cpp`). Системный курсор при этом не трогаем: программным его делает WGC
    /// (показ окна), и это было и без курсора в кадре.
    #[serde(default = "default_true")]
    pub cursor: bool,
    /// Режим показа (06.10, #207): `detail` — «Чёткость» (текст, таблицы, код), `motion` —
    /// «Плавность» (игры, видео). До 06.10 нативный показ режим не получал вовсе — он менял только
    /// битрейт. Теперь: «Чёткость» — до 30 к/с и опорный кадр NVENC до ×10 обычного (без мыла на PLI и
    /// новом зрителе), «Плавность» — частота как выбрана и опорный ×4. Нет поля — «Чёткость», как
    /// умолчание клиента.
    #[serde(default = "default_mode")]
    pub mode: String,
    /// «Максимальное качество — не снижать» (06.10, решение владельца). Нижняя граница оценщика канала =
    /// битрейт пресета с запасом (и через интернет тоже), запасные слои выключены, вся полоса — полному.
    /// Цена: у зрителя со слабым каналом вместо мыла будут подтормаживания, а без запасного слоя его
    /// запросы опорных кадров снова бьют по всем (#109). По умолчанию выключено.
    #[serde(default)]
    pub max_quality: bool,
}

fn default_true() -> bool {
    true
}

fn default_mode() -> String {
    "detail".to_string()
}

struct Session {
    stop: Arc<AtomicBool>,
    room: Room, // kept alive for the duration of the share; closed on stop
    /// Источник кадров. Переживает пересоздание публикации (#111): поток захвата держит его клон и
    /// продолжает писать в него же, пока мы меняем трек под ним.
    source: NativeVideoSource,
    /// Опции ПЕРВОЙ публикации. Пересоздаём ровно ими, иначе самолечение молча сменило бы человеку
    /// качество показа — а он об этом не просил.
    opts: TrackPublishOptions,
    /// Отметка «показ идёт» (#112). Убираем при штатной остановке — уцелевшая означает падение.
    active_marker: Option<PathBuf>,
    /// Счётчик падений подряд (#109). Обнуляем, когда показ С ДВУМЯ СЛОЯМИ дошёл до «Завершить»:
    /// это и есть доказательство, что на этой машине они живут.
    streak_marker: Option<PathBuf>,
    /// Поток захвата текущего поколения (#237): меняется при смене источника, трек и источник — нет.
    capture: CaptureHandle,
    /// Что снимаем СЕЙЧАС — по ней сторож источника (#99) проверяет живость после смены.
    target: CaptureTarget,
    /// Номер текущего поколения захвата (`ACTIVE_GEN`).
    gen: u64,
    /// С чем показ запущен — правило цели для нового источника.
    share: ShareCfg,
    /// С каким размером опубликованы кодировки (у «Родного» — источника на старте или после
    /// переопубликации): от него решаем, пересоздавать ли публикацию при смене.
    declared: (u32, u32),
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Последний УМЕНЬШЕННЫЙ кадр показа для превью по наведению мышкой (#115): `(ширина, высота, RGBA)`.
///
/// ⚠️ Здесь лежит именно уменьшенный кадр, а не готовый PNG. Сжатие стоит миллисекунды, и делать
/// его на потоке захвата значило бы раз в несколько секунд опаздывать с кадром — то есть портить и
/// показ, и собственный счётчик опозданий, по которому мы ставим диагнозы. Сжимаем по требованию,
/// на потоке команды.
static PREVIEW: Mutex<Option<(usize, usize, Vec<u8>)>> = Mutex::new(None);

/// Как часто обновляем превью. Совпадает с периодом, с которым клиент его забирает и шлёт на сервер:
/// чаще — работа впустую, реже — зритель видел бы заметно устаревший кадр.
const PREVIEW_EVERY: Duration = Duration::from_secs(5);

/// Enumerate screens + windows, capturing a thumbnail per source in parallel. Skips windows with
/// empty titles (tool/overlay windows).
pub fn enumerate() -> Vec<ScreenSource> {
    let mut handles = Vec::new();
    for (kind, st) in [
        ("screen", DesktopCaptureSourceType::Screen),
        ("window", DesktopCaptureSourceType::Window),
    ] {
        if let Some(cap) = DesktopCapturer::new(DesktopCapturerOptions::new(st)) {
            for s in cap.get_source_list() {
                let title = s.title();
                if kind == "window" && title.trim().is_empty() {
                    continue;
                }
                let id = s.id();
                // Each thumbnail gets its own DesktopCapturer on its own thread → ~1 frame latency
                // total instead of summing across sources.
                let handle = std::thread::spawn(move || capture_thumb(st, id));
                handles.push((id.to_string(), kind.to_string(), title, handle));
            }
        }
    }
    handles
        .into_iter()
        .map(|(id, kind, title, handle)| {
            let (thumb, width, height) = handle.join().ok().unwrap_or((None, 0, 0));
            ScreenSource { id, kind, title, thumb, width, height }
        })
        .collect()
}

/// Grab one frame from a source and PNG-encode a small thumbnail data-URL. Best-effort: returns None
/// on timeout or for windows that can't be captured (minimized) — the UI falls back to a monogram.
/// Вместе с миниатюрой — размер кадра источника (0×0 — кадра не было).
fn capture_thumb(kind: DesktopCaptureSourceType, id: u64) -> (Option<String>, u32, u32) {
    let Some(mut cap) = DesktopCapturer::new(DesktopCapturerOptions::new(kind)) else {
        return (None, 0, 0);
    };
    let Some(source) = cap.get_source_list().into_iter().find(|s| s.id() == id) else {
        return (None, 0, 0);
    };
    let (tx, rx) = mpsc::channel::<(usize, usize, usize, Vec<u8>)>();
    cap.start_capture(Some(source), move |res| {
        if let Ok(f) = res {
            let _ = tx.send((f.width() as usize, f.height() as usize, f.stride() as usize, f.data().to_vec()));
        }
    });
    for _ in 0..8 {
        cap.capture_frame();
        if let Ok((w, h, stride, data)) = rx.recv_timeout(Duration::from_millis(200)) {
            return if w > 0 && h > 0 {
                (encode_thumb_png(&data, stride, w, h), w as u32, h as u32)
            } else {
                (None, 0, 0)
            };
        }
    }
    (None, 0, 0)
}

/// Ширина миниатюры — и в пикере источников, и в превью показа (#115).
const THUMB_W: usize = 320;

/// Nearest-neighbour downscale a BGRA frame to ~320px wide. Отдаёт `(ширина, высота, RGBA)`.
///
/// Отдельно от сжатия СОЗНАТЕЛЬНО: уменьшение дешёвое (десятки тысяч точек) и его не жалко делать
/// прямо на потоке захвата, а PNG стоит миллисекунды — там ему не место.
fn downscale_bgra(bgra: &[u8], stride: usize, w: usize, h: usize) -> Option<(usize, usize, Vec<u8>)> {
    if w == 0 || h == 0 {
        return None;
    }
    let tw = w.min(THUMB_W).max(1);
    let th = (h * tw / w).max(1);
    let mut rgba = vec![0u8; tw * th * 4];
    for y in 0..th {
        let sy = (y * h / th).min(h - 1);
        for x in 0..tw {
            let sx = (x * w / tw).min(w - 1);
            let si = sy * stride + sx * 4;
            let di = (y * tw + x) * 4;
            if si + 2 < bgra.len() {
                rgba[di] = bgra[si + 2]; // R
                rgba[di + 1] = bgra[si + 1]; // G
                rgba[di + 2] = bgra[si]; // B
                rgba[di + 3] = 255; // A
            }
        }
    }
    Some((tw, th, rgba))
}

/// PNG-encode an RGBA buffer as a data URL.
fn png_data_url(rgba: &[u8], tw: usize, th: usize) -> Option<String> {
    let mut buf = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut buf, tw as u32, th as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf)))
}

/// Nearest-neighbour downscale a BGRA frame to ~320px wide and PNG-encode it as a data URL.
fn encode_thumb_png(bgra: &[u8], stride: usize, w: usize, h: usize) -> Option<String> {
    let (tw, th, rgba) = downscale_bgra(bgra, stride, w, h)?;
    png_data_url(&rgba, tw, th)
}

fn codec_of(s: &str) -> VideoCodec {
    match s {
        "vp9" => VideoCodec::VP9,
        "h264" => VideoCodec::H264,
        "h265" => VideoCodec::H265,
        "av1" => VideoCodec::AV1,
        _ => VideoCodec::VP8, // "auto" / unknown
    }
}

/// BGRA -> I420 через libyuv (SIMD). DesktopFrame на Windows отдаёт BGRA.
///
/// 🔴 Раньше здесь был наивный попиксельный цикл на Rust: 2560×1440 = 3.7 млн пикселей на кадр,
/// на 60 fps это 220 млн пикселей в секунду с проверкой границ на каждом обращении к массиву.
/// Он и был потолком стрима — панель отладки у тестера показывала «ограничение: процессор»
/// (594 с накоплено) и 22 fps при СВОБОДНОМ NVENC и нулевых потерях в сети: видеокарта простаивала,
/// потому что кадры не успевали до неё доехать (#79).
///
/// ⚠️ «ARGB» в libyuv — это порядок байт В ПАМЯТИ B,G,R,A (little-endian), то есть ровно наш BGRA;
/// `abgr_to_i420` взял бы каналы наоборот и покрасил бы стрим в синий.
/// ⚠️ libyuv даёт studio-range BT.601 (16..235), а старый цикл считал full-range без сдвига на 16 —
/// это исправление, а не регрессия: H.264 в вебе ожидает limited range, раньше картинка уходила
/// чуть контрастнее, чем надо.
fn bgra_to_i420(bgra: &[u8], stride: usize, w: usize, h: usize, dst: &mut I420Buffer) {
    let (sy, su, sv) = dst.strides();
    let (yp, up, vp) = dst.data_mut();
    yuv_helper::argb_to_i420(bgra, stride as u32, yp, sy, up, su, vp, sv, w as i32, h as i32);
}

/// 🔴 Счётчики конвейера захвата. Разбор 2026-08-22 упёрся в стену: у человека 4 кадра вместо 30,
/// кодировщик простаивает, упор в процессор, наш процесс занимает ровно одно ядро — то есть 250 мс
/// на кадр. Перевод кадра 2560×1440 в другой формат стоит порядка 10 мс, а куда уходили остальные
/// 96 % времени, сказать было НЕЧЕМ. Снижение качества показа при этом не меняло ничего — улика, что
/// работа идёт над исходником, а не над отправляемой картинкой.
///
/// Делим время на «снять» и «подготовить». ⚠️ Заодно это косвенно отвечает, каким способом снимается
/// экран: быстрый путь через видеокарту — единицы миллисекунд, старый через копирование всего экрана
/// — сотни. Прямо спросить у libwebrtc нельзя, но разница на два порядка, различить хватит.
static PIPE_TOTAL_US: AtomicU64 = AtomicU64::new(0);
static PIPE_CONV_US: AtomicU64 = AtomicU64::new(0);
static PIPE_FRAMES: AtomicU64 = AtomicU64::new(0);
/// Сколько раз не уложились в бюджет кадра. Отличает «захват молчит» от «мы не успеваем».
static PIPE_LATE: AtomicU64 = AtomicU64::new(0);
/// РЕАЛЬНЫЙ размер снимаемого источника. В отчёте до сих пор было только то, что ушло в сеть, и
/// «показывает 1080p» ничего не говорило о том, что сняли 1440p и три четверти работы выбросили.
static PIPE_SRC_W: AtomicU32 = AtomicU32::new(0);
static PIPE_SRC_H: AtomicU32 = AtomicU32::new(0);

/// Сколько раз показ пересобрался сам (#111) и сколько секунд подряд держится залипание СЕЙЧАС.
/// Оба уезжают в отчёт: самолечение, о котором не видно, спрячет от нас настоящую беду.
static HEALS: AtomicU32 = AtomicU32::new(0);
static STUCK_S: AtomicU32 = AtomicU32::new(0);

/// Время захвата кадра за ПОСЛЕДНЕЕ окно сторожа, микросекунды.
///
/// 🔴 Не дубль `capture_ms`: то — среднее с начала показа, и после часа игры оно останется высоким
/// навсегда. Именно это число отвечает на вопрос «видеокарта уже разгрузилась?».
static CAPTURE_NOW_US: AtomicU64 = AtomicU64::new(0);

/// Каким путём идёт показ (#207, шаг 4): `gpu` — кадр не покидает видеокарту, `cpu` — через
/// оперативку, и почему не `gpu` (пусто — получилось). Уезжает в телеметрию: без этого по отчёту
/// не отличить «новый путь не помог» от «новый путь не включился».
static PIPELINE: Mutex<(&'static str, String)> = Mutex::new(("", String::new()));

fn set_pipeline(kind: &'static str, note: impl Into<String>) {
    if let Ok(mut g) = PIPELINE.lock() {
        *g = (kind, note.into());
    }
}

fn reset_pipe_meters() {
    set_pipeline("", "");
    PIPE_TOTAL_US.store(0, Ordering::Relaxed);
    PIPE_CONV_US.store(0, Ordering::Relaxed);
    PIPE_FRAMES.store(0, Ordering::Relaxed);
    PIPE_LATE.store(0, Ordering::Relaxed);
    PIPE_SRC_W.store(0, Ordering::Relaxed);
    PIPE_SRC_H.store(0, Ordering::Relaxed);
    HEALS.store(0, Ordering::Relaxed);
    STUCK_S.store(0, Ordering::Relaxed);
    CAPTURE_NOW_US.store(0, Ordering::Relaxed);
    SWITCHES.store(0, Ordering::Relaxed);
    if let Ok(mut p) = PIPELINE_PENDING.lock() {
        *p = None;
    }
}

/// Счётчики конвейера от НОВОГО источника после смены (#237). Без этого сторож залипания и отчёт
/// сравнивали бы кадры двух разных источников. Самолечение (`HEALS`) и путь кадра не трогаем: первое
/// — свойство показа, а не источника, второе новое поколение выставило само (`activate_gen`).
fn reset_switch_meters() {
    PIPE_TOTAL_US.store(0, Ordering::Relaxed);
    PIPE_CONV_US.store(0, Ordering::Relaxed);
    PIPE_FRAMES.store(0, Ordering::Relaxed);
    PIPE_LATE.store(0, Ordering::Relaxed);
    STUCK_S.store(0, Ordering::Relaxed);
    CAPTURE_NOW_US.store(0, Ordering::Relaxed);
}

// ─── Смена источника без остановки показа (#237) ───
//
// Трек, `NativeVideoSource` и комната `#screen` живут весь показ, а под ними пересоздаётся только поток
// захвата. Каждый поток захвата — «поколение» со своим номером. Кадр уходит в источник только у
// поколения, равного `ACTIVE_GEN`, и проверка с отдачей кадра идут ПОД ЭТИМ ЖЕ замком: новый захват
// поднимается рядом со старым, пока не победил — его кадры выбрасываются, и два писателя в одном
// источнике не смешиваются ни на кадр (иначе кодировщик дёрнул бы пересоздание слоёв дважды).

/// Поколение захвата, чьи кадры сейчас уходят в источник показа. 0 — показа нет.
static ACTIVE_GEN: Mutex<u64> = Mutex::new(0);
/// Счётчик выданных номеров поколений: номера не повторяются и между показами.
static NEXT_GEN: AtomicU64 = AtomicU64::new(0);
/// Сколько раз источник показа сменили на лету (уезжает в `ShareStats.switches`).
static SWITCHES: AtomicU32 = AtomicU32::new(0);
/// Смена идёт прямо сейчас: вторая смена параллельно и самолечение (#111) ждут.
static SWITCHING: AtomicBool = AtomicBool::new(false);
/// Путь кадра поколения, которое ещё не победило: его покажем, только когда оно станет текущим.
static PIPELINE_PENDING: Mutex<Option<(u64, &'static str, String)>> = Mutex::new(None);
/// Сколько новый захват может подниматься, прежде чем смену признаем неудачной (старый всё это время идёт).
const SWITCH_READY_TIMEOUT: Duration = Duration::from_secs(3);
/// Шаг сна потока захвата, чьё поколение сейчас не текущее.
const IDLE_GEN_SLEEP: Duration = Duration::from_millis(5);

fn gen_lock() -> std::sync::MutexGuard<'static, u64> {
    ACTIVE_GEN.lock().unwrap_or_else(|e| e.into_inner())
}

fn gen_is_live(gen: u64) -> bool {
    *gen_lock() == gen
}

/// Выполнить `f` (отдать кадр в источник), только если поколение `gen` текущее, — под замком поколения.
fn with_live_gen<T>(gen: u64, f: impl FnOnce() -> T) -> Option<T> {
    let g = gen_lock();
    if *g == gen {
        Some(f())
    } else {
        None
    }
}

/// Путь кадра от потока захвата поколения `gen`: текущее — сразу в отчёт, нет — отложить до победы.
fn set_pipeline_for(gen: u64, kind: &'static str, note: impl Into<String>) {
    let note = note.into();
    let g = gen_lock();
    if *g == gen {
        set_pipeline(kind, note);
    } else if let Ok(mut p) = PIPELINE_PENDING.lock() {
        *p = Some((gen, kind, note));
    }
    drop(g);
}

/// Сделать поколение `gen` текущим. Возвращает прошлое поколение и прошлый путь кадра — для отката.
fn activate_gen(gen: u64) -> (u64, (&'static str, String)) {
    let mut g = gen_lock();
    let prev_gen = std::mem::replace(&mut *g, gen);
    let prev_pipe = PIPELINE.lock().map(|p| p.clone()).unwrap_or_default();
    if let Some((pg, kind, note)) = PIPELINE_PENDING.lock().ok().and_then(|mut p| p.take()) {
        if pg == gen {
            set_pipeline(kind, note);
        }
    }
    drop(g);
    (prev_gen, prev_pipe)
}

/// Откат `activate_gen`: вернуть прошлое поколение и его путь кадра.
fn restore_gen(gen: u64, pipe: (&'static str, String)) {
    let mut g = gen_lock();
    *g = gen;
    set_pipeline(pipe.0, pipe.1);
    drop(g);
}

/// Что и как снимать — всё, что нужно потоку захвата.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureTarget {
    /// Номер источника libwebrtc: монитор или HWND.
    pub id: u64,
    pub is_window: bool,
    /// Процесс окна на момент выбора: сторож источника (#99) отличает по нему «то же окно» от
    /// «номер достался другому». У экрана `None`.
    pub want_pid: Option<u32>,
    /// Потолок кадра: больше — уменьшаем с сохранением пропорций.
    pub tw: u32,
    pub th: u32,
    pub fps: u32,
    pub cursor: bool,
    /// Почему НЕ путь через видеокарту (#207, шаг 4). `None` — пробуем его.
    pub gpu_skip: Option<&'static str>,
}

/// С чем показ запущен — то, что нужно, чтобы собрать цель для НОВОГО источника тем же правилом,
/// что на старте. Качество при смене не меняется (решение владельца 27.10, Р2).
#[derive(Clone, Debug)]
pub struct ShareCfg {
    /// «Родное» (0×0): размер источника, вписанный в 4K.
    pub native: bool,
    /// Потолок из настроек (у «Родного» 0×0).
    pub width: u32,
    pub height: u32,
    /// Частота из настроек (от неё считается битрейт) и та, с которой снимаем (`mode_fps`).
    pub cfg_fps: u32,
    pub fps: u32,
    pub mode: String,
    pub codec: String,
    pub gpu_pipeline: bool,
    pub cursor: bool,
    /// Слои показа — как решил старт (`decide_layers`).
    pub layers: bool,
}

/// Цель захвата и размер, с которым публикуются кодировки, — общее правило старта и смены.
///
/// `known` — настоящий размер источника (`native_dims`), нужен только «Родному»: экран с известным
/// размером снимаем ровно им, окно и неизвестное держит рамка 4K (окно растягивают на лету).
/// Не узнали размер — объявляем 1080p, а кадр всё равно уходит родным.
pub fn capture_target_for(
    c: &ShareCfg,
    id: u64,
    is_window: bool,
    known: Option<(u32, u32)>,
    want_pid: Option<u32>,
) -> (CaptureTarget, (u32, u32)) {
    let (width, height) = if c.native {
        let (w, h) = known.unwrap_or((1920, 1080));
        fit_native(w, h)
    } else {
        (c.width, c.height)
    };
    let (tw, th) = if !c.native {
        (c.width, c.height)
    } else if is_window || known.is_none() {
        (NATIVE_MAX_W, NATIVE_MAX_H)
    } else {
        (width, height)
    };
    // Путь кадра (#207, шаг 4): новый — только для экрана, H.264 и включённой настройки.
    let gpu_skip: Option<&'static str> = if is_window {
        Some("показ окна")
    } else if !c.gpu_pipeline {
        Some("выключено в настройках")
    } else if c.codec != "h264" {
        Some("кодек не H.264")
    } else {
        None
    };
    let t = CaptureTarget {
        id,
        is_window,
        want_pid: if is_window { want_pid } else { None },
        tw,
        th,
        fps: c.fps,
        cursor: c.cursor,
        gpu_skip,
    };
    (t, (width, height))
}

/// Нужно ли при смене пересоздать публикацию (#237, Р1): только в «Родном» и только когда площадь
/// кадра выросла или упала БОЛЬШЕ чем вдвое. Битрейт и лестница слоёв посчитаны от размера на
/// старте, и без пересчёта окно 720p → экран 1440p пошло бы мылом. Фиксированное разрешение — кадр
/// и так вписывается в тот же потолок.
pub fn switch_needs_republish(native: bool, declared: (u32, u32), next: (u32, u32)) -> bool {
    if !native {
        return false;
    }
    let a = declared.0 as f64 * declared.1 as f64;
    let b = next.0 as f64 * next.1 as f64;
    if a <= 0.0 || b <= 0.0 {
        return false;
    }
    b > a * 2.0 || b * 2.0 < a
}

/// Итог смены источника: тот же, горячая смена под тем же треком, смена с переопубликацией.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchOutcome {
    Same,
    Hot,
    Republished,
}

impl SwitchOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            SwitchOutcome::Same => "same",
            SwitchOutcome::Hot => "hot",
            SwitchOutcome::Republished => "republished",
        }
    }
}

/// «Захват готов» — отправляется ОДИН раз: первым кадром, ошибкой или концом потока.
#[derive(Clone)]
struct ReadyTx(Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>>);

impl ReadyTx {
    fn send(&self, r: Result<(), String>) {
        if let Some(tx) = self.0.lock().ok().and_then(|mut g| g.take()) {
            let _ = tx.send(r);
        }
    }

    fn sent(&self) -> bool {
        self.0.lock().map(|g| g.is_none()).unwrap_or(true)
    }
}

/// Поток захвата одного поколения.
struct CaptureHandle {
    /// Свой стоп-флаг поколения; общий «показ кончился» — `Session.stop`, поток смотрит на оба.
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

/// Погасить поток захвата и дождаться его в `spawn_blocking` (не держа async-поток).
fn retire_capture(mut h: CaptureHandle) {
    h.stop.store(true, Ordering::Relaxed);
    if let Some(j) = h.join.take() {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = j.join();
        });
    }
}

/// Числа одного окна сторожа — всё, что нужно, чтобы решить «залипло или нет».
pub struct StuckInput {
    /// Целевая частота кадров показа.
    pub target_fps: f64,
    /// Сколько кадров в секунду МЫ СНЯЛИ за окно.
    pub cap_fps: f64,
    /// Сколько кадров в секунду КОДИРОВЩИК выдал за окно.
    pub enc_fps: f64,
    /// Среднее время захвата кадра за окно, мс.
    pub capture_ms: f64,
    /// Доля кадров, не уложившихся в бюджет, за окно.
    pub late_share: f64,
    /// Кодировщик жалуется именно на процессор (а не на канал и не молчит).
    pub limit_cpu: bool,
}

/// Похоже ли на залипание отправителя. ЧИСТАЯ функция — ради тестов: цена ошибки здесь высока в
/// обе стороны (пропустим — человек сидит с четырьмя кадрами; сработаем зря — моргание у всех).
///
/// Условия читаются как одно предложение: **кодировщик жалуется на процессор, хотя видеокарта уже
/// свободна, мы подаём норму, а он отдаёт вдвое меньше.**
///
/// ⚠️ Упор в КАНАЛ сюда не попадает сознательно: там ограничение честное, и пересоздание публикации
/// только оборвёт картинку, ничего не починив.
pub fn looks_stuck(i: &StuckInput) -> bool {
    // Нечисловое значение не должно превращаться в решение: сравнения с NaN всегда ложны, и
    // «не сработало» вышло бы случайно, а не по правилу.
    for v in [i.target_fps, i.cap_fps, i.enc_fps, i.capture_ms, i.late_share] {
        if !v.is_finite() {
            return false;
        }
    }
    i.limit_cpu
        && i.target_fps >= MIN_TARGET_FPS
        && i.capture_ms <= CAPTURE_FREE_MS
        && i.late_share <= MAX_LATE_SHARE
        && i.cap_fps >= i.target_fps * CAP_OK_SHARE
        && i.enc_fps <= i.target_fps * ENC_BAD_SHARE
        && i.enc_fps < i.cap_fps * ENC_VS_CAP_SHARE
}

/// Почему второй слой качества выключен не человеком, а нами.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayersOff {
    /// Поколение карты, на котором второй слой уже ронял приложение.
    OldGpu,
    /// Прошлый показ с двумя слоями оборвался смертью приложения — слой снят на ЭТОТ показ.
    Crash,
    /// Оборвался `CRASH_LIMIT` раз подряд — снимаем слой насовсем и правим настройку.
    CrashFinal,
}

impl LayersOff {
    pub fn as_str(self) -> &'static str {
        match self {
            LayersOff::OldGpu => "old-gpu",
            LayersOff::Crash => "crash",
            LayersOff::CrashFinal => "crash-final",
        }
    }
}

/// Слишком ли стара видеокарта для второго слоя. `None` = не NVIDIA или драйвер не сказал.
///
/// ⚠️ Неизвестность НЕ считаем поводом выключать: у владельцев AMD и Intel NVENC не участвует вовсе,
/// и отбирать у них запасной слой из-за чужой беды неправильно.
pub fn gpu_too_old(cc_major: Option<i32>) -> bool {
    matches!(cc_major, Some(major) if major < MODERN_GPU_MAJOR)
}

/// Сколько слоёв публиковать на самом деле и надо ли объяснить человеку, почему не как он просил.
///
/// 🔴 Правило целиком (#112): просьбу человека уважаем, кроме двух случаев — карта того поколения,
/// где слой уже ронял приложение, и прошлый показ, оборвавшийся смертью приложения.
///
/// ⚠️ Про старую карту говорим ОДИН раз (`already_told`): человек, включивший слой обратно
/// осознанно, не должен получать принудительное выключение на каждом показе. А вот свежее падение
/// перебивает и это — оно новее любого прошлого разговора.
///
/// 🔴 Падение снимает слой на ОДИН показ (#109, разбор 2026-09-06), и только `CRASH_LIMIT` падений
/// подряд — насовсем. `crash_streak` считает падения ВКЛЮЧАЯ текущее.
pub fn decide_layers(
    requested: bool,
    crashed_with_layers: bool,
    crash_streak: u32,
    old_gpu: bool,
    already_told: bool,
) -> (bool, Option<LayersOff>) {
    if !requested {
        return (false, None); // человек и так выключил — выключать нечего и говорить не о чем
    }
    if crashed_with_layers {
        let reason =
            if crash_streak >= CRASH_LIMIT { LayersOff::CrashFinal } else { LayersOff::Crash };
        return (false, Some(reason));
    }
    if old_gpu && !already_told {
        return (false, Some(LayersOff::OldGpu));
    }
    (true, None)
}

/// Сколько падений подряд записано. Нечитаемая/битая отметка = «падений не было»: потерять счётчик
/// безопаснее, чем отобрать слой по мусору.
fn streak_read(path: &Path) -> u32 {
    std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

fn streak_write(path: &Path, n: u32) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, n.to_string());
}

/// Отметить, что показ ИДЁТ (и с каким числом слоёв). Файл переживает смерть процесса — на этом
/// всё и держится: уцелел к следующему запуску, значит показ оборвался не кнопкой «Завершить».
fn marker_write(path: &Path, layers: bool) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, if layers { b"2" } else { b"1" });
}

/// Снимает отметку «показ идёт», если `start` вышел с ОШИБКОЙ, не дойдя до живой сессии.
///
/// 🔴 Разбор Codex, 06.09. Метка ставится ДО подключения к LiveKit и до разбора источника —
/// намеренно: приложение умирает и на самом старте показа, ровно этот случай защита и заводилась
/// ловить (#112, GTX 1060). Но обработанная ошибка — просроченный токен, кривой `source_id` — это
/// НЕ смерть, а метка оставалась лежать. Следующий показ читал её как улику падения: накручивал
/// серию, снимал второй слой и показывал предупреждение о падении, которого не было. Несколько
/// таких отказов подряд доводили до постоянного выключения слоя.
///
/// ⚠️ Почему именно `Drop`, а не снятие в каждой ветке ошибки: веток много, и следующая
/// добавленная неминуемо оказалась бы забыта. А главное — при НАСТОЯЩЕЙ смерти процесса `Drop` не
/// выполняется вовсе, и метка переживает её, как и задумано. То есть разделение получается само,
/// а не поддерживается вниманием.
struct ActiveMarkerGuard {
    path: Option<PathBuf>,
    armed: bool,
}

impl ActiveMarkerGuard {
    /// Поставить метку И взять её под охрану ОДНИМ действием.
    ///
    /// ⚠️ Именно одной функцией, а не двумя строками рядом (замечание Codex): порознь их однажды
    /// разнесут — запись останется наверху, страж уедет ниже первого `await`, и unit-тест на сам
    /// страж этого не заметит. Здесь их разнести физически нельзя.
    fn arm(path: Option<PathBuf>, layers: bool) -> Self {
        if let Some(p) = path.as_deref() {
            marker_write(p, layers);
        }
        Self { path, armed: true }
    }

    /// Показ поднялся — метка больше не «висящая», её судьбой заведует `stop()`.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ActiveMarkerGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(p) = self.path.as_deref() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Прибрать метки после ШТАТНО завершённого показа.
///
/// Вынесено из async `stop()` по просьбе Codex: там это решение сидело внутри работы с живой
/// комнатой и не проверялось ничем, хотя правило нетривиальное.
///
/// * отметку «показ идёт» снимаем ВСЕГДА — иначе следующий запуск сочтёт нормальную остановку
///   падением и отберёт второй слой ни за что (#112);
/// * серию падений обнуляем ТОЛЬКО после показа с двумя слоями: он и есть доказательство, что на
///   этой машине они живут. Иначе три беды, разнесённые на месяцы, однажды сложились бы в вечное
///   выключение (#109). Показ с одним слоем ничего про два не доказывает.
fn finish_share_markers(active: Option<&Path>, streak: Option<&Path>, simulcast: bool) {
    if let Some(p) = active {
        let _ = std::fs::remove_file(p);
    }
    if simulcast {
        if let Some(p) = streak {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Снять отметку «показ идёт» при ШТАТНОМ выходе из приложения.
///
/// 🔴 Без этого закрытие приложения с работающим показом неотличимо от смерти процесса: `stop()`
/// зовёт только кнопка «Завершить», а закрывают приложение как есть — с идущим показом это обычное
/// дело. Следующий показ засчитывал это падением и отбирал второй слой ни за что, а расплачивался
/// весь канал. Убитый диспетчером задач процесс сюда не попадает — и правильно, это и есть падение.
pub fn clear_active_marker(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::remove_file(dir.join(ACTIVE_MARKER));
    }
}

/// Прочитать отметку и СРАЗУ убрать. Возвращает «показ шёл с двумя слоями».
///
/// ⚠️ Убираем именно здесь, а не после успешного старта: не сумеем — и одно давнее падение будет
/// вечно отбирать второй слой у человека, который давно живёт нормально.
fn marker_take(path: &Path) -> Option<bool> {
    let raw = std::fs::read(path).ok();
    let _ = std::fs::remove_file(path);
    Some(raw?.first().copied() == Some(b'2'))
}

/// Потолок и пол битрейта среднего слоя. 720p на полной частоте кадров для экрана — 2–2,5 Мбит/с.
/// Сервер ближе этого — локалка (#207, 26.09). Задержка TCP-подключения до сервера LiveKit у владельца
/// ~1 мс, у знакомых через интернет — десятки.
const LAN_RTT_MS: f64 = 5.0;
/// Стартовый битрейт оценщика для сервера через интернет. У GCC по умолчанию 300 кбит/с, и полный
/// слой первые десятки секунд показа идёт мылом; 5 Мбит/с тянет почти любой домашний аплинк, а где не
/// тянет, оценщик сам сбавит.
const REMOTE_START_BPS: u64 = 5_000_000;
/// Запас нижней границы для локалки сверх бюджета лестницы, проценты. 26.09 с границей ровно в бюджет
/// (15,5 Мбит/с, оценка 15,7) полному слою доставалось 10,4 из 12,9: часть оценки WebRTC держит на
/// заголовки пакетов и повторы. В локалке запас ничего не стоит.
const LAN_HEADROOM_PCT: u64 = 130;
/// «Мягкий пол» оценщика через интернет (06.10, #207): доля бюджета лестницы, проценты, и потолок
/// самого пола. Без пола оценка после просадки (Wi-Fi, чужая закачка) падала до 1–3 Мбит/с, а на
/// статике ей не на чем расти — кодировщику нечего слать; полный слой голодал или выключался вовсе.
/// Пол 2,5 Мбит/с держит полный слой живым (экономный 0,15 + средний до 1,5 + минимум полного) и ниже
/// любого проводного аплинка 2026 года; выше не поднимаем — на узком аплинке пол заставил бы показ
/// давить голос того же человека.
const REMOTE_SOFT_FLOOR_PCT: u64 = 40;
const REMOTE_SOFT_FLOOR_MAX_BPS: u64 = 2_500_000;
/// Во сколько раз опорный кадр NVENC крупнее обычного (`lowDelayKeyFrameScale`, 06.10, #207). До 06.10 —
/// умолчание «сверхнизкой задержки», 1: опорный кадр (запрос PLI, новый зритель, возврат на полный
/// слой) получал биты обычного и вспыхивал мылом у всех зрителей.
///
/// Синтетический замер на этой сборке (1080p30, 4,2 Мбит/с, опорный кадр раз в 3 с, стенд 06.10):
/// - ×10 — QP окна с опорным кадром 39 → 31, в следующие 100 мс 43 → 35, весь следующий кадр-секунду
///   ниже на 3–4; статика и прокрутка на 1–2 QP лучше, частота у зрителя та же;
/// - ×4 — 39 → 37 и 43 → 40: мягче, всплеск опорного кадра меньше — для «Плавности» (игра);
/// - буфер VBV 0,25–0,5 с и настройка LOW_LATENCY вместо этого — ХУЖЕ исходного (QP после опорного 47–48):
///   не берём.
const DETAIL_KEYFRAME_SCALE: i32 = 10;
const MOTION_KEYFRAME_SCALE: i32 = 4;
/// Потолок частоты «Чёткости», к/с: текст и таблицы не нуждаются в 60, а лишние кадры съедают биты
/// каждого кадра.
const DETAIL_MAX_FPS: u32 = 30;
/// «Родное» разрешение вписываем в 4K: выше пресетов не было и нет (битрейт, сеансы NVENC).
const NATIVE_MAX_W: u32 = 3840;
const NATIVE_MAX_H: u32 = 2160;

/// Пойдёт ли кадр через видеокарту (#207, шаг 4) — решается ДО подключения, от этого зависит dynacast
/// (0.8.12). Те же условия, что у `gpu_skip` в `start`, плюс «NVENC есть». Откат посреди показа этим не
/// предсказать — он случается уже после подключения.
pub fn gpu_path_planned(is_window: bool, gpu_pipeline: bool, codec: &str, nvenc: bool) -> bool {
    !is_window && gpu_pipeline && codec == "h264" && nvenc
}

/// Включать ли dynacast показу. Только когда кадр идёт через процессор И слоёв несколько.
///
/// 🔴 27.10 (v0.9.50): показ ОКНА с «Максимальным качеством» был у всех зрителей чёрным. Окно идёт
/// через процессор → dynacast включён; «Максимальное качество» оставляет один слой без имени (`rid`
/// пустой) → SDK по ответу сервера о смотримых слоях не находит его среди слоёв и выключает: захват
/// шёл 60 к/с, кодировщик не получил ни кадра (`frames_encoded` 0, слой `active` 0, PLI копятся).
/// С одним слоем dynacast экономить нечего, кроме паузы без зрителей.
pub fn share_dynacast(gpu_planned: bool, layers: bool) -> bool {
    !gpu_planned && layers
}

/// Подсказка оценщику канала WebRTC: `(старт, нижняя граница)`, бит/с, 0 — не трогать.
///
/// 🔴 26.09 на гигабитной локалке оценщик застрял на 5,9 Мбит/с, а полный слой получал 3,5 из 12,9 —
/// картинка сыпалась на каждой смене сцены (панель: цели q 0,15 · h 1,88 · f 3,56 = оценка). Для
/// сервера в локалке узким местом канал быть не может, поэтому старт и нижняя граница = бюджет
/// лестницы с запасом `LAN_HEADROOM_PCT`. Через интернет — только быстрый старт: нижняя граница там
/// уронила бы показ тем, у кого аплинк уже бюджета.
///
/// 🔴 06.10: через интернет — ещё и «мягкий пол» (`REMOTE_SOFT_FLOOR_*`): быстрое восстановление после
/// просадки, полный слой не голодает и не выключается. Высокий пол — только по галочке
/// «Максимальное качество» (`max_quality_hint`).
pub fn bitrate_hint(ladder_bps: u64, server_rtt_ms: Option<f64>) -> (u64, u64) {
    match server_rtt_ms {
        Some(rtt) if rtt < LAN_RTT_MS => {
            let floor = ladder_bps * LAN_HEADROOM_PCT / 100;
            (floor, floor)
        }
        _ => {
            let floor = (ladder_bps * REMOTE_SOFT_FLOOR_PCT / 100).min(REMOTE_SOFT_FLOOR_MAX_BPS);
            (ladder_bps.min(REMOTE_START_BPS).max(floor), floor)
        }
    }
}

/// Подсказка оценщику для «Максимального качества» (06.10): старт и нижняя граница = битрейт полного
/// слоя с тем же запасом, что у локалки (`LAN_HEADROOM_PCT`: часть оценки уходит на заголовки и
/// повторы) — и через интернет тоже. Слоёв под полным при этой галочке нет.
pub fn max_quality_hint(full_bps: u64) -> (u64, u64) {
    let floor = full_bps * LAN_HEADROOM_PCT / 100;
    (floor, floor)
}

/// Множитель опорного кадра NVENC под режим показа (`lowDelayKeyFrameScale`). Неизвестный режим — как
/// «Чёткость» (умолчание клиента).
pub fn keyframe_scale(mode: &str) -> i32 {
    if mode == "motion" {
        MOTION_KEYFRAME_SCALE
    } else {
        DETAIL_KEYFRAME_SCALE
    }
}

/// Частота кадров показа с учётом режима: «Чёткость» — не выше `DETAIL_MAX_FPS` (06.10, решение
/// владельца), «Плавность» — как выбрана. Пределы 5–60 — как и раньше.
pub fn mode_fps(mode: &str, fps: u32) -> u32 {
    let fps = fps.clamp(5, 60);
    if mode == "motion" {
        fps
    } else {
        fps.min(DETAIL_MAX_FPS)
    }
}

/// Опорные точки битрейта экрана: площадь кадра → бит/с при 30 к/с в «Чёткости» без поправки на
/// кодек. Ровно таблица клиента (`bitrateFor`: 720p 1,5 · 1080p 3 · 1440p 5 · 4K 8 Мбит/с).
const BITRATE_ANCHORS: [(f64, f64); 4] = [
    (1280.0 * 720.0, 1_500_000.0),
    (1920.0 * 1080.0, 3_000_000.0),
    (2560.0 * 1440.0, 5_000_000.0),
    (3840.0 * 2160.0, 8_000_000.0),
];

/// Базовый битрейт по площади кадра: между опорными точками — по прямой, ниже первой —
/// пропорционально (не меньше 0,5 Мбит/с), выше последней — как у 4K.
fn base_bitrate_for_pixels(pixels: f64) -> f64 {
    let a = &BITRATE_ANCHORS;
    if pixels <= a[0].0 {
        return (a[0].1 * pixels / a[0].0).max(500_000.0);
    }
    for i in 1..a.len() {
        if pixels <= a[i].0 {
            let (p0, b0) = a[i - 1];
            let (p1, b1) = a[i];
            return b0 + (b1 - b0) * (pixels - p0) / (p1 - p0);
        }
    }
    a[a.len() - 1].1
}

/// Битрейт полного слоя для «Родного» разрешения (06.10) — 🔴 ДВОЙНИК `bitrateForDims` в
/// `streamSettings.ts`, числа обязаны совпадать (там же и подпись «≈ N Мбит/с» в окне показа). На
/// размерах пресетов даёт ровно их числа. Множители — те же: 60 к/с ×1,6, 15 к/с ×0,75,
/// «Плавность» ×1,15, H.264 ×1,4. Частота — ВЫБРАННАЯ, а не урезанная «Чёткостью»: клиент считает так же.
pub fn share_bitrate(width: u32, height: u32, fps: u32, motion: bool, h264: bool) -> u64 {
    let fps_mul = if fps == 60 {
        1.6
    } else if fps == 30 {
        1.0
    } else {
        0.75
    };
    let mode_mul = if motion { 1.15 } else { 1.0 };
    let codec_mul = if h264 { 1.4 } else { 1.0 };
    let base = base_bitrate_for_pixels(width as f64 * height as f64);
    (base * fps_mul * mode_mul * codec_mul).round() as u64
}

/// Вписать «родной» размер в 4K с сохранением пропорций, чётные стороны (06.10).
pub fn fit_native(width: u32, height: u32) -> (u32, u32) {
    let (w, h) = (width.max(2), height.max(2));
    let (bw, bh) = if w >= h { (NATIVE_MAX_W, NATIVE_MAX_H) } else { (NATIVE_MAX_H, NATIVE_MAX_W) };
    let scale = (bw as f64 / w as f64).min(bh as f64 / h as f64).min(1.0);
    let even = |v: f64| ((v as u32) & !1).max(2);
    (even(w as f64 * scale), even(h as f64 * scale))
}

/// Настоящий размер источника для «Родного» (06.10): экран — режим монитора (`EnumDisplaySettingsW`
/// по тому же номеру libwebrtc, что `screen_attached`), окно — его прямоугольник. `None` — не узнали.
fn native_dims(is_window: bool, id: u64) -> Option<(u32, u32)> {
    if is_window {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
        let mut r = RECT::default();
        // SAFETY: HWND из источника libwebrtc; мёртвый дескриптор даёт ошибку, а не UB.
        unsafe { GetWindowRect(HWND(id as usize as *mut core::ffi::c_void), &mut r) }.ok()?;
        let (w, h) = ((r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32);
        // Свёрнутое окно отдаёт прямоугольник-заглушку ~160×28 — по нему битрейт и слои вышли бы крошечными
        // на весь показ. Меньше 320×180 — «не узнали» (тогда 1080p, а кадр всё равно уходит родным).
        return (w >= 320 && h >= 180).then_some((w, h));
    }
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW, ENUM_CURRENT_SETTINGS,
    };
    let index = u32::try_from(id).ok()?;
    let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
    // SAFETY: наши структуры с верным размером, указатели живут весь вызов.
    if !unsafe { EnumDisplayDevicesW(windows::core::PCWSTR::null(), index, &mut dd, 0) }.as_bool() {
        return None;
    }
    let mut dm = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
    let name = windows::core::PCWSTR::from_raw(dd.DeviceName.as_ptr());
    if !unsafe { EnumDisplaySettingsW(name, ENUM_CURRENT_SETTINGS, &mut dm) }.as_bool() {
        return None;
    }
    (dm.dmPelsWidth >= 2 && dm.dmPelsHeight >= 2).then_some((dm.dmPelsWidth, dm.dmPelsHeight))
}

/// С чем показ запущен НА САМОМ ДЕЛЕ — после «Родного», режима и галочки качества (06.10). Уезжает в
/// статистику: без этого по отчёту не понять, какой потолок и какой битрейт были у показа.
#[derive(Clone, Default)]
struct EffectiveCfg {
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u64,
    mode: String,
    max_quality: bool,
    layers: bool,
    keyframe_scale: i32,
}

static EFFECTIVE: Mutex<Option<EffectiveCfg>> = Mutex::new(None);

/// Задержка TCP-подключения до сервера из адреса LiveKit, мс: лучшая из трёх попыток. `None` — не
/// достучались (тогда считаем, что сервер через интернет).
fn server_rtt_ms(url: &str) -> Option<f64> {
    use std::net::ToSocketAddrs;
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host_port = rest.split(['/', '?']).next()?;
    let default_port = if url.starts_with("ws://") || url.starts_with("http://") { 80 } else { 443 };
    let target =
        if host_port.contains(':') { host_port.to_string() } else { format!("{host_port}:{default_port}") };
    let addr = target.to_socket_addrs().ok()?.next()?;
    let mut best: Option<f64> = None;
    for _ in 0..3 {
        let t = Instant::now();
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            best = Some(best.map_or(ms, |b: f64| b.min(ms)));
        }
    }
    best
}

/// Подсказка, выданная оценщику для текущего показа: `(старт, нижняя граница, задержка до сервера)`.
static BWE_HINT: Mutex<(u64, u64, f64)> = Mutex::new((0, 0, 0.0));

/// Сколько тиков подряд захват в видеокарте может быть потерян (смена режима экрана, UAC,
/// полноэкранная игра), прежде чем уйдём на старый путь. ~5 с при 60 к/с.
const GPU_LOST_TICKS: u32 = 300;

enum GpuEnd {
    /// Показ остановлен штатно.
    Stopped,
    /// Новый путь недоступен или отказал: продолжаем старым, причина уже в `PIPELINE`.
    Fallback,
}

/// Захват экрана, при котором кадр не покидает видеокарту (#207, шаг 4.2).
///
/// Цикл повторяет старый: пейсинг по дедлайну, те же счётчики конвейера, превью раз в 5 с. Разница
/// в том, что уходит в источник: не I420 в оперативке, а общая D3D11-текстура, которую кодировщик
/// NVENC каждого слоя сам переводит в NV12 и уменьшает (`nvidia/gv_d3d11_converter.h`).
/// «Подготовки кадра» здесь нет вовсе, поэтому `convert_ms` у такого показа — ноль.
///
/// Смена источника (#237): поколение `gen` отдаёт кадры, только пока оно текущее. Кадр из видеопамяти
/// уходит в источник прямо внутри `capture`, «снять, но не отдать» нельзя, поэтому готовность
/// (`ready`) здесь — поднятое дублирование DXGI и перевод цвета, а не первый кадр; до победы поток
/// спит и `capture` не зовёт.
fn run_gpu_capture(
    t: &CaptureTarget,
    vs: &NativeVideoSource,
    gen: u64,
    first: bool,
    ready: &ReadyTx,
    stopped: &dyn Fn() -> bool,
) -> GpuEnd {
    use webrtc_sys::gv_gpu_capture::ffi as gpu;
    if !gpu::gpu_capture_supported() {
        set_pipeline_for(gen, "cpu", "NVENC недоступен");
        return GpuEnd::Fallback;
    }
    let Ok(index) = i32::try_from(t.id) else {
        set_pipeline_for(gen, "cpu", "номер экрана вне диапазона");
        return GpuEnd::Fallback;
    };
    let mut cap = gpu::new_gpu_screen_capture(index, t.tw, t.th, t.cursor);
    let Some(info) = cap.as_ref() else {
        set_pipeline_for(gen, "cpu", "захват не создан");
        return GpuEnd::Fallback;
    };
    let err = info.init_error().to_string();
    if !err.is_empty() {
        set_pipeline_for(gen, "cpu", err);
        return GpuEnd::Fallback;
    }
    let (fw, fh) = (info.frame_width(), info.frame_height());
    let (src_w, src_h) = (info.source_width(), info.source_height());
    let sys = vs.sys_handle();
    let Some(source) = sys.as_ref() else {
        set_pipeline_for(gen, "cpu", "нет C++-источника");
        return GpuEnd::Fallback;
    };
    // Курсор не поднялся — показ всё равно идёт через видеокарту, просто без курсора. Причину видно
    // в «Пути кадра» (панель и телеметрия), иначе «курсора нет» не отличить от «галочка выключена».
    let cursor_err = if t.cursor { info.cursor_error().to_string() } else { String::new() };
    set_pipeline_for(gen, "gpu", if cursor_err.is_empty() { String::new() } else { format!("курсор: {cursor_err}") });

    // 🔴 Один обычный кадр ДО кадров из видеопамяти. Они идут мимо `capture_frame`, SDK их не
    // считает и до первого «своего» кадра подмешивает чёрные раз в 100 мс — вперемешку с нашими
    // (вендоренный libwebrtc, GUSVOICE.md). Чёрный честно: Y=16, U=V=128, а не нули — те зелёные.
    // 🔴 Только первому захвату ИСТОЧНИКА (`first`): при горячей смене (#237) источник уже видел свои
    // кадры, и чёрный кадр у зрителей мигнул бы.
    if first {
        let mut black = I420Buffer::new(fw, fh);
        {
            let (y, u, v) = black.data_mut();
            y.fill(16);
            u.fill(128);
            v.fill(128);
        }
        vs.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, black));
    }
    ready.send(Ok(()));

    let frame_dur = Duration::from_micros(1_000_000 / t.fps.max(1) as u64);
    let mut next = Instant::now();
    let mut next_preview = Instant::now();
    let mut lost_run = 0u32;
    let mut rgba = Vec::new();
    while !stopped() {
        let t0 = Instant::now();
        // Не текущее поколение: кадр не снимаем вовсе — он ушёл бы в источник поверх чужих.
        let Some(status) = with_live_gen(gen, || cap.pin_mut().capture(source, 0)) else {
            std::thread::sleep(IDLE_GEN_SLEEP);
            next = Instant::now();
            continue;
        };
        PIPE_TOTAL_US.fetch_add(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
        PIPE_SRC_W.store(src_w, Ordering::Relaxed);
        PIPE_SRC_H.store(src_h, Ordering::Relaxed);
        match status {
            // Кадр ушёл: новый, повтор (экран не менялся) или повтор вместо пропущенного.
            0 | 1 | 4 | 5 => {
                PIPE_FRAMES.fetch_add(1, Ordering::Relaxed);
                lost_run = 0;
            }
            2 => {} // с экрана ещё не пришло ни одного кадра
            3 => {
                lost_run += 1;
                if lost_run >= GPU_LOST_TICKS {
                    set_pipeline_for(gen, "cpu", "захват DXGI потерян");
                    return GpuEnd::Fallback;
                }
            }
            -2 => {
                let why = gpu::native_encode_fail_reason().to_string();
                set_pipeline_for(gen, "cpu", format!("кодировщик не взял кадр из видеопамяти: {why}"));
                return GpuEnd::Fallback;
            }
            -3 => {
                set_pipeline_for(gen, "cpu", "кадр захвата не в BGRA (HDR?)");
                return GpuEnd::Fallback;
            }
            _ => {
                set_pipeline_for(gen, "cpu", format!("захват DXGI: код {status}"));
                return GpuEnd::Fallback;
            }
        }
        // Превью (#115) без ожидания видеокарты: первый вызов ставит копию в очередь, следующие
        // забирают её, когда готова.
        if Instant::now() >= next_preview {
            let packed = cap.pin_mut().poll_preview(&mut rgba);
            if packed != 0 {
                next_preview = Instant::now() + PREVIEW_EVERY;
                let (w, h) = ((packed >> 32) as usize, (packed & 0xffff_ffff) as usize);
                if let Ok(mut slot) = PREVIEW.lock() {
                    *slot = Some((w, h, std::mem::take(&mut rgba)));
                }
            }
        }
        next += frame_dur;
        match next.checked_duration_since(Instant::now()) {
            Some(rem) => std::thread::sleep(rem),
            None => {
                PIPE_LATE.fetch_add(1, Ordering::Relaxed);
                next = Instant::now();
            }
        }
    }
    GpuEnd::Stopped
}

const MID_MIN_BPS: u64 = 600_000;
/// 🔴 06.10 (#207): 1,5 Мбит/с вместо 2,5. Распределитель libwebrtc отдаёт нижним слоям их цель
/// ПЕРВЫМИ, а полному — остаток оценки канала: при оценке 6,5 полный 1080p+ получал ~3,85 Мбит/с, и
/// «высокое качество» лишь размазывало те же биты на больше точек. Средний слой смотрят единицы (зритель
/// на «Авто» просит полный, свёрнутый — экономный), а у пути через видеокарту он кодируется и без
/// зрителей (dynacast там выключен, 0.8.12). Миллион — полному слою.
const MID_MAX_BPS: u64 = 1_500_000;
/// Экономный слой — запасной (#109): лишь бы шло, поэтому 3 к/с.
const LOW_FPS: f64 = 3.0;
const LOW_MIN_BPS: u64 = 150_000;

/// Слои под полным: `[экономный]` или `[экономный, средний]` — в том порядке, в каком их ждёт SDK
/// (`simulcast_layers`: он снимает с конца средний, потом нижний) (#191, 24.09).
///
/// 🔴 Та же лестница — в клиенте (`shareLayerPresets` в `streamSettings.ts`), числа обязаны совпадать:
/// зритель не должен различать, из браузера показ или из приложения.
///
/// Почему своя, а не SDK: у показа экрана SDK добавляет РОВНО ОДИН слой — половина при 3 к/с
/// (`screenshare::compute_default_simulcast_preset`), с меткой MEDIUM у полного. Слоя HIGH не было,
/// сервер отдавал на «Среднее» тот же полный слой, и выбирать зрителю было между полным и слайд-шоу.
/// Теперь:
/// - средний — короткая сторона 720 (у 4K — 1080), ПОЛНАЯ частота кадров, до 1,5 Мбит/с (до 06.10 — 2,5);
/// - экономный — вдвое меньше среднего, 3 к/с (запасной слой #109, ~150 кбит/с);
/// - короткая сторона ≤ 720 — среднего нет, остаются полный и экономный, как раньше.
///
/// ⚠️ Каждый слой — свой сеанс NVENC (фабрика оборачивает в `SimulcastEncoderAdapter`), то есть
/// теперь ТРИ сеанса на показ. Потолок задаёт драйвер (на свежих — 8); упор = «показ не стартует»,
/// и тогда человеку выключатель слоёв в настройках показа.
///
/// Размер — ОБЪЯВЛЕННЫЙ (`cfg.width`×`cfg.height`, по настройке). SDK берёт из пресета только
/// короткую сторону и уменьшает реальный кадр во столько же раз.
pub fn share_layer_presets(width: u32, height: u32, max_bitrate: u64, fps: f64) -> Vec<VideoPreset> {
    let short = width.min(height).max(1);
    let scaled = |target: u32| -> (u32, u32) {
        let f = |side: u32| ((((side as f64 * target as f64 / short as f64) / 2.0).round() as u32) * 2).max(2);
        (f(width), f(height))
    };
    let low = |target: u32| -> VideoPreset {
        let (w, h) = scaled(target);
        let ratio = (target as f64 / short as f64).powi(2);
        let bps = ((max_bitrate as f64 * ratio * LOW_FPS / fps.max(1.0)).round() as u64).max(LOW_MIN_BPS);
        VideoPreset::new(w, h, bps, LOW_FPS)
    };
    if short <= 720 {
        return vec![low(((short as f64) / 2.0).round() as u32)];
    }
    let mid_short: u32 = if short >= 2160 { 1080 } else { 720 };
    let ratio = (mid_short as f64 / short as f64).powi(2);
    let mid_bps = ((max_bitrate as f64 * ratio * 1.5).round() as u64)
        .clamp(MID_MIN_BPS, MID_MAX_BPS)
        .min((max_bitrate as f64 * 0.6).round() as u64);
    let (mw, mh) = scaled(mid_short);
    vec![low(mid_short / 2), VideoPreset::new(mw, mh, mid_bps, fps)]
}

/// Целевые размеры кадра: вписать (sw, sh) в (tw, th) с сохранением пропорций. Только вниз, только
/// чётные. `None` — уменьшать не нужно, кадр уходит как есть.
///
/// Раньше это была функция `fit`, которая сразу и решала, и масштабировала. Решение отделено от
/// действия, потому что от ответа зависит СУДЬБА промежуточного буфера: при масштабировании он
/// остаётся у нас и переиспользуется, без него — уходит в libwebrtc (см. цикл захвата).
fn target_dims(sw: u32, sh: u32, tw: u32, th: u32) -> Option<(i32, i32)> {
    if tw == 0 || th == 0 || (sw <= tw && sh <= th) {
        return None;
    }
    let scale = (tw as f64 / sw as f64).min(th as f64 / sh as f64);
    let dw = (((sw as f64 * scale) as i32) & !1).max(2);
    let dh = (((sh as f64 * scale) as i32) & !1).max(2);
    Some((dw, dh))
}

/// Поднять поток захвата поколения `gen` над источником `vs` (#237: вынесено из `start`, чтобы смена
/// источника пересоздавала только его). `first` — первый захват этого ИСТОЧНИКА (старт или новая
/// публикация): только ему нужен чёрный кадр перед кадрами из видеопамяти.
///
/// Готовность (`Receiver`) приходит один раз: `Ok` с первым кадром (у пути через видеокарту — с
/// поднятым захватом, см. `run_gpu_capture`), `Err` — захватчик не создан или источника нет в списке.
/// Раньше это были молчаливые `return`: показ шёл без кадров, пока сторож источника не погасит.
fn spawn_capture(
    t: CaptureTarget,
    vs: NativeVideoSource,
    gen: u64,
    first: bool,
    session_stop: Arc<AtomicBool>,
) -> (CaptureHandle, tokio::sync::oneshot::Receiver<Result<(), String>>) {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = tokio::sync::oneshot::channel();
    let ready = ReadyTx(Arc::new(Mutex::new(Some(tx))));
    let own = stop.clone();
    // Capture runs on its own thread (DesktopCapturer lives entirely here).
    let join = std::thread::spawn(move || {
        let stopped = move || own.load(Ordering::Relaxed) || session_stop.load(Ordering::Relaxed);
        capture_thread(&t, &vs, gen, first, &ready, &stopped);
        // Поток кончился, не дав ни кадра: смена не должна ждать таймаута.
        ready.send(Err("источник не открылся: захват остановился".into()));
    });
    (CaptureHandle { stop, join: Some(join) }, rx)
}

fn capture_thread(
    t: &CaptureTarget,
    vs: &NativeVideoSource,
    gen: u64,
    first: bool,
    ready: &ReadyTx,
    stopped: &dyn Fn() -> bool,
) {
    match t.gpu_skip {
        None => {
            if let GpuEnd::Stopped = run_gpu_capture(t, vs, gen, first, ready, stopped) {
                return;
            }
            // Отказ — в том числе посреди показа. Дальше старым путём, кодировщики сами
            // вернутся к CUDA-сессии и начнут с опорного кадра.
        }
        Some(note) => set_pipeline_for(gen, "cpu", note),
    }
    let st = if t.is_window {
        DesktopCaptureSourceType::Window
    } else {
        DesktopCaptureSourceType::Screen
    };
    // Курсор — только здесь, в самом показе: миниатюрам окна выбора и сторожу источника он не нужен.
    let mut opts = DesktopCapturerOptions::new(st);
    opts.set_include_cursor(t.cursor);
    let Some(mut cap) = DesktopCapturer::new(opts) else {
        ready.send(Err("источник не открылся: захватчик не создан".into()));
        return;
    };
    let want_id = t.id;
    let Some(src) = cap.get_source_list().into_iter().find(|s| s.id() == want_id) else {
        ready.send(Err("источник не открылся: его нет в списке".into()));
        return;
    };
    let (tw, th) = (t.tw, t.th);
    let vs = vs.clone();
    let ready_cb = ready.clone();
    // 🔴 Полноразмерный буфер ПЕРЕИСПОЛЬЗУЕМ между кадрами. Раньше он выделялся заново на каждый
    // кадр, 30–60 раз в секунду: на 1440p это ~5.5 МБ за кадр, то есть сотни мегабайт в секунду
    // непрерывных выделений. Само по себе это не течёт, но делает нас самым частым просителем
    // памяти на машине — а отказ в выделении получает тот, кто просит в неудачный момент.
    // 2026-08-22 Windows объявила нехватку виртуальной памяти, и первым упал именно клиент,
    // хотя занимал меньше всех.
    //
    // ⚠️ Переиспользовать можно ТОЛЬКО тот буфер, который не ушёл наружу. Отданный в
    // `capture_frame` живёт дальше в конвейере кодирования (там свой счётчик ссылок, и из Rust
    // его не видно) — тронешь его на следующем кадре, получишь рваную картинку. Поэтому:
    // масштабируем — полноразмерный остаётся у нас; не масштабируем — он уходит, и следующий
    // кадр выделяет новый.
    let mut scratch: Option<I420Buffer> = None;
    // Первое превью собираем сразу с первого же кадра: иначе наведённая мышка первые пять секунд
    // показа не находила бы ничего.
    let mut next_preview = Instant::now();
    cap.start_capture(Some(src), move |res| {
        if let Ok(frame) = res {
            let t_conv = Instant::now();
            let w = frame.width() as usize;
            let h = frame.height() as usize;
            if w == 0 || h == 0 {
                return;
            }
            // Первый кадр нового источника = захват поднялся (#237).
            ready_cb.send(Ok(()));
            // Не текущее поколение: кадр выбрасываем, не тратя время на перевод цвета.
            if !gen_is_live(gen) {
                return;
            }
            PIPE_SRC_W.store(w as u32, Ordering::Relaxed);
            PIPE_SRC_H.store(h as u32, Ordering::Relaxed);
            let stride = frame.stride() as usize;
            // Размер источника меняется на лету (окно тянут за угол) — буфер не того размера
            // переиспользовать нельзя, проверяем перед тем, как взять.
            let mut buf = match scratch.take() {
                Some(b) if b.width() == w as u32 && b.height() == h as u32 => b,
                _ => I420Buffer::new(w as u32, h as u32),
            };
            bgra_to_i420(frame.data(), stride, w, h, &mut buf);
            // Кадр уходит в источник под замком поколения: смена могла случиться, пока переводили цвет.
            let sent = match target_dims(w as u32, h as u32, tw, th) {
                Some((dw, dh)) => {
                    let scaled = buf.scale(dw, dh);
                    scratch = Some(buf); // наружу ушла копия — полноразмерный снова наш
                    with_live_gen(gen, || {
                        vs.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, scaled))
                    })
                }
                None => {
                    // Уменьшать нечего: буфер уходит наружу, переиспользовать его нельзя.
                    with_live_gen(gen, || vs.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buf)))
                }
            };
            if sent.is_none() {
                return;
            }
            PIPE_CONV_US.fetch_add(t_conv.elapsed().as_micros() as u64, Ordering::Relaxed);
            PIPE_FRAMES.fetch_add(1, Ordering::Relaxed);
            // Превью (#115) — ПОСЛЕ замеров конвейера: это не подготовка кадра, и попав внутрь
            // `convert_ms` оно врало бы про стоимость самого показа.
            if Instant::now() >= next_preview {
                next_preview = Instant::now() + PREVIEW_EVERY;
                if let Some(small) = downscale_bgra(frame.data(), stride, w, h) {
                    if let Ok(mut slot) = PREVIEW.lock() {
                        *slot = Some(small);
                    }
                }
            }
        }
    });
    // 🔴 Пейсинг ПО ДЕДЛАЙНУ, а не `sleep(frame_dur)` поверх работы.
    // `capture_frame()` синхронно тянет за собой конвертацию BGRA→I420 (см. bgra_to_i420) —
    // это единицы-десятки мс на кадр, тем больше, чем выше разрешение. Старый код спал ПОЛНЫЙ
    // `frame_dur` СВЕРХУ этой работы → период = работа + сон, и до целевого fps не дотягивал
    // (на 3440×1440 выходило ~34 из 60, при том что NVENC простаивал — «Ограничение: нет»).
    // Теперь спим лишь ОСТАТОК до следующего тика: период = max(работа, frame_dur). Пока
    // конвертация укладывается в бюджет кадра — держим ровный целевой fps; когда не укладывается
    // (настоящий 4K), идём так быстро, как позволяет конвертация, без лишнего сна и без backlog.
    // Микросекунды, а не миллисекунды: `1000/60` целочисленно = 16 мс (не 16.67) — само по себе
    // роняло 60 → ~62.5, а с учётом округления и того ниже.
    let frame_dur = Duration::from_micros(1_000_000 / t.fps.max(1) as u64);
    let mut next = Instant::now();
    while !stopped() {
        // Поколение не текущее, а захват уже доказал, что живой: не снимаем вхолостую (старый
        // способ снимает экран за сотни мс). Ждём победы или стопа.
        if ready.sent() && !gen_is_live(gen) {
            std::thread::sleep(IDLE_GEN_SLEEP);
            next = Instant::now();
            continue;
        }
        // Замеряем ВЕСЬ вызов: он синхронно тянет за собой колбэк с подготовкой кадра. Время
        // самого захвата = это время минус подготовка, которую колбэк считает отдельно.
        let t_all = Instant::now();
        cap.capture_frame();
        if gen_is_live(gen) {
            PIPE_TOTAL_US.fetch_add(t_all.elapsed().as_micros() as u64, Ordering::Relaxed);
        }
        next += frame_dur;
        match next.checked_duration_since(Instant::now()) {
            Some(rem) => std::thread::sleep(rem),
            // Отстаём (конвертация тяжелее бюджета кадра) — не копим долг, сдвигаем дедлайн на «сейчас».
            None => {
                if gen_is_live(gen) {
                    PIPE_LATE.fetch_add(1, Ordering::Relaxed);
                }
                next = Instant::now();
            }
        }
    }
}

/// Опции публикации показа: старт, самолечение (#111) и переопубликация при смене (#237) строят их
/// одним правилом, иначе пересоздание молча сменило бы человеку качество.
fn share_publish_opts(
    codec: &str,
    max_bitrate: u64,
    fps: u32,
    layers: bool,
    presets: &[VideoPreset],
) -> TrackPublishOptions {
    // 🔴 Слои обязательны (#109). Раньше стоял `false` с доводом «нижний слой никто
    // не смотрит» — довод оказался неверным: его смотрит тот, кому плохо. Без запасного
    // слоя зритель с потерями не может получить картинку полегче и вместо этого просит
    // опорные кадры (PLI) — замерено 1.6 раза в секунду при норме 0.1. Каждый такой
    // запрос заставляет НАШ кодировщик выдать опорный кадр, а слой один на всех →
    // картинка пульсирует У ВСЕХ сразу. Один человек на мобильном интернете (47 %
    // потерь) так уронил весь канал.
    //
    // Слоёв ТРИ (#191, 24.09): полный, средний на полной частоте кадров и экономный на
    // 3 к/с — лестница и цена в `share_layer_presets`. До 0.8.5 SDK добавлял один
    // половинный на 3 к/с, и выбор качества у зрителя был между полным и слайд-шоу.
    // Выключатель `layers` в настройках показа возвращает один поток — на случай, если
    // драйвер не даст столько сеансов NVENC («показ не стартует»).
    TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: codec_of(codec),
        video_encoding: Some(VideoEncoding { max_bitrate, max_framerate: fps as f64 }),
        simulcast: layers,
        simulcast_layers: layers.then(|| presets.to_vec()),
        ..Default::default()
    }
}

/// Connect the companion participant, start capturing the chosen source, and publish it.
pub async fn start(cfg: StartConfig, app: tauri::AppHandle) -> Result<(), String> {
    stop().await; // tear down any in-flight share first

    // Режим захвата окна выставляем ДО создания захватчика: флаг читается в момент его
    // конструирования (см. `set_wgc_window_capture` в вендоренном webrtc-sys). Ставим всегда, а не
    // только при выключении, — иначе прошлый выбор протёк бы в следующий показ.
    webrtc_sys::desktop_capturer::ffi::set_wgc_window_capture(cfg.wgc_window);
    reset_pipe_meters(); // счётчики конвейера считаем от старта КАЖДОГО показа, а не от запуска приложения

    // Второй слой качества: решаем за человека только там, где он уже ронял приложение (#112).
    // ⚠️ Отметку прошлого показа читаем ПОСЛЕ `stop()` выше: штатная остановка её убирает, так что
    // уцелевшая отметка означает ровно одно — приложение умерло, не дойдя до кнопки «Завершить».
    let state_dir = app.path().app_config_dir().ok();
    let active_marker = state_dir.as_ref().map(|d| d.join(ACTIVE_MARKER));
    let told_marker = state_dir.as_ref().map(|d| d.join(TOLD_MARKER));
    let streak_marker = state_dir.as_ref().map(|d| d.join(STREAK_MARKER));
    let crashed_with_layers = active_marker.as_deref().and_then(marker_take).unwrap_or(false);
    // Считаем падения ДО решения и сразу записываем: решение зависит от длины серии, а серия должна
    // пережить и то падение, которое случится прямо сейчас.
    let crash_streak = if crashed_with_layers {
        let n = streak_marker.as_deref().map_or(0, streak_read).saturating_add(1);
        if let Some(p) = streak_marker.as_deref() {
            streak_write(p, n);
        }
        n
    } else {
        0
    };
    let old_gpu = gpu_too_old(crate::gpu_nvml::compute_capability().map(|(major, _)| major));
    let already_told = told_marker.as_deref().is_some_and(Path::exists);
    // «Максимальное качество» (06.10) выключает запасные слои само: вся полоса — полному. Это выбор
    // человека, а не наш, поэтому объяснять нечего (`decide_layers` с `requested = false` молчит).
    let requested_layers = cfg.layers && !cfg.max_quality;
    let (layers, off_reason) =
        decide_layers(requested_layers, crashed_with_layers, crash_streak, old_gpu, already_told);
    if let Some(reason) = off_reason {
        // Отметка «уже говорили» — только про старую карту: это свойство железа, и повторять его
        // человеку незачем. Про падение говорим каждый раз, оно каждый раз новое.
        if reason == LayersOff::OldGpu {
            if let Some(p) = told_marker.as_deref() {
                if let Some(dir) = p.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(p, b"1");
            }
        }
        // Молча подменять выбранную настройку нельзя: клиент по этому событию объяснит человеку, что
        // произошло, а на постоянных причинах ещё и выключит переключатель у себя.
        let _ = app.emit(LAYERS_OFF_EVENT, reason.as_str());
    }
    // Метка ставится и берётся под охрану ОДНИМ вызовом: с этого места и до поднятой сессии любая
    // ОБРАБОТАННАЯ ошибка обязана убрать её за собой — иначе она соврёт следующему запуску, что
    // приложение умирало. Смерть процесса `Drop` не зовёт, и метка её переживает, как и задумано.
    let mut marker_guard = ActiveMarkerGuard::arm(active_marker.clone(), layers);

    // ─── С чем показ пойдёт на самом деле (06.10, #207): «Родное», режим, «Максимальное качество» ───
    let want_id: u64 = cfg.source_id.parse().map_err(|_| "bad source id".to_string())?;
    // «Родное» (0×0): размер источника, вписанный в 4K. До 06.10 «1080p» на мониторе 1440p или
    // ультрашироком уменьшалось в НЕЦЕЛОЕ число раз — текст мылился ещё до кодировщика. Правило цели
    // и потолка кадра — `capture_target_for`, общее со сменой источника (#237).
    let native = cfg.width == 0 || cfg.height == 0;
    let known = if native { native_dims(cfg.is_window, want_id) } else { None };
    let share_cfg = ShareCfg {
        native,
        width: cfg.width,
        height: cfg.height,
        cfg_fps: cfg.fps,
        fps: mode_fps(&cfg.mode, cfg.fps),
        mode: cfg.mode.clone(),
        codec: cfg.codec.clone(),
        gpu_pipeline: cfg.gpu_pipeline,
        cursor: cfg.cursor,
        layers,
    };
    // Процесс окна снимаем ОДИН раз, на старте: дальше сторож сверяется именно с ним, иначе
    // «то же окно» было бы не отличить от «Windows выдала этот номер кому-то другому» (#99).
    let want_pid = if cfg.is_window { crate::apps_enum::window_pid(want_id) } else { None };
    let (target, (width, height)) = capture_target_for(&share_cfg, want_id, cfg.is_window, known, want_pid);
    let fps = mode_fps(&cfg.mode, cfg.fps);
    let max_bitrate = if native || cfg.max_bitrate == 0 {
        share_bitrate(width, height, cfg.fps, cfg.mode == "motion", cfg.codec == "h264")
    } else {
        cfg.max_bitrate
    };
    let presets = if layers { share_layer_presets(width, height, max_bitrate, fps as f64) } else { Vec::new() };
    // Множитель опорного кадра NVENC под режим — ДО публикации: кодировщики слоёв рождаются при ней.
    let kf_scale = keyframe_scale(&cfg.mode);
    webrtc_sys::gv_gpu_capture::ffi::set_screen_encoder_keyframe_scale(kf_scale);
    if let Ok(mut g) = EFFECTIVE.lock() {
        *g = Some(EffectiveCfg {
            width,
            height,
            fps,
            bitrate: max_bitrate,
            mode: if cfg.mode == "motion" { "motion".into() } else { "detail".into() },
            max_quality: cfg.max_quality,
            layers,
            keyframe_scale: kf_scale,
        });
    }

    // dynacast (0.8.12): ВЫКЛЮЧЕН только когда кадр пойдёт через видеокарту (#207, шаг 4), иначе включён.
    // Опыт 26.09 показал: «рассыпание» давал оценщик канала, а не dynacast. Но у пути через видеокарту
    // слои, которые никто не смотрит, почти ничего не стоят (NVENC и перевод цвета на видеокарте), а
    // каждое включение слоя после паузы адаптер слоёв libwebrtc встречает опорным кадром на ВСЕХ слоях —
    // лишняя пульсация у всех зрителей, когда кто-то переключает качество. Там, где слой — это работа
    // процессора (окно, софтверный кодек, не NVIDIA), экономия важнее — как в прошлых выпусках.
    // Путь кадра может откатиться посреди показа — тогда до конца показа dynacast выключен, это цена
    // уменьшения двух слоёв на процессоре у NVIDIA-машины, не больше.
    //
    // Как было (#207, плейбук 25.09): сервер говорит, какие слои кто-то смотрит, и SDK
    // выключает остальные. Без него все три слоя (#191) кодировались всегда — три сеанса NVENC и два
    // уменьшения на процессоре даже без единого зрителя. В SDK по умолчанию `dynacast: false`.
    // ⚠️ Без зрителей кодировщик честно выдаёт 0 к/с — в телеметрии `enc.fps` это не залипание.
    // Самолечение (#111) от этого не срабатывает: ему нужна жалоба «на процессор», а пауза слоёв её
    // не даёт.
    // `RoomOptions` в SDK `#[non_exhaustive]` — литерал с `..Default` не собирается.
    // Подсказка оценщику канала (#207, 26.09) — `bitrate_hint`. Ставится ДО подключения: соединения
    // создаются при входе в комнату, и `SetBitrate` применяется к каждому новому (в т. ч. при
    // переподключении). Бюджет — вся лестница слоёв. «Максимальное качество» (06.10) — свой пол
    // (`max_quality_hint`): битрейт пресета с запасом, где бы ни был сервер.
    let ladder_bps = max_bitrate + presets.iter().map(|p| p.encoding.max_bitrate).sum::<u64>();
    let rtt = {
        let url = cfg.url.clone();
        tokio::task::spawn_blocking(move || server_rtt_ms(&url)).await.ok().flatten()
    };
    let (hint_start, hint_min) =
        if cfg.max_quality { max_quality_hint(max_bitrate) } else { bitrate_hint(ladder_bps, rtt) };
    webrtc_sys::gv_gpu_capture::ffi::set_bitrate_hint(
        i32::try_from(hint_start).unwrap_or(i32::MAX),
        i32::try_from(hint_min).unwrap_or(i32::MAX),
    );
    if let Ok(mut g) = BWE_HINT.lock() {
        *g = (hint_start, hint_min, rtt.unwrap_or(-1.0));
    }

    let gpu_planned = gpu_path_planned(
        cfg.is_window,
        cfg.gpu_pipeline,
        &cfg.codec,
        webrtc_sys::gv_gpu_capture::ffi::gpu_capture_supported(),
    );
    let mut room_opts = RoomOptions::default();
    room_opts.dynacast = share_dynacast(gpu_planned, layers);
    let (room, mut events) = Room::connect(&cfg.url, &cfg.token, room_opts)
        .await
        .map_err(|e| format!("livekit connect: {e}"))?;
    // Drain room events so the channel doesn't grow unbounded; ends when the room closes.
    tokio::spawn(async move { while events.recv().await.is_some() {} });

    let source = NativeVideoSource::new(VideoResolution { width, height }, true);

    let stop = Arc::new(AtomicBool::new(false));
    // Первое поколение показа сразу текущее: старт, как и раньше, готовности захвата не ждёт.
    let gen = NEXT_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    activate_gen(gen);
    let (capture, _ready) = spawn_capture(target.clone(), source.clone(), gen, true, stop.clone());

    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    // Опции — отдельной переменной, а не прямо в вызове: ими же пересоздаётся публикация при
    // самолечении (#111), и разъехаться они не должны.
    let opts = share_publish_opts(&cfg.codec, max_bitrate, fps, layers, &presets);
    let publish = room
        .local_participant()
        .publish_track(LocalTrack::Video(track), opts.clone())
        .await;

    if let Err(e) = publish {
        stop.store(true, Ordering::Relaxed);
        retire_capture(capture);
        let _ = room.close().await;
        return Err(format!("publish: {e}"));
    }

    // Показ живой — метку дальше ведёт `stop()` (штатная остановка) либо она переживает падение.
    marker_guard.disarm();
    if let Ok(mut g) = SESSION.lock() {
        *g = Some(Session {
            stop: stop.clone(),
            room,
            source,
            opts,
            active_marker,
            streak_marker,
            capture,
            target,
            gen,
            share: share_cfg,
            declared: (width, height),
        });
    }

    // Сторож источника (#99): раз в 10 секунд проверяет, что окно/экран ещё существует.
    //
    // Зачем вообще: до этого закрытие игры не обрабатывалось НИКАК. Колбэк захвата отбрасывает
    // ошибку (`if let Ok(frame)`), поток продолжает крутиться вхолостую, трек остаётся
    // опубликованным — и зрители видели замерший последний кадр бесконечно, а стример по кнопке
    // «идёт показ» даже не догадывался.
    //
    // ⚠️ ОТДЕЛЬНАЯ задача, а не проверка внутри цикла захвата: перечисление экранов занимает
    // миллисекунды и сбивало бы пейсинг кадров (он там по дедлайну, см. комментарий в потоке выше).
    // ⚠️ Проверка — через `spawn_blocking`: она блокирующая (COM + обход окон), в async-задаче
    // это заняло бы поток исполнителя. Для окна путь теперь дешёвый (один вызов Win32), но
    // держим его там же: сторож не должен знать, какой из двух способов сработает.
    {
        let watch_stop = stop.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut misses: u32 = 0;
            let mut seen_gen = gen;
            loop {
                tokio::time::sleep(SOURCE_CHECK).await;
                if watch_stop.load(Ordering::Relaxed) {
                    return; // стрим уже остановлен обычным путём
                }
                // 🔴 Цель — ТЕКУЩАЯ, из сессии, а не копия со старта (#237): после смены источника
                // сторож иначе проверял бы старое окно и, когда его закроют, погасил бы живой показ.
                let Some((t, g)) = current_target(&watch_stop) else {
                    return;
                };
                if g != seen_gen {
                    seen_gen = g;
                    misses = 0; // промахи старого источника к новому не относятся
                }
                let alive = tauri::async_runtime::spawn_blocking(move || {
                    source_exists(t.is_window, t.id, t.want_pid)
                })
                .await
                .unwrap_or(true);
                // Флаг проверяем ПОВТОРНО: пока шло перечисление, человек мог нажать «Завершить».
                if watch_stop.load(Ordering::Relaxed) {
                    return;
                }
                // Пока проверяли, источник сменили (или смена идёт) — ответ про чужой источник.
                if SWITCHING.load(Ordering::SeqCst) || current_target(&watch_stop).map(|c| c.1) != Some(g) {
                    continue;
                }
                if alive {
                    misses = 0; // источник вернулся — прошлый промах был провалом, а не закрытием
                    continue;
                }
                misses += 1;
                if misses < MISSES_TO_END {
                    continue;
                }
                // Гасим И тут, И на клиенте (он в ответ на событие зовёт свой обычный stop): событие
                // может не дойти, а показывать мёртвый трек нельзя. `stop()` идемпотентен.
                let _ = app.emit(ENDED_EVENT, ());
                self::stop().await;
                return;
            }
        });
    }

    // Сторож ЗАЛИПАНИЯ (#111) — отдельная задача от сторожа источника: тот отвечает на «есть ли ещё
    // что показывать», этот на «доходит ли показанное до зрителей».
    {
        let watch_stop = stop.clone();
        let app = app.clone();
        let target_fps = fps as f64;
        tauri::async_runtime::spawn(async move {
            let mut prev: Option<Meters> = None;
            let mut bad: u32 = 0;
            let mut heals: u32 = 0;
            let mut cooldown_until: Option<Instant> = None;
            let mut seen_switches = SWITCHES.load(Ordering::Relaxed);

            loop {
                tokio::time::sleep(STUCK_WINDOW).await;
                if watch_stop.load(Ordering::Relaxed) {
                    return;
                }
                // Показ мог кончиться между сном и опросом — тогда сессии уже нет.
                let Some(st) = stats().await else {
                    prev = None;
                    continue;
                };
                let cur = Meters::now(st.frames_encoded);
                // Источник сменили (#237): окно через смену смешало бы два источника — замер заново.
                let switches = SWITCHES.load(Ordering::Relaxed);
                if switches != seen_switches {
                    seen_switches = switches;
                    prev = Some(cur);
                    bad = 0;
                    STUCK_S.store(0, Ordering::Relaxed);
                    continue;
                }
                let Some(p) = prev.replace(cur.clone()) else { continue };
                let Some(input) = cur.diff(&p, target_fps, st.limit_reason == "cpu") else {
                    continue;
                };
                CAPTURE_NOW_US.store((input.capture_ms * 1000.0) as u64, Ordering::Relaxed);

                // После лечения не считаем: публикация должна раскочегариться, иначе первое же окно
                // после пересоздания (кодировщик ещё разгоняется) выглядит как залипание.
                if let Some(until) = cooldown_until {
                    if Instant::now() < until {
                        bad = 0;
                        STUCK_S.store(0, Ordering::Relaxed);
                        continue;
                    }
                    cooldown_until = None;
                }

                bad = if looks_stuck(&input) { bad + 1 } else { 0 };
                STUCK_S.store(bad * STUCK_WINDOW.as_secs() as u32, Ordering::Relaxed);
                if bad < STUCK_WINDOWS || heals >= MAX_HEALS {
                    continue;
                }

                match republish().await {
                    Ok(()) => {
                        heals += 1;
                        HEALS.store(heals, Ordering::Relaxed);
                        bad = 0;
                        STUCK_S.store(0, Ordering::Relaxed);
                        cooldown_until = Some(Instant::now() + HEAL_COOLDOWN);
                        // Счётчики кодировщика у новой публикации начинаются с нуля — окно через
                        // этот разрыв считать нельзя, начинаем замер заново.
                        prev = None;
                        let _ = app.emit(HEALED_EVENT, heals);
                    }
                    // Не смогли даже начать (показ уже гасят, публикации нет) — просто ждём дальше.
                    Err(HealError::NotNow(why)) => {
                        eprintln!("screenshare: пересоздание отложено: {why}");
                        bad = 0;
                    }
                    // Трек сняли, а вернуть не смогли: показывать больше нечего. Гасим ЧЕСТНО, как
                    // при исчезнувшем источнике, — иначе человек остался бы с мёртвой кнопкой
                    // «идёт показ» и чёрным экраном у зрителей.
                    Err(HealError::Lost(why)) => {
                        eprintln!("screenshare: пересоздание провалилось, показ потерян: {why}");
                        let _ = app.emit(ENDED_EVENT, ());
                        self::stop().await;
                        return;
                    }
                }
            }
        });
    }

    Ok(())
}

/// Снимок накопительных счётчиков конвейера + кодировщика на момент времени.
#[derive(Clone)]
struct Meters {
    at: Instant,
    cap_frames: u64,
    total_us: u64,
    conv_us: u64,
    late: u64,
    enc_frames: u32,
}

impl Meters {
    fn now(enc_frames: u32) -> Self {
        Self {
            at: Instant::now(),
            cap_frames: PIPE_FRAMES.load(Ordering::Relaxed),
            total_us: PIPE_TOTAL_US.load(Ordering::Relaxed),
            conv_us: PIPE_CONV_US.load(Ordering::Relaxed),
            late: PIPE_LATE.load(Ordering::Relaxed),
            enc_frames,
        }
    }

    /// Разница с предыдущим снимком в виде «за секунду». `None` — окно негодное.
    fn diff(&self, prev: &Meters, target_fps: f64, limit_cpu: bool) -> Option<StuckInput> {
        let dt = self.at.duration_since(prev.at).as_secs_f64();
        // ⚠️ Счётчик кодировщика УМЕНЬШИЛСЯ — значит публикация пересоздана (нашим же лечением) и
        // отсчёт пошёл с нуля. Такое окно не характеризует ничего.
        if dt < 1.0 || self.enc_frames < prev.enc_frames {
            return None;
        }
        let d_cap = self.cap_frames.saturating_sub(prev.cap_frames) as f64;
        if d_cap <= 0.0 {
            // Захват вообще ничего не дал: либо показывают статичное окно, либо всё встало. Ни то
            // ни другое не лечится пересозданием публикации.
            return None;
        }
        let d_us = self.total_us.saturating_sub(prev.total_us) as f64;
        let d_conv = self.conv_us.saturating_sub(prev.conv_us) as f64;
        Some(StuckInput {
            target_fps,
            cap_fps: d_cap / dt,
            enc_fps: self.enc_frames.saturating_sub(prev.enc_frames) as f64 / dt,
            // Захват = весь вызов минус подготовка кадра, поделить на кадры окна.
            capture_ms: (d_us - d_conv).max(0.0) / d_cap / 1000.0,
            late_share: self.late.saturating_sub(prev.late) as f64 / d_cap,
            limit_cpu,
        })
    }
}

/// Текущая цель захвата и номер поколения — у сессии с этим стоп-флагом. `None` — её уже нет.
fn current_target(session_stop: &Arc<AtomicBool>) -> Option<(CaptureTarget, u64)> {
    let g = SESSION.lock().ok()?;
    let s = g.as_ref().filter(|s| Arc::ptr_eq(&s.stop, session_stop))?;
    Some((s.target.clone(), s.gen))
}

/// Почему лечение не состоялось.
enum HealError {
    /// Сейчас нечего пересоздавать — подождём следующего окна.
    NotNow(String),
    /// 🔴 Трек СНЯТ, а опубликовать заново не вышло: показа больше нет, и молчать об этом нельзя.
    Lost(String),
}

/// Пересоздать публикацию показа, НЕ ТРОГАЯ захват (#111).
///
/// Поток захвата продолжает писать в тот же источник всё это время: клон `NativeVideoSource` внутри
/// разделяемый, а не копия. Поэтому переживают и выбор источника, и режим захвата окна, и прогретый
/// WGC — пересоздаётся только отправитель, в котором и залипло ограничение. Провал для зрителя —
/// около секунды вместо полного перезапуска показа.
async fn republish() -> Result<(), HealError> {
    // Смена источника (#237) сама снимает и публикует трек — второй снимающий ей помешал бы.
    if SWITCHING.load(Ordering::SeqCst) {
        return Err(HealError::NotNow("идёт смена источника".into()));
    }
    let (local, source, opts) = {
        let g = SESSION.lock().map_err(|_| HealError::NotNow("сессия занята".into()))?;
        let s = g.as_ref().ok_or_else(|| HealError::NotNow("показ уже остановлен".into()))?;
        (s.room.local_participant(), s.source.clone(), s.opts.clone())
    };
    republish_with(&local, source, opts).await
}

/// Снять трек показа и опубликовать новый поверх `source` с опциями `opts`: самолечение (#111) — тем
/// же источником и опциями, смена источника с переопубликацией (#237) — новыми.
async fn republish_with(
    local: &LocalParticipant,
    source: NativeVideoSource,
    opts: TrackPublishOptions,
) -> Result<(), HealError> {

    // ⚠️ Проверяем, что трек на месте, ДО снятия: `unpublish_track` внутри разворачивает
    // `publication.track().unwrap()` и на пустой публикации паникует.
    let (sid, alive) = local
        .track_publications()
        .into_iter()
        .find(|(_, p)| p.source() == TrackSource::Screenshare)
        .map(|(sid, p)| (sid, p.track().is_some()))
        .ok_or_else(|| HealError::NotNow("публикации показа нет".into()))?;
    if !alive {
        return Err(HealError::NotNow("трек уже снят".into()));
    }

    local
        .unpublish_track(&sid)
        .await
        .map_err(|e| HealError::NotNow(format!("снять трек: {e}")))?;
    tokio::time::sleep(REPUBLISH_GAP).await;

    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source));
    local
        .publish_track(LocalTrack::Video(track), opts)
        .await
        .map_err(|e| HealError::Lost(format!("опубликовать заново: {e}")))?;
    Ok(())
}

/// Снимает флаг «смена идёт» на любом выходе из `switch_source`.
struct SwitchingGuard;

impl Drop for SwitchingGuard {
    fn drop(&mut self) {
        SWITCHING.store(false, Ordering::SeqCst);
    }
}

/// Сменить источник идущего показа, не останавливая его (#237, «Сменить окно» как в Discord).
///
/// Трек, `NativeVideoSource` и участник `#screen` остаются — зрители не получают ни одного события,
/// меняются только кадры (при другом размере кодировщик сам начинает с опорного). Порядок:
/// 1. новый поток захвата поднимается РЯДОМ со старым, его кадры пока выбрасываются (`ACTIVE_GEN`);
/// 2. ждём его готовности ≤ 3 с — ошибка или таймаут гасят только новый, старый показ идёт дальше;
/// 3. новое поколение становится текущим, и только потом гасим старое.
///
/// В «Родном» при скачке площади кадра больше чем вдвое (`switch_needs_republish`) публикация
/// пересоздаётся под новый размер (новый источник с новым объявленным размером: кодировки SDK считает
/// от него) — у зрителей ~1 с моргания, его глотают грейсы клиента (3 и 6 с). Качество, режим, кодек
/// и слои не меняются (решения владельца 27.10, Р1/Р2).
pub async fn switch_source(source_id: String, is_window: bool, app: tauri::AppHandle) -> Result<SwitchOutcome, String> {
    let id: u64 = source_id.parse().map_err(|_| "bad source id".to_string())?;
    if SWITCHING.swap(true, Ordering::SeqCst) {
        return Err("смена источника уже идёт".into());
    }
    let _busy = SwitchingGuard;

    let (old_gen, share, declared, session_stop, source, local) = {
        let g = SESSION.lock().map_err(|_| "показ не идёт".to_string())?;
        let s = g.as_ref().ok_or_else(|| "показ не идёт".to_string())?;
        if s.target.id == id && s.target.is_window == is_window {
            return Ok(SwitchOutcome::Same);
        }
        (s.gen, s.share.clone(), s.declared, s.stop.clone(), s.source.clone(), s.room.local_participant())
    };

    // Цель — тем же правилом, что на старте. Win32-запросы блокирующие — не на async-потоке.
    let share_b = share.clone();
    let (target, next) = tauri::async_runtime::spawn_blocking(move || {
        let known = if share_b.native { native_dims(is_window, id) } else { None };
        let want_pid = if is_window { crate::apps_enum::window_pid(id) } else { None };
        capture_target_for(&share_b, id, is_window, known, want_pid)
    })
    .await
    .map_err(|e| format!("источник не открылся: {e}"))?;
    if target.is_window && target.want_pid.is_none() {
        return Err("источник не открылся: окна уже нет".into());
    }

    let republish = switch_needs_republish(share.native, declared, next);
    // Переопубликация — новый источник: объявленный размер источника SDK берёт для кодировок слоёв,
    // а поменять его у живого источника нельзя.
    let vs = if republish {
        NativeVideoSource::new(VideoResolution { width: next.0, height: next.1 }, true)
    } else {
        source
    };
    let gen = NEXT_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let (handle, ready) = spawn_capture(target.clone(), vs.clone(), gen, republish, session_stop.clone());
    let up = match tokio::time::timeout(SWITCH_READY_TIMEOUT, ready).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("источник не открылся".to_string()),
        Err(_) => Err("таймаут: источник не дал кадра за 3 с".to_string()),
    };
    if let Err(e) = up {
        retire_capture(handle);
        return Err(e);
    }
    // Пока ждали, показ могли завершить или начать заново.
    if session_stop.load(Ordering::Relaxed) || current_target(&session_stop).is_none() {
        retire_capture(handle);
        return Err("показ не идёт".into());
    }

    // ─── Новое поколение побеждает: с этого кадра в источник пишет только оно ───
    let (_, prev_pipe) = activate_gen(gen);
    reset_switch_meters();

    let mut new_opts = None;
    if republish {
        let max_bitrate =
            share_bitrate(next.0, next.1, share.cfg_fps, share.mode == "motion", share.codec == "h264");
        let presets = if share.layers {
            share_layer_presets(next.0, next.1, max_bitrate, share.fps as f64)
        } else {
            Vec::new()
        };
        let opts = share_publish_opts(&share.codec, max_bitrate, share.fps, share.layers, &presets);
        match republish_with(&local, vs.clone(), opts.clone()).await {
            Ok(()) => {}
            // Трек не снят — возвращаем старое поколение, показ идёт как шёл.
            Err(HealError::NotNow(why)) => {
                restore_gen(old_gen, prev_pipe);
                retire_capture(handle);
                return Err(format!("показ не переопубликован: {why}"));
            }
            // Трек снят, а новый не встал: показывать нечего — гасим честно, как самолечение.
            Err(HealError::Lost(why)) => {
                retire_capture(handle);
                let _ = app.emit(ENDED_EVENT, ());
                stop().await;
                return Err(format!("показ потерян при переопубликации: {why}"));
            }
        }
        if let Ok(mut g) = EFFECTIVE.lock() {
            if let Some(e) = g.as_mut() {
                e.width = next.0;
                e.height = next.1;
                e.bitrate = max_bitrate;
            }
        }
        new_opts = Some(opts);
    }

    // Записать новое поколение в сессию и погасить старое.
    let old = {
        let mut g = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        match g.as_mut().filter(|s| Arc::ptr_eq(&s.stop, &session_stop)) {
            Some(s) => {
                s.target = target;
                s.gen = gen;
                if let Some(opts) = new_opts {
                    s.source = vs;
                    s.opts = opts;
                    s.declared = next;
                }
                Some(std::mem::replace(&mut s.capture, handle))
            }
            // Показ кончился прямо сейчас: новый поток гасит общий стоп-флаг, ему некуда писать.
            None => {
                retire_capture(handle);
                None
            }
        }
    };
    let Some(old) = old else {
        return Err("показ не идёт".into());
    };
    retire_capture(old);
    SWITCHES.fetch_add(1, Ordering::Relaxed);
    Ok(if republish { SwitchOutcome::Republished } else { SwitchOutcome::Hot })
}

/// Stop the active share: kill the capture thread and disconnect the companion participant.
///
/// `room.close()` waits ~10s for LiveKit's graceful WebRTC/signaling teardown, so we must NOT
/// await it here — that blocked the `gv_screen_share_stop` command (and thus the UI's "stop"
/// click) for the whole 10s. The capture thread stops immediately via the flag; the room
/// disconnects in a detached task. A fresh `start()` builds its own Session, so a lingering
/// background close is harmless.
pub async fn stop() {
    // Подсказка оценщику — только на время показа: следующий показ меряет сервер заново.
    webrtc_sys::gv_gpu_capture::ffi::set_bitrate_hint(0, 0);
    if let Ok(mut g) = BWE_HINT.lock() {
        *g = (0, 0, 0.0);
    }
    // Множитель опорного кадра и итог «с чем показ шёл» — тоже только на время показа (06.10).
    webrtc_sys::gv_gpu_capture::ffi::set_screen_encoder_keyframe_scale(0);
    if let Ok(mut g) = EFFECTIVE.lock() {
        *g = None;
    }
    // Кадр прошлого показа не должен пережить сам показ: иначе следующее наведение мышкой отдало бы
    // картинку того, что человек уже не показывает (#115).
    if let Ok(mut slot) = PREVIEW.lock() {
        *slot = None;
    }
    let session = SESSION.lock().ok().and_then(|mut g| g.take());
    if let Some(s) = session {
        s.stop.store(true, Ordering::Relaxed);
        retire_capture(s.capture);
        finish_share_markers(s.active_marker.as_deref(), s.streak_marker.as_deref(), s.opts.simulcast);
        let room = s.room;
        tokio::spawn(async move {
            let _ = room.close().await;
        });
    }
}

/// Свежий кадр показа маленькой картинкой — для превью по наведению мышкой (#115). `None`, когда
/// показа нет или первый кадр ещё не пришёл.
///
/// Сжатие происходит ЗДЕСЬ, на потоке команды, а не на потоке захвата — см. `PREVIEW`.
pub fn preview() -> Option<String> {
    let (tw, th, rgba) = PREVIEW.lock().ok()?.clone()?;
    png_data_url(&rgba, tw, th)
}

/// One sample of how the native share is ACTUALLY encoding right now — the numbers behind «стрим
/// лагает». The client polls this and turns consecutive samples into a bitrate.
///
/// Two fields carry most of the diagnostic weight:
///  * `limit_reason` — "cpu" / "bandwidth" / "none": says whether the encoder or the uplink is the
///    bottleneck, which is otherwise pure guesswork.
///  * `encoder` — libwebrtc's encoder name ("NvCodec…" for NVENC, "OpenH264"/"libvpx" for software),
///    i.e. whether the GPU is doing the work at all.
/// Один слой показа в статистике (#207): что сейчас кодируется, а что стоит.
///
/// 🔴 С dynacast (25.09) слой, который никто не смотрит, стоит на паузе, и его частота 0. Без этого
/// списка «показ живой, но никто не смотрит верхний слой» в телеметрии выглядело бы как `fps = 0`.
#[derive(Serialize, Default, Clone)]
pub struct LayerStat {
    pub rid: String,
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frames_encoded: u32,
    /// Среднее время кодирования кадра этого слоя с начала показа, мс.
    pub encode_ms: f64,
    /// Сколько бит/с WebRTC отдал этому слою из своей оценки канала.
    pub target_bitrate: f64,
    // ─── «Чёрный ящик» (06.10, #207) — накопительные, разность соседних замеров даёт «за окно» ───
    /// Сумма QP всех кадров слоя (`qpSum`). Средний QP за окно = Δqp_sum / Δframes_encoded: 20–30 —
    /// чёткий текст, 40+ — мыло, 51 — предел H.264.
    pub qp_sum: u64,
    pub key_frames: u32,
    /// Сколько байт слой реально отправил (с повторами) и сколько ДОЛЖЕН был выдать кодировщик по своей
    /// цели (`totalEncodedBytesTarget`). Факт ≪ цели — кодировщику нечего слать (статика); факт > цели —
    /// перелёт.
    pub bytes_sent: u64,
    pub encoded_bytes_target: u64,
    pub pli: u32,
}

#[derive(Serialize, Default)]
pub struct ShareStats {
    /// Все слои показа, см. `LayerStat`.
    pub layers: Vec<LayerStat>,
    /// Среднее время кодирования кадра ОСНОВНОГО слоя (того, что ниже в `width`/`fps`), мс.
    pub encode_ms_per_frame: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bytes_sent: u64,
    pub packets_sent: u64,
    pub target_bitrate: f64,
    /// Подсказка оценщику на этот показ (`bitrate_hint`): старт и нижняя граница, бит/с; задержка
    /// TCP до сервера, мс (-1 — не достучались). Нижняя граница > 0 — сервер в локалке.
    pub bwe_start_bps: f64,
    pub bwe_min_bps: f64,
    pub server_rtt_ms: f64,
    /// Оценка канала самим WebRTC (`availableOutgoingBitrate` выбранной пары кандидатов), бит/с.
    ///
    /// 🔴 Не провод, а то, во что WebRTC ВЕРИТ: из этой оценки он и раздаёт биты слоям. 26.09 полный
    /// слой получал ~3,5 Мбит/с из 12,9 на гигабитной локалке. Эта цифра отвечает, виноват оценщик
    /// (застрял низко) или делёж между слоями (оценка высокая, а полному мало).
    pub bwe_bps: f64,
    pub frames_encoded: u32,
    pub key_frames: u32,
    pub limit_reason: String,
    pub limit_cpu_s: f64,
    pub limit_bandwidth_s: f64,
    pub resolution_changes: u32,
    pub encoder: String,
    pub power_efficient: bool,
    pub nack: u32,
    pub pli: u32,
    pub codec: String,
    pub rtt_ms: f64,
    pub fraction_lost: f64,
    pub packets_lost: i64,
    /// Sample time (ms since epoch, from the stats report itself) — the client needs it to divide by.
    pub at_ms: f64,

    // ─── Конвейер захвата (2026-08-22, см. docs/diag-metrics-plan.md) ───
    /// Среднее время ЗАХВАТА кадра, мс. Быстрый путь через видеокарту — единицы, старый через
    /// копирование всего экрана — сотни; разница на два порядка, так что различить хватает.
    pub capture_ms: f64,
    /// Среднее время ПОДГОТОВКИ кадра (перевод формата + уменьшение), мс.
    pub convert_ms: f64,
    /// РЕАЛЬНЫЙ размер снимаемого источника — не путать с `width`/`height`, которые про сеть.
    pub src_width: u32,
    pub src_height: u32,
    /// Сколько кадров реально пришло от захвата и сколько раз мы не уложились в бюджет кадра.
    pub frames_captured: u64,
    pub frames_late: u64,

    // ─── Самолечение залипшего показа (#111) ───
    /// Время захвата за ПОСЛЕДНЕЕ окно сторожа (5 с), мс. 🔴 Не путать с `capture_ms`: то —
    /// среднее с начала показа, и после часа тяжёлой игры оно остаётся высоким навсегда. Только
    /// это число отвечает на вопрос «видеокарта СЕЙЧАС свободна?».
    pub capture_ms_now: f64,
    /// Сколько раз показ пересобрался сам. У здорового показа обязан остаться нулём — это и есть
    /// проверка на ложные срабатывания.
    pub heals: u32,
    /// Сколько секунд ПОДРЯД держится залипание прямо сейчас (0 — всё в порядке). Показывает и
    /// «почти сработало», иначе о промахах порога мы бы не узнали.
    pub stuck_s: u32,
    /// Сколько раз источник показа сменили на лету (#237). Объясняет «ступеньку» счётчиков конвейера
    /// в отчёте: на смене они начинаются заново.
    pub switches: u32,

    // ─── Путь кадра (#207, шаг 4) ───
    /// `gpu` — кадр не покидает видеокарту, `cpu` — через оперативку. Пусто — показ не начался.
    pub pipeline: String,
    /// Почему не `gpu`: показ окна, выключено, кодек, экран не на NVIDIA, HDR, отказ посреди показа.
    pub pipeline_note: String,

    // ─── «Чёрный ящик» (06.10, #207): качество кадра, цель против факта, с чем показ запущен ───
    /// Основной слой, накопительно: сумма QP, байты по цели кодировщика, повторы, «огромные» кадры
    /// (в 2,5 раза больше среднего — смена сцены, опорный кадр). Среднее «за окно» — разностью замеров.
    pub qp_sum: u64,
    pub encoded_bytes_target: u64,
    pub retransmitted_bytes: u64,
    pub huge_frames: u32,
    /// Задержка проверок ICE выбранной пары, мс (`currentRoundTripTime`). 🐞 `rtt_ms` у нативного показа
    /// всегда 1 мс (телеметрия 0.8.12) — верить этому полю и `server_rtt_ms`.
    pub ice_rtt_ms: f64,
    /// С чем показ запущен на самом деле: размер (у «Родного» — источника), частота (у «Чёткости» —
    /// не выше 30), битрейт полного слоя, режим, «Максимальное качество», слои, множитель опорного кадра NVENC.
    pub cfg_width: u32,
    pub cfg_height: u32,
    pub cfg_fps: u32,
    pub cfg_bitrate: u64,
    pub mode: String,
    pub max_quality: bool,
    pub layers_on: bool,
    pub keyframe_scale: i32,
}

/// Stats for the live native share, or None when nothing is being shared.
pub async fn stats() -> Option<ShareStats> {
    // Take the track out from under the lock: get_stats() is async and a std MutexGuard must not be
    // held across an await. LocalTrack is cheap to clone (it's an Arc inside).
    let track = {
        let g = SESSION.lock().ok()?;
        let s = g.as_ref()?;
        s.room
            .local_participant()
            .track_publications()
            .into_values()
            .find(|p| p.source() == TrackSource::Screenshare)
            .and_then(|p| p.track())
    }?;

    let report = track.get_stats().await.ok()?;
    let mut out = ShareStats::default();
    let mut codec_id = String::new();
    let mut best_w = 0u32;
    // С dynacast слой, который никто не смотрит, стоит (#207). Основным считаем самый крупный из
    // АКТИВНЫХ — иначе в отчёт попадал бы замерший верхний слой с `fps = 0` при живом показе.
    let any_active = report.iter().any(|s| {
        matches!(s, livekit::webrtc::stats::RtcStats::OutboundRtp(o) if o.stream.kind == "video" && o.outbound.active)
    });

    for s in &report {
        if let livekit::webrtc::stats::RtcStats::OutboundRtp(o) = s {
            if o.stream.kind != "video" {
                continue;
            }
            let encode_ms = if o.outbound.frames_encoded > 0 {
                (o.outbound.total_encode_time / o.outbound.frames_encoded as f64 * 1000.0 * 100.0).round() / 100.0
            } else {
                0.0
            };
            out.layers.push(LayerStat {
                rid: o.outbound.rid.clone(),
                active: o.outbound.active,
                width: o.outbound.frame_width,
                height: o.outbound.frame_height,
                fps: o.outbound.frames_per_second,
                frames_encoded: o.outbound.frames_encoded,
                encode_ms,
                target_bitrate: o.outbound.target_bitrate,
                qp_sum: o.outbound.qp_sum,
                key_frames: o.outbound.key_frames_encoded,
                bytes_sent: o.sent.bytes_sent,
                encoded_bytes_target: o.outbound.total_encoded_bytes_target,
                pli: o.outbound.pli_count,
            });
            if any_active && !o.outbound.active {
                continue;
            }
            // 🔴 При двух слоях (#109) таких записей НЕСКОЛЬКО — по одной на слой. Раньше цикл
            // молча перезаписывал `out` каждой, и в отчёт попадала ПОСЛЕДНЯЯ, какая придётся:
            // запросто нижний слой 3 кадра/с, а то и вовсе ещё не начавший кодировать, у которого
            // часть чисел не число (NaN). Такое поле уезжает в JSON как `null`, схема на сервере
            // отбивает ВЕСЬ отчёт с кодом 400 — и телеметрия замолкает целиком, что и случилось
            // 2026-08-22: за сутки ноль срезов с показом при 3511 срезах вообще.
            // Берём САМЫЙ КРУПНЫЙ слой — он и есть то, что видит зритель. Веб-путь так делал давно.
            if o.outbound.frame_width < best_w {
                continue;
            }
            best_w = o.outbound.frame_width;
            out.encode_ms_per_frame = encode_ms;
            out.width = o.outbound.frame_width;
            out.height = o.outbound.frame_height;
            out.fps = o.outbound.frames_per_second;
            out.bytes_sent = o.sent.bytes_sent;
            out.packets_sent = o.sent.packets_sent;
            out.target_bitrate = o.outbound.target_bitrate;
            out.frames_encoded = o.outbound.frames_encoded;
            out.key_frames = o.outbound.key_frames_encoded;
            out.limit_reason = format!("{:?}", o.outbound.quality_limitation_reason).to_lowercase();
            out.limit_cpu_s = *o.outbound.quality_limitation_durations.get("cpu").unwrap_or(&0.0);
            out.limit_bandwidth_s = *o
                .outbound
                .quality_limitation_durations
                .get("bandwidth")
                .unwrap_or(&0.0);
            out.resolution_changes = o.outbound.quality_limitation_resolution_changes;
            out.encoder = o.outbound.encoder_implementation.clone();
            out.power_efficient = o.outbound.power_efficient_encoder;
            out.nack = o.outbound.nack_count;
            out.pli = o.outbound.pli_count;
            out.at_ms = o.rtc.timestamp as f64 / 1000.0; // report timestamps are microseconds
            out.qp_sum = o.outbound.qp_sum;
            out.encoded_bytes_target = o.outbound.total_encoded_bytes_target;
            out.retransmitted_bytes = o.outbound.retransmitted_bytes_sent;
            out.huge_frames = o.outbound.huge_frames_sent;
            codec_id = o.stream.codec_id.clone();
        }
    }
    // RTT + loss come from the receiver's report, and the codec's human name from a separate entry.
    // ⚠️ Записей о приёме при двух слоях тоже несколько; у слоя, по которому отчёта ещё не было,
    // время отклика не число. Берём первую, где оно осмысленно.
    let mut have_remote = false;
    for s in &report {
        match s {
            livekit::webrtc::stats::RtcStats::RemoteInboundRtp(r) if r.stream.kind == "video" => {
                if have_remote || !r.remote_inbound.round_trip_time.is_finite() {
                    continue;
                }
                have_remote = true;
                out.rtt_ms = r.remote_inbound.round_trip_time * 1000.0;
                out.fraction_lost = r.remote_inbound.fraction_lost;
                out.packets_lost = r.received.packets_lost;
            }
            livekit::webrtc::stats::RtcStats::Codec(c) if c.rtc.id == codec_id => {
                out.codec = c.codec.mime_type.clone();
            }
            // Пара кандидатов, по которой идёт трафик, — в отчёт отправителя она попадает через
            // транспорт. Невыбранные пары оценки не несут.
            livekit::webrtc::stats::RtcStats::CandidatePair(c) if c.candidate_pair.nominated => {
                let bwe = c.candidate_pair.available_outgoing_bitrate;
                if bwe.is_finite() && bwe > out.bwe_bps {
                    out.bwe_bps = bwe;
                }
                let rtt = c.candidate_pair.current_round_trip_time;
                if rtt.is_finite() && rtt > 0.0 {
                    out.ice_rtt_ms = rtt * 1000.0;
                }
            }
            _ => {}
        }
    }

    // Конвейер захвата: делим накопленное на число кадров прямо здесь — так число сразу читается
    // как «мс на кадр», без арифметики на стороне разбора.
    let frames = PIPE_FRAMES.load(Ordering::Relaxed);
    if frames > 0 {
        let total_us = PIPE_TOTAL_US.load(Ordering::Relaxed) as f64;
        let conv_us = PIPE_CONV_US.load(Ordering::Relaxed) as f64;
        out.convert_ms = conv_us / frames as f64 / 1000.0;
        // Захват = весь вызов минус подготовка. Отрицательным стать не должно, но зажимаем на всякий:
        // счётчики трогают разные потоки, и мгновенный рассинхрон между ними возможен.
        out.capture_ms = ((total_us - conv_us).max(0.0)) / frames as f64 / 1000.0;
    }
    out.src_width = PIPE_SRC_W.load(Ordering::Relaxed);
    out.src_height = PIPE_SRC_H.load(Ordering::Relaxed);
    out.frames_captured = frames;
    out.frames_late = PIPE_LATE.load(Ordering::Relaxed);
    out.capture_ms_now = CAPTURE_NOW_US.load(Ordering::Relaxed) as f64 / 1000.0;
    out.heals = HEALS.load(Ordering::Relaxed);
    out.switches = SWITCHES.load(Ordering::Relaxed);
    out.stuck_s = STUCK_S.load(Ordering::Relaxed);
    if let Ok(g) = PIPELINE.lock() {
        out.pipeline = g.0.to_string();
        out.pipeline_note = g.1.clone();
    }
    if let Ok(g) = BWE_HINT.lock() {
        out.bwe_start_bps = g.0 as f64;
        out.bwe_min_bps = g.1 as f64;
        out.server_rtt_ms = g.2;
    }
    if let Some(e) = EFFECTIVE.lock().ok().and_then(|g| g.clone()) {
        out.cfg_width = e.width;
        out.cfg_height = e.height;
        out.cfg_fps = e.fps;
        out.cfg_bitrate = e.bitrate;
        out.mode = e.mode;
        out.max_quality = e.max_quality;
        out.layers_on = e.layers;
        out.keyframe_scale = e.keyframe_scale;
    }

    // 🔴 Последний рубеж: НИ ОДНО дробное число не должно уехать нечисловым. `serde_json` пишет
    // NaN и бесконечность как `null`, схема на сервере ждёт число и отбивает ВЕСЬ отчёт целиком —
    // то есть одно испорченное поле стоит нам всей телеметрии человека, а не одной метрики.
    for v in [
        &mut out.capture_ms,
        &mut out.capture_ms_now,
        &mut out.convert_ms,
        &mut out.fps,
        &mut out.target_bitrate,
        &mut out.bwe_bps,
        &mut out.server_rtt_ms,
        &mut out.limit_cpu_s,
        &mut out.limit_bandwidth_s,
        &mut out.rtt_ms,
        &mut out.fraction_lost,
        &mut out.at_ms,
        &mut out.ice_rtt_ms,
    ] {
        if !v.is_finite() {
            *v = 0.0;
        }
    }
    // Слои — тоже: их дробные числа уходят в тот же отчёт.
    for l in &mut out.layers {
        for v in [&mut l.fps, &mut l.encode_ms, &mut l.target_bitrate] {
            if !v.is_finite() {
                *v = 0.0;
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn смена_родного_размера_переопубликует_только_строго_за_двойной_площадью() {
        // Сравнивается площадь, не каждая сторона: 100x100 -> 200x100 ровно x2.
        assert!(!switch_needs_republish(true, (100, 100), (200, 100)));
        assert!(!switch_needs_republish(true, (200, 100), (100, 100)));
        assert!(switch_needs_republish(true, (100, 100), (201, 100)));
        assert!(switch_needs_republish(true, (201, 100), (100, 100)));
        assert!(!switch_needs_republish(true, (100, 100), (100, 100)));
        assert!(!switch_needs_republish(true, (100, 100), (50, 200)));
    }

    #[test]
    fn фиксированный_или_нулевой_размер_не_требует_переопубликации() {
        assert!(!switch_needs_republish(false, (100, 100), (400, 400)));
        assert!(!switch_needs_republish(false, (400, 400), (100, 100)));
        for zero in [(0, 100), (100, 0), (0, 0)] {
            assert!(!switch_needs_republish(true, zero, (100, 100)));
            assert!(!switch_needs_republish(true, (100, 100), zero));
        }
    }

    fn switch_test_cfg(native: bool) -> ShareCfg {
        ShareCfg { native, width: 1280, height: 720, cfg_fps: 60, fps: 30,
            mode: "detail".into(), codec: "h264".into(), gpu_pipeline: true,
            cursor: false, layers: true }
    }

    #[test]
    fn цель_родного_экрана_знает_размер_а_окно_оставляет_рамку_4k() {
        let c = switch_test_cfg(true);
        let (screen, declared) = capture_target_for(&c, 42, false, Some((5120, 2880)), Some(7));
        assert_eq!(declared, (3840, 2160));
        assert_eq!((screen.tw, screen.th), declared);
        assert_eq!(screen.id, 42);
        assert!(!screen.is_window);
        assert_eq!(screen.want_pid, None);
        assert_eq!(screen.gpu_skip, None);
        assert_eq!(screen.fps, 30);
        assert!(!screen.cursor);
        let (window, declared) = capture_target_for(&c, 43, true, Some((1280, 720)), Some(7));
        assert_eq!(declared, (1280, 720));
        assert_eq!((window.tw, window.th), (NATIVE_MAX_W, NATIVE_MAX_H));
        assert_eq!(window.id, 43);
        assert!(window.is_window);
        assert_eq!(window.want_pid, Some(7));
        assert_eq!(window.gpu_skip, Some("показ окна"));
        let (unknown, declared) = capture_target_for(&c, 44, false, None, None);
        assert_eq!(declared, (1920, 1080));
        assert_eq!((unknown.tw, unknown.th), (NATIVE_MAX_W, NATIVE_MAX_H));
    }

    #[test]
    fn фиксированный_захват_не_берёт_родной_размер_и_соблюдает_ограничения_gpu() {
        let mut c = switch_test_cfg(false);
        let (fixed, declared) = capture_target_for(&c, 1, false, Some((3840, 2160)), Some(8));
        assert_eq!(declared, (1280, 720));
        assert_eq!((fixed.tw, fixed.th), declared);
        assert_eq!(fixed.want_pid, None);
        c.gpu_pipeline = false;
        assert_eq!(capture_target_for(&c, 1, false, None, None).0.gpu_skip, Some("выключено в настройках"));
        c.gpu_pipeline = true;
        c.codec = "vp9".into();
        assert_eq!(capture_target_for(&c, 1, false, None, None).0.gpu_skip, Some("кодек не H.264"));
    }

    #[test]
    fn лестница_слоёв_совпадает_с_таблицей_клиента() {
        // Межъязыковой страж: зритель не должен получать разные RID из браузера и приложения.
        let cases = [
            (1280, 720, 2_100_000, 30.0, vec![(640, 360, 150_000, 3.0)]),
            (1280, 720, 3_360_000, 60.0, vec![(640, 360, 150_000, 3.0)]),
            (1920, 1080, 4_200_000, 30.0, vec![(640, 360, 150_000, 3.0), (1280, 720, 1_500_000, 30.0)]),
            (1920, 1080, 6_720_000, 60.0, vec![(640, 360, 150_000, 3.0), (1280, 720, 1_500_000, 60.0)]),
            (2560, 1440, 7_000_000, 30.0, vec![(640, 360, 150_000, 3.0), (1280, 720, 1_500_000, 30.0)]),
            (2560, 1440, 11_200_000, 60.0, vec![(640, 360, 150_000, 3.0), (1280, 720, 1_500_000, 60.0)]),
            (3840, 2160, 11_200_000, 30.0, vec![(960, 540, 150_000, 3.0), (1920, 1080, 1_500_000, 30.0)]),
            (3840, 2160, 17_920_000, 60.0, vec![(960, 540, 150_000, 3.0), (1920, 1080, 1_500_000, 60.0)]),
        ];
        for (w, h, bitrate, fps, expected) in cases {
            let actual: Vec<_> = share_layer_presets(w, h, bitrate, fps)
                .into_iter()
                .map(|p| (p.width, p.height, p.encoding.max_bitrate, p.encoding.max_framerate))
                .collect();
            assert_eq!(actual, expected, "{w}x{h}@{fps}");
        }
    }

    #[test]
    fn имя_отметки_старой_карты_держит_второе_поколение() {
        // Откат имени вернул бы старой карте слои без предохранителя после общего возврата настроек.
        assert_eq!(TOLD_MARKER, "screenshare-layers-told-2");
    }

    #[test]
    fn gpu_pipeline_по_умолчанию_включён_и_явно_выключается() {
        // Старый клиент поля не присылает: без serde-default новый десктоп отверг бы весь старт показа.
        let base = serde_json::json!({
            "url": "wss://voice.example.test",
            "token": "test-token",
            "sourceId": "screen:1",
            "isWindow": false,
            "fps": 30,
            "width": 1920,
            "height": 1080,
            "maxBitrate": 3_000_000,
            "codec": "h264"
        });
        let legacy: StartConfig = serde_json::from_value(base.clone()).expect("старый конфиг должен разбираться");
        assert!(legacy.gpu_pipeline);
        let mut disabled = base;
        disabled["gpuPipeline"] = serde_json::Value::Bool(false);
        let disabled: StartConfig = serde_json::from_value(disabled).expect("явный false должен разбираться");
        assert!(!disabled.gpu_pipeline);
    }

    #[test]
    fn курсор_по_умолчанию_включён_и_явно_выключается() {
        // Старый клиент поля не присылает: новый десктоп обязан сохранить прежний вид показа.
        let base = serde_json::json!({
            "url": "wss://voice.example.test",
            "token": "test-token",
            "sourceId": "screen:1",
            "isWindow": false,
            "fps": 30,
            "width": 1920,
            "height": 1080,
            "maxBitrate": 3_000_000,
            "codec": "h264"
        });
        let legacy: StartConfig = serde_json::from_value(base.clone()).expect("старый конфиг должен разбираться");
        assert!(legacy.cursor);
        let mut disabled = base;
        disabled["cursor"] = serde_json::Value::Bool(false);
        let disabled: StartConfig = serde_json::from_value(disabled).expect("явный false должен разбираться");
        assert!(!disabled.cursor);
    }

    #[test]
    fn gpu_путь_планируется_только_для_экрана_h264_и_nvenc() {
        // Ловит dynacast, выключенный для пути, который всё равно уйдёт через CPU.
        assert!(gpu_path_planned(false, true, "h264", true));
        assert!(!gpu_path_planned(true, true, "h264", true));
        assert!(!gpu_path_planned(false, false, "h264", true));
        assert!(!gpu_path_planned(false, true, "vp9", true));
        assert!(!gpu_path_planned(false, true, "H264", true));
        assert!(!gpu_path_planned(false, true, "h264", false));
    }

    #[test]
    fn dynacast_включается_только_для_cpu_с_несколькими_слоями() {
        // CPU + один слой — чёрное окно из 0.9.50; GPU не должен включать dynacast даже со слоями.
        // Единственный положительный случай сохраняет экономию кодирования CPU без зрителей.
        let cases = [
            (false, false, false),
            (false, true, true),
            (true, false, false),
            (true, true, false),
        ];
        for (gpu_planned, layers, expected) in cases {
            assert_eq!(share_dynacast(gpu_planned, layers), expected,
                "R312 dynacast: gpu_planned={gpu_planned}, layers={layers}");
        }

        // Контрфакты формулы используют ту же таблицу: проверяем конкретные несовпавшие входы,
        // а не просто то, что заведомо другая функция вернула какое-нибудь иное значение.
        let mutants: [(&str, fn(bool, bool) -> bool, Vec<(bool, bool)>); 2] = [
            ("!gpu_planned без layers", |gpu, _layers| !gpu, vec![(false, false)]),
            ("!gpu_planned || layers", |gpu, layers| !gpu || layers, vec![(false, false), (true, true)]),
        ];
        for (name, mutant, expected_failures) in mutants {
            let failures: Vec<_> = cases.iter().filter_map(|&(gpu, layers, expected)| {
                (mutant(gpu, layers) != expected).then_some((gpu, layers))
            }).collect();
            assert_eq!(failures, expected_failures, "R312 контрфакт формулы: {name}");
        }
    }

    fn start_использует_правило_dynacast(source: &str) -> bool {
        // Ограничиваемся production-частью и телом start: строка-якорь самого теста, другая
        // функция или закомментированный правильный вызов не должны сделать страж зелёным.
        let production = source.split("\n#[cfg(test)]").next().unwrap_or("");
        let Some((_, tail)) = production.split_once("\npub async fn start(") else { return false };
        // Тело функции закрывается на нулевом отступе; вложенные блоки start имеют отступ.
        let Some((body, _)) = tail.split_once("\n}") else { return false };
        let code: String = body.lines()
            .flat_map(|line| line.split("//").next().unwrap_or("").chars())
            .filter(|c| !c.is_whitespace())
            .collect();
        let assignments: Vec<_> = code.split("room_opts.dynacast=").skip(1)
            .filter_map(|tail| tail.split_once(';').map(|(value, _)| value))
            .collect();
        assignments == ["share_dynacast(gpu_planned,layers)"]
    }

    #[test]
    fn start_передаёт_правилу_dynacast_настоящий_layers_а_не_константу() {
        let source = include_str!("screenshare.rs");
        assert!(start_использует_правило_dynacast(source), "R312 start: dynacast берётся из правила с layers");
        let production = source.split("\n#[cfg(test)]").next().unwrap();
        let anchor = "room_opts.dynacast = share_dynacast(gpu_planned, layers);";
        assert_eq!(production.matches(anchor).count(), 1, "R312 единственный production-якорь dynacast");
        for value in ["share_dynacast(gpu_planned, true)", "!gpu_planned", "!gpu_planned || layers"] {
            // Правильный вызов оставлен в комментарии: страж обязан найти настоящее присваивание.
            let replacement = format!("// {anchor}\n    room_opts.dynacast = {value};");
            let mutant = production.replacen(anchor, &replacement, 1);
            assert!(!start_использует_правило_dynacast(&mutant), "R312 контрфакт start: {value}");
        }
    }

    #[test]
    fn подсказка_битрейта_различает_локалку_и_интернет_на_точной_границе() {
        // Ловит нижнюю границу на интернетном соединении, которая мешала WebRTC честно понижать оценку.
        assert_eq!(bitrate_hint(10_000_000, Some(1.0)), (13_000_000, 13_000_000));
        assert_eq!(bitrate_hint(10_000_000, Some(4.99)), (13_000_000, 13_000_000));
        assert_eq!(bitrate_hint(10_000_000, Some(5.0)), (5_000_000, 2_500_000));
        assert_eq!(bitrate_hint(10_000_000, None), (5_000_000, 2_500_000));
        assert_eq!(bitrate_hint(3_000_000, Some(20.0)), (3_000_000, 1_200_000));
    }

    #[test]
    fn режим_ограничивает_частоту_только_для_чёткости() {
        // Иначе «Чёткость» зря расходует полосу на 60 fps, а «Плавность» не может сохранить выбранную частоту.
        assert_eq!(mode_fps("detail", 60), 30);
        assert_eq!(mode_fps("motion", 60), 60);
        assert_eq!(mode_fps("detail", 15), 15);
        assert_eq!(mode_fps("motion", 0), 5);
        assert_eq!(mode_fps("motion", 90), 60);
    }

    #[test]
    fn опорный_кадр_учитывает_режим_и_неизвестное_значение() {
        // PLI не должен замыливать текст, а режим движения использует меньший множитель для быстрой смены сцен.
        assert_eq!(keyframe_scale("detail"), 10);
        assert_eq!(keyframe_scale("motion"), 4);
        assert_eq!(keyframe_scale("future-mode"), 10);
    }

    #[test]
    fn максимальное_качество_держит_полный_слой_с_запасом() {
        // Галочка должна давать оценщику запас 30% и одинаковый нижний пол, а не обычный мягкий интернетный.
        assert_eq!(max_quality_hint(10_000_000), (13_000_000, 13_000_000));
        assert_eq!(max_quality_hint(3_000_000), (3_900_000, 3_900_000));
    }

    #[test]
    fn родной_размер_вписывается_в_4k_с_чётными_сторонами_без_увеличения() {
        // Портрет и сверхширокий источник не должны переворачиваться или обрезаться до нечётного размера.
        assert_eq!(fit_native(7680, 4320), (3840, 2160));
        assert_eq!(fit_native(4320, 7680), (2160, 3840));
        assert_eq!(fit_native(3440, 1440), (3440, 1440));
        assert_eq!(fit_native(1919, 1081), (1918, 1080));
        assert_eq!(fit_native(1, 1), (2, 2));
    }

    #[test]
    fn новый_и_старый_клиент_совпадают_на_144_сочетаниях_битрейта() {
        // Стенд #207 сравнивает клиент и Rust на реальных форматах экранов; фиксированные базы из его TS-вывода
        // не дают двум копиям формулы незаметно разойтись на ориентации или ультрашироких размерах.
        let cases = [
            (1280, 720, 1_500_000.0), (1920, 1080, 3_000_000.0),
            (2560, 1440, 5_000_000.0), (3840, 2160, 8_000_000.0),
            (3440, 1440, 5_825_000.0), (2560, 1080, 3_857_142.857142857),
            (1600, 900, 2_175_000.0), (800, 600, 781_250.0),
            (3840, 2160, 8_000_000.0), (1080, 1920, 3_000_000.0),
            (3840, 1600, 6_600_000.0), (1366, 768, 1_666_000.0),
        ];
        let mut count = 0;
        for (w, h, base) in cases {
            for fps in [15, 30, 60] {
                for motion in [false, true] {
                    for h264 in [false, true] {
                        let fps_scale: f64 = match fps { 15 => 0.75, 30 => 1.0, _ => 1.6 };
                        let mode_scale: f64 = if motion { 1.15 } else { 1.0 };
                        let codec_scale: f64 = if h264 { 1.4 } else { 1.0 };
                        let expected = (base * fps_scale * mode_scale * codec_scale).round() as u64;
                        assert_eq!(share_bitrate(w, h, fps, motion, h264), expected,
                            "{w}x{h} {fps}fps motion={motion} h264={h264}");
                        count += 1;
                    }
                }
            }
        }
        assert_eq!(count, 144, "матрица обязана покрыть все измерения стенда");
    }

    #[test]
    fn старый_конфиг_получает_режим_чёткости_и_выключенный_max_quality() {
        // Конфиг от версии до #207 не содержит новых ключей и должен запускаться с безопасными значениями.
        let old = serde_json::json!({
            "url": "wss://voice.example.test", "token": "test-token", "sourceId": "screen:1",
            "isWindow": false, "fps": 60, "width": 0, "height": 0, "maxBitrate": 0, "codec": "h264"
        });
        let legacy: StartConfig = serde_json::from_value(old.clone()).expect("старый JSON совместим");
        assert_eq!(legacy.mode, "detail");
        assert!(!legacy.max_quality);
        let mut modern = old;
        modern["mode"] = serde_json::Value::String("motion".into());
        modern["maxQuality"] = serde_json::Value::Bool(true);
        let current: StartConfig = serde_json::from_value(modern).expect("новые поля читаются");
        assert_eq!(current.mode, "motion");
        assert!(current.max_quality);
    }

    /// Живой случай из разбора #111: подаём 28 кадров, кодировщик отдаёт 4, видеокарта уже
    /// свободна (захват 3.8 мс), жалоба — «процессор». Ради этого всё и делалось.
    fn stuck() -> StuckInput {
        StuckInput {
            target_fps: 30.0,
            cap_fps: 28.0,
            enc_fps: 4.0,
            capture_ms: 3.8,
            late_share: 0.0,
            limit_cpu: true,
        }
    }

    #[test]
    fn ловит_живое_залипание() {
        assert!(looks_stuck(&stuck()));
    }

    #[test]
    fn видеокарта_ещё_занята_не_лечим() {
        // 66 мс на кадр — карта под нагрузкой игры. Пересоздавать публикацию бессмысленно:
        // новый кодировщик упрётся ровно в то же самое, а зрители получат моргание.
        let i = StuckInput { capture_ms: 66.0, ..stuck() };
        assert!(!looks_stuck(&i));
    }

    #[test]
    fn упор_в_канал_не_лечим() {
        // Узкий канал — ограничение честное. Обрывать картинку нечем помочь.
        let i = StuckInput { limit_cpu: false, ..stuck() };
        assert!(!looks_stuck(&i));
    }

    #[test]
    fn мы_сами_не_кормим_не_лечим() {
        // Захват даёт 6 из 30 — виноват не отправитель, а источник.
        let i = StuckInput { cap_fps: 6.0, enc_fps: 5.0, ..stuck() };
        assert!(!looks_stuck(&i));
    }

    #[test]
    fn кодировщик_успевает_не_лечим() {
        let i = StuckInput { enc_fps: 27.0, ..stuck() };
        assert!(!looks_stuck(&i));
    }

    #[test]
    fn процессор_реально_забит_не_лечим() {
        // Каждый третий кадр не уложился в бюджет — машине плохо по-настоящему.
        let i = StuckInput { late_share: 0.35, ..stuck() };
        assert!(!looks_stuck(&i));
    }

    #[test]
    fn низкая_цель_правило_не_применяем() {
        // При цели 5 кадров «вдвое меньше» — это 2, и отличить залипание от нормы нечем.
        let i = StuckInput { target_fps: 5.0, cap_fps: 5.0, enc_fps: 2.0, ..stuck() };
        assert!(!looks_stuck(&i));
    }

    #[test]
    fn нечисловое_значение_не_решает() {
        // Сравнения с NaN всегда ложны: без явной проверки «не сработало» вышло бы случайно.
        for i in [
            StuckInput { enc_fps: f64::NAN, ..stuck() },
            StuckInput { capture_ms: f64::NAN, ..stuck() },
            StuckInput { cap_fps: f64::INFINITY, ..stuck() },
        ] {
            assert!(!looks_stuck(&i));
        }
    }

    #[test]
    fn на_границе_условий() {
        // Захват уверенно выше порога (22 из 30), кодировщик ровно на своей границе снизу:
        // 13.0 < 22 × 0.6 = 13.2 — считается залипанием.
        let i = StuckInput { cap_fps: 22.0, enc_fps: 13.0, capture_ms: 15.0, ..stuck() };
        assert!(looks_stuck(&i));
        // Ровно на границе — уже нет: правило требует «заметно меньше, чем подаём», строго.
        assert!(!looks_stuck(&StuckInput { enc_fps: 13.2, ..i }));
    }

    // ─── Второй слой качества: когда его не просить (#112) ───

    #[test]
    fn просьбу_человека_уважаем() {
        assert_eq!(decide_layers(true, false, 0, false, false), (true, None));
        // Выключил сам — выключать нечего и объяснять нечего.
        assert_eq!(decide_layers(false, true, 9, true, false), (false, None));
    }

    #[test]
    fn старая_карта_выключает_слой_и_объясняет() {
        assert_eq!(decide_layers(true, false, 0, true, false), (false, Some(LayersOff::OldGpu)));
    }

    #[test]
    fn про_старую_карту_говорим_один_раз() {
        // Человек включил обратно осознанно — не отбираем на каждом показе.
        assert_eq!(decide_layers(true, false, 0, true, true), (true, None));
    }

    #[test]
    fn падение_перебивает_прошлый_разговор() {
        // Свежая улика новее любого «мы уже говорили».
        assert_eq!(decide_layers(true, true, 1, false, true), (false, Some(LayersOff::Crash)));
        assert_eq!(decide_layers(true, true, 1, true, true), (false, Some(LayersOff::Crash)));
    }

    #[test]
    fn одно_падение_отбирает_слой_только_на_один_показ() {
        // 🔴 Ловит беду, ради которой всё это переписано (#109): одно падение отбирало слой НАВСЕГДА,
        // и за сутки замера два слоя остались ровно у двоих. Признак «на один показ» — причина не
        // постоянная, то есть настройку клиент не трогает.
        let (layers, reason) = decide_layers(true, true, 1, false, false);
        assert!(!layers, "сам показ идёт одним слоем");
        // Именно `Crash`, а не `CrashFinal`: по нему клиент настройку НЕ трогает, только предупреждает.
        assert_eq!(reason, Some(LayersOff::Crash));
        // Следующий показ (отметки падения уже нет) снова просит два слоя — сам, без человека.
        assert_eq!(decide_layers(true, false, 0, false, false), (true, None));
    }

    #[test]
    fn три_падения_подряд_выключают_слой_насовсем() {
        assert_eq!(decide_layers(true, true, 2, false, false), (false, Some(LayersOff::Crash)));
        // На пороге причина становится постоянной — по ней клиент правит саму настройку.
        let (_, reason) = decide_layers(true, true, CRASH_LIMIT, false, false);
        assert_eq!(reason, Some(LayersOff::CrashFinal));
    }

    /// Своя папка на каждый тест: они бегут в одном процессе параллельно, и общий путь дал бы
    /// «то падает, то нет» — худший вид красноты.
    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gv-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn обработанная_ошибка_старта_не_выглядит_падением() {
        // 🔴 Находка Codex: метка пишется ДО подключения к LiveKit, и на обычной ошибке (просроченный
        // токен, кривой источник) оставалась лежать. Следующий показ читал её как улику падения и
        // отбирал второй слой ни за что. Настоящую смерть процесса `Drop` не обслуживает — и это
        // ровно то, что нужно: там метка обязана уцелеть.
        // ⚠️ Метку НЕ пишем руками: её обязан поставить сам `arm`. Первая редакция теста писала её
        // заранее — и мутация «убрать запись из `arm`» проходила зелёной, то есть весь новый
        // договор «записать и охранять одним действием» не проверялся вовсе (поймал Codex).
        // Мутация: убрать `marker_write` из `arm` → падает assertion «поставил её сам».
        let dir = tmpdir("guard");
        let path = dir.join(ACTIVE_MARKER);
        assert!(!path.exists(), "начинаем с чистого места");
        {
            let _guard = ActiveMarkerGuard::arm(Some(path.clone()), true);
            assert!(path.exists(), "`arm` обязан поставить метку сам, а не полагаться на вызывающего");
            assert_eq!(std::fs::read(&path).unwrap(), b"2", "и записать в неё число слоёв");
        } // ранний выход с ошибкой
        assert!(!path.exists(), "после обработанной ошибки метка обязана исчезнуть");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn поднявшийся_показ_метку_сохраняет() {
        let dir = tmpdir("guard-ok");
        let path = dir.join(ACTIVE_MARKER);
        {
            // Метку опять ставит сам `arm` — иначе тест зеленел бы и без неё.
            let mut guard = ActiveMarkerGuard::arm(Some(path.clone()), false);
            assert_eq!(std::fs::read(&path).unwrap(), b"1", "показ с ОДНИМ слоем помечен как «1»");
            guard.disarm(); // сессия поднялась
        }
        assert!(path.exists(), "у живого показа метку снимает stop(), а не страж");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn штатная_остановка_обнуляет_серию_только_после_двух_слоёв() {
        let dir = tmpdir("finish");
        let (active, streak) = (dir.join(ACTIVE_MARKER), dir.join(STREAK_MARKER));

        // Показ с ОДНИМ слоем: он ничего не доказывает про два — серию не трогаем.
        marker_write(&active, false);
        streak_write(&streak, 2);
        finish_share_markers(Some(&active), Some(&streak), false);
        assert!(!active.exists(), "отметку показа снимаем всегда");
        assert_eq!(streak_read(&streak), 2, "серия падений пережила показ с одним слоем");

        // Показ с ДВУМЯ слоями дожил до «Завершить» — вот это доказательство.
        marker_write(&active, true);
        finish_share_markers(Some(&active), Some(&streak), true);
        assert_eq!(streak_read(&streak), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn причины_выключения_слоя_названы_ровно_так_же_как_их_ждёт_клиент() {
        // 🔴 Просьба Codex: это МЕЖЪЯЗЫКОВОЙ контракт. Клиент разбирает эти строки и по ним решает,
        // трогать настройку или нет; перепутай `crash` и `crash-final` — и временный отказ станет
        // постоянным, а Rust-тесты останутся зелёными. Пара к нему — `layersOffPlan` на клиенте.
        assert_eq!(LayersOff::OldGpu.as_str(), "old-gpu");
        assert_eq!(LayersOff::Crash.as_str(), "crash");
        assert_eq!(LayersOff::CrashFinal.as_str(), "crash-final");
    }

    #[test]
    fn счётчик_падений_переживает_чтение_и_мусор() {
        let dir = std::env::temp_dir().join(format!("gv-streak-{}", std::process::id()));
        let path = dir.join("streak");
        let _ = std::fs::remove_file(&path);
        assert_eq!(streak_read(&path), 0, "отметки нет — падений не было");
        streak_write(&path, 2);
        assert_eq!(streak_read(&path), 2);
        std::fs::write(&path, "мусор").unwrap();
        assert_eq!(streak_read(&path), 0, "битую отметку читаем как ноль, а не как повод отобрать");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn поколение_карты() {
        assert!(gpu_too_old(Some(6)), "Pascal 6.1 — на нём и падало");
        assert!(!gpu_too_old(Some(7)), "Turing 7.5");
        assert!(!gpu_too_old(Some(8)), "Ampere");
        // ⚠️ Неизвестность не повод отбирать слой: у AMD и Intel NVENC не участвует вовсе.
        assert!(!gpu_too_old(None));
    }

    #[test]
    fn отметка_показа_переживает_запись_и_снимается_чтением() {
        let dir = std::env::temp_dir().join("gv-test-marker");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("active");

        assert_eq!(marker_take(&path), None, "отметки нет — падения не было");

        marker_write(&path, true);
        assert_eq!(marker_take(&path), Some(true), "показ шёл с двумя слоями");
        assert_eq!(marker_take(&path), None, "чтение снимает отметку");

        marker_write(&path, false);
        assert_eq!(marker_take(&path), Some(false), "показ шёл с одним слоем — отбирать нечего");

        // 🔴 Мусор в файле не должен читаться как «было два слоя»: иначе испорченная отметка
        // молча отобрала бы слой навсегда.
        std::fs::write(&path, b"").unwrap();
        assert_eq!(marker_take(&path), Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn при_скудном_захвате_требование_к_кодировщику_строже() {
        // 🔴 Смысл третьего условия. Подаём впритык (21 из 30) — тогда «вдвое меньше цели» уже не
        // доказательство: 15 кадров при 21 поданном — это работающий кодировщик, а не залипший.
        let i = StuckInput { cap_fps: 21.5, enc_fps: 15.0, ..stuck() };
        assert!(!looks_stuck(&i));
        // А вот 8 из 21.5 — залипание: до цели далеко и от того, что подаём, тоже.
        assert!(looks_stuck(&StuckInput { enc_fps: 8.0, ..i }));
    }
}
