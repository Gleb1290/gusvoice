//! Native screen-share audio: WASAPI **process-loopback** that EXCLUDES the GusVoice process tree.
//!
//! getDisplayMedia "system audio" captures the whole render mix — which includes GusVoice's own voice
//! output, so a stream would echo everyone back to themselves. Windows 10 2004+ exposes a process
//! loopback mode that captures all audio EXCEPT a target process tree; pointing it at our own PID gives
//! "system audio minus GusVoice" — exactly what we want to stream.
//!
//! Phase 1 (this file): capture + a `record_wav` helper so the result can be verified by ear. Phase 2
//! will stream the same PCM to the webview and publish it as the screen-share audio track.
#![cfg(target_os = "windows")]

use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, Ref, Result, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionEnumerator, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VT_BLOB;

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const BITS: u16 = 32; // IEEE float

/// COM completion handler for ActivateAudioInterfaceAsync — just signals an event when activation done.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct CompletionHandler {
    event: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
    fn ActivateCompleted(&self, _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        unsafe {
            let _ = windows::Win32::System::Threading::SetEvent(self.event);
        }
        Ok(())
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// What the capture should carry:
///  - `ExcludeSelf`: everything the machine plays MINUS GusVoice's own voices (full-screen share).
///  - `IncludeProcess(pid)`: ONLY that process tree's audio (window share → just the streamed app).
pub enum AudioTarget {
    ExcludeSelf,
    IncludeProcess(u32),
}

/// Activate an IAudioClient for process-loopback capture of `target_pid`'s process tree in `mode`
/// (EXCLUDE → everything but the target; INCLUDE → only the target).
unsafe fn activate_loopback_client(target_pid: u32, mode: PROCESS_LOOPBACK_MODE) -> Result<IAudioClient> {
    // The magic device path for the process-loopback endpoint.
    let path = wide("VAD\\Process_Loopback");

    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        ..Default::default()
    };
    params.Anonymous.ProcessLoopbackParams = AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        TargetProcessId: target_pid,
        ProcessLoopbackMode: mode,
    };

    // Wrap the params struct in a VT_BLOB PROPVARIANT (what ActivateAudioInterfaceAsync expects).
    let mut prop = PROPVARIANT::default();
    {
        let inner = &mut *prop.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &mut params as *mut _ as *mut u8,
        };
    }

    let event = CreateEventW(None, false, false, PCWSTR::null())?;
    let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler { event }.into();

    let op_result = ActivateAudioInterfaceAsync(PCWSTR(path.as_ptr()), &IAudioClient::IID, Some(&prop), &handler);
    // CRITICAL: our PROPVARIANT's BLOB points at the STACK `params`. PROPVARIANT::drop runs
    // PropVariantClear -> CoTaskMemFree(pBlobData), which would free a stack address and corrupt the
    // heap → access violation / crash. Neutralize the destructor; `params` stays alive on this stack
    // frame through the wait below (it's only read during activation).
    core::mem::forget(prop);
    let op: IActivateAudioInterfaceAsyncOperation = op_result?;

    // Wait for activation to complete (handler signals `event`).
    WaitForSingleObject(event, 2000);
    let _ = CloseHandle(event);

    let mut hr = windows::core::HRESULT(0);
    let mut unknown: Option<windows::core::IUnknown> = None;
    op.GetActivateResult(&mut hr, &mut unknown)?;
    hr.ok()?;
    unknown
        .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?
        .cast::<IAudioClient>()
}

/// Run a capture loop until `should_stop()` returns true, handing each interleaved f32 block to `sink`.
unsafe fn run_capture(
    target_pid: u32,
    mode: PROCESS_LOOPBACK_MODE,
    mut sink: impl FnMut(&[f32]),
    should_stop: impl Fn() -> bool,
) -> Result<()> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

    let client = activate_loopback_client(target_pid, mode)?;

    // Process loopback has no device mix format — we specify one: 48 kHz stereo float.
    let format = WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * (CHANNELS as u32) * (BITS as u32 / 8),
        nBlockAlign: CHANNELS * (BITS / 8),
        wBitsPerSample: BITS,
        cbSize: 0,
    };

    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        2_000_000, // 200 ms buffer (hns)
        0,
        &format,
        None,
    )?;

    let event = CreateEventW(None, false, false, PCWSTR::null())?;
    client.SetEventHandle(event)?;
    let capture: IAudioCaptureClient = client.GetService()?;
    client.Start()?;

    let result = (|| -> Result<()> {
        while !should_stop() {
            if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 {
                continue; // timed out — loop back to re-check should_stop
            }
            loop {
                let packet = capture.GetNextPacketSize()?;
                if packet == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let n = frames as usize * CHANNELS as usize;
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    let zeros = vec![0f32; n];
                    sink(&zeros);
                } else {
                    sink(std::slice::from_raw_parts(data as *const f32, n));
                }
                capture.ReleaseBuffer(frames)?;
            }
        }
        Ok(())
    })();

    let _ = client.Stop();
    let _ = CloseHandle(event);
    result
}

fn write_wav_f32(path: &std::path::Path, samples: &[f32]) -> std::io::Result<()> {
    use std::io::Write;
    let data_bytes = samples.len() * 4;
    let byte_rate = SAMPLE_RATE * CHANNELS as u32 * (BITS as u32 / 8);
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_bytes as u32).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&3u16.to_le_bytes())?; // IEEE float
    f.write_all(&CHANNELS.to_le_bytes())?;
    f.write_all(&SAMPLE_RATE.to_le_bytes())?;
    f.write_all(&byte_rate.to_le_bytes())?;
    f.write_all(&(CHANNELS * (BITS / 8)).to_le_bytes())?;
    f.write_all(&BITS.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&(data_bytes as u32).to_le_bytes())?;
    for s in samples {
        f.write_all(&s.to_le_bytes())?;
    }
    f.flush()
}

/// Exe file name for a PID (lowercased, no path), e.g. "msedgewebview2.exe".
unsafe fn process_name(pid: u32) -> Option<String> {
    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(h);
    r.ok()?;
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    Some(full.rsplit(['\\', '/']).next().unwrap_or(&full).to_lowercase())
}

/// (pid, exe-name, is-active) for every session on the default render endpoint.
unsafe fn render_sessions() -> Result<Vec<(u32, String, bool)>> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device: IMMDevice = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
    let sessions: IAudioSessionEnumerator = mgr.GetSessionEnumerator()?;
    let count = sessions.GetCount()?;
    let mut out = Vec::new();
    for i in 0..count {
        let ctrl = sessions.GetSession(i)?;
        let active = ctrl.GetState().map(|s| s == AudioSessionStateActive).unwrap_or(false);
        let ctrl2: IAudioSessionControl2 = ctrl.cast()?;
        let pid = ctrl2.GetProcessId().unwrap_or(0);
        if pid == 0 {
            continue;
        }
        let name = process_name(pid).unwrap_or_default();
        out.push((pid, name, active));
    }
    Ok(out)
}

/// The process tree to EXCLUDE from the loopback. GusVoice's voices are rendered by an
/// msedgewebview2.exe utility process that is NOT under gusvoice.exe's tree, so we find that audio
/// process via the session API and exclude it (prefer an actively-playing one). Falls back to our own
/// PID if no WebView2 audio session is found.
unsafe fn pick_exclude_target() -> (u32, String) {
    let self_pid = std::process::id();
    let sessions = match render_sessions() {
        Ok(s) => s,
        Err(_) => return (self_pid, "gusvoice.exe (session enum failed)".into()),
    };
    let mut chosen: Option<(u32, String)> = None;
    for (pid, name, active) in &sessions {
        if name == "msedgewebview2.exe" {
            if *active {
                return (*pid, name.clone());
            }
            chosen.get_or_insert_with(|| (*pid, name.clone()));
        }
    }
    chosen.unwrap_or((self_pid, "gusvoice.exe".into()))
}

/// PHASE-1 VERIFICATION: record `seconds` of system-audio-minus-GusVoice to a temp WAV. Returns the path
/// plus which process was excluded. Play it back — game/music present, your own GusVoice voice absent.
pub fn record_wav(seconds: u32) -> std::result::Result<String, String> {
    let secs = seconds.clamp(1, 30);
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let (exclude_pid, exclude_name) = unsafe { pick_exclude_target() };
    let mut buf: Vec<f32> = Vec::with_capacity(SAMPLE_RATE as usize * CHANNELS as usize * secs as usize);
    let deadline = Instant::now() + Duration::from_secs(secs as u64);

    let capture = unsafe {
        run_capture(
            exclude_pid,
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            |block| buf.extend_from_slice(block),
            || Instant::now() >= deadline,
        )
    };
    capture.map_err(|e| format!("capture failed (excluded {exclude_name} pid {exclude_pid}): {e}"))?;

    let path = std::env::temp_dir().join("gusvoice-stream-audio-test.wav");
    write_wav_f32(&path, &buf).map_err(|e| format!("wav write failed: {e}"))?;
    Ok(format!("{}  |  исключён: {} (pid {})", path.to_string_lossy(), exclude_name, exclude_pid))
}

// ---- Phase 2: continuous streaming to the webview ----------------------------------------------

static STREAM_STOP: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Continuously capture stream audio per `target`, handing each block to `sink` as raw little-endian
/// bytes (interleaved f32, 48 kHz stereo) — the webview wraps these into a MediaStreamTrack. Runs on its
/// own thread until `stop_stream()`. Any in-flight capture is stopped first.
///
/// `ExcludeSelf` (full-screen share) = everything minus GusVoice's own voice process; `IncludeProcess`
/// (window share) = ONLY that window's process tree, so the stream carries just the streamed app's audio.
pub fn start_stream<F: Fn(&[u8]) + Send + 'static>(target: AudioTarget, sink: F) {
    stop_stream();
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut g) = STREAM_STOP.lock() {
        *g = Some(stop.clone());
    }
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let (pid, mode) = match target {
            AudioTarget::ExcludeSelf => {
                let (p, _name) = unsafe { pick_exclude_target() };
                (p, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE)
            }
            AudioTarget::IncludeProcess(pid) => (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE),
        };
        let _ = unsafe {
            run_capture(
                pid,
                mode,
                |block| {
                    // Reinterpret the f32 slice as little-endian bytes for the webview to wrap into AudioData.
                    let bytes = std::slice::from_raw_parts(block.as_ptr() as *const u8, size_of::<f32>() * block.len());
                    sink(bytes);
                },
                || stop.load(Ordering::Relaxed),
            )
        };
    });
}

pub fn stop_stream() {
    if let Ok(mut g) = STREAM_STOP.lock() {
        if let Some(stop) = g.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}
