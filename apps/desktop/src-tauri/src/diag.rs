//! Диагностика показа экрана: счётчики системы, которые из веб-слоя не видны.
//!
//! Собирает две вещи сразу:
//!   * под #100 («на Win10 при показе отваливаются Alt+Tab и Win») — видеопамять, дескрипторы и
//!     объекты интерфейса у нас, у `explorer` и у `dwm`;
//!   * под жалобу «при показе игра начинает лагать, падает fps» — общую загрузку процессора,
//!     видеокарты и памяти.
//!
//! Раньше это был PowerShell-скрипт, который человек запускал руками. От него отказались: людям
//! непонятно, как его запускать, и данные так и не приезжали. Теперь собирает само приложение.
//!
//! 🔴 **PDH объявлен здесь вручную, а не взят из крейта `windows`, и это не вкусовщина.** Фича
//! `Win32_System_Performance` раздувает генерируемый код настолько, что в РЕЛИЗНОЙ сборке
//! (`opt-level=3`) rustc падал со `STATUS_STACK_BUFFER_OVERRUN` — у него кончался стек. Локальный
//! `cargo check` этого не ловит вовсе: там нет оптимизации, и сборка десктопа умирала только в CI.
//! Нам из всего модуля нужно шесть функций — дешевле объявить их самим, чем тащить мегабайты.
#![cfg(target_os = "windows")]

use serde::Serialize;
use std::sync::Mutex;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::SystemInformation::{GetTickCount, GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::{
    GetGuiResources, GetProcessHandleCount, OpenProcess, GR_GDIOBJECTS, GR_USEROBJECTS,
    PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};

// ─────────────────────────── PDH: ручные объявления (см. шапку) ───────────────────────────

type PdhHandle = isize;
const PDH_FMT_DOUBLE: u32 = 0x0000_0200;

/// `PDH_FMT_COUNTERVALUE`: `DWORD CStatus` + объединение. На x64 перед объединением 4 байта
/// выравнивания — иначе значение читалось бы со сдвигом и выглядело мусором.
#[repr(C)]
struct PdhFmtValue {
    c_status: u32,
    _pad: u32,
    double_value: f64,
}

#[repr(C)]
struct PdhFmtItemW {
    sz_name: *mut u16,
    value: PdhFmtValue,
}

#[link(name = "pdh")]
extern "system" {
    fn PdhOpenQueryW(data_source: *const u16, user_data: usize, query: *mut PdhHandle) -> u32;
    fn PdhAddEnglishCounterW(
        query: PdhHandle,
        path: *const u16,
        user_data: usize,
        counter: *mut PdhHandle,
    ) -> u32;
    fn PdhCollectQueryData(query: PdhHandle) -> u32;
    fn PdhGetFormattedCounterValue(
        counter: PdhHandle,
        format: u32,
        counter_type: *mut u32,
        value: *mut PdhFmtValue,
    ) -> u32;
    fn PdhGetFormattedCounterArrayW(
        counter: PdhHandle,
        format: u32,
        buffer_size: *mut u32,
        item_count: *mut u32,
        items: *mut PdhFmtItemW,
    ) -> u32;
    fn PdhCloseQuery(query: PdhHandle) -> u32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Прочитать счётчик с подстановкой `*` и вернуть пары «имя экземпляра → значение».
fn pdh_array(counter: PdhHandle) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    unsafe {
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        // Вызов с нулевым буфером сообщает требуемый размер.
        let _ = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            std::ptr::null_mut(),
        );
        if size == 0 || count == 0 {
            return out;
        }
        let mut buf = vec![0u8; size as usize];
        let items = buf.as_mut_ptr() as *mut PdhFmtItemW;
        if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, items) != 0 {
            return out;
        }
        for i in 0..count as usize {
            let item = &*items.add(i);
            let mut name = String::new();
            if !item.sz_name.is_null() {
                let mut p = item.sz_name;
                let mut units = Vec::new();
                while *p != 0 {
                    units.push(*p);
                    p = p.add(1);
                }
                name = String::from_utf16_lossy(&units);
            }
            out.push((name, item.value.double_value));
        }
    }
    out
}

// ─────────────────────────── Постоянный запрос под нагрузку ───────────────────────────

/// Загрузка процессора и видеокарты — счётчики СКОРОСТИ: они считаются как разница между двумя
/// сборами. Поэтому запрос живёт между вызовами: тогда каждое число — средняя загрузка за интервал
/// между срезами (15 секунд), а не мгновенный тык. Первый срез после запуска отдаёт нули — базовой
/// точки ещё нет, и это честнее, чем показать выдуманное значение.
struct LoadQuery {
    query: PdhHandle,
    cpu: PdhHandle,
    gpu: PdhHandle,
}

static LOAD: Mutex<Option<LoadQuery>> = Mutex::new(None);

fn load_sample() -> (f64, f64) {
    let mut guard = match LOAD.lock() {
        Ok(g) => g,
        Err(_) => return (0.0, 0.0),
    };
    unsafe {
        if guard.is_none() {
            let mut query: PdhHandle = 0;
            if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                return (0.0, 0.0);
            }
            let mut cpu: PdhHandle = 0;
            let mut gpu: PdhHandle = 0;
            // `AddEnglishCounter` — именно английский вариант: на русской Windows счётчики
            // называются по-русски, и путь на английском иначе просто не найдётся.
            let p_cpu = wide("\\Processor Information(_Total)\\% Processor Time");
            let p_gpu = wide("\\GPU Engine(*)\\Utilization Percentage");
            let _ = PdhAddEnglishCounterW(query, p_cpu.as_ptr(), 0, &mut cpu);
            let _ = PdhAddEnglishCounterW(query, p_gpu.as_ptr(), 0, &mut gpu);
            let _ = PdhCollectQueryData(query);
            // Первый сбор сделан ЗДЕСЬ — он и есть базовая точка. Отдельного «прогрева» на
            // следующем вызове быть не должно: он выбросил бы первое валидное значение, и загрузка
            // приезжала бы нулевой (уже поймано дымовым прогоном).
            *guard = Some(LoadQuery { query, cpu, gpu });
            return (0.0, 0.0);
        }
        let q = guard.as_ref().unwrap();
        if PdhCollectQueryData(q.query) != 0 {
            return (0.0, 0.0);
        }
        let mut ty: u32 = 0;
        let mut v = PdhFmtValue { c_status: 0, _pad: 0, double_value: 0.0 };
        let cpu = if PdhGetFormattedCounterValue(q.cpu, PDH_FMT_DOUBLE, &mut ty, &mut v) == 0 {
            v.double_value
        } else {
            0.0
        };
        // У видеокарты движков много (3D, кодировщик, копирование). Берём МАКСИМУМ, а не сумму:
        // сумма по восьми движкам легко даёт «400%» и ничего не значит, а узкое место — тот движок,
        // который упёрся в потолок первым.
        let gpu = pdh_array(q.gpu)
            .into_iter()
            .map(|(_, v)| v)
            .fold(0.0_f64, f64::max);
        (cpu, gpu)
    }
}

/// Разовый запрос с подстановкой: суммы по pid. Открывается и закрывается на каждый срез — для
/// счётчиков-ГАУГОВ (занятая память) это корректно, история им не нужна.
fn pdh_sum_by_pid(path: &str) -> std::collections::HashMap<u32, f64> {
    let mut out = std::collections::HashMap::new();
    unsafe {
        let mut query: PdhHandle = 0;
        if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
            return out;
        }
        let mut counter: PdhHandle = 0;
        let p = wide(path);
        if PdhAddEnglishCounterW(query, p.as_ptr(), 0, &mut counter) != 0 {
            let _ = PdhCloseQuery(query);
            return out;
        }
        let _ = PdhCollectQueryData(query);
        for (name, value) in pdh_array(counter) {
            // Имена экземпляров: pid_1234_luid_0x..._phys_0
            if let Some(rest) = name.strip_prefix("pid_") {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(pid) = digits.parse::<u32>() {
                    // 🔴 Экземпляров у одного процесса НЕСКОЛЬКО — по одному на видеоадаптер.
                    // Складываем в БАЙТАХ и переводим в мегабайты один раз в конце: скриптовая
                    // версия складывала уже переведённые значения и делила повторно, из-за чего
                    // второй адаптер занулял первый и dwm с гигабайтом показывался нулём.
                    *out.entry(pid).or_insert(0.0) += value;
                }
            }
        }
        let _ = PdhCloseQuery(query);
    }
    out
}

fn pdh_adapter_total_bytes() -> f64 {
    let mut total = 0.0;
    unsafe {
        let mut query: PdhHandle = 0;
        if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
            return 0.0;
        }
        let mut counter: PdhHandle = 0;
        let p = wide("\\GPU Adapter Memory(*)\\Dedicated Usage");
        if PdhAddEnglishCounterW(query, p.as_ptr(), 0, &mut counter) != 0 {
            let _ = PdhCloseQuery(query);
            return 0.0;
        }
        let _ = PdhCollectQueryData(query);
        for (_, v) in pdh_array(counter) {
            total += v;
        }
        let _ = PdhCloseQuery(query);
    }
    total
}

// ─────────────────────────── Сам срез ───────────────────────────

/// За кем следим поимённо. `explorer` — главный подозреваемый по #100 (он рисует Alt+Tab и «Пуск»),
/// `dwm` держит композицию, остальные двое — мы сами.
const WATCH: [&str; 4] = ["gusvoice.exe", "msedgewebview2.exe", "explorer.exe", "dwm.exe"];

const MB: f64 = 1_048_576.0;

#[derive(Serialize, Clone)]
pub struct ProcSample {
    pub name: String,
    pub pid: u32,
    /// `0` у процесса чужой учётной записи (`dwm`) — без прав администратора туда не заглянуть. Это
    /// не сбой сбора: видеопамять по нему снимается нормально, а она тут и главная.
    pub handles: u32,
    pub gdi: u32,
    pub user: u32,
    pub ws_mb: f64,
    pub gpu_dedicated_mb: f64,
    pub gpu_shared_mb: f64,
    /// Доля процессора, съеденная ИМЕННО этим процессом за интервал между срезами, % от одного ядра
    /// ×100 нормировано на все ядра (то есть 100 = вся машина, как в диспетчере задач).
    ///
    /// 🔴 Без этого числа общая загрузка нечитаема: у человека при старте показа процессор прыгал
    /// с 19 до 47 %, и понять, наши это проценты или его игры, было нечем — а от ответа зависит,
    /// оптимизировать нам конвейер захвата или нет. Первый срез после запуска отдаёт `0`: точки
    /// отсчёта ещё нет, и это честнее выдуманного значения.
    pub cpu_pct: f64,
    /// Сколько ВИРТУАЛЬНОЙ памяти (commit) числится за процессом — `PrivateUsage`, он же «Байты
    /// закрытых страниц» в диспетчере задач.
    ///
    /// 🔴 Это НЕ то же самое, что `ws_mb`. Рабочий набор — сколько страниц процесса сейчас в
    /// оперативке; commit — сколько он ЗАБРОНИРОВАЛ у системы, включая уехавшее в файл подкачки.
    /// Кончается всегда commit, а не оперативка, и по рабочему набору этого не видно вовсе.
    /// Разбор аварии 2026-08-22: Windows объявила «слишком мало виртуальной памяти», клиент упал
    /// на неудачном выделении, а у нас в отчёте оперативка показывала спокойные 24 из 47 ГБ.
    pub commit_mb: f64,
}

#[derive(Serialize, Clone)]
pub struct DiagSnapshot {
    pub procs: Vec<ProcSample>,
    /// Суммарная выделенная видеопамять по всем адаптерам — фон, на котором смотрим процессы.
    pub gpu_adapter_total_mb: f64,
    /// Средняя загрузка процессора за интервал между срезами, %.
    pub cpu_pct: f64,
    /// Загрузка самого нагруженного движка видеокарты за тот же интервал, %.
    pub gpu_pct: f64,
    pub ram_used_mb: f64,
    pub ram_total_mb: f64,
    /// ВИРТУАЛЬНАЯ память системы (commit): занято и потолок = оперативка + файл подкачки.
    ///
    /// 🔴 Отдельно от `ram_*` намеренно. Именно этот потолок упирается первым: 2026-08-22 Windows
    /// показала «слишком мало виртуальной памяти», следом клиент упал на выделении, а `ram_used_mb`
    /// в тот момент был спокойным. Пока мерили только оперативку, отказ был НЕВИДИМ в принципе.
    /// Файл подкачки у системы обычно растёт сам, и в момент роста выделения могут получать отказ —
    /// поэтому важен именно ОСТАТОК, а не факт «памяти вроде хватает».
    pub commit_used_mb: f64,
    pub commit_total_mb: f64,
    /// Число логических ядер.
    ///
    /// 🔴 Без него доля процессора НЕЧИТАЕМА: она нормирована на все ядра, поэтому «8 %» на 12
    /// потоках — это занятое ядро целиком, а на 4 потоках — треть ядра. При разборе 2026-08-22
    /// пришлось оговаривать это словами вместо того, чтобы посчитать.
    pub cores: u32,
    /// Настоящее состояние видеокарты (частоты, состояние производительности, ёмкость видеопамяти,
    /// загрузка кодировщика). Без него `gpu_pct` выше нечитаем: карта на рабочем столе роняет частоту
    /// почти на порядок, и «занята на 75%» там означает совсем не то же, что на полной частоте.
    /// `None` на не-NVIDIA — штатно, см. `gpu_nvml`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<crate::gpu_nvml::GpuState>,

    // ─── Отвечает ли оболочка и доходят ли до нас клавиши (#100, замеры 2026-08-19) ───
    /// Завис ли поток окна ОБОЛОЧКИ (рабочий стол) и панели задач.
    ///
    /// 🔴 Главное измерение под #100. У человека с воспроизведённым багом Alt+Tab и «Пуск» мертвы, а
    /// Alt+F4 и Ctrl+Shift+Esc работают — и это ровно граница: первые два требуют участия
    /// `explorer`, вторые обрабатываются системой мимо него. То есть отказала ОБОЛОЧКА, а не ввод.
    /// Зависание потока в счётчиках объектов не видно вообще — там всё ровно, мы месяц мерили не то.
    pub shell_hung: bool,
    pub taskbar_hung: bool,
    /// Сколько миллисекунд назад человек в последний раз что-либо вводил (мышь или клавиатура).
    pub input_idle_ms: u32,
    /// Сколько миллисекунд назад система в последний раз ВЫЗЫВАЛА наш низкоуровневый хук клавиатуры.
    /// `null` — не вызывался ни разу.
    ///
    /// Пара к `input_idle_ms`: человек активно вводит (первое мало), а хук молчит (второе растёт) =
    /// Windows выбросила хук из цепочки за неответ. Изнутри приложения это иначе не отличить от
    /// «просто не нажимали», а выбрасывает она молча.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_idle_ms: Option<u32>,
    /// Объекты интерфейса и GDI, просуммированные по ВСЕЙ системе, и сколько процессов посчитать не
    /// удалось (чужая учётная запись — без прав администратора их не открыть).
    ///
    /// Лимит на СЕССИЮ считается отдельно от лимита на процесс, а мерили мы только четыре процесса:
    /// исчерпание сессии выглядело бы как «у всех всё ровно», что мы и наблюдали.
    pub sys_gdi_total: u32,
    pub sys_user_total: u32,
    pub sys_procs_denied: u32,
}

/// Завис ли поток окна оболочки и панели задач + время простоя ввода.
///
/// `IsHungAppWindow` спрашивает у системы ровно то, что нам нужно: отвечает ли поток, которому
/// принадлежит окно, на сообщения. Именно этот поток обрабатывает Alt+Tab и «Пуск», и именно его
/// молчание объясняет наблюдаемую границу «Alt+F4 работает, Alt+Tab нет».
fn shell_health() -> (bool, bool, u32) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetShellWindow, IsHungAppWindow};
    unsafe {
        let shell = GetShellWindow();
        let shell_hung = !shell.is_invalid() && IsHungAppWindow(shell).as_bool();

        let cls = wide("Shell_TrayWnd");
        let taskbar_hung = match FindWindowW(windows::core::PCWSTR(cls.as_ptr()), None) {
            Ok(h) if !h.is_invalid() => IsHungAppWindow(h).as_bool(),
            _ => false,
        };

        let mut li = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        let idle = if GetLastInputInfo(&mut li).as_bool() {
            GetTickCount().wrapping_sub(li.dwTime)
        } else {
            0
        };
        (shell_hung, taskbar_hung, idle)
    }
}

/// Объекты интерфейса и GDI, просуммированные по ВСЕЙ системе.
///
/// Лимит на сессию рабочего стола считается отдельно от лимита на процесс: его исчерпание выглядит
/// как «у всех процессов всё в норме» — ровно то, что мы и видели, пока мерили только четыре.
/// Процессы чужой учётной записи не открываются без прав администратора; считаем их отдельно, чтобы
/// было видно, насколько сумма неполна, а не молча занижать её.
fn system_gui_totals() -> (u32, u32, u32) {
    let (mut gdi, mut user, mut denied) = (0u32, 0u32, 0u32);
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return (0, 0, 0);
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let pid = e.th32ProcessID;
                if pid != 0 {
                    match OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) {
                        Ok(h) => {
                            gdi += GetGuiResources(h, GR_GDIOBJECTS);
                            user += GetGuiResources(h, GR_USEROBJECTS);
                            let _ = CloseHandle(h);
                        }
                        Err(_) => denied += 1,
                    }
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    (gdi, user, denied)
}

/// Оперативка и ВИРТУАЛЬНАЯ память (commit) одним вызовом: `(ram_used, ram_total, commit_used,
/// commit_total)`.
///
/// ⚠️ Поля с `PageFile` в названии врут именем: `ullTotalPageFile` — это НЕ размер файла подкачки,
/// а общий потолок commit (оперативка + файл подкачки), так это и задокументировано у Microsoft.
/// Ровно этот потолок упирается первым, см. комментарий у `commit_used_mb`.
fn mem() -> (f64, f64, f64, f64) {
    unsafe {
        let mut m = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut m).is_err() {
            return (0.0, 0.0, 0.0, 0.0);
        }
        let ram_total = m.ullTotalPhys as f64 / MB;
        let commit_total = m.ullTotalPageFile as f64 / MB;
        (
            ram_total - m.ullAvailPhys as f64 / MB,
            ram_total,
            commit_total - m.ullAvailPageFile as f64 / MB,
            commit_total,
        )
    }
}

/// Предыдущие показания счётчика процессорного времени по pid + отметка времени.
///
/// Процесс отдаёт НАКОПЛЕННОЕ время, а нам нужна скорость его роста — значит нужна пара замеров.
/// Держим между вызовами; на смерть процесса запись просто перестаёт обновляться (чистим по факту
/// отсутствия, чтобы карта не росла бесконечно на плодящихся `msedgewebview2`).
static CPU_PREV: Mutex<Option<std::collections::HashMap<u32, (u64, u64)>>> = Mutex::new(None);

/// Процессорное время процесса (ядро + пользовательский режим) в 100-наносекундных единицах.
unsafe fn proc_cpu_100ns(h: windows::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;
    let (mut cr, mut ex, mut kern, mut usr) =
        (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    if GetProcessTimes(h, &mut cr, &mut ex, &mut kern, &mut usr).is_err() {
        return None;
    }
    let as_u64 = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    Some(as_u64(kern) + as_u64(usr))
}

fn sample_proc(
    name: &str,
    pid: u32,
    ded: &std::collections::HashMap<u32, f64>,
    shr: &std::collections::HashMap<u32, f64>,
) -> ProcSample {
    let mut s = ProcSample {
        name: name.to_string(),
        pid,
        handles: 0,
        gdi: 0,
        user: 0,
        ws_mb: 0.0,
        gpu_dedicated_mb: ded.get(&pid).copied().unwrap_or(0.0) / MB,
        gpu_shared_mb: shr.get(&pid).copied().unwrap_or(0.0) / MB,
        cpu_pct: 0.0,
        commit_mb: 0.0,
    };
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
            let mut hc: u32 = 0;
            if GetProcessHandleCount(h, &mut hc).is_ok() {
                s.handles = hc;
            }
            s.gdi = GetGuiResources(h, GR_GDIOBJECTS);
            s.user = GetGuiResources(h, GR_USEROBJECTS);
            // ⚠️ Берём EX-версию структуры ради `PrivateUsage` (commit процесса). Функция принимает
            // указатель на БАЗОВУЮ структуру, а размером `cb` сообщает, что буфер длиннее — так этот
            // вызов и задуман. Обычная `PROCESS_MEMORY_COUNTERS` поля commit не содержит вовсе, а без
            // него не видно, кто именно съедает упирающийся потолок (см. `commit_used_mb`).
            let mut pmc = PROCESS_MEMORY_COUNTERS_EX::default();
            let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            if GetProcessMemoryInfo(h, &mut pmc as *mut _ as *mut PROCESS_MEMORY_COUNTERS, cb).is_ok()
            {
                s.ws_mb = pmc.WorkingSetSize as f64 / MB;
                s.commit_mb = pmc.PrivateUsage as f64 / MB;
            }
            // Скорость роста процессорного времени между этим срезом и предыдущим. Нормируем на
            // число ядер, чтобы число читалось так же, как в диспетчере задач: 100 = вся машина.
            if let (Some(now_cpu), Ok(mut guard)) = (proc_cpu_100ns(h), CPU_PREV.lock()) {
                let now_ms = GetTickCount() as u64;
                let map = guard.get_or_insert_with(std::collections::HashMap::new);
                if let Some((prev_cpu, prev_ms)) = map.insert(pid, (now_cpu, now_ms)) {
                    let d_ms = now_ms.saturating_sub(prev_ms);
                    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
                    if d_ms > 0 {
                        // 100-нс единицы → миллисекунды: делим на 10 000.
                        let busy_ms = now_cpu.saturating_sub(prev_cpu) as f64 / 10_000.0;
                        s.cpu_pct = (busy_ms / (d_ms as f64 * cores) * 100.0).clamp(0.0, 100.0);
                    }
                }
            }
            let _ = CloseHandle(h);
        }
    }
    s
}

/// Один срез. Зовётся раз в 15 секунд, пока идёт показ экрана.
pub fn snapshot() -> DiagSnapshot {
    let ded = pdh_sum_by_pid("\\GPU Process Memory(*)\\Dedicated Usage");
    let shr = pdh_sum_by_pid("\\GPU Process Memory(*)\\Shared Usage");
    let (cpu_pct, gpu_pct) = load_sample();
    let (ram_used_mb, ram_total_mb, commit_used_mb, commit_total_mb) = mem();
    let (shell_hung, taskbar_hung, input_idle_ms) = shell_health();
    let (sys_gdi_total, sys_user_total, sys_procs_denied) = system_gui_totals();
    let mut procs = Vec::new();

    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut e = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    // szExeFile — массив фиксированной длины, добитый нулями: режем по первому нулю,
                    // иначе имя не совпадёт ни с одной строкой из WATCH.
                    let end = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    let name = String::from_utf16_lossy(&e.szExeFile[..end]);
                    if WATCH.iter().any(|w| w.eq_ignore_ascii_case(&name)) {
                        procs.push(sample_proc(&name, e.th32ProcessID, &ded, &shr));
                    }
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
    }

    DiagSnapshot {
        procs,
        gpu_adapter_total_mb: pdh_adapter_total_bytes() / MB,
        cpu_pct,
        gpu_pct,
        ram_used_mb,
        ram_total_mb,
        commit_used_mb,
        commit_total_mb,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0) as u32,
        gpu: crate::gpu_nvml::snapshot(),
        shell_hung,
        taskbar_hung,
        input_idle_ms,
        // Хук ни разу не вызывался (не установлен) — это не «молчит», это «его нет»; не путаем.
        hook_idle_ms: match crate::hotkey_key::last_hook_tick() {
            0 => None,
            t => Some(unsafe { GetTickCount() }.wrapping_sub(t)),
        },
        sys_gdi_total,
        sys_user_total,
        sys_procs_denied,
    }
}

/// Команда для веб-слоя: один срез. Буферизация и отправка — забота клиента.
#[tauri::command]
pub fn gv_diag_snapshot() -> DiagSnapshot {
    snapshot()
}

/// Настоящая версия Windows.
///
/// 🔴 Ради этого и пишется: **строка браузера версию не различает.** У всех, кто прислал отчёты, там
/// одинаковое `Windows NT 10.0` — и у десятки, и у одиннадцатой. А баг с залипающим Alt+Tab при
/// показе экрана воспроизводится именно на Windows 10, так что без этого поля выборку не разделить и
/// половина смысла отчётов теряется.
///
/// Берём `RtlGetVersion` из `ntdll`, а не `GetVersionEx`: последняя врёт (без манифеста совместимости
/// сообщает 6.2), а первая отдаёт настоящий номер сборки. Одиннадцатая отличается от десятой только
/// номером сборки — 22000 и выше, отдельного «major 11» в системе не существует.
/// Версия приложения — та же, что в `tauri.conf.json`.
///
/// 🔴 Появилась потому, что дважды за один вечер я определял версию клиента КОСВЕННО — по наличию
/// новых полей в отчёте. Это работает ровно до первой ошибки и на нём нельзя строить выводы вроде
/// «он уже обновился, значит дело не в старой сборке».
#[tauri::command]
pub fn gv_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn gv_os_info() -> String {
    // ⚠️ Без `#[derive(Default)]`: `csd` — массив на 128 элементов, а `Default` для массивов выводится
    // только до 32 (E0277). Заполняем нулями явно.
    #[repr(C)]
    struct OsVersionInfoW {
        dw_size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        csd: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }
    unsafe {
        let mut v = OsVersionInfoW {
            dw_size: std::mem::size_of::<OsVersionInfoW>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            csd: [0; 128],
        };
        if RtlGetVersion(&mut v) != 0 {
            return String::new();
        }
        let name = if v.major >= 10 && v.build >= 22000 {
            "Windows 11"
        } else if v.major >= 10 {
            "Windows 10"
        } else {
            "Windows (старая)"
        };
        format!("{name} build {}", v.build)
    }
}

#[cfg(test)]
mod tests {
    /// Дымовой прогон на живой машине. `#[ignore]` — в CI не гоняется (там Linux, модуль
    /// windows-only), запускать руками:
    ///   cargo test --lib diag -- --ignored --nocapture
    ///
    /// Смысл ровно один: PDH-обёртка, которая компилируется и возвращает нули, выглядит точно так же,
    /// как рабочая. Скриптовая версия этого сборщика именно так и врала.
    #[test]
    #[ignore]
    fn smoke() {
        // Первый вызов только заводит счётчики скорости — нагрузка в нём заведомо нулевая.
        let _ = super::snapshot();
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let s = super::snapshot();
        println!(
            "ЦП {:.0}%  ГП {:.0}%  ОЗУ {:.0}/{:.0} МБ  видеопамять адаптера {:.0} МБ",
            s.cpu_pct, s.gpu_pct, s.ram_used_mb, s.ram_total_mb, s.gpu_adapter_total_mb
        );
        println!(
            "виртуальная память (commit): {:.0}/{:.0} МБ, остаток {:.0} МБ",
            s.commit_used_mb,
            s.commit_total_mb,
            s.commit_total_mb - s.commit_used_mb
        );
        println!(
            "оболочка зависла={}  панель задач зависла={}  ввод молчит {} мс  хук молчит {:?} мс",
            s.shell_hung, s.taskbar_hung, s.input_idle_ms, s.hook_idle_ms
        );
        println!(
            "по всей системе: GDI {}  объектов интерфейса {}  (не открылось процессов: {})",
            s.sys_gdi_total, s.sys_user_total, s.sys_procs_denied
        );
        assert!(s.sys_user_total > 0, "суммарные объекты интерфейса не посчитались");
        for p in &s.procs {
            println!(
                "  {:22} pid={:<6} ЦП={:>5.1}%  дескр={:<6} gdi={:<5} user={:<5} ws={:.0}МБ commit={:.0}МБ gpu={:.1}МБ",
                p.name, p.pid, p.cpu_pct, p.handles, p.gdi, p.user, p.ws_mb, p.commit_mb,
                p.gpu_dedicated_mb
            );
        }
        assert!(!s.procs.is_empty(), "не найдено ни одного процесса из WATCH");
        assert!(s.ram_total_mb > 0.0, "не прочитался объём ОЗУ");
        // 🔴 Потолок commit ВСЕГДА больше объёма оперативки (он = ОЗУ + файл подкачки). Если это не
        // так — прочитали не то поле, а именно на этой мерке держится весь разбор нехватки памяти.
        assert!(
            s.commit_total_mb >= s.ram_total_mb,
            "потолок commit ({:.0}) меньше ОЗУ ({:.0}) — прочитано не то поле",
            s.commit_total_mb,
            s.ram_total_mb
        );
        assert!(
            s.procs.iter().any(|p| p.commit_mb > 0.0),
            "ни у одного процесса не прочитался commit"
        );
    }
}
