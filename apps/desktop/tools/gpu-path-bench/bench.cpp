// gpu-path-bench — замер пути кадра при показе экрана (#207, шаг 4.0): нынешний путь через
// оперативку против «кадр не покидает видеокарту».
//
// Отдельная программа, не приложение: снимает монитор через DXGI и кодирует его слоями NVENC с теми
// же настройками, что показ в GusVoice (лестница `share_layer_presets`, P4 + ULL + CBR, бесконечный
// GOP), но никуда не отправляет. Сеть, зрители и dynacast не участвуют — меряется цена самого показа
// для машины и для игры.
//
// Режимы:
//   cpu — как сейчас в приложении: копия кадра в staging-текстуру → Map (ждёт видеокарту) → копия в
//         оперативку → libyuv (тот же, что в приложении: из prebuilt libwebrtc) BGRA→I420 и
//         уменьшение под каждый слой → CUDA загружает каждый слой обратно → NVENC (CUDA-сессия).
//   gpu — кадр не покидает видеокарту: копия в свою текстуру → видеопроцессор D3D11 переводит
//         BGRA→NV12 с уменьшением прямо во входную текстуру NVENC (D3D11-сессия, без CUDA).
//   capture — только захват DXGI (взять и отпустить кадр), без копий и кодирования.
//   idle — ни захвата, ни кодирования: пустой цикл с ежесекундным опросом.
// Два последних и `--engines 0` (не опрашивать счётчики `GPU Engine`) — чтобы разделить, что именно
// из показа даёт игре рывки (замер под Valheim 25.09: рывков 5 → ~55 в ОБОИХ режимах кодирования).
//
// Чего НЕ повторяет: курсор (DXGI отдаёт его отдельно), сеть, превью (#115). Кодирование
// синхронное, как в приложении: каждый слой ждёт готовый кадр, прежде чем идти дальше.

#include <windows.h>

#include <d3d11_4.h>
#include <dxgi1_5.h>
#include <pdh.h>
#include <tlhelp32.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <deque>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <cuda.h>

#include "NvEncoder/NvEncoderCuda.h"
#include "libyuv/convert_from_argb.h"
#include "libyuv/scale.h"
#include "nvenc_d3d11.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "pdh.lib")

using Microsoft::WRL::ComPtr;

namespace {

std::atomic<bool> g_stop{false};
bool g_record = false;  // первые секунды (запуск кодировщиков, первый опорный кадр) в итог не идут
constexpr double kWarmupMs = 2000;

double NowMs() {
  static const LARGE_INTEGER freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f;
  }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return c.QuadPart * 1000.0 / freq.QuadPart;
}

double ProcessCpuMs() {
  FILETIME created, exited, kernel, user;
  GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user);
  const ULARGE_INTEGER k{{kernel.dwLowDateTime, kernel.dwHighDateTime}};
  const ULARGE_INTEGER u{{user.dwLowDateTime, user.dwHighDateTime}};
  return (k.QuadPart + u.QuadPart) / 10000.0;
}

// Ряд замеров: за последнюю секунду (для строки раз в секунду) и за весь прогон (для итога).
struct Series {
  std::vector<double> all;
  double sec_sum = 0, sec_max = 0;
  int sec_n = 0;

  void Add(double v) {
    sec_sum += v;
    sec_max = std::max(sec_max, v);
    ++sec_n;
    if (g_record) all.push_back(v);
  }
  double SecAvg() const { return sec_n ? sec_sum / sec_n : 0; }
  void ResetSec() { sec_sum = sec_max = 0, sec_n = 0; }
  double Avg() const {
    double s = 0;
    for (double v : all) s += v;
    return all.empty() ? 0 : s / all.size();
  }
  double Q(double p) const {
    if (all.empty()) return 0;
    std::vector<double> s = all;
    std::sort(s.begin(), s.end());
    return s[static_cast<size_t>(std::floor(p * (s.size() - 1)))];
  }
};

struct Args {
  std::string mode = "gpu";
  int seconds = 60;
  int fps = 60;
  int layers = 3;
  int monitor = 0;
  int kbps = 0;  // 0 — как приложение при 1440p60 «движение» H.264: 5000 × 1,6 × 1,15 × 1,4
  int max_w = 0, max_h = 0;
  bool main_profile = false;
  std::string game;
  std::string out;
  std::string json;
  bool list = false;
  bool engines = true;  // опрашивать ли раз в секунду счётчики `GPU Engine`
  bool shared = false;  // режим gpu как в приложении: своё устройство у кодировщика, общая текстура
  int depth = 0;        // конвейер NVENC в режиме gpu: сколько кадров в работе сверх текущего
};

void Usage() {
  std::printf(
      "gpu-path-bench --mode cpu|gpu|capture|idle [--seconds 60] [--fps 60] [--layers 3|1] [--monitor 0]\n"
      "               [--engines 1|0] [--depth 0..3]\n"
      "               [--kbps 12880] [--max 2560x1440] [--profile baseline|main]\n"
      "               [--game Valheim.exe] [--out full.h264] [--json итог.json]\n"
      "gpu-path-bench --list   — мониторы и их номера для --monitor\n");
}

bool ParseArgs(int argc, char** argv, Args* a) {
  for (int i = 1; i < argc; ++i) {
    const std::string k = argv[i];
    auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
    if (k == "--mode") a->mode = next();
    else if (k == "--seconds") a->seconds = std::atoi(next());
    else if (k == "--fps") a->fps = std::atoi(next());
    else if (k == "--layers") a->layers = std::atoi(next());
    else if (k == "--monitor") a->monitor = std::atoi(next());
    else if (k == "--kbps") a->kbps = std::atoi(next());
    else if (k == "--max") std::sscanf(next(), "%dx%d", &a->max_w, &a->max_h);
    else if (k == "--profile") a->main_profile = std::string(next()) == "main";
    else if (k == "--game") a->game = next();
    else if (k == "--out") a->out = next();
    else if (k == "--json") a->json = next();
    else if (k == "--list") a->list = true;
    else if (k == "--engines") a->engines = std::atoi(next()) != 0;
    else if (k == "--shared") a->shared = true;
    else if (k == "--depth") a->depth = std::clamp(std::atoi(next()), 0, 3);
    else return false;
  }
  return a->list || (a->mode == "cpu" || a->mode == "gpu" || a->mode == "capture" || a->mode == "idle") && a->fps > 0 && a->seconds > 0 &&
         (a->layers == 1 || a->layers == 3);
}

// Слой показа. `every` — кодировать каждый N-й тик (экономный слой идёт при 3 к/с).
struct Layer {
  const char* rid;
  int w, h;
  int fps;
  int kbps;
  int every;
};

// Копия `share_layer_presets` (screenshare.rs): полный + средний (короткая сторона 720, у 4K — 1080,
// полная частота, 0,6–2,5 Мбит/с и не выше 0,6 полного) + экономный (вдвое меньше среднего, 3 к/с).
std::vector<Layer> MakeLayers(int w, int h, int fps, int kbps, int count) {
  std::vector<Layer> out = {{"f", w, h, fps, kbps, 1}};
  if (count == 1) return out;
  const int short_side = std::max(1, std::min(w, h));
  auto scaled = [&](int target, int side) {
    return std::max(2, static_cast<int>(std::lround(side * double(target) / short_side / 2.0)) * 2);
  };
  auto low = [&](int target) {
    const double ratio = std::pow(double(target) / short_side, 2);
    const long long bps =
        std::max(150000LL, std::llround(kbps * 1000.0 * ratio * 3.0 / std::max(1, fps)));
    return Layer{"q", scaled(target, w), scaled(target, h), 3, int(bps / 1000),
                 std::max(1, int(std::lround(fps / 3.0)))};
  };
  if (short_side <= 720) {
    out.push_back(low(int(std::lround(short_side / 2.0))));
    return out;
  }
  const int mid_short = short_side >= 2160 ? 1080 : 720;
  const double ratio = std::pow(double(mid_short) / short_side, 2);
  long long mid_bps = std::clamp(std::llround(kbps * 1000.0 * ratio * 1.5), 600000LL, 2500000LL);
  mid_bps = std::min(mid_bps, std::llround(kbps * 1000.0 * 0.6));
  out.push_back({"h", scaled(mid_short, w), scaled(mid_short, h), fps, int(mid_bps / 1000), 1});
  out.push_back(low(mid_short / 2));
  return out;
}

// Настройки как в `NvidiaH264EncoderImpl::InitEncode` (вендоренный webrtc-sys).
void InitEncoder(NvEncoder& enc, const Layer& l, NV_ENC_BUFFER_FORMAT format, bool main_profile) {
  NV_ENC_INITIALIZE_PARAMS init = {NV_ENC_INITIALIZE_PARAMS_VER};
  NV_ENC_CONFIG cfg = {NV_ENC_CONFIG_VER};
  init.encodeConfig = &cfg;
  enc.CreateDefaultEncoderParams(&init, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P4_GUID,
                                 NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY);
  init.frameRateNum = static_cast<uint32_t>(l.fps);
  init.frameRateDen = 1;
  init.bufferFormat = format;
  cfg.profileGUID = main_profile ? NV_ENC_H264_PROFILE_MAIN_GUID : NV_ENC_H264_PROFILE_BASELINE_GUID;
  cfg.gopLength = NVENC_INFINITE_GOPLENGTH;
  cfg.frameIntervalP = 1;
  cfg.encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_AUTOSELECT;
  cfg.encodeCodecConfig.h264Config.idrPeriod = NVENC_INFINITE_GOPLENGTH;
  cfg.rcParams.version = NV_ENC_RC_PARAMS_VER;
  cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
  cfg.rcParams.averageBitRate = static_cast<uint32_t>(l.kbps) * 1000;
  cfg.rcParams.vbvBufferSize = cfg.rcParams.averageBitRate / init.frameRateNum * 5;
  cfg.rcParams.vbvInitialDelay = cfg.rcParams.vbvBufferSize;
  enc.CreateEncoder(&init);
}

// Время нашей работы на видеокарте по меткам D3D11. Читается без ожидания, через несколько тиков.
// ⚠️ Это время ОТ НАЧАЛА ДО КОНЦА наших команд на шкале видеокарты: если между ними она выполняла
// игру, оно тоже сюда попадёт. То есть это «сколько наш кадр пробыл на видеокарте», а не чистая цена.
// Охватывает копию кадра и перевод под слои; кодирование NVENC — отдельный блок, его здесь нет.
// Только в режиме gpu: в режиме cpu копия в staging идёт копирующим движком, и метки ловят его
// ожидание (ровно период обновления экрана), а не цену — цифра врала бы.
class GpuTimer {
 public:
  GpuTimer(ID3D11Device* dev, bool enabled) : enabled_(enabled && dev) {
    if (!enabled_) return;
    for (Slot& s : slots_) {
      D3D11_QUERY_DESC d = {D3D11_QUERY_TIMESTAMP_DISJOINT, 0};
      dev->CreateQuery(&d, &s.disjoint);
      d.Query = D3D11_QUERY_TIMESTAMP;
      dev->CreateQuery(&d, &s.begin);
      dev->CreateQuery(&d, &s.end);
    }
  }
  void Begin(ID3D11DeviceContext* ctx) {
    if (!enabled_) return;
    Collect(ctx);
    Slot& s = slots_[cur_];
    ctx->Begin(s.disjoint.Get());
    ctx->End(s.begin.Get());
    open_ = true;
  }
  void End(ID3D11DeviceContext* ctx) {
    if (!open_) return;
    Slot& s = slots_[cur_];
    ctx->End(s.end.Get());
    ctx->End(s.disjoint.Get());
    s.pending = true;
    cur_ = (cur_ + 1) % kSlots;
    open_ = false;
  }
  Series ms;

 private:
  void Collect(ID3D11DeviceContext* ctx) {
    for (Slot& s : slots_) {
      if (!s.pending) continue;
      D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj;
      UINT64 a = 0, b = 0;
      if (ctx->GetData(s.disjoint.Get(), &dj, sizeof dj, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK ||
          ctx->GetData(s.begin.Get(), &a, sizeof a, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK ||
          ctx->GetData(s.end.Get(), &b, sizeof b, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) {
        continue;
      }
      s.pending = false;
      if (!dj.Disjoint && dj.Frequency) ms.Add((b - a) * 1000.0 / dj.Frequency);
    }
  }
  static constexpr int kSlots = 8;
  struct Slot {
    ComPtr<ID3D11Query> disjoint, begin, end;
    bool pending = false;
  } slots_[kSlots];
  int cur_ = 0;
  bool open_ = false;
  bool enabled_;
};

// Загрузка движков видеокарты по процессам — те же счётчики, что у диспетчера задач и у `gpu_by` в
// телеметрии приложения: `\GPU Engine(pid_…_engtype_…)\Utilization Percentage`.
struct EngineLoad {
  double d3 = 0, copy = 0, venc = 0, other = 0;
  void Add(const EngineLoad& o) { d3 += o.d3, copy += o.copy, venc += o.venc, other += o.other; }
};

class GpuEngines {
 public:
  bool Init() {
    if (PdhOpenQueryW(nullptr, 0, &query_) != ERROR_SUCCESS) return false;
    if (PdhAddEnglishCounterW(query_, L"\\GPU Engine(*)\\Utilization Percentage", 0, &counter_) !=
        ERROR_SUCCESS) {
      return false;
    }
    PdhCollectQueryData(query_);
    return true;
  }
  void Sample(DWORD self, const std::vector<DWORD>& game, EngineLoad* ours, EngineLoad* theirs) {
    *ours = {}, *theirs = {};
    if (!query_ || PdhCollectQueryData(query_) != ERROR_SUCCESS) return;
    DWORD bytes = 0, count = 0;
    PdhGetFormattedCounterArrayW(counter_, PDH_FMT_DOUBLE, &bytes, &count, nullptr);
    if (!bytes) return;
    std::vector<BYTE> buf(bytes);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
    if (PdhGetFormattedCounterArrayW(counter_, PDH_FMT_DOUBLE, &bytes, &count, items) !=
        ERROR_SUCCESS) {
      return;
    }
    for (DWORD i = 0; i < count; ++i) {
      const wchar_t* name = items[i].szName;  // pid_1234_luid_…_phys_0_eng_0_engtype_3D
      if (std::wcsncmp(name, L"pid_", 4) != 0) continue;
      const DWORD pid = std::wcstoul(name + 4, nullptr, 10);
      EngineLoad* dst = pid == self ? ours
                        : std::find(game.begin(), game.end(), pid) != game.end() ? theirs
                                                                                 : nullptr;
      if (!dst) continue;
      const wchar_t* type = std::wcsstr(name, L"engtype_");
      const double v = items[i].FmtValue.doubleValue;
      if (!type) dst->other += v;
      else if (!std::wcscmp(type + 8, L"3D")) dst->d3 += v;
      else if (!std::wcscmp(type + 8, L"Copy")) dst->copy += v;
      else if (!std::wcscmp(type + 8, L"VideoEncode")) dst->venc += v;
      else dst->other += v;
    }
  }

 private:
  PDH_HQUERY query_ = nullptr;
  PDH_HCOUNTER counter_ = nullptr;
};

void ListMonitors() {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return;
  int n = 0;
  ComPtr<IDXGIAdapter1> adapter;
  for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
    DXGI_ADAPTER_DESC1 ad;
    adapter->GetDesc1(&ad);
    ComPtr<IDXGIOutput> out;
    for (UINT o = 0; adapter->EnumOutputs(o, &out) != DXGI_ERROR_NOT_FOUND; ++o) {
      DXGI_OUTPUT_DESC od;
      out->GetDesc(&od);
      const RECT& r = od.DesktopCoordinates;
      std::printf("--monitor %d: %ls %ldx%ld в (%ld,%ld)%s — %ls\n", n++, od.DeviceName,
                  r.right - r.left, r.bottom - r.top, r.left, r.top,
                  r.left == 0 && r.top == 0 ? " основной" : "", ad.Description);
    }
  }
}

std::vector<DWORD> FindPids(const std::string& exe) {
  std::vector<DWORD> out;
  if (exe.empty()) return out;
  const std::wstring want(exe.begin(), exe.end());
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return out;
  PROCESSENTRY32W pe = {sizeof pe};
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
    if (!_wcsicmp(pe.szExeFile, want.c_str())) out.push_back(pe.th32ProcessID);
  }
  CloseHandle(snap);
  return out;
}

// Захват монитора через DXGI Desktop Duplication — тот же API, что у показа экрана с 0.8.9.
class Duplicator {
 public:
  enum class Got { kNew, kNoImage, kNone, kLost };

  bool Init(int monitor) {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
    int n = 0;
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
      ComPtr<IDXGIOutput> out;
      for (UINT o = 0; adapter->EnumOutputs(o, &out) != DXGI_ERROR_NOT_FOUND; ++o) {
        if (n++ == monitor) {
          adapter_ = adapter;
          output_ = out;
        }
      }
    }
    if (!output_) {
      std::fprintf(stderr, "Монитор %d не найден (всего %d)\n", monitor, n);
      return false;
    }
    DXGI_ADAPTER_DESC1 ad;
    adapter_->GetDesc1(&ad);
    std::printf("Видеокарта: %ls%s\n", ad.Description,
                ad.VendorId == 0x10DE ? "" : "  ⚠️ не NVIDIA — NVENC тут не заработает");
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    if (FAILED(D3D11CreateDevice(adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT |
                                     D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                                 levels, 2, D3D11_SDK_VERSION, &device, nullptr, &ctx))) {
      std::fprintf(stderr, "D3D11CreateDevice не удался\n");
      return false;
    }
    ComPtr<ID3D11Multithread> mt;
    if (SUCCEEDED(ctx.As(&mt))) mt->SetMultithreadProtected(TRUE);
    return Duplicate();
  }

  Got Acquire(ComPtr<ID3D11Texture2D>* tex) {
    if (!dup_ && !Duplicate()) return Got::kLost;
    DXGI_OUTDUPL_FRAME_INFO info;
    ComPtr<IDXGIResource> res;
    const HRESULT hr = dup_->AcquireNextFrame(0, &info, &res);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return Got::kNone;
    if (FAILED(hr)) {
      dup_.Reset();  // ACCESS_LOST: смена режима, полноэкранная игра, UAC — пересоздадим
      ++lost;
      return Got::kLost;
    }
    if (info.LastPresentTime.QuadPart == 0) return Got::kNoImage;  // сдвинулась только мышь
    res.As(tex);
    return Got::kNew;
  }
  void Release() { dup_->ReleaseFrame(); }
  IDXGIAdapter1* adapter() const { return adapter_.Get(); }

  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> ctx;
  int width = 0, height = 0;
  int lost = 0;

 private:
  bool Duplicate() {
    ComPtr<IDXGIOutput1> out1;
    if (FAILED(output_.As(&out1))) return false;
    // Как приложение с 26.09: BGRA явно — у 10-битного вывода стол в FP16 даже без HDR.
    HRESULT hr = E_FAIL;
    ComPtr<IDXGIOutput5> out5;
    if (SUCCEEDED(output_.As(&out5))) {
      const DXGI_FORMAT formats[] = {DXGI_FORMAT_B8G8R8A8_UNORM};
      hr = out5->DuplicateOutput1(device.Get(), 0, 1, formats, &dup_);
    }
    if (FAILED(hr)) hr = out1->DuplicateOutput(device.Get(), &dup_);
    if (FAILED(hr)) {
      std::fprintf(stderr, "DuplicateOutput: 0x%08lx\n", static_cast<unsigned long>(hr));
      return false;
    }
    DXGI_OUTDUPL_DESC d;
    dup_->GetDesc(&d);
    width = int(d.ModeDesc.Width);
    height = int(d.ModeDesc.Height);
    return true;
  }
  ComPtr<IDXGIAdapter1> adapter_;
  ComPtr<IDXGIOutput> output_;
  ComPtr<IDXGIOutputDuplication> dup_;
};

struct Stats {
  Series grab, prep, upload, enc, tick;
  Series latency;  // от начала подготовки кадра до готового пакета, полный слой
  std::vector<long long> frames, bytes;          // за весь прогон (после прогрева)
  std::vector<long long> sec_frames, sec_bytes;  // за последнюю секунду
  void CountPacket(size_t layer, size_t n) {
    sec_bytes[layer] += n;
    if (g_record) bytes[layer] += n;
  }
  void CountFrame(size_t layer) {
    ++sec_frames[layer];
    if (g_record) ++frames[layer];
  }
};

class Pipeline {
 public:
  virtual ~Pipeline() = default;
  // Новый кадр рабочего стола. Живёт до ReleaseFrame — только поставить копию в очередь видеокарты.
  virtual void Grab(ID3D11Texture2D* desktop) = 0;
  // Подготовить и закодировать слои, которым пора. Обязан закрыть `timer` после последней команды
  // D3D11 этого тика.
  virtual void Process(const std::vector<bool>& due, GpuTimer& timer) = 0;
};

using Packets = std::vector<std::vector<uint8_t>>;

void EncodeOne(NvEncoder& enc, bool* first, Packets* packets) {
  NV_ENC_PIC_PARAMS pic = {NV_ENC_PIC_PARAMS_VER};
  if (*first) {
    pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEINTRA | NV_ENC_PIC_FLAG_FORCEIDR |
                         NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    *first = false;
  }
  enc.EncodeFrame(*packets, &pic);
}

// ---------------------------------------------------------------------------------------------
// cpu: нынешний путь приложения.

struct I420 {
  int w = 0, h = 0;
  std::vector<uint8_t> y, u, v;
  void Resize(int nw, int nh) {
    w = nw, h = nh;
    y.resize(size_t(w) * h);
    u.resize(size_t(Cw()) * Ch());
    v.resize(size_t(Cw()) * Ch());
  }
  int Cw() const { return (w + 1) / 2; }
  int Ch() const { return (h + 1) / 2; }
};

void ScaleI420(const I420& s, I420* d) {
  // Как `I420Buffer::CropAndScaleFrom` в libwebrtc: libyuv, фильтр box.
  libyuv::I420Scale(s.y.data(), s.w, s.u.data(), s.Cw(), s.v.data(), s.Cw(), s.w, s.h, d->y.data(),
                    d->w, d->u.data(), d->Cw(), d->v.data(), d->Cw(), d->w, d->h,
                    libyuv::kFilterBox);
}

void CopyPlane(CUdeviceptr dst, uint32_t dst_pitch, const uint8_t* src, int src_pitch, int width,
               int height) {
  CUDA_MEMCPY2D c = {};
  c.srcMemoryType = CU_MEMORYTYPE_HOST;
  c.srcHost = src;
  c.srcPitch = size_t(src_pitch);
  c.dstMemoryType = CU_MEMORYTYPE_DEVICE;
  c.dstDevice = dst;
  c.dstPitch = dst_pitch;
  c.WidthInBytes = size_t(width);
  c.Height = size_t(height);
  CUDA_DRVAPI_CALL(cuMemcpy2D(&c));
}

class CpuPipeline : public Pipeline {
 public:
  CpuPipeline(Duplicator& cap, const std::vector<Layer>& layers, bool main_profile, Stats& st,
              FILE* out)
      : cap_(cap), stats_(st), out_(out) {
    CUDA_DRVAPI_CALL(cuInit(0));
    CUdevice dev;
    CUDA_DRVAPI_CALL(cuDeviceGet(&dev, 0));
    // Как в приложении с 0.8.7: ждать видеокарту сном, а не вращением ядра.
    CUDA_DRVAPI_CALL(cuCtxCreate(&cu_, CU_CTX_SCHED_BLOCKING_SYNC, dev));
    for (const Layer& l : layers) {
      auto enc = std::make_unique<NvEncoderCuda>(cu_, l.w, l.h, NV_ENC_BUFFER_FORMAT_IYUV, 0);
      InitEncoder(*enc, l, NV_ENC_BUFFER_FORMAT_IYUV, main_profile);
      Slot s{l, std::move(enc)};
      s.buf.Resize(l.w, l.h);
      slots_.push_back(std::move(s));
    }
  }
  ~CpuPipeline() override {
    for (Slot& s : slots_) s.enc->DestroyEncoder();
    slots_.clear();
    if (cu_) cuCtxDestroy(cu_);
  }

  void Grab(ID3D11Texture2D* desktop) override {
    if (!staging_) {
      D3D11_TEXTURE2D_DESC d;
      desktop->GetDesc(&d);
      d.Usage = D3D11_USAGE_STAGING;
      d.BindFlags = 0;
      d.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      d.MiscFlags = 0;
      cap_.device->CreateTexture2D(&d, nullptr, &staging_);
      src_w_ = int(d.Width), src_h_ = int(d.Height);
      bgra_.resize(size_t(src_w_) * src_h_ * 4);
      src_.Resize(src_w_, src_h_);
    }
    cap_.ctx->CopyResource(staging_.Get(), desktop);
    fresh_ = true;
  }

  void Process(const std::vector<bool>& due, GpuTimer& timer) override {
    timer.End(cap_.ctx.Get());
    if (fresh_) {
      // Забор в оперативку: Map ждёт, пока видеокарта сделает копию, — в очереди за игрой.
      const double t0 = NowMs();
      D3D11_MAPPED_SUBRESOURCE m;
      if (SUCCEEDED(cap_.ctx->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &m))) {
        for (int row = 0; row < src_h_; ++row) {
          std::memcpy(&bgra_[size_t(row) * src_w_ * 4],
                      static_cast<const uint8_t*>(m.pData) + size_t(row) * m.RowPitch,
                      size_t(src_w_) * 4);
        }
        cap_.ctx->Unmap(staging_.Get(), 0);
      }
      stats_.grab.Add(NowMs() - t0);
      fresh_ = false;
    }
    // Перевод каждый тик, даже без нового кадра: приложение тоже переводит каждый отданный кадр.
    const double t1 = NowMs();
    tick_start_ = t1;
    // «ARGB» у libyuv — порядок байт B,G,R,A в памяти, то есть наш BGRA (как `bgra_to_i420`).
    libyuv::ARGBToI420(bgra_.data(), src_w_ * 4, src_.y.data(), src_.w, src_.u.data(), src_.Cw(),
                       src_.v.data(), src_.Cw(), src_w_, src_h_);
    Slot& full = slots_[0];
    if (full.buf.w != src_.w || full.buf.h != src_.h) ScaleI420(src_, &full.buf);
    const I420& top = (full.buf.w == src_.w && full.buf.h == src_.h) ? src_ : full.buf;
    for (size_t i = 1; i < slots_.size(); ++i) {
      if (due[i]) ScaleI420(top, &slots_[i].buf);
    }
    stats_.prep.Add(NowMs() - t1);

    double up = 0, en = 0;
    for (size_t i = 0; i < slots_.size(); ++i) {
      if (!due[i]) continue;
      Slot& s = slots_[i];
      const I420& b = i == 0 ? top : s.buf;
      const double t2 = NowMs();
      const NvEncInputFrame* f = s.enc->GetNextInputFrame();
      CUDA_DRVAPI_CALL(cuCtxPushCurrent(cu_));
      const CUdeviceptr y = reinterpret_cast<CUdeviceptr>(f->inputPtr);
      CopyPlane(y, f->pitch, b.y.data(), b.w, b.w, b.h);
      CopyPlane(y + f->chromaOffsets[0], f->chromaPitch, b.u.data(), b.Cw(), b.Cw(), b.Ch());
      CopyPlane(y + f->chromaOffsets[1], f->chromaPitch, b.v.data(), b.Cw(), b.Cw(), b.Ch());
      CUDA_DRVAPI_CALL(cuCtxPopCurrent(nullptr));
      const double t3 = NowMs();
      up += t3 - t2;
      Packets packets;
      EncodeOne(*s.enc, &s.first, &packets);
      en += NowMs() - t3;
      if (i == 0 && !packets.empty()) stats_.latency.Add(NowMs() - tick_start_);
      Account(i, packets);
    }
    stats_.upload.Add(up);
    stats_.enc.Add(en);
  }

 private:
  struct Slot {
    Layer layer;
    std::unique_ptr<NvEncoderCuda> enc;
    I420 buf;
    bool first = true;
  };
  void Account(size_t i, const Packets& packets) {
    stats_.CountFrame(i);
    for (const auto& p : packets) {
      stats_.CountPacket(i, p.size());
      if (i == 0 && out_) std::fwrite(p.data(), 1, p.size(), out_);
    }
  }
  Duplicator& cap_;
  Stats& stats_;
  FILE* out_;
  CUcontext cu_ = nullptr;
  std::vector<Slot> slots_;
  ComPtr<ID3D11Texture2D> staging_;
  std::vector<uint8_t> bgra_;
  I420 src_;
  int src_w_ = 0, src_h_ = 0;
  bool fresh_ = false;
  double tick_start_ = 0;
};

// ---------------------------------------------------------------------------------------------
// gpu: кадр не покидает видеокарту.

class GpuPipeline : public Pipeline {
 public:
  GpuPipeline(Duplicator& cap, const std::vector<Layer>& layers, bool main_profile, Stats& st,
              FILE* out, int depth, bool shared)
      : cap_(cap), stats_(st), out_(out), shared_(shared) {
    // `--shared` — как в приложении (#207, 4.1): у кодировщика своё устройство на той же карте,
    // кадр приходит общей текстурой (NT-хэндл + keyed mutex). Иначе — одно устройство на всё.
    edev_ = cap_.device;
    ectx_ = cap_.ctx;
    if (shared_) {
      const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      edev_.Reset();
      ectx_.Reset();
      Check(D3D11CreateDevice(cap_.adapter(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                              D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                              levels, 2, D3D11_SDK_VERSION, &edev_, nullptr, &ectx_),
            "D3D11CreateDevice (кодировщик)");
    }
    if (FAILED(edev_.As(&vdev_)) || FAILED(ectx_.As(&vctx_))) {
      throw std::runtime_error("у устройства D3D11 нет видеопроцессора");
    }
    for (const Layer& l : layers) {
      Slot s;
      s.layer = l;
      s.enc = std::make_unique<NvEncoderD3D11Tex>(edev_.Get(), l.w, l.h,
                                                  NV_ENC_BUFFER_FORMAT_NV12, uint32_t(depth));
      InitEncoder(*s.enc, l, NV_ENC_BUFFER_FORMAT_NV12, main_profile);
      slots_.push_back(std::move(s));
    }
  }
  ~GpuPipeline() override {
    for (Slot& s : slots_) s.enc->DestroyEncoder();
  }

  void Grab(ID3D11Texture2D* desktop) override {
    if (!copy_) {
      D3D11_TEXTURE2D_DESC d;
      desktop->GetDesc(&d);
      if (d.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
        throw std::runtime_error("рабочий стол не в BGRA (включён HDR?) — замер его не умеет");
      }
      d.Usage = D3D11_USAGE_DEFAULT;
      d.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      d.CPUAccessFlags = 0;
      d.MiscFlags = shared_ ? D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX : 0;
      Check(cap_.device->CreateTexture2D(&d, nullptr, &copy_), "CreateTexture2D (копия кадра)");
      src_ = copy_;
      if (shared_) {
        ComPtr<IDXGIResource1> r;
        Check(copy_.As(&r), "IDXGIResource1");
        Check(r->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                                    nullptr, &handle_),
              "CreateSharedHandle");
        ComPtr<ID3D11Device1> dev1;
        Check(edev_.As(&dev1), "ID3D11Device1");
        src_.Reset();
        Check(dev1->OpenSharedResource1(handle_, IID_PPV_ARGS(&src_)), "OpenSharedResource1");
        Check(copy_.As(&cap_mutex_), "IDXGIKeyedMutex (захват)");
        Check(src_.As(&enc_mutex_), "IDXGIKeyedMutex (кодировщик)");
      }
      for (Slot& s : slots_) SetupProcessor(s, int(d.Width), int(d.Height));
    }
    // Своя копия, чтобы сразу отпустить кадр DXGI (как Sunshine), — копия внутри видеопамяти.
    if (shared_) Check(cap_mutex_->AcquireSync(0, 100), "AcquireSync (захват)");
    cap_.ctx->CopyResource(copy_.Get(), desktop);
    if (shared_) {
      cap_.ctx->Flush();
      Check(cap_mutex_->ReleaseSync(0), "ReleaseSync (захват)");
    }
  }

  void Process(const std::vector<bool>& due, GpuTimer& timer) override {
    const double t0 = NowMs();
    if (shared_) Check(enc_mutex_->AcquireSync(0, 500), "AcquireSync (кодировщик)");
    for (size_t i = 0; i < slots_.size(); ++i) {
      if (!due[i]) continue;
      Slot& s = slots_[i];
      ID3D11Texture2D* dst = NvEncoderD3D11Tex::Texture(s.enc->GetNextInputFrame());
      ComPtr<ID3D11VideoProcessorOutputView>& view = s.views[dst];
      if (!view) {
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC vd = {};
        vd.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
        if (FAILED(vdev_->CreateVideoProcessorOutputView(dst, s.vpe.Get(), &vd, &view))) {
          throw std::runtime_error("не создать выход видеопроцессора в NV12");
        }
      }
      D3D11_VIDEO_PROCESSOR_STREAM stream = {};
      stream.Enable = TRUE;
      stream.pInputSurface = s.in.Get();
      Check(vctx_->VideoProcessorBlt(s.vp.Get(), view.Get(), 0, 1, &stream), "VideoProcessorBlt");
    }
    if (shared_) Check(enc_mutex_->ReleaseSync(0), "ReleaseSync (кодировщик)");
    timer.End(cap_.ctx.Get());
    // 🔴 Отправить команды видеокарте ДО кодирования. D3D11 копит их в буфере, пока его ничто не
    // вытолкнет, а NVENC-сессия этот буфер сама не выталкивает: без Flush кодировщик читал бы
    // текстуру, в которую перевод ещё не записан (метки времени показывали ровно один кадр задержки).
    ectx_->Flush();
    stats_.prep.Add(NowMs() - t0);
    stats_.upload.Add(0);  // загрузки нет: кадр уже в видеопамяти

    double en = 0;
    for (size_t i = 0; i < slots_.size(); ++i) {
      if (!due[i]) continue;
      Slot& s = slots_[i];
      const double t1 = NowMs();
      Packets packets;
      s.sent.push_back(t0);
      EncodeOne(*s.enc, &s.first, &packets);
      const double t2 = NowMs();
      en += t2 - t1;
      // При конвейере пакеты приходят за кадры на `depth` раньше — задержку считаем по их отправке.
      for (size_t k = 0; k < packets.size() && !s.sent.empty(); ++k) {
        if (i == 0) stats_.latency.Add(t2 - s.sent.front());
        s.sent.pop_front();
        stats_.CountFrame(i);
      }
      for (const auto& p : packets) {
        stats_.CountPacket(i, p.size());
        if (i == 0 && out_) std::fwrite(p.data(), 1, p.size(), out_);
      }
    }
    stats_.enc.Add(en);
  }

 private:
  struct Slot {
    Layer layer{};
    std::unique_ptr<NvEncoderD3D11Tex> enc;
    ComPtr<ID3D11VideoProcessorEnumerator> vpe;
    ComPtr<ID3D11VideoProcessor> vp;
    ComPtr<ID3D11VideoProcessorInputView> in;
    std::map<ID3D11Texture2D*, ComPtr<ID3D11VideoProcessorOutputView>> views;
    std::deque<double> sent;  // когда ушли кадры, чьи пакеты ещё не вернулись
    bool first = true;
  };

  static void Check(HRESULT hr, const char* what) {
    if (FAILED(hr)) {
      char b[160];
      std::snprintf(b, sizeof b, "%s: 0x%08lx", what, static_cast<unsigned long>(hr));
      throw std::runtime_error(b);
    }
  }

  void SetupProcessor(Slot& s, int src_w, int src_h) {
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd = {};
    cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    cd.InputFrameRate = {UINT(s.layer.fps), 1};
    cd.InputWidth = UINT(src_w);
    cd.InputHeight = UINT(src_h);
    cd.OutputFrameRate = {UINT(s.layer.fps), 1};
    cd.OutputWidth = UINT(s.layer.w);
    cd.OutputHeight = UINT(s.layer.h);
    cd.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
    if (FAILED(vdev_->CreateVideoProcessorEnumerator(&cd, &s.vpe))) {
      throw std::runtime_error("CreateVideoProcessorEnumerator не удался");
    }
    UINT flags = 0;
    s.vpe->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &flags);
    if (!(flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
      throw std::runtime_error("видеопроцессор не пишет NV12");
    }
    if (FAILED(vdev_->CreateVideoProcessor(s.vpe.Get(), 0, &s.vp))) {
      throw std::runtime_error("CreateVideoProcessor не удался");
    }
    // Цвет как у libyuv `ARGBToI420` в приложении: BT.601, диапазон 16–235 — чтобы картинки двух
    // режимов совпадали и сравнивались на глаз.
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE in_cs = {};
    in_cs.RGB_Range = 0;  // 0–255
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE out_cs = {};
    out_cs.YCbCr_Matrix = 0;  // BT.601
    out_cs.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    vctx_->VideoProcessorSetStreamColorSpace(s.vp.Get(), 0, &in_cs);
    vctx_->VideoProcessorSetOutputColorSpace(s.vp.Get(), &out_cs);
    vctx_->VideoProcessorSetStreamFrameFormat(s.vp.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    vctx_->VideoProcessorSetStreamAutoProcessingMode(s.vp.Get(), 0, FALSE);
    const RECT src_rect = {0, 0, src_w, src_h};
    const RECT dst_rect = {0, 0, s.layer.w, s.layer.h};
    vctx_->VideoProcessorSetStreamSourceRect(s.vp.Get(), 0, TRUE, &src_rect);
    vctx_->VideoProcessorSetStreamDestRect(s.vp.Get(), 0, TRUE, &dst_rect);
    vctx_->VideoProcessorSetOutputTargetRect(s.vp.Get(), TRUE, &dst_rect);
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd = {};
    ivd.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    Check(vdev_->CreateVideoProcessorInputView(src_.Get(), s.vpe.Get(), &ivd, &s.in),
          "CreateVideoProcessorInputView");
  }

  Duplicator& cap_;
  Stats& stats_;
  FILE* out_;
  ComPtr<ID3D11VideoDevice> vdev_;
  ComPtr<ID3D11VideoContext> vctx_;
  ComPtr<ID3D11Texture2D> copy_;  // на устройстве захвата
  ComPtr<ID3D11Texture2D> src_;   // та же текстура на устройстве кодировщика (или она же)
  std::vector<Slot> slots_;
  bool shared_;
  ComPtr<ID3D11Device> edev_;
  ComPtr<ID3D11DeviceContext> ectx_;
  HANDLE handle_ = nullptr;
  ComPtr<IDXGIKeyedMutex> cap_mutex_, enc_mutex_;
};

// ---------------------------------------------------------------------------------------------

void PrintRow(const char* name, const Series& s) {
  std::printf("  %-26s %7.2f %7.2f %7.2f %7.2f %7.2f\n", name, s.Avg(), s.Q(0.5), s.Q(0.95),
              s.Q(0.99), s.all.empty() ? 0 : *std::max_element(s.all.begin(), s.all.end()));
}

std::string JsonSeries(const Series& s) {
  char b[256];
  std::snprintf(b, sizeof b, "{\"avg\":%.3f,\"p50\":%.3f,\"p95\":%.3f,\"p99\":%.3f,\"max\":%.3f}",
                s.Avg(), s.Q(0.5), s.Q(0.95), s.Q(0.99),
                s.all.empty() ? 0 : *std::max_element(s.all.begin(), s.all.end()));
  return b;
}

BOOL WINAPI OnCtrl(DWORD) {
  g_stop = true;
  return TRUE;
}

}  // namespace

int main(int argc, char** argv) {
  SetConsoleOutputCP(CP_UTF8);
  // `DuplicateOutput1` работает только в процессе с DPI-осознанностью per-monitor (у Tauri так).
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  Args a;
  if (!ParseArgs(argc, argv, &a)) {
    Usage();
    return 2;
  }
  SetConsoleCtrlHandler(OnCtrl, TRUE);
  if (a.list) {
    ListMonitors();
    return 0;
  }

  const bool uses_cap = a.mode != "idle";
  const bool encodes = a.mode == "cpu" || a.mode == "gpu";
  Duplicator cap;
  if (uses_cap && !cap.Init(a.monitor)) return 1;
  int fw = cap.width, fh = cap.height;
  if (a.max_w > 0 && a.max_h > 0 && (fw > a.max_w || fh > a.max_h)) {
    // Как `target_dims` в screenshare.rs: вписать с сохранением пропорций, только вниз.
    const double s = std::min(double(a.max_w) / fw, double(a.max_h) / fh);
    fw = int(fw * s), fh = int(fh * s);
  }
  fw = std::max(2, fw & ~1), fh = std::max(2, fh & ~1);
  const int kbps = a.kbps > 0 ? a.kbps : 12880;
  const std::vector<Layer> layers =
      encodes ? MakeLayers(fw, fh, a.fps, kbps, a.layers) : std::vector<Layer>{};

  std::printf("Режим %s%s, конвейер %d, экран %dx%d, %d к/с, %d с. Слои:", a.mode.c_str(),
              a.engines ? "" : " (без опроса GPU Engine)", a.mode == "gpu" ? a.depth : 0, cap.width,
              cap.height, a.fps, a.seconds);
  for (const Layer& l : layers) {
    std::printf("  %s %dx%d@%d %dк", l.rid, l.w, l.h, l.fps, l.kbps);
  }
  std::printf("\n");

  FILE* out = a.out.empty() ? nullptr : std::fopen(a.out.c_str(), "wb");
  Stats st;
  st.frames.assign(layers.size(), 0), st.bytes.assign(layers.size(), 0);
  st.sec_frames.assign(layers.size(), 0), st.sec_bytes.assign(layers.size(), 0);

  std::unique_ptr<Pipeline> pipe;
  try {
    if (a.mode == "cpu") pipe = std::make_unique<CpuPipeline>(cap, layers, a.main_profile, st, out);
    else if (a.mode == "gpu") {
      pipe = std::make_unique<GpuPipeline>(cap, layers, a.main_profile, st, out, a.depth, a.shared);
    }
  } catch (const std::exception& e) {
    std::fprintf(stderr, "Не запустился: %s\n", e.what());
    return 1;
  }

  GpuTimer timer(cap.device.Get(), a.mode == "gpu");
  GpuEngines engines;
  const bool have_engines = a.engines && engines.Init();
  std::vector<DWORD> game = FindPids(a.game);
  if (!a.game.empty() && game.empty()) std::printf("⚠️ Процесс %s не найден\n", a.game.c_str());

  HANDLE wait = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                       TIMER_ALL_ACCESS);
  if (!wait) wait = CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS);
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  const int cpus = int(si.dwNumberOfProcessors);

  const double frame_ms = 1000.0 / a.fps;
  const double start = NowMs();
  double next = start, sec_start = start, sec_cpu = ProcessCpuMs();
  double rec_start = 0, rec_cpu = 0;
  long long tick = 0, late = 0, fresh = 0, secs = 0;
  bool have_frame = false;
  EngineLoad ours_sum, game_sum;
  int engine_samples = 0;

  try {
    while (!g_stop && NowMs() - start < a.seconds * 1000.0) {
      const double t_tick = NowMs();
      if (!g_record && t_tick - start >= kWarmupMs) {
        g_record = true;
        rec_start = t_tick, rec_cpu = ProcessCpuMs();
      }
      std::vector<bool> due(layers.size());
      for (size_t i = 0; i < layers.size(); ++i) due[i] = tick % layers[i].every == 0;

      if (uses_cap) {
        ComPtr<ID3D11Texture2D> desktop;
        const Duplicator::Got got = cap.Acquire(&desktop);
        timer.Begin(cap.ctx.Get());  // только наша копия и перевод, без внутренностей DXGI
        if (got == Duplicator::Got::kNew) {
          if (pipe) pipe->Grab(desktop.Get());
          have_frame = true;
          if (g_record) ++fresh;
        }
        if (got == Duplicator::Got::kNew || got == Duplicator::Got::kNoImage) cap.Release();
        if (pipe && have_frame) pipe->Process(due, timer);
        else timer.End(cap.ctx.Get());
      }
      st.tick.Add(NowMs() - t_tick);

      ++tick;
      next += frame_ms;
      const double rem = next - NowMs();
      if (rem > 0) {
        LARGE_INTEGER due_time;
        due_time.QuadPart = -static_cast<LONGLONG>(rem * 10000.0);
        SetWaitableTimerEx(wait, &due_time, 0, nullptr, nullptr, nullptr, 0);
        WaitForSingleObject(wait, INFINITE);
      } else {
        // Отстаём — долг не копим, как приложение.
        if (g_record) ++late;
        next = NowMs();
      }

      const double now = NowMs();
      if (now - sec_start >= 1000.0) {
        const double cpu_now = ProcessCpuMs();
        const double core_pct = (cpu_now - sec_cpu) / (now - sec_start) * 100.0;
        EngineLoad ours, theirs;
        if (have_engines) engines.Sample(GetCurrentProcessId(), game, &ours, &theirs);
        if (g_record) {
          ours_sum.Add(ours), game_sum.Add(theirs);
          ++engine_samples;
        }
        std::printf("[%3.0fс] кадры", (now - start) / 1000.0);
        for (size_t i = 0; i < layers.size(); ++i) {
          std::printf(" %s%lld/%lldк", layers[i].rid, st.sec_frames[i], st.sec_bytes[i] * 8 / 1000);
        }
        std::printf(" | задерж %.1f/%.1f", st.latency.SecAvg(), st.latency.sec_max);
        std::printf(" | забор %.1f/%.1f подг %.1f/%.1f загр %.1f код %.1f/%.1f тик %.1f/%.1f мс"
                    " | ядро %.1f%% | GPU наш 3D %.1f коп %.1f NVENC %.1f",
                    st.grab.SecAvg(), st.grab.sec_max, st.prep.SecAvg(), st.prep.sec_max,
                    st.upload.SecAvg(), st.enc.SecAvg(), st.enc.sec_max, st.tick.SecAvg(),
                    st.tick.sec_max, core_pct, ours.d3, ours.copy, ours.venc);
        if (!game.empty()) std::printf(" | игра 3D %.1f", theirs.d3);
        std::printf("\n");
        for (Series* s : {&st.grab, &st.prep, &st.upload, &st.enc, &st.tick, &st.latency, &timer.ms}) {
          s->ResetSec();
        }
        std::fill(st.sec_frames.begin(), st.sec_frames.end(), 0);
        std::fill(st.sec_bytes.begin(), st.sec_bytes.end(), 0);
        sec_start = now, sec_cpu = cpu_now;
        if (++secs % 5 == 0 && !a.game.empty()) game = FindPids(a.game);  // игру могли перезапустить
      }
    }
  } catch (const std::exception& e) {
    std::fprintf(stderr, "Упал на тике %lld: %s\n", tick, e.what());
    return 1;
  }

  const double rec_ms = std::max(1.0, NowMs() - rec_start);
  const double core_pct = (ProcessCpuMs() - rec_cpu) / rec_ms * 100.0;
  const double n = std::max(1, engine_samples);
  pipe.reset();
  if (out) std::fclose(out);

  std::printf("\n=== Итог: режим %s, без первых %.0f с ===\n", a.mode.c_str(), kWarmupMs / 1000);
  for (size_t i = 0; i < layers.size(); ++i) {
    std::printf("  слой %s %dx%d: %.1f к/с из %d, %.0f кбит/с из %d\n", layers[i].rid, layers[i].w,
                layers[i].h, st.frames[i] * 1000.0 / rec_ms, layers[i].fps,
                st.bytes[i] * 8.0 / rec_ms, layers[i].kbps);
  }
  std::printf("  новых кадров с экрана: %.1f/с; опоздавших тиков: %lld; потерь захвата: %d\n",
              fresh * 1000.0 / rec_ms, late, cap.lost);
  std::printf("  %-26s %7s %7s %7s %7s %7s  (мс)\n", "стадия", "сред", "p50", "p95", "p99", "макс");
  PrintRow("забор в оперативку", st.grab);
  PrintRow("подготовка (процессор)", st.prep);
  PrintRow("загрузка в видеокарту", st.upload);
  PrintRow("кодирование (все слои)", st.enc);
  PrintRow("тик целиком", st.tick);
  PrintRow("задержка кадра (полный слой)", st.latency);
  if (a.mode == "gpu") PrintRow("наш D3D11 на видеокарте", timer.ms);
  std::printf("  процессор: %.1f%% одного ядра (%.2f%% машины из %d потоков)\n", core_pct,
              core_pct / cpus, cpus);
  std::printf("  видеокарта, наш процесс: 3D %.1f%%, копирование %.1f%%, NVENC %.1f%%, прочее %.1f%%\n",
              ours_sum.d3 / n, ours_sum.copy / n, ours_sum.venc / n, ours_sum.other / n);
  if (!a.game.empty()) std::printf("  видеокарта, игра: 3D %.1f%%\n", game_sum.d3 / n);
  if (a.mode == "cpu") {
    std::printf("  ⚠️ В приложении забор+перевод и кодирование идут в ДВУХ потоках, здесь в одном: опоздания\n"
                "     в режиме cpu хуже, чем в приложении. Сравнивать процессор, стадии и видеокарту.\n");
  }

  std::string j = "{\"mode\":\"" + a.mode + "\",\"depth\":" + std::to_string(a.mode == "gpu" ? a.depth : 0) +
                  ",\"engines\":" + (a.engines ? "true" : "false") +
                  ",\"src\":\"" + std::to_string(cap.width) + "x" +
                  std::to_string(cap.height) + "\",\"fps\":" + std::to_string(a.fps) + ",\"layers\":[";
  for (size_t i = 0; i < layers.size(); ++i) {
    char b[200];
    std::snprintf(b, sizeof b, "%s{\"rid\":\"%s\",\"w\":%d,\"h\":%d,\"fps\":%.2f,\"kbps\":%.0f}",
                  i ? "," : "", layers[i].rid, layers[i].w, layers[i].h,
                  st.frames[i] * 1000.0 / rec_ms, st.bytes[i] * 8.0 / rec_ms);
    j += b;
  }
  char tail[512];
  std::snprintf(tail, sizeof tail,
                "],\"fresh_fps\":%.2f,\"late\":%lld,\"lost\":%d,\"cpu_core_pct\":%.2f,\"cpus\":%d,"
                "\"gpu_ours\":{\"3d\":%.2f,\"copy\":%.2f,\"venc\":%.2f,\"other\":%.2f},"
                "\"gpu_game_3d\":%.2f,",
                fresh * 1000.0 / rec_ms, late, cap.lost, core_pct, cpus, ours_sum.d3 / n,
                ours_sum.copy / n, ours_sum.venc / n, ours_sum.other / n, game_sum.d3 / n);
  j += tail;
  j += "\"grab_ms\":" + JsonSeries(st.grab) + ",\"prep_ms\":" + JsonSeries(st.prep) +
       ",\"upload_ms\":" + JsonSeries(st.upload) + ",\"enc_ms\":" + JsonSeries(st.enc) +
       ",\"tick_ms\":" + JsonSeries(st.tick) + ",\"latency_ms\":" + JsonSeries(st.latency) +
       ",\"gpu_d3d_ms\":" + JsonSeries(timer.ms) + "}";
  std::printf("\n%s\n", j.c_str());
  if (!a.json.empty()) {
    if (FILE* f = std::fopen(a.json.c_str(), "wb")) {
      std::fwrite(j.data(), 1, j.size(), f);
      std::fclose(f);
    }
  }
  return 0;
}
