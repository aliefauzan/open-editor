// `--embed` (D-77): local sentence vectors from NaturalLanguage's `NLContextualEmbedding`. Pure
// parsing, pooling and encoding; the NaturalLanguage calls live in the executable (Embed.swift).
//
//   stdin  {"texts":[string], "language"?: string}       one JSON object (one line)
//   stdout {"vectors":[[number]], "dim", "language"} | {"error":{"code","message"}}
//
// One vector per text, in order: the mean of the model's token vectors, rounded to 6 decimals.
// An empty (or whitespace-only) text gets a zero vector. `language` is the BCP 47 code the model
// ran with: the request's, else the dominant language of all texts, else "en".

/// Most texts one `--embed` request may carry (a screenplay has at most 60 scenes; the footage
/// set is the rest).
public let maxEmbedTexts = 512
/// Longest text in UTF-16 units; the model reads at most a few hundred tokens anyway.
public let maxEmbedTextLength = 4000

public struct EmbedRequest: Equatable, Sendable {
  public let texts: [String]
  /// BCP 47 language code (`en`, `id`), or nil to detect it.
  public let language: String?

  public init(texts: [String], language: String?) {
    self.texts = texts
    self.language = language
  }

  static let fields: Set<String> = ["texts", "language"]

  /// Parses and validates the request text (one JSON object).
  public static func parse(_ text: String) -> Result<EmbedRequest, Request.Failure> {
    func fail(_ message: String) -> Result<EmbedRequest, Request.Failure> {
      .failure(Request.Failure(id: nil, message: message))
    }
    let json: JSONValue
    do {
      json = try JSONValue.parse(String(text.drop(while: \.isWhitespace).reversed().drop(while: \.isWhitespace).reversed()))
    } catch {
      return fail("embed request is not valid JSON (\(error))")
    }
    guard case .object(let pairs) = json else { return fail("embed request must be a JSON object") }
    if let extra = pairs.first(where: { !fields.contains($0.0) }) {
      return fail("unknown field: \(extra.0)")
    }
    guard case .array(let raw)? = json["texts"], !raw.isEmpty, raw.count <= maxEmbedTexts else {
      return fail("texts must be an array of 1 to \(maxEmbedTexts) strings")
    }
    var texts: [String] = []
    for item in raw {
      guard let s = item.stringValue else { return fail("each text must be a string") }
      guard s.utf16.count <= maxEmbedTextLength else {
        return fail("each text must be at most \(maxEmbedTextLength) characters")
      }
      texts.append(s)
    }
    var language: String?
    if let rawLanguage = json["language"] {
      guard let l = rawLanguage.stringValue, isLanguageCode(l) else {
        return fail("language must be a BCP 47 code such as \"en\" or \"id\"")
      }
      language = l
    }
    return .success(EmbedRequest(texts: texts, language: language))
  }
}

/// `en`, `id`, `zh-Hans`, `pt-BR`: letters, then up to three letter-or-digit subtags.
public func isLanguageCode(_ s: String) -> Bool {
  let parts = s.split(separator: "-", omittingEmptySubsequences: false)
  guard let first = parts.first, (2...3).contains(first.count),
    first.allSatisfy({ $0.isASCII && $0.isLetter }), parts.count <= 4
  else { return false }
  return parts.dropFirst().allSatisfy { p in
    (2...8).contains(p.count) && p.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
  }
}

/// The mean of the token vectors, `dim` long; zeros when there are none. A token vector of
/// another length is skipped.
public func meanPool(_ tokens: [[Double]], dim: Int) -> [Double] {
  var sum = [Double](repeating: 0, count: dim)
  var n = 0
  for v in tokens where v.count == dim {
    for i in 0..<dim { sum[i] += v[i] }
    n += 1
  }
  guard n > 0 else { return sum }
  return sum.map { $0 / Double(n) }
}

/// Rounded to 6 decimals; NaN and infinities become 0 (keeps the line short and valid JSON).
public func roundedComponent(_ x: Double) -> Double {
  guard x.isFinite else { return 0 }
  return (x * 1_000_000).rounded() / 1_000_000
}

public func encodeEmbedding(vectors: [[Double]], dim: Int, language: String) -> String {
  JSONValue.object([
    ("vectors", .array(vectors.map { .array($0.map { .double(roundedComponent($0)) }) })),
    ("dim", .int(dim)),
    ("language", .string(language)),
  ]).encoded()
}
