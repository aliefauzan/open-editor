// `--sounds` (D-83): sound-class tags per time window from SoundAnalysis' built-in classifier
// (`SNClassifySoundRequest(classifierIdentifier: .version1)`, macOS 12+, 303 classes such as
// `laughter`, `applause`, `cheering`, `music`, `speech`). Pure parsing, filtering and encoding;
// the SoundAnalysis calls live in the executable (Sounds.swift).
//
//   stdin  {"audioPath": absolute path, "classes"?: [string], "windowSec"?: number,
//           "minConfidence"?: number}                                 one JSON object (one line)
//   stdout {"windows":[{"startMs","endMs","labels":[{"id","confidence"}]}], "windowMs"}
//          | {"error":{"code","message"}}
//
// `classes` keeps only those class ids (all classes when absent); a label is kept when its
// confidence is at least `minConfidence` (default 0.5). Windows with no label left are dropped, so
// the answer stays small. Labels are sorted by confidence, highest first; confidence has 3 decimals.

/// Window length when the request has none: the classifier's own default is 0.975 s; 1.5 s
/// halves the windows and still places a laugh or a round of applause to the second.
public let defaultSoundWindowSec = 1.5
/// The classifier accepts windows from 0.5 s to about 15 s (`windowDurationConstraint`).
public let soundWindowRange: ClosedRange<Double> = 0.5...15
public let defaultSoundMinConfidence = 0.5
/// Most class ids one request may name (the classifier knows 303).
public let maxSoundClasses = 400

public struct SoundsRequest: Equatable, Sendable {
  public let audioPath: String
  /// Class ids to keep, or nil for all.
  public let classes: [String]?
  public let windowSec: Double
  public let minConfidence: Double

  public init(
    audioPath: String, classes: [String]?, windowSec: Double = defaultSoundWindowSec,
    minConfidence: Double = defaultSoundMinConfidence
  ) {
    self.audioPath = audioPath
    self.classes = classes
    self.windowSec = windowSec
    self.minConfidence = minConfidence
  }

  static let fields: Set<String> = ["audioPath", "classes", "windowSec", "minConfidence"]

  /// Parses and validates the request text (one JSON object).
  public static func parse(_ text: String) -> Result<SoundsRequest, Request.Failure> {
    func fail(_ message: String) -> Result<SoundsRequest, Request.Failure> {
      .failure(Request.Failure(id: nil, message: message))
    }
    let json: JSONValue
    do {
      json = try JSONValue.parse(
        String(text.drop(while: \.isWhitespace).reversed().drop(while: \.isWhitespace).reversed()))
    } catch {
      return fail("sounds request is not valid JSON (\(error))")
    }
    guard case .object(let pairs) = json else { return fail("sounds request must be a JSON object") }
    if let extra = pairs.first(where: { !fields.contains($0.0) }) {
      return fail("unknown field: \(extra.0)")
    }
    guard let path = json["audioPath"]?.stringValue, path.hasPrefix("/") else {
      return fail("audioPath must be an absolute path")
    }
    var classes: [String]?
    if let raw = json["classes"] {
      guard case .array(let list) = raw, !list.isEmpty, list.count <= maxSoundClasses else {
        return fail("classes must be an array of 1 to \(maxSoundClasses) class ids")
      }
      var ids: [String] = []
      for item in list {
        guard let s = item.stringValue, isSoundClassId(s) else {
          return fail("each class must be a class id such as \"laughter\"")
        }
        ids.append(s)
      }
      classes = ids
    }
    var windowSec = defaultSoundWindowSec
    if let raw = json["windowSec"] {
      guard let w = raw.doubleValue, w.isFinite, soundWindowRange.contains(w) else {
        return fail(
          "windowSec must be a number from \(soundWindowRange.lowerBound) to \(soundWindowRange.upperBound)"
        )
      }
      windowSec = w
    }
    var minConfidence = defaultSoundMinConfidence
    if let raw = json["minConfidence"] {
      guard let c = raw.doubleValue, c.isFinite, (0...1).contains(c) else {
        return fail("minConfidence must be a number from 0 to 1")
      }
      minConfidence = c
    }
    return .success(
      SoundsRequest(
        audioPath: path, classes: classes, windowSec: windowSec, minConfidence: minConfidence))
  }
}

/// `laughter`, `chuckle_chortle`, `keyboard_musical`: lower-case letters, digits and `_`, 1–64.
public func isSoundClassId(_ s: String) -> Bool {
  (1...64).contains(s.count)
    && s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "_") }
}

public struct SoundsAnswer: Equatable, Sendable {
  public struct Label: Equatable, Sendable {
    public let id: String
    public let confidence: Double
    public init(id: String, confidence: Double) {
      self.id = id
      self.confidence = confidence
    }
  }
  public struct Window: Equatable, Sendable {
    public let startMs: Int
    public let endMs: Int
    public let labels: [Label]
    public init(startMs: Int, endMs: Int, labels: [Label]) {
      self.startMs = startMs
      self.endMs = endMs
      self.labels = labels
    }
  }
  public let windows: [Window]
  /// The window length the classifier ran with, in whole milliseconds.
  public let windowMs: Int

  public init(windows: [Window], windowMs: Int) {
    self.windows = windows
    self.windowMs = windowMs
  }
}

/// The labels of one window to keep: in `classes` (all when nil), confidence at least
/// `minConfidence`, rounded to 3 decimals, highest first (ties by id).
public func keptLabels(
  _ classifications: [(id: String, confidence: Double)], classes: Set<String>?,
  minConfidence: Double
) -> [SoundsAnswer.Label] {
  classifications
    .filter { c in
      c.confidence.isFinite && c.confidence >= minConfidence && (classes?.contains(c.id) ?? true)
    }
    .map { SoundsAnswer.Label(id: $0.id, confidence: roundedConfidence($0.confidence)) }
    .sorted { $0.confidence != $1.confidence ? $0.confidence > $1.confidence : $0.id < $1.id }
}

/// 3 decimals, clamped to 0...1 (NaN and infinities become 0).
public func roundedConfidence(_ c: Double) -> Double {
  guard c.isFinite else { return 0 }
  return (min(1, max(0, c)) * 1000).rounded() / 1000
}

public func encodeSounds(_ a: SoundsAnswer) -> String {
  JSONValue.object([
    (
      "windows",
      .array(
        a.windows.map { w in
          .object([
            ("startMs", .int(w.startMs)), ("endMs", .int(w.endMs)),
            (
              "labels",
              .array(
                w.labels.map {
                  .object([("id", .string($0.id)), ("confidence", .double($0.confidence))])
                })
            ),
          ])
        })
    ),
    ("windowMs", .int(a.windowMs)),
  ]).encoded()
}
