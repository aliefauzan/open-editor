// `--embed` (D-77): sentence vectors from NaturalLanguage's `NLContextualEmbedding` (macOS 14+, no
// Apple Intelligence needed). The model is one transformer per script (Latin covers English and
// Indonesian, 512 dimensions on macOS 27); its token vectors are mean-pooled into one vector per
// text. `NLEmbedding.sentenceEmbedding` is not used: it has no Indonesian model.
// When the language's model assets are not on this Mac, `requestAssets` asks the system to fetch
// them (the system downloads them; the helper opens no connection itself) and a failure is
// `assetsMissing`. Reads only stdin; writes no file.
import AppleLLMCore
import Foundation
import NaturalLanguage

enum Embed {
  /// The contextual embedding API exists here (macOS 14+). Assets may still need a download.
  static var available: Bool { NLContextualEmbedding(language: .english) != nil }

  /// Request text → one output line, and whether it is an answer (not an error).
  static func run(_ input: String) async -> (line: String, ok: Bool) {
    let request: EmbedRequest
    switch EmbedRequest.parse(input) {
    case .failure(let f): return (encodeError(id: nil, code: .badRequest, message: f.message), false)
    case .success(let r): request = r
    }
    let language = request.language.map { NLLanguage(rawValue: $0) } ?? detect(request.texts)
    guard let model = NLContextualEmbedding(language: language) else {
      return (
        encodeError(
          id: nil, code: .unavailable,
          message: "no contextual embedding model for language \(language.rawValue)"),
        false
      )
    }
    if !model.hasAvailableAssets {
      let result: NLContextualEmbedding.AssetsResult
      do {
        result = try await model.requestAssets()
      } catch {
        return (
          encodeError(
            id: nil, code: .assetsMissing,
            message: "embedding assets for \(language.rawValue) could not be loaded: \(describe(error))"),
          false
        )
      }
      guard result == .available, model.hasAvailableAssets else {
        return (
          encodeError(
            id: nil, code: .assetsMissing,
            message: "embedding assets for \(language.rawValue) are not available on this Mac"),
          false
        )
      }
    }
    do {
      try model.load()
    } catch {
      return (
        encodeError(id: nil, code: .unavailable, message: "embedding model did not load: \(describe(error))"),
        false
      )
    }
    defer { model.unload() }
    let dim = model.dimension
    var vectors: [[Double]] = []
    vectors.reserveCapacity(request.texts.count)
    for text in request.texts {
      if text.allSatisfy(\.isWhitespace) {
        vectors.append([Double](repeating: 0, count: dim))
        continue
      }
      do {
        let r = try model.embeddingResult(for: text, language: language)
        var tokens: [[Double]] = []
        r.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { v, _ in
          tokens.append(v)
          return true
        }
        vectors.append(meanPool(tokens, dim: dim))
      } catch {
        return (
          encodeError(id: nil, code: .generation, message: "embedding failed: \(describe(error))"),
          false
        )
      }
    }
    return (encodeEmbedding(vectors: vectors, dim: dim, language: language.rawValue), true)
  }

  /// The dominant language of all texts together; English when it cannot tell.
  static func detect(_ texts: [String]) -> NLLanguage {
    let r = NLLanguageRecognizer()
    r.processString(String(texts.joined(separator: "\n").prefix(20_000)))
    guard let l = r.dominantLanguage, l != .undetermined else { return .english }
    return l
  }

  static func describe(_ error: any Error) -> String {
    let ns = error as NSError
    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
  }
}
