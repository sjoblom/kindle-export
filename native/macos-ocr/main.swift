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
//   <-  {"id":1,"ok":true,"text":"…"}
//   <-  {"id":2,"ok":false,"error":"unreadable image"}
//
// Startup emits {"ready":true,"protocol":1} so the caller can tell a working
// binary from one the OS refused to run.

let protocolVersion = 1

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

struct Response: Encodable {
  let id: Int
  let ok: Bool
  var text: String?
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
    // Encoding a struct of two strings should not fail, but a response that
    // never arrives would hang the caller, so answer with something valid.
    let fallback = #"{"id":\#(response.id),"ok":false,"error":"encoding failed"}"#
    writeLine(Data(fallback.utf8))
    return
  }
  writeLine(data)
}

func recognize(path: String, languages: [String]?, correct: Bool) throws -> String {
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

  guard let observations = request.results else { return "" }

  // Observations arrive in reading order; one line each.
  return
    observations
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")
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
      let text = try recognize(
        path: request.path,
        languages: request.languages,
        correct: request.correct ?? true)
      emit(Response(id: request.id, ok: true, text: text, error: nil))
    } catch {
      emit(
        Response(
          id: request.id, ok: false, text: nil,
          error: error.localizedDescription))
    }
  }
}

// stdin closed — finish what's in flight before exiting, so the caller still
// gets answers for requests it already sent.
group.wait()
