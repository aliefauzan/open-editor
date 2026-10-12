// `--sounds` (D-83): SoundAnalysis' built-in sound classifier (`SNClassifySoundRequest`,
// `.version1`, macOS 12+, so every Mac the helper runs on) over one audio file, in windows of
// `windowSec` with no overlap. SoundAnalysis is a system framework on macOS 14, so no weak
// linking is needed; it needs no Apple Intelligence. Reads only the request on stdin and the audio
// file it names; writes no file.
import AppleLLMCore
import CoreMedia
import Foundation
import SoundAnalysis

enum Sounds {
  /// SoundAnalysis' built-in classifier exists on every macOS the helper starts on (14+).
  static var available: Bool { true }

  /// Request text → one output line, and whether it is an answer (not an error).
  static func run(_ input: String) async -> (line: String, ok: Bool) {
    let request: SoundsRequest
    switch SoundsRequest.parse(input) {
    case .failure(let f): return (encodeError(id: nil, code: .badRequest, message: f.message), false)
    case .success(let r): request = r
    }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: request.audioPath, isDirectory: &isDir),
      !isDir.boolValue, FileManager.default.isReadableFile(atPath: request.audioPath)
    else {
      return (encodeError(id: nil, code: .badRequest, message: "audio file not readable"), false)
    }
    let classify: SNClassifySoundRequest
    do {
      classify = try SNClassifySoundRequest(classifierIdentifier: .version1)
    } catch {
      return (
        encodeError(
          id: nil, code: .unavailable, message: "sound classifier did not load: \(describe(error))"),
        false
      )
    }
    if let classes = request.classes {
      let known = Set(classify.knownClassifications)
      if let unknown = classes.first(where: { !known.contains($0) }) {
        return (encodeError(id: nil, code: .badRequest, message: "unknown sound class: \(unknown)"), false)
      }
    }
    classify.windowDuration = CMTime(seconds: request.windowSec, preferredTimescale: 48_000)
    classify.overlapFactor = 0
    let analyzer: SNAudioFileAnalyzer
    do {
      analyzer = try SNAudioFileAnalyzer(url: URL(fileURLWithPath: request.audioPath))
    } catch {
      return (
        encodeError(id: nil, code: .badRequest, message: "audio file not readable: \(describe(error))"),
        false
      )
    }
    let collector = Collector(
      classes: request.classes.map(Set.init), minConfidence: request.minConfidence)
    do {
      try analyzer.add(classify, withObserver: collector)
    } catch {
      return (encodeError(id: nil, code: .generation, message: describe(error)), false)
    }
    await analyzer.analyze()
    let (windows, failure) = collector.result()
    if let failure {
      return (encodeError(id: nil, code: .generation, message: failure), false)
    }
    let windowMs = milliseconds(request.windowSec) ?? 0
    return (encodeSounds(SoundsAnswer(windows: windows, windowMs: windowMs)), true)
  }

  static func describe(_ error: any Error) -> String {
    let ns = error as NSError
    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
  }
}

/// Collects the classifier's windows. SoundAnalysis calls it on its own queue; the lock keeps
/// the state consistent for the read after `analyze()` returns.
final class Collector: NSObject, SNResultsObserving, @unchecked Sendable {
  private let lock = NSLock()
  private let classes: Set<String>?
  private let minConfidence: Double
  private var windows: [SoundsAnswer.Window] = []
  private var failure: String?

  init(classes: Set<String>?, minConfidence: Double) {
    self.classes = classes
    self.minConfidence = minConfidence
  }

  func request(_ request: any SNRequest, didProduce result: any SNResult) {
    guard let r = result as? SNClassificationResult, let range = Highlights.range(r.timeRange)
    else { return }
    let labels = keptLabels(
      r.classifications.map { (id: $0.identifier, confidence: $0.confidence) },
      classes: classes, minConfidence: minConfidence)
    guard !labels.isEmpty else { return }
    lock.withLock {
      windows.append(.init(startMs: range.startMs, endMs: range.endMs, labels: labels))
    }
  }

  func request(_ request: any SNRequest, didFailWithError error: any Error) {
    lock.withLock { failure = Sounds.describe(error) }
  }

  func result() -> ([SoundsAnswer.Window], String?) {
    lock.withLock { (windows.sorted { $0.startMs < $1.startMs }, failure) }
  }
}
