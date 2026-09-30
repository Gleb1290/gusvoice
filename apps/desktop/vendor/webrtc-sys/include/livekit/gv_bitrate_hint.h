// GusVoice (#207): подсказка оценщику канала WebRTC для показа экрана.
//
// Биты кодировщику раздаёт не провод, а оценка канала WebRTC (GCC): она стартует с 300 кбит/с и
// разгоняется, пока не увидит признаков перегрузки. 26.09 на гигабитной локалке она застряла на
// ~6 Мбит/с, и полный слой получал 3,5 из 12,9 — картинка сыпалась на каждой смене сцены.
//
// Подсказку ставит Rust перед подключением показа (`screenshare.rs`), `PeerConnection::Initialize`
// применяет её к каждому новому соединению через `SetBitrate`. 0 — не трогать.
#pragma once

#include <cstdint>

namespace livekit {

void SetBitrateHint(int32_t start_bps, int32_t min_bps);
int32_t BitrateHintStart();
int32_t BitrateHintMin();

}  // namespace livekit
