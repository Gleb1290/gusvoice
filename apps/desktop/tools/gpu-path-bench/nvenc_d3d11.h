// NVENC-сессия на D3D11-устройстве: вход — NV12-текстуры в видеопамяти, без CUDA (#207, шаг 4).
//
// Наш наследник базового `NvEncoder` из вендоренного webrtc-sys, а не `NvEncoderD3D11.cpp` из
// NVIDIA Video Codec SDK: файлы SDK идут под лицензией NVIDIA, и тащить ещё один незачем — классу
// нужно только выделить текстуры и зарегистрировать их в NVENC. Так же устроены Sunshine и OBS
// (`NV_ENC_DEVICE_TYPE_DIRECTX`): CUDA-контекста нет вовсе, а с ним уходят и его ожидания, и P2.
//
// Текстуры — `D3D11_BIND_RENDER_TARGET`: так их требует NVENC для DirectX-входа, и в них же пишет
// видеопроцессор D3D11 (перевод BGRA→NV12 с уменьшением под слой).
//
// `output_delay` — конвейер: при N > 0 подача кадра ждёт готовности не своего кадра, а кадра на N
// раньше, и текстур входа становится N + 1. Под игрой, занявшей видеокарту, это меняет ожидание
// очереди на задержку в N кадров вместо потери частоты (замер Crimson Desert 26.09: без конвейера
// показ упирался в 45 к/с).
#pragma once

#include <d3d11.h>

#include <vector>

#include "NvEncoder/NvEncoder.h"

class NvEncoderD3D11Tex : public NvEncoder {
 public:
  NvEncoderD3D11Tex(ID3D11Device* device, uint32_t width, uint32_t height,
                    NV_ENC_BUFFER_FORMAT format, uint32_t output_delay = 0)
      : NvEncoder(NV_ENC_DEVICE_TYPE_DIRECTX, device, width, height, format, output_delay,
                  /*bMotionEstimationOnly=*/false),
        device_(device) {
    device_->AddRef();
  }

  ~NvEncoderD3D11Tex() override {
    ReleaseTextures();
    device_->Release();
  }

  // Текстура, в которую надо записать следующий кадр: `GetNextInputFrame()->inputPtr`.
  static ID3D11Texture2D* Texture(const NvEncInputFrame* frame) {
    return static_cast<ID3D11Texture2D*>(frame->inputPtr);
  }

 private:
  void AllocateInputBuffers(int32_t count) override {
    std::vector<void*> frames;
    for (int32_t i = 0; i < count; ++i) {
      // 🔴 NV12-текстура бывает только чётного размера, а слой — нет: WebRTC делит 2560×1068 на 4 и
      // получает экономный слой 640×267 (26.09 из-за этого новый путь молча откатывался у владельца).
      // Текстура — с запасом до чётного, NVENC кодирует свои строки из её левого верхнего угла.
      D3D11_TEXTURE2D_DESC desc = {};
      desc.Width = (GetMaxEncodeWidth() + 1) & ~1u;
      desc.Height = (GetMaxEncodeHeight() + 1) & ~1u;
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.Format = DXGI_FORMAT_NV12;
      desc.SampleDesc.Count = 1;
      desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_RENDER_TARGET;
      ID3D11Texture2D* texture = nullptr;
      if (FAILED(device_->CreateTexture2D(&desc, nullptr, &texture))) {
        for (void* made : frames) static_cast<ID3D11Texture2D*>(made)->Release();
        NVENC_THROW_ERROR("CreateTexture2D(NV12) failed", NV_ENC_ERR_OUT_OF_MEMORY);
      }
      frames.push_back(texture);
    }
    // Шаг у DirectX-ресурса задаёт драйвер, поэтому 0 — как в примерах SDK.
    RegisterInputResources(frames, NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX,
                           GetMaxEncodeWidth(), GetMaxEncodeHeight(), 0,
                           GetPixelFormat());
  }

  void ReleaseInputBuffers() override { ReleaseTextures(); }

  void ReleaseTextures() {
    if (!m_hEncoder) return;
    UnregisterInputResources();
    for (NvEncInputFrame& frame : m_vInputFrames) {
      if (frame.inputPtr) static_cast<ID3D11Texture2D*>(frame.inputPtr)->Release();
    }
    m_vInputFrames.clear();
  }

  ID3D11Device* device_;
};
