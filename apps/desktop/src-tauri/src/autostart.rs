//! Optional Windows login startup. Nothing calls set() during application startup.
//! Run's 260 UTF-16-unit command limit:
//! https://learn.microsoft.com/windows/win32/setupapi/run-and-runonce-registry-keys
//! StartupApproved is an undocumented Explorer format, not a stable Win32 API.
//! Read it conservatively (absent / known enabled states only), never write it.
//! References: Electron's GetLoginItemSettingsHelper and Unsloth's startup_approved_disabled:
//! https://github.com/electron/electron/blob/main/shell/browser/browser_win.cc
//! https://github.com/unslothai/unsloth/blob/main/studio/src-tauri/src/main.rs
//! This reports our Run registration and Explorer approval, not a guarantee of execution:
//! machine policy, Safe Mode and Windows startup delays can still prevent/delay launch.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS, WIN32_ERROR,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_BINARY, REG_OPTION_NON_VOLATILE,
    REG_SAM_FLAGS, REG_SZ, REG_VALUE_TYPE,
};

const RUN: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");
const APPROVAL: PCWSTR =
    w!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run");
const NAME: PCWSTR = w!("GusVoice");
const MAX_COMMAND_UNITS: usize = 260;
const MAX_VALUE_BYTES: usize = (MAX_COMMAND_UNITS + 1) * 2;

fn os_error(operation: &str, status: WIN32_ERROR) -> String {
    format!("Автозапуск: {operation} (ошибка Windows {}).", status.0)
}

/// Every successfully opened/created handle has exactly one owner, including error paths.
struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

impl Key {
    fn open(path: PCWSTR, access: REG_SAM_FLAGS) -> Result<Option<Self>, String> {
        let mut handle = HKEY::default();
        let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path, None, access, &mut handle) };
        match status {
            ERROR_SUCCESS => Ok(Some(Self(handle))),
            ERROR_FILE_NOT_FOUND => Ok(None),
            _ => Err(os_error("не удалось открыть раздел", status)),
        }
    }

    fn create(path: PCWSTR) -> Result<Self, String> {
        let mut handle = HKEY::default();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path,
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                None,
                &mut handle,
                None,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(Self(handle))
        } else {
            Err(os_error("не удалось создать раздел", status))
        }
    }

    /// One bounded read: no unchecked size allocation, no retry loop if another writer races.
    /// RegQueryValueExW's byte count includes NUL only when it was actually stored.
    /// https://learn.microsoft.com/windows/win32/api/winreg/nf-winreg-regqueryvalueexw
    fn read(&self) -> Result<Option<(REG_VALUE_TYPE, Vec<u8>)>, String> {
        let mut bytes = [0u8; MAX_VALUE_BYTES];
        let mut size = bytes.len() as u32;
        let mut kind = REG_VALUE_TYPE::default();
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                NAME,
                None,
                Some(&mut kind),
                Some(bytes.as_mut_ptr()),
                Some(&mut size),
            )
        };
        match status {
            ERROR_FILE_NOT_FOUND => Ok(None),
            ERROR_MORE_DATA => {
                Err("Автозапуск: запись реестра превышает допустимый размер.".into())
            }
            ERROR_SUCCESS if size as usize <= bytes.len() => {
                Ok(Some((kind, bytes[..size as usize].to_vec())))
            }
            _ => Err(os_error("не удалось прочитать запись", status)),
        }
    }

    fn write(&self, kind: REG_VALUE_TYPE, bytes: &[u8]) -> Result<(), String> {
        let status = unsafe { RegSetValueExW(self.0, NAME, None, kind, Some(bytes)) };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(os_error("не удалось сохранить запись", status))
        }
    }

    fn remove(&self) -> Result<(), String> {
        let status = unsafe { RegDeleteValueW(self.0, NAME) };
        match status {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
            _ => Err(os_error("не удалось удалить запись", status)),
        }
    }
}

/// Executable only, always quoted, no flags/shell/hidden startup. Preserve UTF-16 exactly.
fn quoted_command(path: &OsStr) -> Result<Vec<u16>, String> {
    let path: Vec<u16> = path.encode_wide().collect();
    if path.is_empty()
        || path.iter().any(|unit| *unit == 0 || *unit == b'"' as u16)
        || matches!(path.last(), Some(92 | 47))
        || String::from_utf16(&path).is_err()
    {
        return Err("Автозапуск: недопустимый путь приложения.".into());
    }
    if path.len() + 2 > MAX_COMMAND_UNITS {
        return Err(
            "Автозапуск: путь приложения превышает лимит Windows Run (260 символов).".into(),
        );
    }
    let mut command = Vec::with_capacity(path.len() + 3);
    command.push(b'"' as u16);
    command.extend(path);
    command.extend([b'"' as u16, 0]);
    Ok(command)
}

fn current_command() -> Result<Vec<u16>, String> {
    let exe = std::env::current_exe()
        .map_err(|_| "Автозапуск: не удалось определить путь приложения.".to_string())?;
    if !exe.is_absolute() {
        return Err("Автозапуск: путь приложения должен быть абсолютным.".into());
    }
    quoted_command(exe.as_os_str())
}

fn reg_sz_matches(kind: REG_VALUE_TYPE, bytes: &[u8], command: &[u16]) -> bool {
    // Exact length and every code unit (including exactly one final NUL).
    // This rejects wrong types, odd byte counts, missing/embedded NUL, invalid UTF-16,
    // extra arguments, stale executable paths and unquoted paths.
    kind == REG_SZ
        && bytes.len() == command.len() * 2
        && bytes
            .chunks_exact(2)
            .zip(command)
            .all(|(pair, unit)| u16::from_le_bytes([pair[0], pair[1]]) == *unit)
}

/// Known enabled/re-enabled states only; unknown/malformed data never means enabled.
fn approved(kind: REG_VALUE_TYPE, bytes: &[u8]) -> bool {
    kind == REG_BINARY
        && bytes.len() == 12
        && matches!(u32::from_le_bytes(bytes[..4].try_into().unwrap()), 2 | 6)
}

fn explorer_allows() -> Result<bool, String> {
    let Some(key) = Key::open(APPROVAL, KEY_QUERY_VALUE)? else {
        return Ok(true);
    };
    Ok(match key.read()? {
        None => true,
        Some((kind, bytes)) => approved(kind, &bytes),
    })
}

pub fn enabled() -> Result<bool, String> {
    let Some(key) = Key::open(RUN, KEY_QUERY_VALUE)? else {
        return Ok(false);
    };
    let Some((kind, bytes)) = key.read()? else {
        return Ok(false);
    };
    if !reg_sz_matches(kind, &bytes, &current_command()?) {
        return Ok(false);
    }
    explorer_allows()
}

pub fn set(enabled: bool) -> Result<bool, String> {
    if enabled {
        let command = current_command()?;
        if !explorer_allows()? {
            return Err("Автозапуск GusVoice отключён в Windows. Разрешите его в «Параметры → Приложения → Автозагрузка».".into());
        }
        let bytes: Vec<u8> = command.iter().flat_map(|unit| unit.to_le_bytes()).collect();
        Key::create(RUN)?.write(REG_SZ, &bytes)?;
    } else if let Some(key) = Key::open(RUN, KEY_SET_VALUE)? {
        // Only our named value. Do not delete the Run key or Explorer's approval record.
        key.remove()?;
    }
    self::enabled()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(path: &str) -> Vec<u16> {
        quoted_command(OsStr::new(path)).unwrap()
    }

    fn bytes(command: &[u16]) -> Vec<u8> {
        command.iter().flat_map(|unit| unit.to_le_bytes()).collect()
    }

    #[test]
    fn путь_с_пробелами_запускает_только_exe() {
        assert_eq!(
            command(r"C:\Program Files\GusVoice\gusvoice.exe"),
            "\"C:\\Program Files\\GusVoice\\gusvoice.exe\"\0"
                .encode_utf16()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn кириллица_и_суррогатная_пара_сохраняются() {
        let value = command(r"C:\Приложения\🪿\gusvoice.exe");
        assert_eq!(
            String::from_utf16(&value).unwrap(),
            "\"C:\\Приложения\\🪿\\gusvoice.exe\"\0"
        );
        assert!(reg_sz_matches(REG_SZ, &bytes(&value), &value));
    }

    #[test]
    fn опасный_или_пустой_путь_отклоняется() {
        use std::os::windows::ffi::OsStringExt;
        for path in [
            "",
            "C:\\bad\".exe",
            "C:\\bad\0.exe",
            "C:\\folder\\",
            "C:/folder/",
        ] {
            assert!(quoted_command(OsStr::new(path)).is_err());
        }
        assert!(quoted_command(&std::ffi::OsString::from_wide(&[0xD800])).is_err());
        assert!(quoted_command(OsStr::new(r"C:\GusVoice\gusvoice.exe")).is_ok());
    }

    #[test]
    fn лимит_windows_учитывает_кавычки_и_utf16() {
        assert_eq!(command(&"a".repeat(258)).len(), 261); // 260 + stored NUL
        assert!(quoted_command(OsStr::new(&"a".repeat(259))).is_err());
        assert!(quoted_command(OsStr::new(&format!("{}🪿", "a".repeat(256)))).is_ok());
        assert!(quoted_command(OsStr::new(&format!("{}🪿", "a".repeat(257)))).is_err());
    }

    #[test]
    fn реестр_принимает_только_точную_команду_текущего_exe() {
        let wanted = command(r"C:\GusVoice\gusvoice.exe");
        assert!(reg_sz_matches(REG_SZ, &bytes(&wanted), &wanted));
        for other in [
            "\"C:\\GusVoice\\gusvoice.exe\" --hidden\0",
            "\"C:\\Other\\gusvoice.exe\"\0",
            "C:\\GusVoice\\gusvoice.exe\0",
        ] {
            assert!(!reg_sz_matches(
                REG_SZ,
                &bytes(&other.encode_utf16().collect::<Vec<_>>()),
                &wanted
            ));
        }
        assert!(!reg_sz_matches(REG_BINARY, &bytes(&wanted), &wanted));
    }

    #[test]
    fn повреждённая_строка_реестра_не_включает_автозапуск() {
        let wanted = command(r"C:\GusVoice\gusvoice.exe");
        let valid = bytes(&wanted);
        let mut embedded_nul = valid.clone();
        embedded_nul[4..6].copy_from_slice(&[0, 0]);
        let mut surrogate = valid.clone();
        surrogate[4..6].copy_from_slice(&0xD800u16.to_le_bytes());
        for invalid in [
            vec![],
            valid[..valid.len() - 1].to_vec(),
            valid[..valid.len() - 2].to_vec(),
            embedded_nul,
            surrogate,
            [valid.clone(), vec![0, 0]].concat(),
        ] {
            assert!(!reg_sz_matches(REG_SZ, &invalid, &wanted));
        }
    }

    #[test]
    fn запрет_windows_и_неизвестное_состояние_не_обходятся() {
        for state in [2u32, 6] {
            let mut data = vec![0u8; 12];
            data[..4].copy_from_slice(&state.to_le_bytes());
            assert!(approved(REG_BINARY, &data));
        }
        for state in [0u32, 3, 7, 255] {
            let mut data = vec![0u8; 12];
            data[..4].copy_from_slice(&state.to_le_bytes());
            assert!(!approved(REG_BINARY, &data));
        }
        assert!(!approved(REG_SZ, &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(!approved(REG_BINARY, &[]));
        assert!(!approved(REG_BINARY, &[2, 0, 0, 0]));
    }

    #[test]
    fn временный_раздел_проверяет_чтение_запись_и_повторное_удаление() {
        use windows::Win32::System::Registry::RegDeleteKeyW;
        // Never Run/StartupApproved: unique, leaf-only key with bounded cleanup even on panic.
        struct Temp(Vec<u16>);
        impl Drop for Temp {
            fn drop(&mut self) {
                let status = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(self.0.as_ptr())) };
                assert!(status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND);
            }
        }
        let name = format!(
            r"Software\GusVoiceAutostartTest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let temp = Temp(name.encode_utf16().chain(Some(0)).collect());
        let key = Key::create(PCWSTR(temp.0.as_ptr())).unwrap();
        assert!(key.read().unwrap().is_none());
        let wanted = command(r"C:\Приложения\GusVoice\gusvoice.exe");
        key.write(REG_SZ, &bytes(&wanted)).unwrap();
        let (kind, data) = key.read().unwrap().unwrap();
        assert!(reg_sz_matches(kind, &data, &wanted));
        key.write(REG_BINARY, &[3; 12]).unwrap();
        let (kind, data) = key.read().unwrap().unwrap();
        assert!(!reg_sz_matches(kind, &data, &wanted));
        key.write(REG_BINARY, &vec![0; MAX_VALUE_BYTES + 1])
            .unwrap();
        assert!(key.read().is_err()); // bounded ERROR_MORE_DATA path
        key.remove().unwrap();
        key.remove().unwrap();
        assert!(key.read().unwrap().is_none());
        drop(key); // close before deleting the unique leaf
        drop(temp);
    }
}
