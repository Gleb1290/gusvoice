// Правка GusVoice (#207): опорный кадр только на том слое, который его попросил.
//
// Без неё libwebrtc отвечает на запрос опорного кадра (PLI) по ЛЮБОМУ слою опорным кадром на ВСЕХ
// слоях показа. 26.09.2026 один зритель на телефоне с каналом 0,2–0,5 Мбит/с сидел на нижнем слое и
// просил опорный кадр раз в секунду — полный слой отдавал 62 опорных кадра в минуту при 1,7 запросах на
// него самого, и картинка у всех зрителей мутнела и собиралась заново раз в секунду.
//
// libwebrtc умеет иначе (`SupportsPerLayerPictureLossIndication`: его читают `EncoderRtcpFeedback` и
// `SimulcastEncoderAdapter`), но включает это параметром `x-google-per-layer-pli=1` в fmtp кодека,
// который объявляет ПРИНИМАЮЩАЯ сторона. Принимает у нас SFU, и он параметр не шлёт. Поэтому дописываем
// его в видеокодеки ответа SFU перед `set_remote_description`: параметр живёт только в нашем объекте
// соединения, на провод и на сервер он не уходит.

const PARAM: &str = "x-google-per-layer-pli";
const CODECS: [&str; 5] = ["H264", "H265", "VP8", "VP9", "AV1"];

/// Дописать `x-google-per-layer-pli=1` видеокодекам SDP. Остальное — без изменений, байт в байт.
///
/// Трогаются только `m=video`-секции и только полезные нагрузки кодеков из `CODECS`: у служебных
/// (rtx, red, ulpfec) опорного кадра нет. Есть строка `a=fmtp` — параметр дописывается в её конец,
/// нет строки — добавляется сразу после `a=rtpmap` этого кодека. Уже объявленный параметр не трогаем.
pub fn add_per_layer_pli(sdp: &str) -> String {
    let eol = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = sdp.split(eol).collect();

    // Секции: [начало, конец) по строкам `m=`.
    let mut starts: Vec<usize> =
        lines.iter().enumerate().filter(|(_, l)| l.starts_with("m=")).map(|(i, _)| i).collect();
    starts.push(lines.len());

    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 8);
    out.extend(lines[..starts[0]].iter().map(|l| l.to_string()));

    for w in starts.windows(2) {
        let section = &lines[w[0]..w[1]];
        if !section[0].starts_with("m=video") {
            out.extend(section.iter().map(|l| l.to_string()));
            continue;
        }

        let payloads: Vec<&str> = section
            .iter()
            .filter_map(|l| l.strip_prefix("a=rtpmap:"))
            .filter_map(|rest| {
                let (pt, codec) = rest.split_once(' ')?;
                let name = codec.split('/').next()?;
                CODECS.iter().any(|c| c.eq_ignore_ascii_case(name)).then_some(pt)
            })
            .collect();
        let has_fmtp = |pt: &str| {
            section.iter().any(|l| {
                l.strip_prefix("a=fmtp:").and_then(|r| r.split_once(' ')).map(|(p, _)| p) == Some(pt)
            })
        };

        for line in section {
            if let Some((pt, params)) =
                line.strip_prefix("a=fmtp:").and_then(|r| r.split_once(' '))
            {
                if payloads.contains(&pt) && !params.contains(PARAM) {
                    out.push(format!("{line};{PARAM}=1"));
                    continue;
                }
            }
            out.push(line.to_string());
            if let Some(pt) =
                line.strip_prefix("a=rtpmap:").and_then(|r| r.split_once(' ')).map(|(p, _)| p)
            {
                if payloads.contains(&pt) && !has_fmtp(pt) {
                    out.push(format!("a=fmtp:{pt} {PARAM}=1"));
                }
            }
        }
    }
    out.join(eol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn меняет_только_видеокодеки_а_служебные_и_аудио_оставляет() {
        // Ловит параметр у opus/rtx: первый не видео, второй не создаёт опорных кадров.
        let sdp = concat!(
            "v=0\r\n",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
            "a=rtpmap:111 opus/48000/2\r\n",
            "a=fmtp:111 minptime=10\r\n",
            "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\n",
            "a=rtpmap:96 H264/90000\r\n",
            "a=fmtp:96 profile-level-id=42e01f\r\n",
            "a=rtpmap:97 VP8/90000\r\n",
            "a=rtpmap:98 rtx/90000\r\n",
            "a=fmtp:98 apt=96\r\n",
        );
        let out = add_per_layer_pli(sdp);
        assert!(out.contains("a=fmtp:111 minptime=10\r\n"));
        assert!(out.contains("a=fmtp:96 profile-level-id=42e01f;x-google-per-layer-pli=1\r\n"));
        assert!(out.contains("a=rtpmap:97 VP8/90000\r\na=fmtp:97 x-google-per-layer-pli=1\r\n"));
        assert!(out.contains("a=fmtp:98 apt=96\r\n"));
        assert_eq!(out.matches(PARAM).count(), 2);
    }

    #[test]
    fn все_поддержанные_кодеки_без_учёта_регистра_и_повторный_прогон_идемпотентны() {
        // Ловит забытый H265/AV1 и удвоение параметра при повторной установке ответа.
        let sdp = concat!(
            "m=video 9 UDP/TLS/RTP/SAVPF 1 2 3 4 5\n",
            "a=rtpmap:1 h264/90000\n",
            "a=rtpmap:2 H265/90000\n",
            "a=rtpmap:3 vp8/90000\n",
            "a=rtpmap:4 Vp9/90000\n",
            "a=rtpmap:5 av1/90000\n",
            "a=fmtp:5 x-google-per-layer-pli=1\n",
        );
        let once = add_per_layer_pli(sdp);
        assert_eq!(once.matches(PARAM).count(), 5);
        assert_eq!(add_per_layer_pli(&once), once);
        assert!(once.ends_with('\n'));
    }

    #[test]
    fn payload_одной_видеосекции_не_влияет_на_другую() {
        // Ловит общий список payload type, из-за которого совпавший номер менял чужую секцию.
        let sdp = concat!(
            "m=video 9 UDP/TLS/RTP/SAVPF 96\n",
            "a=rtpmap:96 H264/90000\n",
            "m=video 9 UDP/TLS/RTP/SAVPF 96\n",
            "a=rtpmap:96 red/90000\n",
        );
        let out = add_per_layer_pli(sdp);
        assert_eq!(out.matches(PARAM).count(), 1);
        assert!(out.ends_with("a=rtpmap:96 red/90000\n"));
    }
}
