/*
 * Copyright 2025 LiveKit, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "livekit/peer_connection.h"
#include "livekit/peer_connection_factory.h"

#include <algorithm>
#include <atomic>
#include <memory>

#include "api/data_channel_interface.h"
#include "api/field_trials_view.h"
#include "api/peer_connection_interface.h"
#include "api/scoped_refptr.h"
#include "livekit/candidate.h"
#include "livekit/data_channel.h"
#include "livekit/gv_bitrate_hint.h"
#include "livekit/jsep.h"
#include "livekit/media_stream.h"
#include "livekit/rtc_error.h"
#include "livekit/rtp_transceiver.h"
#include "rtc_base/logging.h"

#if defined(USE_NVIDIA_VIDEO_CODEC)
#include "nvidia/nvidia_encoder_factory.h"
#endif

namespace livekit_ffi {

webrtc::PeerConnectionInterface::RTCConfiguration to_native_rtc_configuration(
    RtcConfiguration config) {
  webrtc::PeerConnectionInterface::RTCConfiguration rtc_config{};

  for (auto item : config.ice_servers) {
    webrtc::PeerConnectionInterface::IceServer ice_server;
    ice_server.username = item.username.c_str();
    ice_server.password = item.password.c_str();

    for (auto url : item.urls)
      ice_server.urls.emplace_back(url.c_str());

    rtc_config.servers.push_back(ice_server);
  }

  rtc_config.continual_gathering_policy =
      static_cast<webrtc::PeerConnectionInterface::ContinualGatheringPolicy>(
          config.continual_gathering_policy);

  rtc_config.type =
      static_cast<webrtc::PeerConnectionInterface::IceTransportsType>(
          config.ice_transport_type);

#if defined(USE_NVIDIA_VIDEO_CODEC)
  // GusVoice (#207 loss #2, #111): no CPU-overuse adaptation when NVENC encodes. The overuse
  // detector measures WALL time from frame-in to last-layer-out, so waiting for a GPU busy with a
  // game reads as "CPU overuse" and the screen share is throttled to a few fps while the CPU idles
  // (telemetry: limitation=cpu at CPU 23 %). With hardware encoding the CPU is not the bottleneck.
  // Without NVENC (software OpenH264 / libvpx) the adaptation stays ON — there it is real.
  // The probe is cached: it opens a CUDA context and an NVENC session once per process.
  static const bool kNvenc = webrtc::NvidiaVideoEncoderFactory::IsSupported();
  if (kNvenc) {
    rtc_config.set_cpu_adaptation(false);
  }
#endif

  return rtc_config;
}

inline webrtc::PeerConnectionInterface::RTCOfferAnswerOptions
to_native_offer_answer_options(const RtcOfferAnswerOptions& options) {
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions rtc_options;
  rtc_options.offer_to_receive_video = options.offer_to_receive_video;
  rtc_options.offer_to_receive_audio = options.offer_to_receive_audio;
  rtc_options.voice_activity_detection = options.voice_activity_detection;
  rtc_options.ice_restart = options.ice_restart;
  rtc_options.use_rtp_mux = options.use_rtp_mux;
  rtc_options.raw_packetization_for_video = options.raw_packetization_for_video;
  rtc_options.num_simulcast_layers = options.num_simulcast_layers;
  rtc_options.use_obsolete_sctp_sdp = options.use_obsolete_sctp_sdp;
  return rtc_options;
}

}  // namespace livekit_ffi

// GusVoice (#207): подсказка оценщику канала — см. livekit/gv_bitrate_hint.h.
namespace livekit {
namespace {
std::atomic<int32_t> g_hint_start_bps{0};
std::atomic<int32_t> g_hint_min_bps{0};
}  // namespace

void SetBitrateHint(int32_t start_bps, int32_t min_bps) {
  g_hint_start_bps.store(start_bps, std::memory_order_relaxed);
  g_hint_min_bps.store(min_bps, std::memory_order_relaxed);
}

int32_t BitrateHintStart() {
  return g_hint_start_bps.load(std::memory_order_relaxed);
}

int32_t BitrateHintMin() {
  return g_hint_min_bps.load(std::memory_order_relaxed);
}

// GusVoice (#207, 06.10): множитель опорного кадра NVENC для показа — см. livekit/gv_bitrate_hint.h.
// Здесь, а не в кодировщике: тот собирается только с NVENC, а мост из Rust есть в любой сборке.
namespace {
std::atomic<int32_t> g_enc_keyframe_scale{0};
}  // namespace

void SetScreenEncoderKeyframeScale(int32_t keyframe_scale) {
  g_enc_keyframe_scale.store(keyframe_scale, std::memory_order_relaxed);
}

int32_t ScreenEncoderKeyframeScale() {
  return g_enc_keyframe_scale.load(std::memory_order_relaxed);
}
}  // namespace livekit

namespace livekit_ffi {

namespace {
// GusVoice (#207, 06.10): полевые испытания соединений нативного показа — см. `Initialize`. Класса
// `webrtc::FieldTrials` в готовом libwebrtc нет (`api/field_trials.cc` в сборку не вошёл, ссылка не
// линкуется), поэтому — простой ответ по имени испытания. Остальные имена — пусто, то есть умолчания
// libwebrtc: глобальной строки испытаний в приложении никто не ставит.
class GvFieldTrials : public webrtc::FieldTrialsView {
 public:
  std::string Lookup(absl::string_view key) const override {
    // Значение — часть строки испытания после имени: «WebRTC-Bwe-ProbingConfiguration/<это>/».
    if (key == "WebRTC-Bwe-ProbingConfiguration") return "alr_interval:2s";
    return "";
  }
  std::unique_ptr<webrtc::FieldTrialsView> CreateCopy() const override {
    return std::make_unique<GvFieldTrials>();
  }
};
}  // namespace

PeerConnection::PeerConnection(
    std::shared_ptr<RtcRuntime> rtc_runtime,
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> pc_factory,
    rust::Box<PeerConnectionObserverWrapper> observer)
    : rtc_runtime_(std::move(rtc_runtime)),
      pc_factory_(std::move(pc_factory)),
      observer_(std::move(observer)) {
  RTC_LOG(LS_VERBOSE) << "PeerConnection::PeerConnection()";
}

PeerConnection::~PeerConnection() {
  RTC_LOG(LS_VERBOSE) << "PeerConnection::~PeerConnection()";
}

bool PeerConnection::Initialize(
    webrtc::PeerConnectionInterface::RTCConfiguration config) {
  webrtc::PeerConnectionDependencies deps{this};
  // GusVoice (#207, 06.10): проба канала на статике чаще. Через этот WebRTC в приложении идёт только
  // нативный показ экрана (голос и веб-показ живут в WebView со своим WebRTC), а своих полевых
  // испытаний у фабрики нет — так что строка ниже заменяет пустоту, а не чужие настройки.
  //
  // Для экрана (`is_screencast`) libwebrtc сам включает периодическую пробу канала в «простое» (ALR,
  // `WebRTC-ProbingScreenshareBwe`, по умолчанию включён): когда кодировщику нечего слать (таблица,
  // рабочий стол), оценке не на чем расти, и раз в `alr_interval` идёт короткая проба на удвоенную
  // оценку — с продолжением, пока канал отвечает. По умолчанию раз в 5 с: после просадки на статике
  // картинка дотягивалась долго. 2 с — чаще, но проба короткая (от 15 мс), выше суммарного потолка
  // слоёв не идёт, а на высоте оценки её нет вовсе.
  deps.trials = std::make_unique<GvFieldTrials>();
  auto result =
      pc_factory_->CreatePeerConnectionOrError(config, std::move(deps));

  if (!result.ok()) {
    RTC_LOG(LS_ERROR) << "Failed to create peer connection: "
                      << result.error().message();
    return false;
  }
  peer_connection_ = std::move(result.value());

  // GusVoice (#207): стартовый битрейт и нижняя граница оценщика для показа экрана, если Rust
  // их выставил (livekit/gv_bitrate_hint.h). Без них GCC стартует с 300 кбит/с.
  const int32_t hint_min = livekit::BitrateHintMin();
  const int32_t hint_start = livekit::BitrateHintStart();
  if (hint_min > 0 || hint_start > 0) {
    webrtc::BitrateSettings bitrate;
    if (hint_min > 0) bitrate.min_bitrate_bps = hint_min;
    if (hint_start > 0) bitrate.start_bitrate_bps = std::max(hint_start, hint_min);
    const webrtc::RTCError err = peer_connection_->SetBitrate(bitrate);
    RTC_LOG(LS_INFO) << "GusVoice bitrate hint: start=" << hint_start << " min=" << hint_min
                     << (err.ok() ? "" : " (SetBitrate failed)");
  }
  return true;
}

void PeerConnection::set_configuration(RtcConfiguration config) const {
  auto result =
      peer_connection_->SetConfiguration(to_native_rtc_configuration(config));

  if (!result.ok()) {
    throw std::runtime_error(serialize_error(to_error(result)));
  }
}

void PeerConnection::create_offer(
    RtcOfferAnswerOptions options,
    rust::Box<PeerContext> ctx,
    rust::Fn<void(rust::Box<PeerContext>, std::unique_ptr<SessionDescription>)>
        on_success,
    rust::Fn<void(rust::Box<PeerContext>, RtcError)> on_error) const {
  webrtc::scoped_refptr<NativeCreateSdpObserver> observer =
      webrtc::make_ref_counted<NativeCreateSdpObserver>(std::move(ctx), on_success,
                                                     on_error);

  peer_connection_->CreateOffer(observer.get(),
                                to_native_offer_answer_options(options));
}

void PeerConnection::create_answer(
    RtcOfferAnswerOptions options,
    rust::Box<PeerContext> ctx,
    rust::Fn<void(rust::Box<PeerContext>, std::unique_ptr<SessionDescription>)>
        on_success,
    rust::Fn<void(rust::Box<PeerContext>, RtcError)> on_error) const {
  webrtc::scoped_refptr<NativeCreateSdpObserver> observer =
      webrtc::make_ref_counted<NativeCreateSdpObserver>(std::move(ctx), on_success,
                                                     on_error);

  peer_connection_->CreateAnswer(observer.get(),
                                 to_native_offer_answer_options(options));
}

void PeerConnection::set_local_description(
    std::unique_ptr<SessionDescription> desc,
    rust::Box<PeerContext> ctx,
    rust::Fn<void(rust::Box<PeerContext>, RtcError)> on_complete) const {
  webrtc::scoped_refptr<NativeSetLocalSdpObserver> observer =
      webrtc::make_ref_counted<NativeSetLocalSdpObserver>(std::move(ctx),
                                                       on_complete);

  peer_connection_->SetLocalDescription(desc->clone()->release(), observer);
}

void PeerConnection::set_remote_description(
    std::unique_ptr<SessionDescription> desc,
    rust::Box<PeerContext> ctx,
    rust::Fn<void(rust::Box<PeerContext>, RtcError)> on_complete) const {
  webrtc::scoped_refptr<NativeSetRemoteSdpObserver> observer =
      webrtc::make_ref_counted<NativeSetRemoteSdpObserver>(std::move(ctx),
                                                        on_complete);

  peer_connection_->SetRemoteDescription(desc->clone()->release(), observer);
}

void PeerConnection::restart_ice() const {
  peer_connection_->RestartIce();
}

void PeerConnection::add_ice_candidate(
    std::shared_ptr<IceCandidate> candidate,
    rust::Box<PeerContext> ctx,
    rust::Fn<void(rust::Box<PeerContext>, RtcError)> on_complete) const {
  peer_connection_->AddIceCandidate(
      candidate->release(), [&](const webrtc::RTCError& err) {
        on_complete(std::move(ctx), to_error(err));
      });
}

std::shared_ptr<DataChannel> PeerConnection::create_data_channel(
    rust::String label,
    DataChannelInit init) const {
  webrtc::DataChannelInit rtc_init = to_native_data_channel_init(init);
  auto result =
      peer_connection_->CreateDataChannelOrError(label.c_str(), &rtc_init);

  if (!result.ok()) {
    throw std::runtime_error(serialize_error(to_error(result.error())));
  }

  return std::make_shared<DataChannel>(rtc_runtime_, result.value());
}

std::shared_ptr<RtpSender> PeerConnection::add_track(
    std::shared_ptr<MediaStreamTrack> track,
    const rust::Vec<rust::String>& stream_ids) const {
  std::vector<std::string> std_stream_ids(stream_ids.begin(), stream_ids.end());
  auto result = peer_connection_->AddTrack(track->rtc_track(), std_stream_ids);
  if (!result.ok()) {
    throw std::runtime_error(serialize_error(to_error(result.error())));
  }

  return std::make_shared<RtpSender>(rtc_runtime_, result.value(),
                                     peer_connection_);
}

void PeerConnection::remove_track(std::shared_ptr<RtpSender> sender) const {
  auto error = peer_connection_->RemoveTrackOrError(sender->rtc_sender());
  if (!error.ok())
    throw std::runtime_error(serialize_error(to_error(error)));
}

void PeerConnection::get_stats(
    rust::Box<PeerContext> ctx,
    rust::Fn<void(rust::Box<PeerContext>, rust::String)> on_stats) const {
  auto observer = webrtc::make_ref_counted<NativeRtcStatsCollector<PeerContext>>(
      std::move(ctx), on_stats);
  peer_connection_->GetStats(observer.get());
}

std::shared_ptr<RtpTransceiver> PeerConnection::add_transceiver(
    std::shared_ptr<MediaStreamTrack> track,
    RtpTransceiverInit init) const {
  auto result = peer_connection_->AddTransceiver(
      track->rtc_track(), to_native_rtp_transceiver_init(init));
  if (!result.ok())
    throw std::runtime_error(serialize_error(to_error(result.error())));

  return std::make_shared<RtpTransceiver>(rtc_runtime_, result.value(),
                                          peer_connection_);
}

std::shared_ptr<RtpTransceiver> PeerConnection::add_transceiver_for_media(
    MediaType media_type,
    RtpTransceiverInit init) const {
  auto result = peer_connection_->AddTransceiver(
      static_cast<webrtc::MediaType>(media_type),
      to_native_rtp_transceiver_init(init));

  if (!result.ok())
    throw std::runtime_error(serialize_error(to_error(result.error())));

  return std::make_shared<RtpTransceiver>(rtc_runtime_, result.value(),
                                          peer_connection_);
}

rust::Vec<RtpSenderPtr> PeerConnection::get_senders() const {
  rust::Vec<RtpSenderPtr> vec;
  for (auto sender : peer_connection_->GetSenders())
    vec.push_back(RtpSenderPtr{
        std::make_shared<RtpSender>(rtc_runtime_, sender, peer_connection_)});

  return vec;
}

rust::Vec<RtpReceiverPtr> PeerConnection::get_receivers() const {
  rust::Vec<RtpReceiverPtr> vec;
  for (auto receiver : peer_connection_->GetReceivers())
    vec.push_back(RtpReceiverPtr{std::make_shared<RtpReceiver>(
        rtc_runtime_, receiver, peer_connection_)});

  return vec;
}

rust::Vec<RtpTransceiverPtr> PeerConnection::get_transceivers() const {
  rust::Vec<RtpTransceiverPtr> vec;
  for (auto transceiver : peer_connection_->GetTransceivers())
    vec.push_back(RtpTransceiverPtr{std::make_shared<RtpTransceiver>(
        rtc_runtime_, transceiver, peer_connection_)});

  return vec;
}

std::unique_ptr<SessionDescription> PeerConnection::current_local_description()
    const {
  auto local_description = peer_connection_->current_local_description();
  if (local_description)
    return std::make_unique<SessionDescription>(local_description->Clone());

  return nullptr;
}

std::unique_ptr<SessionDescription> PeerConnection::current_remote_description()
    const {
  auto remote_description = peer_connection_->current_remote_description();
  if (remote_description)
    return std::make_unique<SessionDescription>(remote_description->Clone());

  return nullptr;
}

std::unique_ptr<SessionDescription> PeerConnection::pending_local_description()
    const {
  auto local_description = peer_connection_->pending_local_description();
  if (local_description)
    return std::make_unique<SessionDescription>(local_description->Clone());

  return nullptr;
}

std::unique_ptr<SessionDescription> PeerConnection::pending_remote_description()
    const {
  auto remote_description = peer_connection_->pending_remote_description();
  if (remote_description)
    return std::make_unique<SessionDescription>(remote_description->Clone());

  return nullptr;
}

std::unique_ptr<SessionDescription> PeerConnection::local_description() const {
  auto local_description = peer_connection_->local_description();
  if (local_description)
    return std::make_unique<SessionDescription>(local_description->Clone());

  return nullptr;
}

std::unique_ptr<SessionDescription> PeerConnection::remote_description() const {
  auto remote_description = peer_connection_->remote_description();
  if (remote_description)
    return std::make_unique<SessionDescription>(remote_description->Clone());

  return nullptr;
}

PeerConnectionState PeerConnection::connection_state() const {
  return static_cast<PeerConnectionState>(
      peer_connection_->peer_connection_state());
}

SignalingState PeerConnection::signaling_state() const {
  return static_cast<SignalingState>(peer_connection_->signaling_state());
}

IceGatheringState PeerConnection::ice_gathering_state() const {
  return static_cast<IceGatheringState>(
      peer_connection_->ice_gathering_state());
}

IceConnectionState PeerConnection::ice_connection_state() const {
  return static_cast<IceConnectionState>(
      peer_connection_->ice_connection_state());
}

void PeerConnection::close() const {
  peer_connection_->Close();
}

// PeerConnectionObserver

void PeerConnection::OnSignalingChange(
    webrtc::PeerConnectionInterface::SignalingState new_state) {
  observer_->on_signaling_change(static_cast<SignalingState>(new_state));
}

void PeerConnection::OnAddStream(
    webrtc::scoped_refptr<webrtc::MediaStreamInterface> stream) {
  observer_->on_add_stream(std::make_unique<MediaStream>(rtc_runtime_, stream));
}

void PeerConnection::OnRemoveStream(
    webrtc::scoped_refptr<webrtc::MediaStreamInterface> stream) {
  // Find current MediaStream
  // observer_->on_remove_stream(std::make_unique<MediaStream>(rtc_runtime_,
  // stream));
}

void PeerConnection::OnDataChannel(
    webrtc::scoped_refptr<webrtc::DataChannelInterface> data_channel) {
  observer_->on_data_channel(
      std::make_shared<DataChannel>(rtc_runtime_, data_channel));
}

void PeerConnection::OnRenegotiationNeeded() {
  observer_->on_renegotiation_needed();
}

void PeerConnection::OnNegotiationNeededEvent(uint32_t event_id) {
  observer_->on_negotiation_needed_event(event_id);
}

void PeerConnection::OnIceConnectionChange(
    webrtc::PeerConnectionInterface::IceConnectionState new_state) {
  observer_->on_ice_connection_change(
      static_cast<IceConnectionState>(new_state));
}

void PeerConnection::OnStandardizedIceConnectionChange(
    webrtc::PeerConnectionInterface::IceConnectionState new_state) {
  observer_->on_standardized_ice_connection_change(
      static_cast<IceConnectionState>(new_state));
}

void PeerConnection::OnConnectionChange(
    webrtc::PeerConnectionInterface::PeerConnectionState new_state) {
  observer_->on_connection_change(static_cast<PeerConnectionState>(new_state));
}

void PeerConnection::OnIceGatheringChange(
    webrtc::PeerConnectionInterface::IceGatheringState new_state) {
  observer_->on_ice_gathering_change(static_cast<IceGatheringState>(new_state));
}

void PeerConnection::OnIceCandidate(
    const webrtc::IceCandidate* candidate) {
  auto new_candidate = webrtc::CreateIceCandidate(candidate->sdp_mid(),
                                                  candidate->sdp_mline_index(),
                                                  candidate->candidate());
  observer_->on_ice_candidate(
      std::make_unique<IceCandidate>(std::move(new_candidate)));
}

void PeerConnection::OnIceCandidateError(const std::string& address,
                                         int port,
                                         const std::string& url,
                                         int error_code,
                                         const std::string& error_text) {
  observer_->on_ice_candidate_error(address, port, url, error_code, error_text);
}

void PeerConnection::OnIceCandidateRemoved(const webrtc::IceCandidate* ice_candidate) {
  rust::Vec<CandidatePtr> vec;
  if(ice_candidate != nullptr) {
    vec.push_back(CandidatePtr{std::make_unique<Candidate>(ice_candidate->candidate())});
  }
  observer_->on_ice_candidates_removed(std::move(vec));
}

void PeerConnection::OnIceConnectionReceivingChange(bool receiving) {
  observer_->on_ice_connection_receiving_change(receiving);
}

void PeerConnection::OnIceSelectedCandidatePairChanged(
    const webrtc::CandidatePairChangeEvent& event) {
  CandidatePairChangeEvent e{};
  e.selected_candidate_pair.local =
      std::make_unique<Candidate>(event.selected_candidate_pair.local);
  e.selected_candidate_pair.remote =
      std::make_unique<Candidate>(event.selected_candidate_pair.remote);
  e.last_data_received_ms = event.last_data_received_ms;
  e.reason = event.reason;
  e.estimated_disconnected_time_ms = event.estimated_disconnected_time_ms;

  observer_->on_ice_selected_candidate_pair_changed(std::move(e));
}

void PeerConnection::OnAddTrack(
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver,
    const std::vector<webrtc::scoped_refptr<webrtc::MediaStreamInterface>>&
        streams) {
  rust::Vec<MediaStreamPtr> vec;

  for (const auto& item : streams) {
    vec.push_back(
        MediaStreamPtr{std::make_unique<MediaStream>(rtc_runtime_, item)});
  }

  observer_->on_add_track(
      std::make_unique<RtpReceiver>(rtc_runtime_, receiver, peer_connection_),
      std::move(vec));
}

void PeerConnection::OnTrack(
    webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) {
  observer_->on_track(std::make_unique<RtpTransceiver>(
      rtc_runtime_, transceiver, peer_connection_));
}

void PeerConnection::OnRemoveTrack(
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) {
  observer_->on_remove_track(
      std::make_unique<RtpReceiver>(rtc_runtime_, receiver, peer_connection_));
}

void PeerConnection::OnInterestingUsage(int usage_pattern) {
  observer_->on_interesting_usage(usage_pattern);
}

}  // namespace livekit_ffi
