// GusVoice (#207, шаг 4.2): захват экрана без выхода кадра из видеокарты — см. заголовок.
//
// Цифры, на которых решение принято (замер `apps/desktop/tools/gpu-path-bench`, 25–26.09):
// под игрой, занявшей видеокарту, нынешний путь давал игре 15–18 рывков за 90 с и показ 31 к/с,
// этот — 0–2 рывка и 45 к/с (60 — с конвейером в кодировщике), процессор в 13 раз меньше.
#include "livekit/gv_d3d11_frame_buffer.h"
#include "livekit/gv_gpu_capture.h"

#include <d3d11_4.h>
#include <d3dcompiler.h>
#include <dxgi1_5.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "api/make_ref_counted.h"
#include "api/video/video_frame.h"
#include "livekit/gv_bitrate_hint.h"
#include "livekit/video_track.h"
#include "rtc_base/logging.h"
#include "rtc_base/time_utils.h"
#if defined(USE_NVIDIA_VIDEO_CODEC)
#include "nvidia/nvidia_encoder_factory.h"
#endif

using Microsoft::WRL::ComPtr;

namespace livekit_ffi {
namespace {

// Кадры держат текстуры, пока их кодирует libwebrtc: конвейер кодировщика, повтор последнего
// кадра для экрана без изменений. Восьми хватает с запасом; кончились — пропускаем новый кадр.
constexpr size_t kMaxSlots = 8;
constexpr UINT kVendorNvidia = 0x10DE;
constexpr int kThumbWidth = 320;  // как THUMB_W в screenshare.rs
// Крупнее курсоров не бывает: Windows растит их до 256 точек (специальные возможности × масштаб).
constexpr int kMaxCursor = 512;
// Точки курсора BGRA одним словом (младший байт — синий).
constexpr uint32_t kClear = 0x00000000u;
constexpr uint32_t kBlack = 0xFF000000u;
constexpr uint32_t kWhite = 0xFFFFFFFFu;
std::atomic<uint64_t> g_slot_id{0};

// Курсор поверх кадра: прямоугольник из четырёх вершин без буфера вершин; точку берём из текстуры
// курсора по целым координатам, без фильтрации, — курсор остаётся резким.
constexpr char kCursorHlsl[] = R"(
cbuffer Place : register(b0) { float4 rect; int4 origin; };
struct V { float4 pos : SV_Position; };
V vs_main(uint id : SV_VertexID) {
  V o;
  float2 t = float2(id & 1, id >> 1);
  o.pos = float4(lerp(rect.xy, rect.zw, t), 0, 1);
  return o;
}
Texture2D<float4> shape : register(t0);
float4 ps_main(V i) : SV_Target {
  return shape.Load(int3(int2(i.pos.xy) - origin.xy, 0));
}
)";

// Прямоугольник курсора в координатах отрисовки и его левый верхний угол в точках кадра.
struct CursorPlace {
  float rect[4];
  int32_t origin[4];
};

std::string Utf8(const wchar_t* w) {
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(size_t(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

// Вписать (sw, sh) в (tw, th) с сохранением пропорций, только вниз, чётные — как `target_dims`
// в screenshare.rs. Без рамки — родной размер, выровненный до чётного.
void FitDown(int sw, int sh, int tw, int th, int* dw, int* dh) {
  if (tw <= 0 || th <= 0 || (sw <= tw && sh <= th)) {
    *dw = std::max(2, sw & ~1);
    *dh = std::max(2, sh & ~1);
    return;
  }
  const double s = std::min(double(tw) / sw, double(th) / sh);
  *dw = std::max(2, int(sw * s) & ~1);
  *dh = std::max(2, int(sh * s) & ~1);
}

// Компилятор шейдеров берём из системной папки в момент показа, а не импортом: так `.exe` не
// получает новой зависимости (страж `check-exe-imports.mjs`), а без библиотеки показ просто идёт без
// курсора. `d3dcompiler_47.dll` есть в любой Windows 10/11.
pD3DCompile ShaderCompiler() {
  static const pD3DCompile fn = []() -> pD3DCompile {
    HMODULE m = LoadLibraryExW(L"d3dcompiler_47.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    return m ? reinterpret_cast<pD3DCompile>(GetProcAddress(m, "D3DCompile")) : nullptr;
  }();
  return fn;
}

}  // namespace

struct GpuScreenCapture::Impl {
  std::string error;
  std::string adapter_name;
  LUID luid{};
  ComPtr<IDXGIOutput1> output;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> ctx;
  ComPtr<IDXGIOutputDuplication> dup;
  // Кадр DXGI держим до следующего тика, как Sunshine: отпущенную поверхность DWM вправе
  // переписать, пока наша копия ещё стоит в очереди видеокарты.
  bool holding = false;
  int src_w = 0, src_h = 0, out_w = 0, out_h = 0, max_w = 0, max_h = 0;
  uint32_t lost = 0;
  std::vector<std::shared_ptr<livekit::D3D11SharedSlot>> pool;
  webrtc::scoped_refptr<livekit::D3D11FrameBuffer> last;
  ComPtr<ID3D11Texture2D> staging;  // превью
  bool preview_pending = false;

  // Курсор. `cursor_ok` — просили и есть чем рисовать; иначе путь кадра ровно прежний.
  bool cursor_ok = false;
  std::string cursor_error;
  // Стол без курсора. Когда сдвинулась только мышь, DXGI нового изображения не даёт, а кадр с
  // курсором на новом месте собрать надо — из этой копии.
  ComPtr<ID3D11Texture2D> clean;
  std::vector<uint8_t> shape_buf;
  ComPtr<ID3D11ShaderResourceView> cur_srv;
  int cur_w = 0, cur_h = 0;
  POINT cur_pos{};
  bool cur_visible = false;
  ComPtr<ID3D11VertexShader> cur_vs;
  ComPtr<ID3D11PixelShader> cur_ps;
  ComPtr<ID3D11Buffer> cur_cb;
  ComPtr<ID3D11BlendState> cur_blend;
  ComPtr<ID3D11RasterizerState> cur_raster;
  std::map<uint64_t, ComPtr<ID3D11RenderTargetView>> rtvs;  // по сквозному номеру слота

  bool Init(int32_t display_index);
  bool Duplicate();
  std::shared_ptr<livekit::D3D11SharedSlot> TakeSlot();
  void Push(const VideoTrackSource& source, int64_t timestamp_us);
  int32_t Compose(const VideoTrackSource& source, int64_t timestamp_us, ID3D11Texture2D* desktop);

  bool InitCursor();
  bool UpdatePointer(const DXGI_OUTDUPL_FRAME_INFO& info);
  bool LoadShape(const DXGI_OUTDUPL_POINTER_SHAPE_INFO& si);
  bool EnsureClean();
  void DrawCursor(const livekit::D3D11SharedSlot& slot);
};

bool GpuScreenCapture::Impl::Init(int32_t display_index) {
  // Номер экрана у libwebrtc — индекс `EnumDisplayDevicesW` (и у DXGI-, и у WGC-захвата).
  DISPLAY_DEVICEW dd = {};
  dd.cb = sizeof(dd);
  if (display_index < 0 || !EnumDisplayDevicesW(nullptr, DWORD(display_index), &dd, 0)) {
    error = "экран не найден";
    return false;
  }
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    error = "CreateDXGIFactory1 не удался";
    return false;
  }
  ComPtr<IDXGIAdapter1> adapter;
  for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
    ComPtr<IDXGIOutput> out;
    for (UINT o = 0; adapter->EnumOutputs(o, &out) != DXGI_ERROR_NOT_FOUND; ++o) {
      DXGI_OUTPUT_DESC od;
      if (SUCCEEDED(out->GetDesc(&od)) && wcscmp(od.DeviceName, dd.DeviceName) == 0) {
        out.As(&output);
        break;
      }
    }
    if (output) break;
  }
  if (!output) {
    error = "экран не найден среди выходов DXGI";
    return false;
  }
  DXGI_ADAPTER_DESC1 ad;
  adapter->GetDesc1(&ad);
  adapter_name = Utf8(ad.Description);
  luid = ad.AdapterLuid;
  // Ноутбук с Optimus: экран на встроенной графике, NVENC на другой карте. Переезд между
  // адаптерами пока не делаем — старый путь.
  if (ad.VendorId != kVendorNvidia) {
    error = "экран подключён не к NVIDIA: " + adapter_name;
    return false;
  }
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                               D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 2, D3D11_SDK_VERSION,
                               &device, nullptr, &ctx))) {
    error = "D3D11CreateDevice не удался";
    return false;
  }
  // Запасной `ToI420` кадра зовут с потока кодировщика — устройство должно это пережить.
  // Он только копирует и читает текстуру, состояние конвейера (шейдеры курсора) не трогает.
  ComPtr<ID3D11Multithread> mt;
  if (SUCCEEDED(ctx.As(&mt))) mt->SetMultithreadProtected(TRUE);
  if (!Duplicate()) {
    error = "DuplicateOutput не удался";
    return false;
  }
  // Формат режима НЕ проверяем: у 10-битного вывода Windows 11 складывает стол в FP16 даже без HDR
  // (замер 26.09 на мониторе владельца: режим FP16, а кадр по `DuplicateOutput1` — BGRA). Что пришло
  // на самом деле, смотрит `capture()` на каждом кадре.
  DXGI_OUTDUPL_DESC d;
  dup->GetDesc(&d);
  if (d.Rotation != DXGI_MODE_ROTATION_IDENTITY && d.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
    error = "экран повёрнут";
    return false;
  }
  return true;
}

bool GpuScreenCapture::Impl::Duplicate() {
  dup.Reset();
  holding = false;
  // 🔴 Просим BGRA явно: тогда перевод из FP16 (10-битный вывод, HDR) делает сама Windows. Старый
  // `DuplicateOutput` отдаёт стол как есть — у владельца это был FP16, и первая пробная сборка из-за
  // этого молча ушла на старый путь. Нужен процесс с DPI-осознанностью per-monitor — у Tauri так.
  HRESULT hr = E_FAIL;
  ComPtr<IDXGIOutput5> output5;
  if (SUCCEEDED(output.As(&output5))) {
    const DXGI_FORMAT formats[] = {DXGI_FORMAT_B8G8R8A8_UNORM};
    hr = output5->DuplicateOutput1(device.Get(), 0, 1, formats, &dup);
  }
  if (FAILED(hr)) hr = output->DuplicateOutput(device.Get(), &dup);
  if (FAILED(hr)) {
    dup.Reset();
    return false;
  }
  DXGI_OUTDUPL_DESC d;
  dup->GetDesc(&d);
  const int w = int(d.ModeDesc.Width);
  const int h = int(d.ModeDesc.Height);
  if (w != src_w || h != src_h) {
    // Сменилось разрешение экрана: старые текстуры не того размера. Кадры, что их держат, доживут.
    src_w = w;
    src_h = h;
    pool.clear();
    rtvs.clear();
    clean.Reset();
    staging.Reset();
    preview_pending = false;
    FitDown(src_w, src_h, max_w, max_h, &out_w, &out_h);
  }
  return true;
}

std::shared_ptr<livekit::D3D11SharedSlot> GpuScreenCapture::Impl::TakeSlot() {
  // Свободна та, на которую не ссылается ни один кадр: у пула единственная ссылка.
  for (auto& slot : pool) {
    if (slot.use_count() == 1) return slot;
  }
  if (pool.size() >= kMaxSlots) return nullptr;
  D3D11_TEXTURE2D_DESC desc = {};
  desc.Width = UINT(src_w);
  desc.Height = UINT(src_h);
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  // RENDER_TARGET | SHADER_RESOURCE — чтобы видеопроцессор кодировщика мог брать её входом.
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  auto slot = std::make_shared<livekit::D3D11SharedSlot>();
  if (FAILED(device->CreateTexture2D(&desc, nullptr, &slot->texture))) {
    RTC_LOG(LS_ERROR) << "GpuScreenCapture: CreateTexture2D(shared) failed";
    return nullptr;
  }
  ComPtr<IDXGIResource1> resource;
  if (FAILED(slot->texture.As(&resource)) ||
      FAILED(resource->CreateSharedHandle(nullptr,
                                          DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                                          nullptr, &slot->shared_handle))) {
    RTC_LOG(LS_ERROR) << "GpuScreenCapture: CreateSharedHandle failed";
    return nullptr;
  }
  slot->id = ++g_slot_id;
  pool.push_back(slot);
  return slot;
}

void GpuScreenCapture::Impl::Push(const VideoTrackSource& source, int64_t timestamp_us) {
  if (!last) return;
  // Без метки — монотонные микросекунды: источник сам выровняет их по своим часам.
  const int64_t ts = timestamp_us > 0 ? timestamp_us : webrtc::TimeMicros();
  webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                 .set_video_frame_buffer(last)
                                 .set_rotation(webrtc::kVideoRotation_0)
                                 .set_timestamp_us(ts)
                                 .build();
  FrameMetadata meta;
  meta.has_packet_trailer = false;
  meta.user_timestamp = 0;
  meta.frame_id = 0;
  source.get()->on_captured_frame(frame, meta);
}

// Собрать новый кадр в свободной текстуре пула: из стола DXGI (`desktop`) или, когда сдвинулась
// только мышь, из своей копии стола (`desktop == nullptr`); сверху — курсор.
int32_t GpuScreenCapture::Impl::Compose(const VideoTrackSource& source,
                                        int64_t timestamp_us,
                                        ID3D11Texture2D* desktop) {
  auto slot = TakeSlot();
  if (!slot) {
    Push(source, timestamp_us);
    return 4;
  }
  ComPtr<IDXGIKeyedMutex> mutex;
  slot->texture.As(&mutex);
  if (!mutex || mutex->AcquireSync(0, 50) != S_OK) {
    Push(source, timestamp_us);
    return 5;
  }
  if (desktop) {
    ctx->CopyResource(slot->texture.Get(), desktop);
    if (cursor_ok && EnsureClean()) ctx->CopyResource(clean.Get(), desktop);
  } else {
    ctx->CopyResource(slot->texture.Get(), clean.Get());
  }
  if (cursor_ok) DrawCursor(*slot);
  ctx->Flush();
  mutex->ReleaseSync(0);
  last = webrtc::make_ref_counted<livekit::D3D11FrameBuffer>(
      device, slot, luid, RECT{0, 0, src_w, src_h}, out_w, out_h);
  Push(source, timestamp_us);
  return 0;
}

bool GpuScreenCapture::Impl::InitCursor() {
  const pD3DCompile compile = ShaderCompiler();
  if (!compile) {
    cursor_error = "нет d3dcompiler_47.dll";
    return false;
  }
  ComPtr<ID3DBlob> vsb, psb, errors;
  if (FAILED(compile(kCursorHlsl, sizeof(kCursorHlsl) - 1, "cursor", nullptr, nullptr, "vs_main",
                     "vs_4_0", 0, 0, &vsb, &errors)) ||
      FAILED(compile(kCursorHlsl, sizeof(kCursorHlsl) - 1, "cursor", nullptr, nullptr, "ps_main",
                     "ps_4_0", 0, 0, &psb, &errors))) {
    if (errors) {
      RTC_LOG(LS_ERROR) << "GpuScreenCapture cursor shader: "
                        << static_cast<const char*>(errors->GetBufferPointer());
    }
    cursor_error = "шейдер курсора не собрался";
    return false;
  }
  if (FAILED(device->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr,
                                        &cur_vs)) ||
      FAILED(device->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr,
                                       &cur_ps))) {
    cursor_error = "шейдеры курсора не созданы";
    return false;
  }
  D3D11_BUFFER_DESC bd = {};
  bd.ByteWidth = sizeof(CursorPlace);
  bd.Usage = D3D11_USAGE_DEFAULT;
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  // Обычное наложение с прозрачностью; прозрачность самого стола не трогаем (кодировщику она не нужна).
  D3D11_BLEND_DESC bl = {};
  D3D11_RENDER_TARGET_BLEND_DESC& rt = bl.RenderTarget[0];
  rt.BlendEnable = TRUE;
  rt.SrcBlend = D3D11_BLEND_SRC_ALPHA;
  rt.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
  rt.BlendOp = D3D11_BLEND_OP_ADD;
  rt.SrcBlendAlpha = D3D11_BLEND_ZERO;
  rt.DestBlendAlpha = D3D11_BLEND_ONE;
  rt.BlendOpAlpha = D3D11_BLEND_OP_ADD;
  rt.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
  D3D11_RASTERIZER_DESC rd = {};
  rd.FillMode = D3D11_FILL_SOLID;
  rd.CullMode = D3D11_CULL_NONE;
  rd.DepthClipEnable = TRUE;
  if (FAILED(device->CreateBuffer(&bd, nullptr, &cur_cb)) ||
      FAILED(device->CreateBlendState(&bl, &cur_blend)) ||
      FAILED(device->CreateRasterizerState(&rd, &cur_raster))) {
    cursor_error = "состояние отрисовки курсора не создано";
    return false;
  }
  return true;
}

// Положение и вид курсора из кадра DXGI. true — курсор на кадре изменился и кадр надо пересобрать.
bool GpuScreenCapture::Impl::UpdatePointer(const DXGI_OUTDUPL_FRAME_INFO& info) {
  bool changed = false;
  // Положение приходит, только если мышь двигалась или пряталась: иначе `LastMouseUpdateTime` — 0.
  // Невидим — либо игра спрятала курсор (шутеры), либо он на другом экране: тогда не рисуем.
  if (info.LastMouseUpdateTime.QuadPart != 0) {
    const bool visible = info.PointerPosition.Visible != FALSE;
    const POINT p = info.PointerPosition.Position;
    if (visible != cur_visible || (visible && (p.x != cur_pos.x || p.y != cur_pos.y))) {
      changed = true;
    }
    cur_visible = visible;
    if (visible) cur_pos = p;
  }
  // Новый вид — только когда сменился (стрелка → рука → «I»).
  if (info.PointerShapeBufferSize > 0) {
    shape_buf.resize(info.PointerShapeBufferSize);
    UINT need = 0;
    DXGI_OUTDUPL_POINTER_SHAPE_INFO si = {};
    if (SUCCEEDED(dup->GetFramePointerShape(UINT(shape_buf.size()), shape_buf.data(), &need, &si)) &&
        LoadShape(si)) {
      changed = true;
    }
  }
  return changed;
}

// Вид курсора → текстура BGRA с прозрачностью. Три вида курсоров Windows:
// - цветной — BGRA с прозрачностью, как есть;
// - цветной с маской — прозрачность 0: точка заменяет экран, 0xFF: исключающее ИЛИ с экраном;
// - чёрно-белый — две маски по биту на точку (И сверху, исключающее ИЛИ снизу), высота двойная.
// Инверсию экрана видеокарта без чтения стола не повторит, поэтому такие точки рисуем чёрными с белой
// обводкой, как libwebrtc (`AddCursorOutline`): курсор «I» виден и на светлом, и на тёмном.
bool GpuScreenCapture::Impl::LoadShape(const DXGI_OUTDUPL_POINTER_SHAPE_INFO& si) {
  const bool mono = si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  const bool masked = si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
  if (!mono && !masked && si.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) return false;
  const int w = int(si.Width);
  const int h = mono ? int(si.Height / 2) : int(si.Height);
  if (w <= 0 || h <= 0 || w > kMaxCursor || h > kMaxCursor) return false;
  const size_t pitch = si.Pitch;
  const size_t rows = mono ? size_t(h) * 2 : size_t(h);
  if (pitch * rows > shape_buf.size()) return false;
  if (mono ? pitch * 8 < size_t(w) : pitch < size_t(w) * 4) return false;
  const uint8_t* b = shape_buf.data();
  std::vector<uint32_t> px(size_t(w) * h, kClear);
  std::vector<uint8_t> inv(size_t(w) * h, 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const size_t i = size_t(y) * w + x;
      if (mono) {
        const uint8_t bit = uint8_t(0x80 >> (x & 7));
        const bool and_bit = (b[size_t(y) * pitch + x / 8] & bit) != 0;
        const bool xor_bit = (b[size_t(y + h) * pitch + x / 8] & bit) != 0;
        if (!and_bit) {
          px[i] = xor_bit ? kWhite : kBlack;
        } else if (xor_bit) {
          inv[i] = 1;
        }
      } else {
        uint32_t v;
        std::memcpy(&v, b + size_t(y) * pitch + size_t(x) * 4, 4);
        if (!masked) {
          px[i] = v;
        } else if ((v >> 24) == 0) {
          px[i] = v | 0xFF000000u;
        } else if ((v & 0x00FFFFFFu) != 0) {
          inv[i] = 1;  // исключающее ИЛИ с нулём ничего не меняет — такие точки прозрачны
        }
      }
    }
  }
  for (size_t i = 0; i < px.size(); ++i) {
    if (inv[i]) px[i] = kBlack;
  }
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const size_t i = size_t(y) * w + x;
      if (px[i] != kClear || inv[i]) continue;
      if ((y > 0 && inv[i - w]) || (y < h - 1 && inv[i + w]) || (x > 0 && inv[i - 1]) ||
          (x < w - 1 && inv[i + 1])) {
        px[i] = kWhite;
      }
    }
  }
  D3D11_TEXTURE2D_DESC desc = {};
  desc.Width = UINT(w);
  desc.Height = UINT(h);
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_IMMUTABLE;
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  D3D11_SUBRESOURCE_DATA data = {px.data(), UINT(w) * 4, 0};
  ComPtr<ID3D11Texture2D> tex;
  ComPtr<ID3D11ShaderResourceView> srv;
  if (FAILED(device->CreateTexture2D(&desc, &data, &tex)) ||
      FAILED(device->CreateShaderResourceView(tex.Get(), nullptr, &srv))) {
    return false;
  }
  cur_srv = srv;
  cur_w = w;
  cur_h = h;
  return true;
}

bool GpuScreenCapture::Impl::EnsureClean() {
  if (clean) return true;
  D3D11_TEXTURE2D_DESC desc = {};
  desc.Width = UINT(src_w);
  desc.Height = UINT(src_h);
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  return SUCCEEDED(device->CreateTexture2D(&desc, nullptr, &clean));
}

// Курсор поверх кадра в текстуре слота. Зовётся под keyed mutex, до `Flush()`.
void GpuScreenCapture::Impl::DrawCursor(const livekit::D3D11SharedSlot& slot) {
  if (!cur_visible || !cur_srv || src_w <= 0 || src_h <= 0) return;
  ComPtr<ID3D11RenderTargetView>& rtv = rtvs[slot.id];
  if (!rtv && FAILED(device->CreateRenderTargetView(slot.texture.Get(), nullptr, &rtv))) {
    rtvs.erase(slot.id);
    return;
  }
  const float fw = float(src_w), fh = float(src_h);
  const CursorPlace place = {
      {2.f * cur_pos.x / fw - 1.f, 1.f - 2.f * cur_pos.y / fh, 2.f * (cur_pos.x + cur_w) / fw - 1.f,
       1.f - 2.f * (cur_pos.y + cur_h) / fh},
      {int32_t(cur_pos.x), int32_t(cur_pos.y), 0, 0}};
  ctx->UpdateSubresource(cur_cb.Get(), 0, nullptr, &place, 0, 0);
  const D3D11_VIEWPORT vp = {0.f, 0.f, fw, fh, 0.f, 1.f};
  ctx->RSSetViewports(1, &vp);
  ctx->RSSetState(cur_raster.Get());
  ctx->IASetInputLayout(nullptr);
  ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
  ctx->VSSetShader(cur_vs.Get(), nullptr, 0);
  ctx->VSSetConstantBuffers(0, 1, cur_cb.GetAddressOf());
  ctx->PSSetShader(cur_ps.Get(), nullptr, 0);
  ctx->PSSetConstantBuffers(0, 1, cur_cb.GetAddressOf());
  ctx->PSSetShaderResources(0, 1, cur_srv.GetAddressOf());
  ctx->OMSetBlendState(cur_blend.Get(), nullptr, 0xffffffff);
  ctx->OMSetRenderTargets(1, rtv.GetAddressOf(), nullptr);
  ctx->Draw(4, 0);
  // Общую текстуру не оставляем привязанной: дальше её открывает кодировщик на своём устройстве.
  ID3D11RenderTargetView* none = nullptr;
  ctx->OMSetRenderTargets(1, &none, nullptr);
}

GpuScreenCapture::GpuScreenCapture(int32_t display_index,
                                   uint32_t max_width,
                                   uint32_t max_height,
                                   bool cursor)
    : impl_(std::make_unique<Impl>()) {
  livekit::SetNativeEncodeFailed(false);  // флаг прошлого показа к этому отношения не имеет
  impl_->max_w = int(max_width);
  impl_->max_h = int(max_height);
  if (impl_->Init(display_index)) {
    // Курсор не поднялся — показ всё равно идёт, без курсора; причина уезжает в «Путь кадра».
    impl_->cursor_ok = cursor && impl_->InitCursor();
    RTC_LOG(LS_INFO) << "GpuScreenCapture: " << impl_->adapter_name << ", " << impl_->src_w
                     << "x" << impl_->src_h << " -> " << impl_->out_w << "x" << impl_->out_h
                     << (impl_->cursor_ok ? ", cursor" : "");
    if (cursor && !impl_->cursor_ok) {
      RTC_LOG(LS_WARNING) << "GpuScreenCapture cursor unavailable: " << impl_->cursor_error;
    }
  } else {
    RTC_LOG(LS_WARNING) << "GpuScreenCapture unavailable: " << impl_->error;
  }
}

GpuScreenCapture::~GpuScreenCapture() {
  if (impl_->dup && impl_->holding) impl_->dup->ReleaseFrame();
}

rust::String GpuScreenCapture::init_error() const {
  return rust::String(impl_->error);
}

rust::String GpuScreenCapture::cursor_error() const {
  return rust::String(impl_->cursor_error);
}

rust::String GpuScreenCapture::adapter_name() const {
  return rust::String(impl_->adapter_name);
}

uint32_t GpuScreenCapture::source_width() const {
  return uint32_t(impl_->src_w);
}

uint32_t GpuScreenCapture::source_height() const {
  return uint32_t(impl_->src_h);
}

uint32_t GpuScreenCapture::frame_width() const {
  return uint32_t(impl_->out_w);
}

uint32_t GpuScreenCapture::frame_height() const {
  return uint32_t(impl_->out_h);
}

uint32_t GpuScreenCapture::lost_count() const {
  return impl_->lost;
}

// Коды: 0 — новый кадр, 1 — экран не менялся (повторён прошлый), 2 — кадров ещё не было,
// 3 — захват потерян (смена режима, UAC, полноэкранная игра) и пересоздаётся,
// 4 — все текстуры пула заняты, 5 — текстуру держит кодировщик, -1 — захват не поднялся,
// -2 — кодировщик не смог взять кадр из видеопамяти, -3 — кадр пришёл не в BGRA (показу пора на
// старый путь в обоих случаях).
int32_t GpuScreenCapture::capture(const VideoTrackSource& source, int64_t timestamp_us) {
  Impl& s = *impl_;
  if (!s.error.empty()) return -1;
  if (livekit::NativeEncodeFailed()) return -2;
  if (s.holding) {
    s.dup->ReleaseFrame();
    s.holding = false;
  }
  if (!s.dup && !s.Duplicate()) {
    s.Push(source, timestamp_us);
    return 3;
  }
  DXGI_OUTDUPL_FRAME_INFO info;
  ComPtr<IDXGIResource> resource;
  const HRESULT hr = s.dup->AcquireNextFrame(0, &info, &resource);
  if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
    if (!s.last) return 2;
    s.Push(source, timestamp_us);
    return 1;
  }
  if (FAILED(hr)) {
    s.dup.Reset();
    ++s.lost;
    s.Push(source, timestamp_us);
    return 3;
  }
  s.holding = true;
  // Положение и вид курсора берём из КАЖДОГО кадра DXGI: пропущенный кадр — потерянная смена вида.
  const bool pointer_changed = s.cursor_ok && s.UpdatePointer(info);
  if (info.LastPresentTime.QuadPart == 0) {  // сдвинулась только мышь
    if (!s.last) return 2;
    // Курсор на кадре другой — собираем кадр из своей копии стола, иначе повторяем прошлый.
    if (pointer_changed && s.clean) return s.Compose(source, timestamp_us, nullptr);
    s.Push(source, timestamp_us);
    return 1;
  }
  ComPtr<ID3D11Texture2D> desktop;
  resource.As(&desktop);
  D3D11_TEXTURE2D_DESC desk;
  desktop->GetDesc(&desk);
  if (desk.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
    s.Push(source, timestamp_us);
    return -3;
  }
  if (int(desk.Width) != s.src_w || int(desk.Height) != s.src_h) {
    // Размер кадра разошёлся с режимом — пересоздаём дубликат, как при потере.
    s.dup->ReleaseFrame();
    s.holding = false;
    s.dup.Reset();
    ++s.lost;
    s.Push(source, timestamp_us);
    return 3;
  }
  return s.Compose(source, timestamp_us, desktop.Get());
}

uint64_t GpuScreenCapture::poll_preview(rust::Vec<uint8_t>& rgba) {
  Impl& s = *impl_;
  if (!s.last || s.src_w <= 0 || s.src_h <= 0) return 0;
  if (s.last->texture_width() != s.src_w || s.last->texture_height() != s.src_h) return 0;
  if (!s.preview_pending) {
    if (!s.staging) {
      D3D11_TEXTURE2D_DESC desc = {};
      desc.Width = UINT(s.src_w);
      desc.Height = UINT(s.src_h);
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      desc.SampleDesc.Count = 1;
      desc.Usage = D3D11_USAGE_STAGING;
      desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      if (FAILED(s.device->CreateTexture2D(&desc, nullptr, &s.staging))) return 0;
    }
    ComPtr<IDXGIKeyedMutex> mutex;
    s.last->texture()->QueryInterface(IID_PPV_ARGS(&mutex));
    // Текстуру сейчас читает кодировщик — не ждём, попробуем на следующем тике.
    if (!mutex || mutex->AcquireSync(0, 0) != S_OK) return 0;
    s.ctx->CopyResource(s.staging.Get(), s.last->texture());
    s.ctx->Flush();
    mutex->ReleaseSync(0);
    s.preview_pending = true;
    return 0;
  }
  D3D11_MAPPED_SUBRESOURCE map;
  const HRESULT hr =
      s.ctx->Map(s.staging.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &map);
  if (hr == DXGI_ERROR_WAS_STILL_DRAWING) return 0;
  s.preview_pending = false;
  if (FAILED(hr)) return 0;
  // Ближайший сосед, как `downscale_bgra` в screenshare.rs: десятки тысяч точек из миллионов.
  const int w = s.src_w, h = s.src_h;
  const int tw = std::max(1, std::min(w, kThumbWidth));
  const int th = std::max(1, h * tw / w);
  rgba.clear();
  rgba.reserve(size_t(tw) * th * 4);
  for (int y = 0; y < th; ++y) {
    const int sy = std::min(y * h / th, h - 1);
    const uint8_t* row = static_cast<const uint8_t*>(map.pData) + size_t(sy) * map.RowPitch;
    for (int x = 0; x < tw; ++x) {
      const uint8_t* p = row + size_t(std::min(x * w / tw, w - 1)) * 4;
      rgba.push_back(p[2]);  // R
      rgba.push_back(p[1]);  // G
      rgba.push_back(p[0]);  // B
      rgba.push_back(255);
    }
  }
  s.ctx->Unmap(s.staging.Get(), 0);
  return (uint64_t(tw) << 32) | uint64_t(th);
}

std::unique_ptr<GpuScreenCapture> new_gpu_screen_capture(int32_t display_index,
                                                         uint32_t max_width,
                                                         uint32_t max_height,
                                                         bool cursor) {
  return std::make_unique<GpuScreenCapture>(display_index, max_width, max_height, cursor);
}

void set_bitrate_hint(int32_t start_bps, int32_t min_bps) {
  livekit::SetBitrateHint(start_bps, min_bps);
}

void set_screen_encoder_keyframe_scale(int32_t keyframe_scale) {
  livekit::SetScreenEncoderKeyframeScale(keyframe_scale);
}

rust::String native_encode_fail_reason() {
  return rust::String(livekit::NativeEncodeFailReason());
}

bool gpu_capture_supported() {
#if defined(USE_NVIDIA_VIDEO_CODEC)
  return webrtc::NvidiaVideoEncoderFactory::IsSupported();
#else
  return false;
#endif
}

}  // namespace livekit_ffi
