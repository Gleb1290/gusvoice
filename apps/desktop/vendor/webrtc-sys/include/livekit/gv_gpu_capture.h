// GusVoice (#207, шаг 4.2): захват экрана, при котором кадр не покидает видеокарту.
//
// DXGI Desktop Duplication → копия в общую текстуру пула (keyed mutex, NT-хэндл) → кадр
// `D3D11FrameBuffer` прямо в источник показа. Перевод цвета и уменьшение под слои делает
// кодировщик NVENC у себя (см. `nvidia/gv_d3d11_converter.h`). Нынешний путь libwebrtc
// (`DesktopCapturer`) отдаёт кадр в оперативке всегда, и внутри prebuilt его не поправить,
// поэтому захват свой.
//
// Только экран, только NVIDIA и только рабочий стол в BGRA: иначе `init_error` говорит почему,
// и Rust остаётся на старом пути.
//
// Курсор (28.09): DXGI отдаёт стол БЕЗ курсора, а положение и вид курсора — отдельно. Рисуем его
// сами поверх копии, как OBS. Системный курсор при этом не трогаем — в отличие от WGC, который на
// время показа переводит его в программный (из-за этого он дёргался над игрой, #207).
#pragma once

#include <cstdint>
#include <memory>

#include "rust/cxx.h"

namespace livekit_ffi {

class VideoTrackSource;

class GpuScreenCapture {
 public:
  // `display_index` — номер экрана libwebrtc (индекс `EnumDisplayDevicesW`), `max_*` — рамка
  // из настройки качества: кадр вписывается в неё с сохранением пропорций, только вниз.
  // `cursor` — рисовать курсор в кадре.
  GpuScreenCapture(int32_t display_index, uint32_t max_width, uint32_t max_height, bool cursor);
  ~GpuScreenCapture();

  // Пусто — готов к работе. Иначе причина, по которой остаёмся на старом пути.
  rust::String init_error() const;
  // Курсор просили, а рисовать нечем — почему. Показ при этом идёт, просто без курсора.
  rust::String cursor_error() const;
  rust::String adapter_name() const;
  uint32_t source_width() const;
  uint32_t source_height() const;
  uint32_t frame_width() const;
  uint32_t frame_height() const;
  uint32_t lost_count() const;

  // Один тик показа: взять кадр и отдать его в источник. Коды — `GpuCaptureStatus` в Rust.
  int32_t capture(const VideoTrackSource& source, int64_t timestamp_us);

  // Превью по наведению (#115): уменьшенный RGBA шириной до 320 точек. Без ожидания видеокарты:
  // первый вызов ставит копию в очередь, следующие пробуют забрать её. 0 — пока нечего,
  // иначе `(ширина << 32) | высота`.
  uint64_t poll_preview(rust::Vec<uint8_t>& rgba);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

std::unique_ptr<GpuScreenCapture> new_gpu_screen_capture(int32_t display_index,
                                                         uint32_t max_width,
                                                         uint32_t max_height,
                                                         bool cursor);

// Подсказка оценщику канала для следующих соединений (livekit/gv_bitrate_hint.h). 0 — не трогать.
void set_bitrate_hint(int32_t start_bps, int32_t min_bps);

// Почему кодировщик не взял кадр из видеопамяти (код -2 у `capture`). Пусто — не отказывал.
rust::String native_encode_fail_reason();

// Собран ли кодировщик NVENC и видит ли он карту. Без него новый путь смысла не имеет:
// программный кодировщик тянул бы каждый кадр обратно в оперативку.
bool gpu_capture_supported();

}  // namespace livekit_ffi
