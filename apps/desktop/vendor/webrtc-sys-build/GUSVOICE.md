# GusVoice webrtc-sys-build 0.3.18

Published LiveKit crate 0.3.18, source archive SHA-256:
7d46da6b5a5cbd091fae0400f77189f4ca4807c0d9442b85838a584f28720570.
The complete src/lib.rs is unchanged (SHA-256:
e02b8b422e55af010bf2a1822111c8ead949dd927da3707124b0d907a2a5161f).
In particular WEBRTC_TAG remains webrtc-51ef663, preserving the precompiled
libwebrtc ABI required by the existing NVENC fork.

Only dependency selection changes: zip 0.6 becomes =9.1.3, default features
disabled, deflate-flate2 enabled; flate2 =1.1.9 with rust_backend preserves
the old pure-Rust miniz backend without enabling Zopfli or zlib-rs.
This removes CVE-2026-115905 and CVE-2026-115906; extraction still uses
ZipArchive::new(file) and extract(destination), with no validation bypass.
See https://github.com/zip-rs/zip2/security/advisories/GHSA-m665-v7pm-7grj
and https://github.com/zip-rs/zip2/releases/tag/v9.1.3.

The added tests/zip_compat.rs checks Stored/Deflate layout, parent traversal
rejection and CRC failure without network access. Both the desktop and standalone
webrtc-sys lockfiles must select this helper and the fixed zip/rustls versions.
When updating upstream, review WEBRTC_TAG and binary ABI before replacing this fork.
The Apache-2.0 license is retained; the published crate supplies its copyright
header but no standalone license, so the standard license text is included here.
