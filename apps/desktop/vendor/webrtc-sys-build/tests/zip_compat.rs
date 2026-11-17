use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/zip-compat");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!(
            "{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/zip-compat");
        assert_eq!(self.0.parent(), Some(root.as_path()));
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn archive(name: &str, method: CompressionMethod) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(name, SimpleFileOptions::default().compression_method(method))
        .unwrap();
    writer.write_all(b"local libwebrtc fixture").unwrap();
    writer.finish().unwrap().into_inner()
}

#[test]
fn stored_and_deflated_libwebrtc_layout_remains_readable() {
    for method in [CompressionMethod::Stored, CompressionMethod::Deflated] {
        let dir = TestDir::new();
        let mut zip = ZipArchive::new(Cursor::new(archive(
            "win-x64-release/lib/webrtc.lib",
            method,
        )))
        .unwrap();
        // The same new + extract API used by download_webrtc, without HTTP.
        zip.extract(&dir.0).unwrap();
        assert_eq!(
            fs::read(dir.0.join("win-x64-release/lib/webrtc.lib")).unwrap(),
            b"local libwebrtc fixture"
        );
    }
}

#[test]
fn parent_traversal_is_rejected_without_creating_an_external_file() {
    let dir = TestDir::new();
    let output = dir.0.join("extract");
    let mut zip = ZipArchive::new(Cursor::new(archive(
        "../outside.txt",
        CompressionMethod::Stored,
    )))
    .unwrap();
    assert!(zip.extract(&output).is_err());
    assert!(!dir.0.join("outside.txt").exists());
}

#[test]
fn corrupt_payload_fails_crc_validation() {
    let mut bytes = archive("webrtc.ninja", CompressionMethod::Stored);
    let data_start = {
        let mut zip = ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let file = zip.by_index(0).unwrap();
        file.data_start().expect("fixture entry has a data offset") as usize
    };
    bytes[data_start] ^= 1;
    let dir = TestDir::new();
    let mut zip = ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert!(zip.extract(&dir.0).is_err());
}
