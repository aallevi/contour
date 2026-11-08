// contour-vision: the subject of a picture, as a mask, by Apple's Vision.
//
//   contour-vision <in.png> <out.png> [x0 y0 x1 y1]
//
// Writes an 8-bit greyscale PNG the size of the input: white where the subject
// is, black elsewhere, soft at the edge. It is the same foreground model as
// Preview's Remove Background and the Photos "lift subject" gesture.
//
// With a box (fractions of the picture, origin top left) only the subjects
// that lie mostly inside it are kept — a person, not the dog beside them. When
// none does, the one overlapping the box most is kept rather than nothing.
//
// A separate executable rather than Swift linked into the Rust app: Vision is
// an Objective-C framework with a Swift API, and a process boundary is the
// least fragile way across. Exit codes: 2 usage, 3 unreadable input,
// 4 no subject found, 5 needs macOS 14.

import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
guard args.count == 3 || args.count == 7 else {
  fail(2, "usage: contour-vision <in.png> <out.png> [x0 y0 x1 y1]")
}
let box: [Double]? = args.count == 7 ? args[3...6].map { Double($0) ?? 0 } : nil

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  fail(3, "could not read \(args[1])")
}

guard #available(macOS 14.0, *) else {
  fail(5, "subject masks need macOS 14 or later")
}

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
  try handler.perform([request])
} catch {
  fail(4, "Vision failed: \(error.localizedDescription)")
}
guard let result = request.results?.first, !result.allInstances.isEmpty else {
  fail(4, "no subject found")
}

// Which instances to keep. The instance mask is a small label image: 0 is
// background, n is instance n.
var keep = result.allInstances
if let b = box {
  let labels = result.instanceMask
  CVPixelBufferLockBaseAddress(labels, .readOnly)
  let w = CVPixelBufferGetWidth(labels)
  let h = CVPixelBufferGetHeight(labels)
  let row = CVPixelBufferGetBytesPerRow(labels)
  let base = CVPixelBufferGetBaseAddress(labels)!.assumingMemoryBound(to: UInt8.self)
  var inside = [Int: Int]()
  var total = [Int: Int]()
  let x0 = Int(b[0] * Double(w)), x1 = Int(b[2] * Double(w))
  let y0 = Int(b[1] * Double(h)), y1 = Int(b[3] * Double(h))
  for y in 0..<h {
    for x in 0..<w {
      let l = Int(base[y * row + x])
      if l == 0 { continue }
      total[l, default: 0] += 1
      if x >= x0 && x < x1 && y >= y0 && y < y1 { inside[l, default: 0] += 1 }
    }
  }
  CVPixelBufferUnlockBaseAddress(labels, .readOnly)
  let share = { (l: Int) -> Double in Double(inside[l] ?? 0) / Double(max(1, total[l] ?? 0)) }
  var chosen = IndexSet(result.allInstances.filter { share($0) >= 0.5 })
  if chosen.isEmpty, let best = result.allInstances.max(by: { (inside[$0] ?? 0) < (inside[$1] ?? 0) }),
     (inside[best] ?? 0) > 0 {
    chosen.insert(best)
  }
  guard !chosen.isEmpty else { fail(4, "no subject inside the box") }
  keep = chosen
}

let mask: CVPixelBuffer
do {
  mask = try result.generateScaledMaskForImage(forInstances: keep, from: handler)
} catch {
  fail(4, "could not make the mask: \(error.localizedDescription)")
}

// A float mask at the picture's size; write it out as 8-bit grey.
let ci = CIImage(cvPixelBuffer: mask)
let context = CIContext(options: [.workingColorSpace: NSNull()])
let grey = CGColorSpaceCreateDeviceGray()
guard let out = context.createCGImage(ci, from: ci.extent, format: .L8, colorSpace: grey),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL,
                                                 UTType.png.identifier as CFString, 1, nil) else {
  fail(4, "could not write \(args[2])")
}
CGImageDestinationAddImage(dest, out, nil)
guard CGImageDestinationFinalize(dest) else { fail(4, "could not write \(args[2])") }
