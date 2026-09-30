// GusVoice (#207, шаг 4): кадр рабочего стола, который не покидает видеокарту.
//
// Общая текстура BGRA на устройстве захвата (`gv_gpu_capture`). Кодировщик NVENC открывает её
// у СЕБЯ на отдельном устройстве той же видеокарты по NT-хэндлу и сам уменьшает под свой слой —
// так же, как OBS: потоки захвата и кодирования не делят одно устройство D3D11. Порядок записи
// и чтения держит keyed mutex текстуры (ключ 0 у всех).
//
// Идёт по libwebrtc как `kNative`. Близнец `DmaBufVideoFrameBuffer` (Jetson), но с отличием,
// ради которого он и написан: `CropAndScale` не отдаёт тот же кадр, а запоминает окно и размер —
// иначе у показа пропали бы нижние слои качества. Сам перевод делает кодировщик слоя.
#pragma once

#if defined(_WIN32)

#include <winsock2.h>
#include <windows.h>

#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstdint>
#include <memory>
#include <string>

#include "api/scoped_refptr.h"
#include "api/video/video_frame_buffer.h"

namespace livekit {

// Одна текстура пула захвата. Живёт, пока на неё ссылается пул или хоть один кадр.
struct D3D11SharedSlot {
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;  // на устройстве захвата
  HANDLE shared_handle = nullptr;                   // NT-хэндл для OpenSharedResource1
  uint64_t id = 0;  // сквозной номер: ключ кэша открытых текстур у кодировщика
  ~D3D11SharedSlot();
};

// Кодировщик слоя не смог взять кадр из видеопамяти и ушёл на загрузку через оперативку. Тогда каждый
// слой тянул бы ПОЛНЫЙ кадр в оперативку сам — хуже старого пути, поэтому захват, увидев флаг, переводит
// весь показ на старый путь. Сбрасывается новым захватом.
void SetNativeEncodeFailed(bool failed, const std::string& reason = std::string());
bool NativeEncodeFailed();
// Почему — для «Пути кадра» (панель, телеметрия). Пусто — не отказывал.
std::string NativeEncodeFailReason();

class D3D11FrameBuffer : public webrtc::VideoFrameBuffer {
 public:
  // `crop` — окно в пикселях текстуры, `width`×`height` — размер, который кадр ОБЪЯВЛЯЕТ
  // (после вписывания в настройку качества). Уменьшение до него — забота кодировщика.
  D3D11FrameBuffer(Microsoft::WRL::ComPtr<ID3D11Device> device,
                   std::shared_ptr<D3D11SharedSlot> slot,
                   LUID adapter,
                   RECT crop,
                   int width,
                   int height);
  ~D3D11FrameBuffer() override;

  Type type() const override;
  int width() const override;
  int height() const override;

  // Запасной путь: кадр в оперативку (редко — программный кодировщик, отказ видеокарты).
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override;

  // Без работы: запоминает новое окно и размер (адаптация разрешения libwebrtc).
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> CropAndScale(int offset_x,
                                                               int offset_y,
                                                               int crop_width,
                                                               int crop_height,
                                                               int scaled_width,
                                                               int scaled_height) override;

  // Наш ли это кадр. Других `kNative` на Windows в процессе нет, но проверяем метку.
  static D3D11FrameBuffer* FromNative(webrtc::VideoFrameBuffer* buffer);

  ID3D11Texture2D* texture() const { return slot_->texture.Get(); }  // на устройстве захвата
  HANDLE shared_handle() const { return slot_->shared_handle; }
  uint64_t slot_id() const { return slot_->id; }
  LUID adapter() const { return adapter_; }
  const RECT& crop() const { return crop_; }
  int texture_width() const;
  int texture_height() const;

 private:
  static constexpr uint32_t kMagic = 0x47563344;  // 'GV3D'
  uint32_t magic_ = kMagic;
  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  std::shared_ptr<D3D11SharedSlot> slot_;
  LUID adapter_;
  RECT crop_;
  int width_;
  int height_;
};

}  // namespace livekit

#endif  // _WIN32
