# GusVoice glib 0.18.5 backport

This directory contains the published glib 0.18.5 Cargo package, with the upstream
soundness fix from gtk-rs/gtk-rs-core commit
b5a4071e439bef2b5eea76c3aa25e5ae84839e34:
https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34

Advisories: https://github.com/advisories/GHSA-wrw7-89jp-8q8g and
https://rustsec.org/advisories/RUSTSEC-2024-0429.html.

GTK 0.18 requires glib 0.18, while the advisory lists glib 0.20.0 as the
first fixed release. This backport changes only the mutability of the output
pointer in VariantStrIter::impl_get. It preserves the 0.18.5 version and public
API; compatibility still requires build and runtime validation on supported
targets. The package remains subject to other advisories.

For future maintenance, compare this directory with the published 0.18.5
package, review new RustSec/GHSA advisories and relevant upstream patches,
backport and test applicable fixes, and keep their provenance documented here.
When the full GTK/WebKit/Tauri dependency family supports a maintained fixed
upstream release, evaluate replacing this fork and verify the resolved Cargo
graph and lockfile. Scanners may continue to flag 0.18.5 by version despite
this source fix; do not treat the version as proof that the fix is absent or
hide the finding without review.

Verification: the unchanged files were compared against the published crate,
and all 11 existing variant_iter tests passed with Rust 1.96.0 in Linux release
mode, offline with read-only sources and bounded scratch/resources.
Trivy still reports the registry-version advisory for this path package.
The repository OpenVEX statement records this exact backport as fixed;
scripts/check-sast-backports.mjs verifies the entire source tree, patch selection,
resolved lockfile and the single scoped statement before it can be applied.
