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
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
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
const TOLD_MARKER: &str = "screenshare-layers-told";

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
fn source_exists(is_window: bool, id: u64, want_pid: Option<u32>) -> bool {
    // Окно с известным процессом: точный ответ Win32, перечисление даже не трогаем (заодно не
    // ходим каждые 10 секунд обходить все окна системы через COM).
    if is_window {
        if let Some(pid) = want_pid {
            return crate::apps_enum::window_pid(id) == Some(pid);
        }
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
    pub width: u32,  // target max width  (frames larger than this are scaled down to fit)
    pub height: u32, // target max height
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
}

fn default_true() -> bool {
    true
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
        .map(|(id, kind, title, handle)| ScreenSource { id, kind, title, thumb: handle.join().ok().flatten() })
        .collect()
}

/// Grab one frame from a source and PNG-encode a small thumbnail data-URL. Best-effort: returns None
/// on timeout or for windows that can't be captured (minimized) — the UI falls back to a monogram.
fn capture_thumb(kind: DesktopCaptureSourceType, id: u64) -> Option<String> {
    let mut cap = DesktopCapturer::new(DesktopCapturerOptions::new(kind))?;
    let source = cap.get_source_list().into_iter().find(|s| s.id() == id)?;
    let (tx, rx) = mpsc::channel::<(usize, usize, usize, Vec<u8>)>();
    cap.start_capture(Some(source), move |res| {
        if let Ok(f) = res {
            let _ = tx.send((f.width() as usize, f.height() as usize, f.stride() as usize, f.data().to_vec()));
        }
    });
    for _ in 0..8 {
        cap.capture_frame();
        if let Ok((w, h, stride, data)) = rx.recv_timeout(Duration::from_millis(200)) {
            return if w > 0 && h > 0 { encode_thumb_png(&data, stride, w, h) } else { None };
        }
    }
    None
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

fn reset_pipe_meters() {
    PIPE_TOTAL_US.store(0, Ordering::Relaxed);
    PIPE_CONV_US.store(0, Ordering::Relaxed);
    PIPE_FRAMES.store(0, Ordering::Relaxed);
    PIPE_LATE.store(0, Ordering::Relaxed);
    PIPE_SRC_W.store(0, Ordering::Relaxed);
    PIPE_SRC_H.store(0, Ordering::Relaxed);
    HEALS.store(0, Ordering::Relaxed);
    STUCK_S.store(0, Ordering::Relaxed);
    CAPTURE_NOW_US.store(0, Ordering::Relaxed);
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
    let (layers, off_reason) =
        decide_layers(cfg.layers, crashed_with_layers, crash_streak, old_gpu, already_told);
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

    let (room, mut events) = Room::connect(&cfg.url, &cfg.token, RoomOptions::default())
        .await
        .map_err(|e| format!("livekit connect: {e}"))?;
    // Drain room events so the channel doesn't grow unbounded; ends when the room closes.
    tokio::spawn(async move { while events.recv().await.is_some() {} });

    let source = NativeVideoSource::new(VideoResolution { width: cfg.width, height: cfg.height }, true);

    let stop = Arc::new(AtomicBool::new(false));
    let want_id: u64 = cfg.source_id.parse().map_err(|_| "bad source id".to_string())?;
    let is_window = cfg.is_window;
    // Процесс окна снимаем ОДИН раз, на старте: дальше сторож сверяется именно с ним, иначе
    // «то же окно» было бы не отличить от «Windows выдала этот номер кому-то другому» (#99).
    let want_pid = if is_window { crate::apps_enum::window_pid(want_id) } else { None };
    let fps = cfg.fps.clamp(5, 60);
    let (tw, th) = (cfg.width, cfg.height);
    let vs = source.clone();
    let stop_thread = stop.clone();

    // Capture runs on its own thread (DesktopCapturer lives entirely here).
    std::thread::spawn(move || {
        let st = if is_window {
            DesktopCaptureSourceType::Window
        } else {
            DesktopCaptureSourceType::Screen
        };
        let Some(mut cap) = DesktopCapturer::new(DesktopCapturerOptions::new(st)) else {
            return;
        };
        let Some(src) = cap.get_source_list().into_iter().find(|s| s.id() == want_id) else {
            return;
        };
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
                match target_dims(w as u32, h as u32, tw, th) {
                    Some((dw, dh)) => {
                        let scaled = buf.scale(dw, dh);
                        scratch = Some(buf); // наружу ушла копия — полноразмерный снова наш
                        vs.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, scaled));
                    }
                    None => {
                        // Уменьшать нечего: буфер уходит наружу, переиспользовать его нельзя.
                        vs.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buf));
                    }
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
        let frame_dur = Duration::from_micros(1_000_000 / fps.max(1) as u64);
        let mut next = Instant::now();
        while !stop_thread.load(Ordering::Relaxed) {
            // Замеряем ВЕСЬ вызов: он синхронно тянет за собой колбэк с подготовкой кадра. Время
            // самого захвата = это время минус подготовка, которую колбэк считает отдельно.
            let t_all = Instant::now();
            cap.capture_frame();
            PIPE_TOTAL_US.fetch_add(t_all.elapsed().as_micros() as u64, Ordering::Relaxed);
            next += frame_dur;
            match next.checked_duration_since(Instant::now()) {
                Some(rem) => std::thread::sleep(rem),
                // Отстаём (конвертация тяжелее бюджета кадра) — не копим долг, сдвигаем дедлайн на «сейчас».
                None => {
                    PIPE_LATE.fetch_add(1, Ordering::Relaxed);
                    next = Instant::now();
                }
            }
        }
    });

    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    // Опции — отдельной переменной, а не прямо в вызове: ими же пересоздаётся публикация при
    // самолечении (#111), и разъехаться они не должны.
    let opts = TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: codec_of(&cfg.codec),
                video_encoding: Some(VideoEncoding {
                    max_bitrate: cfg.max_bitrate,
                    max_framerate: fps as f64,
                }),
                // 🔴 Слоёв ДВА, и это принципиально (#109). Раньше стоял `false` с доводом
                // «нижний слой никто не смотрит» — довод оказался неверным: его смотрит тот,
                // кому плохо. Без запасного слоя зритель с потерями не может получить картинку
                // полегче и вместо этого просит опорные кадры (PLI) — замерено 1.6 раза в
                // секунду при норме 0.1. Каждый такой запрос заставляет НАШ кодировщик выдать
                // опорный кадр, а слой один на всех → картинка пульсирует У ВСЕХ сразу.
                // Один человек на мобильном интернете (47 % потерь) так уронил весь канал.
                //
                // Цена мала: для показа SDK добавляет РОВНО ОДИН слой — половина ширины и
                // высоты при 3 кадрах в секунду (`screenshare::compute_default_simulcast_preset`),
                // то есть ~160 кбит/с. Полный слой остаётся нетронутым.
                // ⚠️ Кодировщик оборачивается в `SimulcastEncoderAdapter` (см. вендоренный
                // `video_encoder_factory.cpp`), то есть на нижний слой заводится ВТОРОЙ сеанс
                // NVENC. На современных драйверах лимит сеансов заведомо больше двух, но если
                // где-то упрёмся — симптом будет «показ не стартует», и тогда сюда возвращаться.
                // Для этого случая и сделан выключатель `layers` в настройках показа: он вернёт
                // старое поведение с одним слоем, не заставляя человека ждать нового релиза.
                simulcast: layers,
                ..Default::default()
    };
    let publish = room
        .local_participant()
        .publish_track(LocalTrack::Video(track), opts.clone())
        .await;

    if let Err(e) = publish {
        stop.store(true, Ordering::Relaxed);
        let _ = room.close().await;
        return Err(format!("publish: {e}"));
    }

    // Показ живой — метку дальше ведёт `stop()` (штатная остановка) либо она переживает падение.
    marker_guard.disarm();
    if let Ok(mut g) = SESSION.lock() {
        *g = Some(Session { stop: stop.clone(), room, source, opts, active_marker, streak_marker });
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
            loop {
                tokio::time::sleep(SOURCE_CHECK).await;
                if watch_stop.load(Ordering::Relaxed) {
                    return; // стрим уже остановлен обычным путём
                }
                let alive =
                    tauri::async_runtime::spawn_blocking(move || source_exists(is_window, want_id, want_pid))
                        .await
                        .unwrap_or(true);
                // Флаг проверяем ПОВТОРНО: пока шло перечисление, человек мог нажать «Завершить».
                if watch_stop.load(Ordering::Relaxed) {
                    return;
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
    let (local, source, opts) = {
        let g = SESSION.lock().map_err(|_| HealError::NotNow("сессия занята".into()))?;
        let s = g.as_ref().ok_or_else(|| HealError::NotNow("показ уже остановлен".into()))?;
        (s.room.local_participant(), s.source.clone(), s.opts.clone())
    };

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

/// Stop the active share: kill the capture thread and disconnect the companion participant.
///
/// `room.close()` waits ~10s for LiveKit's graceful WebRTC/signaling teardown, so we must NOT
/// await it here — that blocked the `gv_screen_share_stop` command (and thus the UI's "stop"
/// click) for the whole 10s. The capture thread stops immediately via the flag; the room
/// disconnects in a detached task. A fresh `start()` builds its own Session, so a lingering
/// background close is harmless.
pub async fn stop() {
    // Кадр прошлого показа не должен пережить сам показ: иначе следующее наведение мышкой отдало бы
    // картинку того, что человек уже не показывает (#115).
    if let Ok(mut slot) = PREVIEW.lock() {
        *slot = None;
    }
    let session = SESSION.lock().ok().and_then(|mut g| g.take());
    if let Some(s) = session {
        s.stop.store(true, Ordering::Relaxed);
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
#[derive(Serialize, Default)]
pub struct ShareStats {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bytes_sent: u64,
    pub packets_sent: u64,
    pub target_bitrate: f64,
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

    for s in &report {
        if let livekit::webrtc::stats::RtcStats::OutboundRtp(o) = s {
            if o.stream.kind != "video" {
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
    out.stuck_s = STUCK_S.load(Ordering::Relaxed);

    // 🔴 Последний рубеж: НИ ОДНО дробное число не должно уехать нечисловым. `serde_json` пишет
    // NaN и бесконечность как `null`, схема на сервере ждёт число и отбивает ВЕСЬ отчёт целиком —
    // то есть одно испорченное поле стоит нам всей телеметрии человека, а не одной метрики.
    for v in [
        &mut out.capture_ms,
        &mut out.capture_ms_now,
        &mut out.convert_ms,
        &mut out.fps,
        &mut out.target_bitrate,
        &mut out.limit_cpu_s,
        &mut out.limit_bandwidth_s,
        &mut out.rtt_ms,
        &mut out.fraction_lost,
        &mut out.at_ms,
    ] {
        if !v.is_finite() {
            *v = 0.0;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

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
