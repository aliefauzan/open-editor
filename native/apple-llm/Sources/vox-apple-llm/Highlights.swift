// `--highlights <videoPath>` (D-75): macOS 27 MediaIntelligence highlight and key-frame analysis
// of one video file. MediaIntelligence is weak-linked (`@_weakLinked import`, so an SDK without it
// needs no linker flag and builds a helper that answers `unavailable`) and every use is behind
// `#available(macOS 27, *)`, so the helper still starts on macOS 14–26 and answers `unavailable`.
// The caller passes the engine's H.264 proxy: the analyzer fails on VP9 sources
// (`NSOSStatusErrorDomain` -18, "Analysis failed to complete"). Reads only that file; writes none.
import AppleLLMCore
import CoreMedia
import Foundation

#if canImport(MediaIntelligence)
  @_weakLinked import MediaIntelligence
#endif

enum Highlights {
  /// MediaIntelligence video analysis can run on this Mac.
  static var available: Bool {
    #if canImport(MediaIntelligence)
      if #available(macOS 27, *) { return true }
    #endif
    return false
  }

  /// One output line: the analysis, or an error line (`unavailable`, `badRequest`, `generation`).
  static func analyze(path: String) async -> (line: String, ok: Bool) {
    guard path.hasPrefix("/") else {
      return (encodeError(id: nil, code: .badRequest, message: "videoPath must be absolute"), false)
    }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue,
      FileManager.default.isReadableFile(atPath: path)
    else {
      return (encodeError(id: nil, code: .badRequest, message: "video file not readable"), false)
    }
    #if canImport(MediaIntelligence)
      if #available(macOS 27, *) { return await run(URL(fileURLWithPath: path)) }
    #endif
    return (
      encodeError(
        id: nil, code: .unavailable, message: "video highlights need macOS 27 (MediaIntelligence)"),
      false
    )
  }

  #if canImport(MediaIntelligence)
    @available(macOS 27, *)
    static func run(_ url: URL) async -> (line: String, ok: Bool) {
      let asset = MediaIntelligenceVideoAsset(id: .init("vox"), kind: .url(url))
      let results:
        (
          Result<HighlightAnalysisRequest.Result, any Error>,
          Result<KeyFrameAnalysisRequest.Result, any Error>
        )
      do {
        results = try await VideoAnalyzer.shared.analyze(
          asset, for: HighlightAnalysisRequest(), KeyFrameAnalysisRequest())
      } catch {
        return (encodeError(id: nil, code: .generation, message: describe(error)), false)
      }
      var errors: [HighlightsAnswer.Failure] = []
      var ranges: [HighlightsAnswer.Range] = []
      var levels: [HighlightsAnswer.Level] = []
      switch results.0 {
      case .success(let r):
        ranges = r.highlights.compactMap(range)
        levels = r.levels.compactMap { item in
          range(item.timeRange).map {
            HighlightsAnswer.Level(
              startMs: $0.startMs, endMs: $0.endMs, level: roundedLevel(Double(item.level)))
          }
        }
      case .failure(let e):
        errors.append(.init(request: "highlights", message: describe(e)))
      }
      var keyFrameMs: Int?
      switch results.1 {
      case .success(let r):
        if r.timestamp.isNumeric { keyFrameMs = milliseconds(r.timestamp.seconds) }
      case .failure(let e):
        errors.append(.init(request: "keyFrame", message: describe(e)))
      }
      if errors.count == 2 {
        let message = errors.map { "\($0.request): \($0.message)" }.joined(separator: "; ")
        return (encodeError(id: nil, code: .generation, message: message), false)
      }
      let answer = HighlightsAnswer(
        highlights: ranges, levels: levels, keyFrameMs: keyFrameMs, errors: errors)
      return (encodeHighlights(answer), true)
    }
  #endif

  /// A time range in whole milliseconds, or nil when it is not numeric or empty.
  static func range(_ r: CMTimeRange) -> HighlightsAnswer.Range? {
    guard r.isValid, r.start.isNumeric, r.end.isNumeric,
      let s = milliseconds(r.start.seconds), let e = milliseconds(r.end.seconds), e > s
    else { return nil }
    return HighlightsAnswer.Range(startMs: s, endMs: e)
  }

  /// Short error text without the file path (it is the caller's own path anyway).
  static func describe(_ error: any Error) -> String {
    let ns = error as NSError
    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
  }
}
