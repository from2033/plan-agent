import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
  fputs("usage: vision-ocr.swift <image>\n", stderr)
  exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: imageURL) else {
  fputs("image_open_failed\n", stderr)
  exit(3)
}
var proposed = CGRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else {
  fputs("image_conversion_failed\n", stderr)
  exit(4)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

let observations = (request.results ?? []).sorted {
  if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.015 {
    return $0.boundingBox.midY > $1.boundingBox.midY
  }
  return $0.boundingBox.minX < $1.boundingBox.minX
}
for observation in observations {
  if let text = observation.topCandidates(1).first?.string {
    print(text)
  }
}
