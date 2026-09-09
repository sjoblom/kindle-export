import AppKit
import Foundation
import Vision

// A long-lived OCR worker built on Apple's Vision framework, so transcription
// needs no API key, no network and no per-page cost on macOS.
//
// Protocol: one JSON request per line on stdin, one JSON response per line on
// stdout. Requests are recognised concurrently and responses carry the request
// id, so they may come back in any order.
//
//   ->  {"id":1,"path":"/…/001-001.png"}
//   <-  {"id":1,"ok":true,"lines":[{"text":"…","left":0,"top":0,"width":0,"height":0}]}
//   <-  {"id":2,"ok":false,"error":"unreadable image"}
//
// Answers are one entry per *rendered* line, with the box it occupies, rather
// than a blob of text: where the lines sit is the only remaining evidence of
// where the paragraphs were, and the caller rebuilds them from it (see
// src/ocr-layout.ts). Doing that here would work too, but in TypeScript it can
// be unit-tested against fixtures without running Vision at all.
//
// Startup emits {"ready":true,"protocol":2} so the caller can tell a working
// binary from one the OS refused to run.

let protocolVersion = 2

struct Request: Decodable {
  let id: Int
  let path: String
  /// BCP-47 tags, e.g. ["en-US"]. Omitted means Vision's own default.
  let languages: [String]?
  /// Let Vision resolve ambiguous glyphs against a dictionary. Defaults to on:
  /// measured over a real 126-page book it changed 62 pages and touched a digit
  /// exactly once, so on prose it resolves far more than it invents. An
  /// isolated number with no surrounding words is where it errs, hence the
  /// escape hatch.
  let correct: Bool?
}

/// One recognised line, in pixels from the top-left of the page image. Vision
/// reports normalised boxes with the origin at the bottom left; flipping them
/// here means only one place has to know that, and the caller reasons in the
/// same frame a reader would.
struct Line: Encodable {
  let text: String
  let left: Double
  let top: Double
  let width: Double
  let height: Double
}

struct Response: Encodable {
  let id: Int
  let ok: Bool
  var lines: [Line]?
  var error: String?
}

enum OcrError: LocalizedError {
  case unreadable(String)

  var errorDescription: String? {
    switch self {
    case .unreadable(let path):
      return "unreadable image: \(path)"
    }
  }
}

let stdoutLock = NSLock()
let encoder = JSONEncoder()

func writeLine(_ data: Data) {
  var line = data
  line.append(0x0A)
  stdoutLock.lock()
  FileHandle.standardOutput.write(line)
  stdoutLock.unlock()
}

func emit(_ response: Response) {
  guard let data = try? encoder.encode(response) else {
    // Encoding plain strings and doubles should not fail, but a response that
    // never arrives would hang the caller, so answer with something valid.
    let fallback = #"{"id":\#(response.id),"ok":false,"error":"encoding failed"}"#
    writeLine(Data(fallback.utf8))
    return
  }
  writeLine(data)
}

/// Trim the noise off a normalised coordinate scaled to pixels: sub-pixel
/// precision means nothing here and would triple the size of a page's JSON.
func round2(_ value: Double) -> Double {
  (value * 100).rounded() / 100
}

func recognize(path: String, languages: [String]?, correct: Bool) throws -> [Line] {
  guard let image = NSImage(contentsOfFile: path),
    let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else {
    throw OcrError.unreadable(path)
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = correct
  if let languages, !languages.isEmpty {
    request.recognitionLanguages = languages
  }

  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])

  guard let observations = request.results else { return [] }

  // Observations arrive in reading order; one line each. Keep that order — it
  // is the reading order Vision worked out — and hand the caller each box so it
  // can tell a wrapped line from a new paragraph.
  let width = Double(cgImage.width)
  let height = Double(cgImage.height)

  return observations.compactMap { observation in
    guard let text = observation.topCandidates(1).first?.string else { return nil }

    let box = observation.boundingBox
    return Line(
      text: text,
      left: round2(box.minX * width),
      top: round2((1 - box.maxY) * height),
      width: round2(box.width * width),
      height: round2(box.height * height))
  }
}

let queue = DispatchQueue(
  label: "kindle-export.ocr",
  qos: .userInitiated,
  attributes: .concurrent
)
let group = DispatchGroup()
let decoder = JSONDecoder()

// Vision parallelises internally and needs threads of its own. Dispatching a
// whole book at once starves it of them and the process deadlocks without
// returning a single page, so cap the work in flight. Acquiring the slot on the
// read loop rather than inside the block also stops an eager caller from
// queueing hundreds of full-page images into memory.
let inFlight = DispatchSemaphore(
  value: max(2, min(6, ProcessInfo.processInfo.activeProcessorCount - 2)))

writeLine(Data(#"{"ready":true,"protocol":\#(protocolVersion)}"#.utf8))

while let line = readLine(strippingNewline: true) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty { continue }

  guard let request = try? decoder.decode(Request.self, from: Data(trimmed.utf8))
  else {
    writeLine(Data(#"{"id":-1,"ok":false,"error":"malformed request"}"#.utf8))
    continue
  }

  inFlight.wait()
  group.enter()
  queue.async {
    defer {
      inFlight.signal()
      group.leave()
    }
    do {
      let lines = try recognize(
        path: request.path,
        languages: request.languages,
        correct: request.correct ?? true)
      emit(Response(id: request.id, ok: true, lines: lines, error: nil))
    } catch {
      emit(
        Response(
          id: request.id, ok: false, lines: nil,
          error: error.localizedDescription))
    }
  }
}

// stdin closed — finish what's in flight before exiting, so the caller still
// gets answers for requests it already sent.
group.wait()
