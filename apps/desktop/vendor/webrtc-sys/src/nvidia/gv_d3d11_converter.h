// GusVoice (#207, шаг 4.1): перевод кадра из видеопамяти во вход NVENC — на СВОЁМ устройстве
// D3D11 кодировщика слоя.
//
// Захват (`gv_gpu_capture`) пишет в общие текстуры на своём устройстве, кодировщик открывает их
// здесь по NT-хэндлу. Потоки не делят одно устройство — как в OBS. Порядок записи и чтения держит
// keyed mutex (ключ 0 у всех).
//
// Перевод BGRA→NV12 и уменьшение до размера слоя — один проход видеопроцессора D3D11. Слой сам
// уменьшает полный кадр: `SimulcastEncoderAdapter` для `kNative` и `supports_native_handle`
// отдаёт каждому слою кадр как есть («encoder is expected to sample/scale the source texture»).
// Замер (`apps/desktop/tools/gpu-path-bench`): копия + перевод под три слоя 3440×1440 — 0,27 мс
// на RTX 5080.
#pragma once

#if defined(_WIN32)

#include <winsock2.h>
#include <windows.h>

#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstdio>
#include <map>
#include <string>

#include "livekit/gv_d3d11_frame_buffer.h"
#include "rtc_base/logging.h"

namespace webrtc {

class GvD3D11Converter {
 public:
  // Устройство на той же видеокарте, что и захват (по LUID адаптера).
  bool Init(LUID adapter) {
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> a;
    for (UINT i = 0; factory->EnumAdapters1(i, &a) != DXGI_ERROR_NOT_FOUND; ++i) {
      DXGI_ADAPTER_DESC1 d;
      a->GetDesc1(&d);
      if (d.AdapterLuid.LowPart != adapter.LowPart || d.AdapterLuid.HighPart != adapter.HighPart) {
        continue;
      }
      const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      if (FAILED(D3D11CreateDevice(a.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT |
                                       D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                                   levels, 2, D3D11_SDK_VERSION, &device_, nullptr, &ctx_))) {
        return false;
      }
      luid_ = adapter;
      return SUCCEEDED(device_.As(&device1_)) && SUCCEEDED(device_.As(&vdev_)) &&
             SUCCEEDED(ctx_.As(&vctx_));
    }
    return false;
  }

  ID3D11Device* device() const { return device_.Get(); }
  // Входные текстуры NVENC пересозданной сессии — новые; виды на старые держали бы их живыми.
  void ForgetOutputs() { outputs_.clear(); }
  bool SameAdapter(LUID adapter) const {
    return device_ && adapter.LowPart == luid_.LowPart && adapter.HighPart == luid_.HighPart;
  }

  // Почему последний `Convert` не удался — уезжает в «Путь кадра» (панель, телеметрия).
  const std::string& last_error() const { return last_error_; }

  // Окно кадра → NV12 прямо в `dst` (вход NVENC), во всю текстуру: она бывает на строку больше слоя
  // (чётная), NVENC берёт свои строки сверху. false — отказ, путь не годится.
  bool Convert(const livekit::D3D11FrameBuffer& frame, ID3D11Texture2D* dst) {
    D3D11_TEXTURE2D_DESC dd;
    dst->GetDesc(&dd);
    const int dst_w = int(dd.Width);
    const int dst_h = int(dd.Height);
    ID3D11Texture2D* src = Open(frame);
    if (!src) return false;
    if (!SetupProcessor(frame.texture_width(), frame.texture_height(), dst_w, dst_h)) return false;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView>& in = inputs_[frame.slot_id()];
    if (!in) {
      D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC d = {};
      d.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
      const HRESULT hr = vdev_->CreateVideoProcessorInputView(src, vpe_.Get(), &d, &in);
      if (FAILED(hr)) {
        inputs_.erase(frame.slot_id());
        return Fail("CreateVideoProcessorInputView", hr);
      }
    }
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView>& out = outputs_[dst];
    if (!out) {
      D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC d = {};
      d.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
      const HRESULT hr = vdev_->CreateVideoProcessorOutputView(dst, vpe_.Get(), &d, &out);
      if (FAILED(hr)) {
        outputs_.erase(dst);
        return Fail("CreateVideoProcessorOutputView", hr);
      }
    }
    const RECT src_rect = frame.crop();
    const RECT dst_rect = {0, 0, dst_w, dst_h};
    vctx_->VideoProcessorSetStreamSourceRect(vp_.Get(), 0, TRUE, &src_rect);
    vctx_->VideoProcessorSetStreamDestRect(vp_.Get(), 0, TRUE, &dst_rect);
    vctx_->VideoProcessorSetOutputTargetRect(vp_.Get(), TRUE, &dst_rect);

    Microsoft::WRL::ComPtr<IDXGIKeyedMutex> mutex;
    src->QueryInterface(IID_PPV_ARGS(&mutex));
    // Захват пишет только в текстуры, на которые не ссылается ни один кадр, так что ждать тут
    // почти нечего. Долгое ожидание — признак поломки, а не очереди.
    const HRESULT acquired = mutex ? mutex->AcquireSync(0, 500) : E_NOINTERFACE;
    if (acquired != S_OK) return Fail("AcquireSync", acquired);
    D3D11_VIDEO_PROCESSOR_STREAM stream = {};
    stream.Enable = TRUE;
    stream.pInputSurface = in.Get();
    const HRESULT hr = vctx_->VideoProcessorBlt(vp_.Get(), out.Get(), 0, 1, &stream);
    mutex->ReleaseSync(0);
    // 🔴 Отправить команды ДО кодирования: NVENC-сессия буфер D3D11 сама не выталкивает, и без
    // Flush кодировщик брал бы текстуру до записи кадра (замер 25.09: разрыв ровно в один кадр).
    ctx_->Flush();
    if (FAILED(hr)) return Fail("VideoProcessorBlt", hr);
    return true;
  }

 private:
  // Кэш открытых общих текстур по сквозному номеру слота захвата. Пул захвата — до 8 текстур, но
  // после смены разрешения экрана старые номера больше не придут: чистим при переполнении, иначе
  // держали бы видеопамять мёртвых текстур.
  static constexpr size_t kMaxOpened = 10;

  bool Fail(const char* what, HRESULT hr) {
    char text[96];
    std::snprintf(text, sizeof text, "%s 0x%08lx", what, static_cast<unsigned long>(hr));
    last_error_ = text;
    RTC_LOG(LS_ERROR) << "GvD3D11Converter: " << last_error_;
    return false;
  }

  ID3D11Texture2D* Open(const livekit::D3D11FrameBuffer& frame) {
    auto it = opened_.find(frame.slot_id());
    if (it != opened_.end()) return it->second.Get();
    if (opened_.size() >= kMaxOpened) {
      opened_.clear();
      inputs_.clear();
    }
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    const HRESULT hr = device1_->OpenSharedResource1(frame.shared_handle(), IID_PPV_ARGS(&texture));
    if (FAILED(hr)) {
      Fail("OpenSharedResource1", hr);
      return nullptr;
    }
    opened_[frame.slot_id()] = texture;
    return texture.Get();
  }

  bool SetupProcessor(int src_w, int src_h, int dst_w, int dst_h) {
    if (vp_ && src_w == src_w_ && src_h == src_h_ && dst_w == dst_w_ && dst_h == dst_h_) {
      return true;
    }
    // Виды привязаны к перечислителю — со сменой размеров старые не годятся.
    inputs_.clear();
    outputs_.clear();
    vp_.Reset();
    vpe_.Reset();
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd = {};
    cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    cd.InputFrameRate = {60, 1};
    cd.InputWidth = UINT(src_w);
    cd.InputHeight = UINT(src_h);
    cd.OutputFrameRate = {60, 1};
    cd.OutputWidth = UINT(dst_w);
    cd.OutputHeight = UINT(dst_h);
    cd.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
    const HRESULT hr = vdev_->CreateVideoProcessorEnumerator(&cd, &vpe_);
    if (FAILED(hr)) return Fail("CreateVideoProcessorEnumerator", hr);
    UINT flags = 0;
    vpe_->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &flags);
    if (!(flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
      vpe_.Reset();
      return Fail("NV12 output unsupported", E_NOTIMPL);
    }
    const HRESULT vp_hr = vdev_->CreateVideoProcessor(vpe_.Get(), 0, &vp_);
    if (FAILED(vp_hr)) {
      vpe_.Reset();
      return Fail("CreateVideoProcessor", vp_hr);
    }
    // Цвет как у libyuv `ARGBToI420` на старом пути: BT.601, диапазон 16–235. Зритель не должен
    // видеть разницы между путями.
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE in_cs = {};
    in_cs.RGB_Range = 0;  // 0–255
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE out_cs = {};
    out_cs.YCbCr_Matrix = 0;  // BT.601
    out_cs.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    vctx_->VideoProcessorSetStreamColorSpace(vp_.Get(), 0, &in_cs);
    vctx_->VideoProcessorSetOutputColorSpace(vp_.Get(), &out_cs);
    vctx_->VideoProcessorSetStreamFrameFormat(vp_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    vctx_->VideoProcessorSetStreamAutoProcessingMode(vp_.Get(), 0, FALSE);
    src_w_ = src_w, src_h_ = src_h, dst_w_ = dst_w, dst_h_ = dst_h;
    return true;
  }

  LUID luid_{};
  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11Device1> device1_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> ctx_;
  Microsoft::WRL::ComPtr<ID3D11VideoDevice> vdev_;
  Microsoft::WRL::ComPtr<ID3D11VideoContext> vctx_;
  Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> vpe_;
  Microsoft::WRL::ComPtr<ID3D11VideoProcessor> vp_;
  int src_w_ = 0, src_h_ = 0, dst_w_ = 0, dst_h_ = 0;
  std::map<uint64_t, Microsoft::WRL::ComPtr<ID3D11Texture2D>> opened_;
  std::map<uint64_t, Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView>> inputs_;
  std::map<ID3D11Texture2D*, Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView>> outputs_;
  std::string last_error_;
};

}  // namespace webrtc

#endif  // _WIN32
