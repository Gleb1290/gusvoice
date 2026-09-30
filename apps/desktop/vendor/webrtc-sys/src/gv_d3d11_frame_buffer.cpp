// GusVoice (#207, шаг 4): кадр рабочего стола в видеопамяти — см. заголовок.
#include "livekit/gv_d3d11_frame_buffer.h"

#if defined(_WIN32)

#include <algorithm>
#include <atomic>
#include <mutex>

#include "api/make_ref_counted.h"
#include "api/video/i420_buffer.h"
#include "rtc_base/logging.h"
#include "third_party/libyuv/include/libyuv/convert.h"

using Microsoft::WRL::ComPtr;

namespace livekit {

namespace {
std::atomic<bool> g_native_encode_failed{false};
std::mutex g_reason_mutex;
std::string g_reason;
}  // namespace

void SetNativeEncodeFailed(bool failed, const std::string& reason) {
  {
    std::lock_guard<std::mutex> lock(g_reason_mutex);
    g_reason = failed ? reason : std::string();
  }
  g_native_encode_failed.store(failed, std::memory_order_relaxed);
}

std::string NativeEncodeFailReason() {
  std::lock_guard<std::mutex> lock(g_reason_mutex);
  return g_reason;
}

bool NativeEncodeFailed() {
  return g_native_encode_failed.load(std::memory_order_relaxed);
}

D3D11SharedSlot::~D3D11SharedSlot() {
  if (shared_handle) CloseHandle(shared_handle);
}

D3D11FrameBuffer::D3D11FrameBuffer(ComPtr<ID3D11Device> device,
                                   std::shared_ptr<D3D11SharedSlot> slot,
                                   LUID adapter,
                                   RECT crop,
                                   int width,
                                   int height)
    : device_(std::move(device)),
      slot_(std::move(slot)),
      adapter_(adapter),
      crop_(crop),
      width_(width),
      height_(height) {}

D3D11FrameBuffer::~D3D11FrameBuffer() = default;

webrtc::VideoFrameBuffer::Type D3D11FrameBuffer::type() const {
  return Type::kNative;
}

int D3D11FrameBuffer::width() const {
  return width_;
}

int D3D11FrameBuffer::height() const {
  return height_;
}

int D3D11FrameBuffer::texture_width() const {
  D3D11_TEXTURE2D_DESC d;
  slot_->texture->GetDesc(&d);
  return static_cast<int>(d.Width);
}

int D3D11FrameBuffer::texture_height() const {
  D3D11_TEXTURE2D_DESC d;
  slot_->texture->GetDesc(&d);
  return static_cast<int>(d.Height);
}

D3D11FrameBuffer* D3D11FrameBuffer::FromNative(webrtc::VideoFrameBuffer* buffer) {
  if (!buffer || buffer->type() != Type::kNative) return nullptr;
  auto* d3d = static_cast<D3D11FrameBuffer*>(buffer);
  return d3d->magic_ == kMagic ? d3d : nullptr;
}

webrtc::scoped_refptr<webrtc::VideoFrameBuffer> D3D11FrameBuffer::CropAndScale(
    int offset_x,
    int offset_y,
    int crop_width,
    int crop_height,
    int scaled_width,
    int scaled_height) {
  // Окно задано в координатах ОБЪЯВЛЕННОГО размера — переводим в пиксели текстуры.
  const double sx = double(crop_.right - crop_.left) / std::max(1, width_);
  const double sy = double(crop_.bottom - crop_.top) / std::max(1, height_);
  RECT next;
  next.left = crop_.left + LONG(offset_x * sx);
  next.top = crop_.top + LONG(offset_y * sy);
  next.right = next.left + std::max<LONG>(2, LONG(crop_width * sx));
  next.bottom = next.top + std::max<LONG>(2, LONG(crop_height * sy));
  next.right = std::min(next.right, crop_.right);
  next.bottom = std::min(next.bottom, crop_.bottom);
  return webrtc::make_ref_counted<D3D11FrameBuffer>(device_, slot_, adapter_, next,
                                                    scaled_width, scaled_height);
}

webrtc::scoped_refptr<webrtc::I420BufferInterface> D3D11FrameBuffer::ToI420() {
  // Запасной путь, поэтому без кэшей: промежуточная текстура на каждый вызов.
  const int cw = crop_.right - crop_.left;
  const int ch = crop_.bottom - crop_.top;
  D3D11_TEXTURE2D_DESC desc;
  slot_->texture->GetDesc(&desc);
  desc.Width = UINT(cw);
  desc.Height = UINT(ch);
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  if (FAILED(device_->CreateTexture2D(&desc, nullptr, &staging))) {
    RTC_LOG(LS_ERROR) << "D3D11FrameBuffer::ToI420: CreateTexture2D(staging) failed";
    return nullptr;
  }
  ComPtr<ID3D11DeviceContext> ctx;
  device_->GetImmediateContext(&ctx);
  ComPtr<IDXGIKeyedMutex> mutex;
  slot_->texture.As(&mutex);
  if (mutex && mutex->AcquireSync(0, 1000) != S_OK) {
    RTC_LOG(LS_ERROR) << "D3D11FrameBuffer::ToI420: AcquireSync timed out";
    return nullptr;
  }
  const D3D11_BOX box = {UINT(crop_.left), UINT(crop_.top), 0, UINT(crop_.right),
                         UINT(crop_.bottom), 1};
  ctx->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, slot_->texture.Get(), 0, &box);
  if (mutex) mutex->ReleaseSync(0);

  D3D11_MAPPED_SUBRESOURCE m;
  if (FAILED(ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &m))) {
    RTC_LOG(LS_ERROR) << "D3D11FrameBuffer::ToI420: Map failed";
    return nullptr;
  }
  webrtc::scoped_refptr<webrtc::I420Buffer> i420 = webrtc::I420Buffer::Create(cw, ch);
  // «ARGB» у libyuv — порядок байт B,G,R,A в памяти, то есть BGRA (как `bgra_to_i420` в Rust).
  libyuv::ARGBToI420(static_cast<const uint8_t*>(m.pData), int(m.RowPitch), i420->MutableDataY(),
                     i420->StrideY(), i420->MutableDataU(), i420->StrideU(),
                     i420->MutableDataV(), i420->StrideV(), cw, ch);
  ctx->Unmap(staging.Get(), 0);
  if (cw == width_ && ch == height_) return i420;
  webrtc::scoped_refptr<webrtc::I420Buffer> scaled = webrtc::I420Buffer::Create(width_, height_);
  scaled->ScaleFrom(*i420);
  return scaled;
}

}  // namespace livekit

#endif  // _WIN32
