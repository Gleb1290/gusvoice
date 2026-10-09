// GusVoice (#207, шаг 4.2): захват экрана, при котором кадр не покидает видеокарту.
// Устройство и причины отказа — в `include/livekit/gv_gpu_capture.h`.

use crate::impl_thread_safety;

#[cxx::bridge(namespace = "livekit_ffi")]
pub mod ffi {
    unsafe extern "C++" {
        include!("livekit/video_track.h");
        include!("livekit/gv_gpu_capture.h");

        type VideoTrackSource = crate::video_track::ffi::VideoTrackSource;
        type GpuScreenCapture;

        /// `cursor` — рисовать курсор в кадре (DXGI отдаёт стол без него).
        fn new_gpu_screen_capture(
            display_index: i32,
            max_width: u32,
            max_height: u32,
            cursor: bool,
        ) -> UniquePtr<GpuScreenCapture>;
        fn gpu_capture_supported() -> bool;
        /// Подсказка оценщику канала WebRTC для следующих соединений (#207). 0 — не трогать.
        fn set_bitrate_hint(start_bps: i32, min_bps: i32);
        /// Множитель опорного кадра NVENC для следующих кодировщиков показа (06.10). 0 — умолчание
        /// NVENC, как было до 06.10 (опорный кадр размером с обычный).
        fn set_screen_encoder_keyframe_scale(keyframe_scale: i32);
        /// Почему кодировщик не взял кадр из видеопамяти (код -2 у `capture`).
        fn native_encode_fail_reason() -> String;

        fn init_error(self: &GpuScreenCapture) -> String;
        /// Курсор просили, а рисовать нечем — почему (показ идёт без курсора).
        fn cursor_error(self: &GpuScreenCapture) -> String;
        fn adapter_name(self: &GpuScreenCapture) -> String;
        fn source_width(self: &GpuScreenCapture) -> u32;
        fn source_height(self: &GpuScreenCapture) -> u32;
        fn frame_width(self: &GpuScreenCapture) -> u32;
        fn frame_height(self: &GpuScreenCapture) -> u32;
        fn lost_count(self: &GpuScreenCapture) -> u32;
        fn capture(
            self: Pin<&mut GpuScreenCapture>,
            source: &VideoTrackSource,
            timestamp_us: i64,
        ) -> i32;
        fn poll_preview(self: Pin<&mut GpuScreenCapture>, rgba: &mut Vec<u8>) -> u64;
    }
}

impl_thread_safety!(ffi::GpuScreenCapture, Send);
