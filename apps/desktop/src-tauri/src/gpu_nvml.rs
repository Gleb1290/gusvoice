//! ⚠️ Без фичи `diag` (публичная сборка, #113) из модуля живёт только `compute_capability` —
//! поколение карты для защиты от вылета показа на Pascal (#112). Остальное собирает телеметрию и не
//! вызывается; глушим шум о неиспользуемом, а не удаляем — нашей сборке этот код нужен.
#![cfg_attr(not(feature = "diag"), allow(dead_code, unused_imports))]

//! Что на самом деле происходит с видеокартой — через NVML (библиотека управления NVIDIA).
//!
//! Зачем отдельно от PDH-счётчиков в `diag.rs`: **процент загрузки видеокарты сам по себе почти
//! ничего не доказывает.** Это доля времени, когда движок был чем-то занят, а не объём работы. На
//! рабочем столе карта уходит в энергосберегающее состояние и роняет частоту почти на порядок —
//! замерено на RTX 3080 прямо у нас: `210 МГц при максимуме 2130, состояние P8, загрузка 18%,
//! потребление 29 Вт из 370`. Те же «18%» на полной частоте означали бы в десять раз больше работы.
//! Поэтому без частоты, состояния производительности и потребления цифра загрузки нечитаема, и
//! разговор «стримлю — падает fps» по ней вести нельзя.
//!
//! Что это даёт по существу:
//!   * **Ёмкость видеопамяти.** Переполнение VRAM — самая частая причина «игра залагала»: драйвер
//!     начинает вытеснять текстуры в оперативную память через шину, и это ощущается как рывки, а не
//!     как честное падение fps. Знать `занято` без `всего` бесполезно, а WMI на ёмкости врёт (на той
//!     же 3080 отдаёт 4 ГБ вместо 10 — переполнение 32-битного поля), так что источник только этот.
//!   * **Загрузку кодировщика отдельно от 3D.** Сразу видно, кодируем ли мы железом (NVENC) или
//!     свалились в software-кодек, который вместо этого ест процессор.
//!   * **Причину низких частот.** Карта может стоять на низкой частоте не потому, что ей нечего
//!     делать, а из-за упора в лимит мощности или перегрева — это разные диагнозы.
//!
//! 🔴 **Загружаем `nvml.dll` динамически и объявляем функции вручную.** Никаких новых зависимостей и
//! никаких новых фич крейта `windows`: фича `Win32_System_Performance` в своё время раздувала
//! генерируемый код так, что rustc падал в РЕЛИЗНОЙ сборке (и `cargo check` этого не показывал) —
//! повторять не хочется. Библиотека ставится вместе с драйвером NVIDIA и лежит в `System32`; на
//! машинах с AMD/Intel её просто нет, и весь модуль тихо отдаёт `None`, ничего не ломая.
#![cfg(target_os = "windows")]

use serde::Serialize;
use std::ffi::c_void;
use std::sync::Mutex;

// ─────────────────────────── ручные объявления (см. шапку) ───────────────────────────

type NvmlDevice = *mut c_void;
type NvmlReturn = u32;
const NVML_SUCCESS: NvmlReturn = 0;

/// Тип частоты: 0 — графическое ядро, 2 — память.
const NVML_CLOCK_GRAPHICS: u32 = 0;
const NVML_CLOCK_MEM: u32 = 2;
/// Датчик температуры: 0 — сам кристалл.
const NVML_TEMPERATURE_GPU: u32 = 0;

#[repr(C)]
#[derive(Default)]
struct NvmlMemory {
    total: u64,
    free: u64,
    used: u64,
}

#[repr(C)]
#[derive(Default)]
struct NvmlUtilization {
    gpu: u32,
    memory: u32,
}

/// Указатели на функции NVML, добытые через `GetProcAddress`. Держим ровно то, что читаем.
struct Nvml {
    _lib: isize,
    device: NvmlDevice,
    get_name: unsafe extern "C" fn(NvmlDevice, *mut u8, u32) -> NvmlReturn,
    get_memory: unsafe extern "C" fn(NvmlDevice, *mut NvmlMemory) -> NvmlReturn,
    get_clock: unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlReturn,
    get_max_clock: unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlReturn,
    get_pstate: unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlReturn,
    get_throttle: unsafe extern "C" fn(NvmlDevice, *mut u64) -> NvmlReturn,
    get_util: unsafe extern "C" fn(NvmlDevice, *mut NvmlUtilization) -> NvmlReturn,
    get_enc_util: unsafe extern "C" fn(NvmlDevice, *mut u32, *mut u32) -> NvmlReturn,
    get_power: unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlReturn,
    get_power_limit: unsafe extern "C" fn(NvmlDevice, *mut u32) -> NvmlReturn,
    get_temp: unsafe extern "C" fn(NvmlDevice, u32, *mut u32) -> NvmlReturn,
    /// Поколение карты (вычислительная способность CUDA).
    ///
    /// ⚠️ `Option`, а не `?` при загрузке, СОЗНАТЕЛЬНО: функции нет в совсем старых драйверах, и
    /// через `?` её отсутствие уронило бы загрузку NVML целиком — то есть мы потеряли бы ВСЕ
    /// показания видеокарты ради одного необязательного числа.
    get_cc: Option<unsafe extern "C" fn(NvmlDevice, *mut i32, *mut i32) -> NvmlReturn>,
}

// Указатели живут ровно столько же, сколько загруженная библиотека (мы её не выгружаем), и
// используются под мьютексом — гонок за ними нет.
unsafe impl Send for Nvml {}

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}

/// Достать функцию по имени; `None` — если библиотека старая и такой в ней нет.
unsafe fn sym(lib: isize, name: &str) -> Option<*const c_void> {
    let mut n = name.as_bytes().to_vec();
    n.push(0);
    let p = GetProcAddress(lib, n.as_ptr());
    if p.is_null() {
        None
    } else {
        Some(p)
    }
}

/// Единственная инициализация на весь процесс: `nvmlInit` не бесплатный, а зовут нас раз в
/// несколько секунд. `Err` кэшируется так же, как `Ok` — на машине без NVIDIA нет смысла дёргать
/// загрузку библиотеки на каждом замере.
static NVML: Mutex<Option<Option<Nvml>>> = Mutex::new(None);

unsafe fn load() -> Option<Nvml> {
    // "nvml.dll" ищется по обычному порядку поиска — драйвер кладёт её в System32.
    let name: Vec<u16> = "nvml.dll\0".encode_utf16().collect();
    let lib = LoadLibraryW(name.as_ptr());
    if lib == 0 {
        return None; // не NVIDIA — это штатный исход, не ошибка
    }

    let init: unsafe extern "C" fn() -> NvmlReturn = std::mem::transmute(sym(lib, "nvmlInit_v2")?);
    if init() != NVML_SUCCESS {
        return None;
    }

    // Карт может быть несколько (дискретка + встройка на ноутбуке). Берём ту, где больше всего
    // видеопамяти: играют и кодируют именно на ней.
    let get_count: unsafe extern "C" fn(*mut u32) -> NvmlReturn =
        std::mem::transmute(sym(lib, "nvmlDeviceGetCount_v2")?);
    let by_index: unsafe extern "C" fn(u32, *mut NvmlDevice) -> NvmlReturn =
        std::mem::transmute(sym(lib, "nvmlDeviceGetHandleByIndex_v2")?);
    let get_memory: unsafe extern "C" fn(NvmlDevice, *mut NvmlMemory) -> NvmlReturn =
        std::mem::transmute(sym(lib, "nvmlDeviceGetMemoryInfo")?);

    let mut count = 0u32;
    if get_count(&mut count) != NVML_SUCCESS || count == 0 {
        return None;
    }
    let mut best: NvmlDevice = std::ptr::null_mut();
    let mut best_vram = 0u64;
    for i in 0..count {
        let mut dev: NvmlDevice = std::ptr::null_mut();
        if by_index(i, &mut dev) != NVML_SUCCESS {
            continue;
        }
        let mut m = NvmlMemory::default();
        if get_memory(dev, &mut m) == NVML_SUCCESS && m.total > best_vram {
            best_vram = m.total;
            best = dev;
        }
    }
    if best.is_null() {
        return None;
    }

    Some(Nvml {
        _lib: lib,
        device: best,
        get_name: std::mem::transmute(sym(lib, "nvmlDeviceGetName")?),
        get_memory,
        get_clock: std::mem::transmute(sym(lib, "nvmlDeviceGetClockInfo")?),
        get_max_clock: std::mem::transmute(sym(lib, "nvmlDeviceGetMaxClockInfo")?),
        get_pstate: std::mem::transmute(sym(lib, "nvmlDeviceGetPerformanceState")?),
        get_throttle: std::mem::transmute(sym(lib, "nvmlDeviceGetCurrentClocksThrottleReasons")?),
        get_util: std::mem::transmute(sym(lib, "nvmlDeviceGetUtilizationRates")?),
        get_enc_util: std::mem::transmute(sym(lib, "nvmlDeviceGetEncoderUtilization")?),
        get_power: std::mem::transmute(sym(lib, "nvmlDeviceGetPowerUsage")?),
        get_power_limit: std::mem::transmute(sym(lib, "nvmlDeviceGetEnforcedPowerLimit")?),
        get_temp: std::mem::transmute(sym(lib, "nvmlDeviceGetTemperature")?),
        get_cc: sym(lib, "nvmlDeviceGetCudaComputeCapability").map(|p| std::mem::transmute(p)),
    })
}

/// Срез состояния видеокарты. Все поля — «как есть от драйвера»; расшифровку и выводы делаем на
/// сервере, чтобы клиент можно было не переобновлять ради смены трактовки.
#[derive(Serialize, Default, Clone)]
#[cfg(feature = "diag")]
pub struct GpuState {
    /// Модель карты — без неё числа не с чем соотнести («6 ГБ занято» на 3080 и на 1660 это разное).
    pub name: String,
    pub vram_used_mb: u32,
    /// 🔴 Ёмкость. Именно её не хватало, чтобы понять, упирается человек в видеопамять или нет.
    pub vram_total_mb: u32,
    /// Текущая и максимальная частота ядра. Их отношение и отличает «карта спит» от «карта пашет».
    pub clock_mhz: u32,
    pub clock_max_mhz: u32,
    pub mem_clock_mhz: u32,
    /// Состояние производительности: 0 — максимум, 8 и дальше — глубокий простой.
    pub pstate: u32,
    /// Битовая маска причин, по которым частоты ниже максимума (упор в мощность, нагрев и т.п.).
    pub throttle_reasons: u64,
    pub util_gpu: u32,
    pub util_mem: u32,
    /// Загрузка блока аппаратного кодирования. Ноль во время показа = кодируем не железом.
    pub util_encoder: u32,
    pub power_w: f32,
    pub power_limit_w: f32,
    pub temp_c: u32,
}

/// Снять состояние видеокарты. `None` — карты NVIDIA нет или драйвер не отдал данные; это штатно.
#[cfg(feature = "diag")]
pub fn snapshot() -> Option<GpuState> {
    let mut guard = NVML.lock().ok()?;
    let slot = guard.get_or_insert_with(|| unsafe { load() });
    let n = slot.as_ref()?;

    unsafe {
        let mut s = GpuState::default();

        let mut buf = [0u8; 96];
        if (n.get_name)(n.device, buf.as_mut_ptr(), buf.len() as u32) == NVML_SUCCESS {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            s.name = String::from_utf8_lossy(&buf[..end]).into_owned();
        }

        let mut m = NvmlMemory::default();
        if (n.get_memory)(n.device, &mut m) == NVML_SUCCESS {
            s.vram_used_mb = (m.used / 1_048_576) as u32;
            s.vram_total_mb = (m.total / 1_048_576) as u32;
        }

        let mut v = 0u32;
        if (n.get_clock)(n.device, NVML_CLOCK_GRAPHICS, &mut v) == NVML_SUCCESS {
            s.clock_mhz = v;
        }
        if (n.get_max_clock)(n.device, NVML_CLOCK_GRAPHICS, &mut v) == NVML_SUCCESS {
            s.clock_max_mhz = v;
        }
        if (n.get_clock)(n.device, NVML_CLOCK_MEM, &mut v) == NVML_SUCCESS {
            s.mem_clock_mhz = v;
        }
        if (n.get_pstate)(n.device, &mut v) == NVML_SUCCESS {
            s.pstate = v;
        }
        let mut t = 0u64;
        if (n.get_throttle)(n.device, &mut t) == NVML_SUCCESS {
            s.throttle_reasons = t;
        }

        let mut u = NvmlUtilization::default();
        if (n.get_util)(n.device, &mut u) == NVML_SUCCESS {
            s.util_gpu = u.gpu;
            s.util_mem = u.memory;
        }
        // Второй аргумент — период усреднения в микросекундах; он нам не нужен, но передать обязаны.
        let (mut enc, mut period) = (0u32, 0u32);
        if (n.get_enc_util)(n.device, &mut enc, &mut period) == NVML_SUCCESS {
            s.util_encoder = enc;
        }

        // Мощность приходит в милливаттах.
        if (n.get_power)(n.device, &mut v) == NVML_SUCCESS {
            s.power_w = v as f32 / 1000.0;
        }
        if (n.get_power_limit)(n.device, &mut v) == NVML_SUCCESS {
            s.power_limit_w = v as f32 / 1000.0;
        }
        if (n.get_temp)(n.device, NVML_TEMPERATURE_GPU, &mut v) == NVML_SUCCESS {
            s.temp_c = v;
        }

        Some(s)
    }
}

/// Поколение видеокарты — «вычислительная способность» CUDA, старшая и младшая цифры.
///
/// 🔴 Зачем показу (#112): на старой карте (Pascal, GTX 1060) второй слой качества ронял приложение, у владельцев свежих карт тот
/// же слой работает без нареканий. Различать поколения по НАЗВАНИЮ («GTX 10…») — путь в ад: имён
/// сотни, и каждый год новые. Вычислительная способность даёт ровно ту границу, которая нужна, одним
/// числом: Pascal — 6.x, Turing — 7.5, Ampere — 8.x.
///
/// `None` — не NVIDIA, либо драйвер старше самой функции. Обе ситуации значат «не знаем», и решать
/// по ним ничего нельзя.
pub fn compute_capability() -> Option<(i32, i32)> {
    let mut guard = NVML.lock().ok()?;
    let slot = guard.get_or_insert_with(|| unsafe { load() });
    let n = slot.as_ref()?;
    let get_cc = n.get_cc?;
    unsafe {
        let (mut major, mut minor) = (0i32, 0i32);
        if get_cc(n.device, &mut major, &mut minor) != NVML_SUCCESS {
            return None;
        }
        Some((major, minor))
    }
}

#[cfg(test)]
mod tests {
    /// Ручная проверка на машине с NVIDIA: `cargo test --release -- --ignored --nocapture`.
    /// Смысл в том, чтобы глазами сверить частоту с `nvidia-smi` — автоматически «правильность»
    /// показаний драйвера не проверить.
    /// ⚠️ Гейт по фиче обязателен: `snapshot()` существует только с `diag`, и без этой строки
    /// обычная документированная команда `cargo test --lib screenshare` вообще не компилируется
    /// (E0425) — то есть чужие тесты падают из-за соседа. Поймал Codex; я на это налетел сам и
    /// обошёл флагом вместо того, чтобы починить.
    #[cfg(feature = "diag")]
    #[test]
    #[ignore]
    fn smoke() {
        match super::snapshot() {
            Some(s) => println!(
                "{} | {} / {} МБ VRAM | {} из {} МГц | P{} | 3D {}% enc {}% | {:.0}/{:.0} Вт | {}°C | throttle 0x{:X}",
                s.name, s.vram_used_mb, s.vram_total_mb, s.clock_mhz, s.clock_max_mhz, s.pstate,
                s.util_gpu, s.util_encoder, s.power_w, s.power_limit_w, s.temp_c, s.throttle_reasons
            ),
            None => println!("NVML недоступен (карта не NVIDIA или нет драйвера) — это штатно"),
        }
    }
}
