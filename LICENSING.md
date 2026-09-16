# Licensing

GusVoice is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3 only** (SPDX: `AGPL-3.0-only`), as published by the Free Software
Foundation. The full text is in [`LICENSE`](LICENSE).

Copyright (C) 2026 The GusVoice authors.

GusVoice is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

In short: you may run, study, change and share GusVoice. If you run a modified GusVoice as a service for other people,
you must offer those people the source code of your modified version.

## Additional permission under GNU AGPL version 3 section 7

If you modify this Program, or any covered work, by linking or combining it with the NVIDIA Video Codec SDK (or a
modified version of that library), containing parts covered by the terms of the NVIDIA Video Codec SDK License
Agreement, the licensors of this Program grant you additional permission to convey the resulting work.

*Why:* the Windows desktop app encodes screen-share on NVIDIA GPUs (NVENC) through sample code from the NVIDIA Video
Codec SDK, which is compiled into the app. Those files carry NVIDIA's own license terms, which the AGPL alone would not
allow to be combined with it. The permission covers exactly that combination and nothing else; without an NVIDIA GPU the
app falls back to a software encoder.

## Third-party code in this repository

Code written by others keeps its own license. The notable pieces:

| Path | License | Notes |
|---|---|---|
| `apps/desktop/vendor/webrtc-sys/` | Apache-2.0 (see its `NOTICE.md`), parts BSD-3-Clause (WebRTC) and MIT | Fork of LiveKit's `webrtc-sys` 0.3.35, modified by GusVoice — the changes are listed in its `NOTICE.md` |
| `apps/desktop/vendor/webrtc-sys/src/nvidia/NvCodec/include/{cuviddec,nvcuvid,nvEncodeAPI}.h` | MIT (NVIDIA) | NVIDIA Video Codec SDK API headers |
| `apps/desktop/vendor/webrtc-sys/src/nvidia/NvCodec/NvCodec/`, `.../include/Utils/` | NVIDIA Video Codec SDK License Agreement | Sample encoder/decoder code, covered by the section 7 permission above |

Dependencies installed by the package managers (npm, Cargo) come under their own licenses — all of them permissive
(MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unicode, Zlib) as of the audit on 2026-09-15; the bundled fonts (Manrope,
JetBrains Mono) are under the SIL Open Font License 1.1.

## Contributions

Contributions are accepted under the Contributor License Agreement in [`CLA.md`](CLA.md), which lets the project keep
granting permissions such as the one above for code written by all contributors.
