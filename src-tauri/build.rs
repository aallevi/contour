//! Builds the Vision helper before Tauri checks its bundle.
//!
//! `contour-vision` (vision/subject.swift) is a small Swift executable that
//! asks Apple's Vision for the subject of a picture. Tauri bundles it as an
//! external binary, which it expects to find, named for the target, before it
//! will build at all — so it is compiled here, first. Off macOS, or without a
//! Swift compiler, an empty placeholder keeps the build going and the app
//! reports that background removal is unavailable.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let dir = PathBuf::from("binaries");
    std::fs::create_dir_all(&dir).expect("create binaries/");
    let out = dir.join(format!("contour-vision-{target}"));
    println!("cargo:rerun-if-changed=vision/subject.swift");

    let built = target.contains("apple-darwin")
        && Command::new("swiftc")
            .args(["-O", "vision/subject.swift", "-o"])
            .arg(&out)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    if !built {
        println!("cargo:warning=contour-vision not built; background removal will be unavailable");
        std::fs::write(&out, b"").expect("write placeholder");
    }
    tauri_build::build()
}
