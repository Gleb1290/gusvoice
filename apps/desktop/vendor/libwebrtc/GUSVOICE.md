# libwebrtc 0.3.38 (LiveKit, Apache-2.0) — вендорено GusVoice

Копия опубликованного крейта `libwebrtc` 0.3.38 (https://github.com/livekit/rust-sdks, лицензия
Apache-2.0), подключена через `[patch.crates-io]` в `apps/desktop/src-tauri/Cargo.toml`. Версия та же,
что тянет `livekit` 0.7.49; при обновлении SDK крейт надо вендорить заново и перенести правку.

## Правки (две)

`src/video_source.rs`, `native::NativeVideoSource::sys_handle()` — публичный доступ к C++-источнику
(`webrtc_sys::video_track::ffi::VideoTrackSource`). Нужен захвату экрана, при котором кадр не покидает
видеокарту (`webrtc_sys::gv_gpu_capture`, #207 шаг 4.2): такой кадр — `kNative` D3D11-текстура, а подать
его через `capture_frame` нельзя — трейт буфера запечатан, а платформенный буфер в крейте есть только
на macOS.

⚠️ Кадры мимо `capture_frame` не засчитываются в счётчик источника, и SDK подмешивал бы чёрные кадры
раз в 100 мс, пока счётчик пуст. Перед ними подаётся один обычный кадр (см. `screenshare.rs`).

### 2. Опорный кадр только на запрошенном слое (0.8.12)

`src/gv_sdp.rs` (новый) + `src/peer_connection.rs`, `PeerConnection::set_remote_description`: в ответ
SFU (`SdpType::Answer`) дописывается `x-google-per-layer-pli=1` ко всем видеокодекам (H264/H265/VP8/
VP9/AV1; rtx/red/ulpfec не трогаются). Не разобрался или не принялся — ставится исходный ответ.

Зачем: без параметра libwebrtc на запрос опорного кадра по ЛЮБОМУ слою отвечает опорным кадром на ВСЕХ
слоях. 26.09 один зритель на телефоне (канал 0,2–0,5 Мбит/с, нижний слой) довёл полный слой до 62
опорных кадров в минуту — у всех зрителей картинка мутнела раз в секунду. Параметр читают
`EncoderRtcpFeedback` и `SimulcastEncoderAdapter` (`SupportsPerLayerPictureLossIndication`), а объявлять
его должна принимающая сторона — наш SFU его не шлёт. Параметр живёт только в локальном описании, на
сервер не уходит. Проверка — телеметрией: `enc.key_frames` полного слоя снова идёт за его `enc.pli`.
