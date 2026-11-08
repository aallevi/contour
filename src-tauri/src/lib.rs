//! Native services for Contour.
//!
//! Three things the web view cannot do for itself: find the command line tools,
//! trace a stack of bitmaps, and decode image formats browsers do not speak.
//! Everything else — adjustment, banding, fills, export — is TypeScript,
//! because it has to keep working in `npm run dev` where none of this exists.
//!
//! There are two tracers. `potrace` is a subprocess and has to be installed;
//! vtracer is the `vtracer` crate, linked in, so it is always there. That
//! asymmetry is deliberate — the app should be able to trace out of the box,
//! and potrace should still be reachable for the people who want its particular
//! curve fitting.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

// -- locating the tools ------------------------------------------------------

/// Where to look for a binary, in order, before giving up.
///
/// `PATH` is deliberately consulted *last* and is not enough on its own: an app
/// launched from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
/// else, so a Homebrew `potrace` is invisible to it even though it is plainly
/// on the user's PATH in a terminal. Probing the known prefixes explicitly is
/// what makes the bundled app behave the same as `npm run dev`.
const PREFIXES: &[&str] = &[
    "/opt/homebrew/bin", // Apple silicon Homebrew
    "/usr/local/bin",    // Intel Homebrew, and most manual installs
    "/opt/local/bin",    // MacPorts
    "/usr/bin",
    "/bin",
];

fn locate(name: &str) -> Option<PathBuf> {
    for prefix in PREFIXES {
        let p = PathBuf::from(prefix).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // Last resort: whatever PATH this process happens to have.
    let out = Command::new("/usr/bin/which").arg(name).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

#[derive(Serialize, Clone)]
pub struct Tool {
    pub path: String,
    pub version: String,
}

#[derive(Serialize, Clone)]
pub struct Tools {
    pub potrace: Option<Tool>,
    pub magick: Option<Tool>,
    /// Always present: compiled in rather than located on disk.
    pub vtracer: Tool,
}

fn describe(name: &str, version_args: &[&str], override_path: Option<&str>) -> Option<Tool> {
    let path = match override_path {
        Some(p) if !p.is_empty() => {
            let pb = PathBuf::from(p);
            if pb.is_file() {
                pb
            } else {
                return None;
            }
        }
        _ => locate(name)?,
    };
    let out = Command::new(&path).args(version_args).output().ok()?;
    // ImageMagick prints its banner on stdout; potrace on stdout too, but be
    // forgiving — a tool that runs at all is more useful than one we reject
    // because its version string landed on the wrong stream.
    let text = if out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).to_string()
    } else {
        String::from_utf8_lossy(&out.stdout).to_string()
    };
    let version = text.lines().next().unwrap_or("").trim().to_string();
    Some(Tool {
        path: path.to_string_lossy().to_string(),
        version,
    })
}

/// Report which external tools are available, so the UI can say so plainly
/// rather than failing at the moment the user presses Trace.
#[tauri::command]
fn probe_tools(potrace_path: Option<String>, magick_path: Option<String>) -> Tools {
    Tools {
        potrace: describe("potrace", &["--version"], potrace_path.as_deref()),
        magick: describe("magick", &["--version"], magick_path.as_deref()),
        vtracer: Tool {
            path: "built in".to_string(),
            version: format!("vtracer {}", VTRACER_VERSION),
        },
    }
}

/// Pinned in `Cargo.toml`; reported so the UI can say which tracer ran.
const VTRACER_VERSION: &str = "0.6.5";

// -- tracing -----------------------------------------------------------------

#[derive(Deserialize)]
struct Job {
    /// Length in bytes of this job's PBM inside the concatenated payload.
    len: usize,
    /// Command line flags for this band (`-t`, `-a`, `-O`, `-z`, `-u`, `-n`).
    #[serde(default)]
    args: Vec<String>,
    /// vtracer's settings for this band, when vtracer is the engine.
    #[serde(default)]
    vt: Option<VtConfig>,
}

/// vtracer's parameters, one to one with the crate's `Config`.
#[derive(Deserialize, Clone)]
struct VtConfig {
    filter_speckle: usize,
    /// `spline`, `polygon` or `pixel`.
    mode: String,
    corner_threshold: i32,
    length_threshold: f64,
    splice_threshold: i32,
    precision: u32,
}

#[derive(Deserialize)]
struct TraceRequest {
    jobs: Vec<Job>,
    /// `potrace` or `vtracer`. Absent means potrace, for older front ends.
    #[serde(default)]
    engine: Option<String>,
    /// Explicit binary, when the user has pointed the app at one.
    potrace: Option<String>,
}

#[derive(Serialize, Clone, Default)]
pub struct TraceResult {
    /// potrace's SVG document, parsed on the TypeScript side.
    pub svg: String,
    pub error: Option<String>,
    pub millis: u64,
}

/// Run one bitmap through potrace, start to finish, without touching the disk.
///
/// The PBM goes in on stdin and the SVG comes back on stdout, which matters
/// more than it sounds: a six-band trace of a large photograph would otherwise
/// be twelve temporary files per keystroke-worth of parameter change.
fn trace_one(bin: &std::path::Path, args: &[String], pbm: &[u8]) -> TraceResult {
    let started = std::time::Instant::now();
    let mut child = match Command::new(bin)
        .args(args)
        .arg("-s")
        .arg("-o")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return TraceResult {
                error: Some(format!("could not start potrace: {e}")),
                ..Default::default()
            }
        }
    };

    // Write on a thread. potrace streams its output, so a large bitmap can fill
    // the stdout pipe while we are still filling stdin — writing and reading
    // from the same thread deadlocks exactly then, which is to say only on the
    // big images where it is least welcome.
    let mut stdin = child.stdin.take().expect("stdin piped above");
    let bytes = pbm.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&bytes);
        // Dropping closes the pipe, which is potrace's end-of-input.
    });

    let out = child.wait_with_output();
    let _ = writer.join();

    match out {
        Ok(o) if o.status.success() => TraceResult {
            svg: String::from_utf8_lossy(&o.stdout).to_string(),
            error: None,
            millis: started.elapsed().as_millis() as u64,
        },
        Ok(o) => TraceResult {
            error: Some(
                String::from_utf8_lossy(&o.stderr)
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("potrace failed")
                    .to_string(),
            ),
            ..Default::default()
        },
        Err(e) => TraceResult {
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

// -- vtracer -----------------------------------------------------------------

/// Unpack a binary PBM (`P4`) back into width, height and one byte per pixel.
///
/// The front end already packs every mask this way for potrace, which reads it
/// on stdin. vtracer is a library call and wants pixels, so rather than add a
/// second wire format — and a second thing that can disagree with the first —
/// the same bytes are unpacked here. A megapixel mask is a millisecond.
fn read_pbm(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    // Header: "P4\n{w} {h}\n". Written by us, so it is exact — but a truncated
    // payload must not index past the end.
    if bytes.len() < 3 || &bytes[0..2] != b"P4" {
        return Err("not a P4 bitmap".into());
    }
    let mut i = 2;
    let mut fields = [0usize; 2];
    for field in fields.iter_mut() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if start == i {
            return Err("truncated PBM header".into());
        }
        *field = std::str::from_utf8(&bytes[start..i])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or("bad PBM dimension")?;
    }
    // Exactly one whitespace character separates the header from the raster.
    i += 1;
    let (w, h) = (fields[0], fields[1]);
    let row_bytes = (w + 7) / 8;
    if w == 0 || h == 0 || bytes.len() < i + row_bytes * h {
        return Err("truncated PBM raster".into());
    }

    let mut out = vec![0u8; w * h];
    for y in 0..h {
        let row = i + y * row_bytes;
        for x in 0..w {
            // Most significant bit is the leftmost pixel; a 1 bit is the region.
            let bit = bytes[row + (x >> 3)] >> (7 - (x & 7)) & 1;
            out[y * w + x] = bit;
        }
    }
    Ok((w, h, out))
}

// vtracer's `Config.mode` is a visioncortex type that vtracer does not
// re-export, so visioncortex is a direct dependency pinned to the same minor
// version — two copies of it in the tree would be two incompatible enums.
fn simplify_mode(name: &str) -> visioncortex::PathSimplifyMode {
    match name {
        "polygon" => visioncortex::PathSimplifyMode::Polygon,
        "pixel" => visioncortex::PathSimplifyMode::None,
        _ => visioncortex::PathSimplifyMode::Spline,
    }
}

/// Trace one mask with vtracer, in process.
///
/// vtracer is handed a black-on-white image rather than the mask directly,
/// because its binary mode is defined as "red channel below 128" — that is the
/// contract, and expressing the mask in its terms here is cheaper than
/// depending on an internal representation staying put.
fn vtrace_one(cfg: &VtConfig, pbm: &[u8]) -> TraceResult {
    let started = std::time::Instant::now();
    let (w, h, bits) = match read_pbm(pbm) {
        Ok(v) => v,
        Err(e) => {
            return TraceResult {
                error: Some(e),
                ..Default::default()
            }
        }
    };

    let mut pixels = vec![255u8; w * h * 4];
    for (p, &on) in bits.iter().enumerate() {
        let i = p * 4;
        let v = if on == 1 { 0 } else { 255 };
        pixels[i] = v;
        pixels[i + 1] = v;
        pixels[i + 2] = v;
        pixels[i + 3] = 255;
    }
    let img = vtracer::ColorImage {
        pixels,
        width: w,
        height: h,
    };

    let config = vtracer::Config {
        color_mode: vtracer::ColorMode::Binary,
        hierarchical: vtracer::Hierarchical::Stacked,
        filter_speckle: cfg.filter_speckle,
        color_precision: 8,
        layer_difference: 16,
        mode: simplify_mode(&cfg.mode),
        corner_threshold: cfg.corner_threshold,
        length_threshold: cfg.length_threshold.clamp(3.5, 10.0),
        max_iterations: 10,
        splice_threshold: cfg.splice_threshold,
        path_precision: Some(cfg.precision),
    };

    match vtracer::convert(img, config) {
        Ok(svg) => TraceResult {
            svg: svg.to_string(),
            error: None,
            millis: started.elapsed().as_millis() as u64,
        },
        Err(e) => TraceResult {
            error: Some(format!("vtracer: {e}")),
            ..Default::default()
        },
    }
}

/// Trace a whole band stack in one call.
///
/// The payload is `[u32 header length][header JSON][pbm 0][pbm 1]...`, sent as
/// a raw IPC body. Tauri serialises ordinary command arguments as JSON, which
/// would turn each bitmap into an array of five hundred thousand decimal
/// numbers; a raw body moves the same bytes untouched.
#[tauri::command]
fn trace_bands(request: tauri::ipc::Request<'_>) -> Result<Vec<TraceResult>, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("trace_bands expects a raw body".into()),
    };
    if body.len() < 4 {
        return Err("payload truncated".into());
    }
    let header_len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + header_len {
        return Err("payload truncated".into());
    }
    let req: TraceRequest = serde_json::from_slice(&body[4..4 + header_len])
        .map_err(|e| format!("bad header: {e}"))?;

    let use_vtracer = req.engine.as_deref() == Some("vtracer");
    // Located up front rather than per band: the error for a missing potrace
    // should arrive once, before any work, not sixteen times afterwards.
    let bin = if use_vtracer {
        PathBuf::new()
    } else {
        match req.potrace.as_deref().filter(|s| !s.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => locate("potrace").ok_or_else(|| {
                "potrace was not found. Install it with `brew install potrace`.".to_string()
            })?,
        }
    };

    // Slice the payload into one borrowed bitmap per band.
    let mut bitmaps: Vec<&[u8]> = Vec::with_capacity(req.jobs.len());
    let mut offset = 4 + header_len;
    for job in &req.jobs {
        let end = offset + job.len;
        if end > body.len() {
            return Err("payload truncated".into());
        }
        bitmaps.push(&body[offset..end]);
        offset = end;
    }

    let mut results = vec![TraceResult::default(); req.jobs.len()];

    // Bands are independent and both tracers are single-threaded, so the stack
    // is exactly as parallel as the machine is. A shared cursor rather than one
    // thread per band: a sixteen-level posterisation should not spawn sixteen
    // processes at once on a four-core laptop.
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(req.jobs.len().max(1));
    let cursor = AtomicUsize::new(0);
    let slots: Vec<_> = results.iter_mut().collect();
    let slots = std::sync::Mutex::new(slots);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = cursor.fetch_add(1, Ordering::SeqCst);
                if i >= req.jobs.len() {
                    break;
                }
                let job = &req.jobs[i];
                let r = match (use_vtracer, job.vt.as_ref()) {
                    (true, Some(cfg)) => vtrace_one(cfg, bitmaps[i]),
                    (true, None) => TraceResult {
                        error: Some("vtracer was asked for without its settings".into()),
                        ..Default::default()
                    },
                    _ => trace_one(&bin, &job.args, bitmaps[i]),
                };
                *slots.lock().expect("no panics while holding this")[i] = r;
            });
        }
    });

    Ok(results)
}

// -- decoding ----------------------------------------------------------------

#[derive(Serialize)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    /// Plain bytes; Tauri v2 returns these without base64, which at 4096x4096 is
    /// the difference between a snappy open and a visible stall.
    pub rgba: Vec<u8>,
}

fn decode_bytes(bytes: &[u8]) -> Result<DecodedImage, String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let rgba = img.to_rgba8();
    Ok(DecodedImage {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    })
}

/// Decode an image file to RGBA, falling back to ImageMagick.
///
/// The `image` crate covers TIFF, which is what print work arrives as. Anything
/// past that — PSD, camera raw, EXR, PDF, CMYK JPEG — is ImageMagick's job, and
/// it is asked for sRGB explicitly because a CMYK or Lab file handed straight to
/// a canvas comes out looking nothing like it should.
#[tauri::command]
fn decode_image(path: String, magick_path: Option<String>) -> Result<DecodedImage, String> {
    if let Ok(img) = image::open(&path) {
        let rgba = img.to_rgba8();
        return Ok(DecodedImage {
            width: rgba.width(),
            height: rgba.height(),
            rgba: rgba.into_raw(),
        });
    }

    let magick = match magick_path.filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => locate("magick")
            .or_else(|| locate("convert"))
            .ok_or_else(|| format!("{path}: unsupported format, and ImageMagick was not found"))?,
    };
    // `[0]` takes the first frame: a multi-page PDF or an animated GIF would
    // otherwise be written out as a numbered sequence and nothing reaches stdout.
    let out = Command::new(&magick)
        .arg(format!("{path}[0]"))
        .args(["-colorspace", "sRGB", "-alpha", "on", "PNG32:-"])
        .output()
        .map_err(|e| format!("ImageMagick: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ImageMagick: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    decode_bytes(&out.stdout)
}

/// Extensions worth offering in the open dialog. ImageMagick widens this a lot,
/// so the list depends on whether it is there.
// -- lossless WebP -------------------------------------------------------------

/// RGBA pixels to lossless WebP, for the web view that cannot encode it.
///
/// WebKit's canvas hands back a PNG when asked for WebP, so the desktop app
/// encodes here. The body is raw RGBA; `x-size` says `width height`.
#[tauri::command]
fn encode_webp(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("encode_webp expects a raw body".into()),
    };
    let size = request
        .headers()
        .get("x-size")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-size")?;
    let mut it = size.split_whitespace().map(|s| s.parse::<u32>());
    let (w, h) = match (it.next(), it.next()) {
        (Some(Ok(w)), Some(Ok(h))) => (w, h),
        _ => return Err("bad x-size".into()),
    };
    if body.len() != (w as usize) * (h as usize) * 4 {
        return Err("pixel data does not match the size".into());
    }
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .encode(body, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(out))
}

// -- subject masks -------------------------------------------------------------

/// The subject of a picture as an 8-bit grey PNG mask, by Apple's Vision.
///
/// The body is the picture as PNG; an optional `x-box` header holds four
/// fractions, `x0 y0 x1 y1`, to keep only the subjects inside that box. The
/// work is done by `contour-vision`, the Swift helper bundled beside the app's
/// own executable (see build.rs), so a missing or placeholder helper is an
/// error the interface can explain rather than a crash.
#[tauri::command]
fn vision_subject(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("vision_subject expects a raw body".into()),
    };
    let helper = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("contour-vision");
    if std::fs::metadata(&helper).map(|m| m.len() == 0).unwrap_or(true) {
        return Err("Background removal needs the desktop app on a Mac".into());
    }
    static JOB: AtomicUsize = AtomicUsize::new(0);
    let n = JOB.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir();
    let input = tmp.join(format!("contour-vision-{}-{n}-in.png", std::process::id()));
    let output = tmp.join(format!("contour-vision-{}-{n}-out.png", std::process::id()));
    std::fs::write(&input, body).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&helper);
    cmd.arg(&input).arg(&output);
    if let Some(b) = request.headers().get("x-box").and_then(|v| v.to_str().ok()) {
        let parts: Vec<&str> = b.split_whitespace().collect();
        if parts.len() == 4 && parts.iter().all(|p| p.parse::<f64>().is_ok()) {
            cmd.args(parts);
        }
    }
    let result = cmd.output();
    let _ = std::fs::remove_file(&input);
    let out = result.map_err(|e| format!("could not run the Vision helper: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&output);
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(match out.status.code() {
            Some(4) => "No subject found".to_string(),
            Some(5) => "Background removal needs macOS 14 or later".to_string(),
            _ if !msg.is_empty() => msg,
            _ => "Vision could not find the subject".to_string(),
        });
    }
    let png = std::fs::read(&output).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&output);
    Ok(tauri::ipc::Response::new(png?))
}

#[tauri::command]
fn image_formats() -> Vec<String> {
    let mut v: Vec<String> = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if locate("magick").is_some() || locate("convert").is_some() {
        v.extend(
            ["psd", "heic", "avif", "exr", "pdf", "eps", "dng", "cr2", "nef", "arw", "ppm", "pgm"]
                .iter()
                .map(|s| s.to_string()),
        );
    }
    v
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            vision_subject,
            encode_webp,
            probe_tools,
            trace_bands,
            decode_image,
            image_formats
        ])
        .run(tauri::generate_context!())
        .expect("error while running Contour");
}
