// The JSON-lines protocol (agent spec "Apple on-device model"). Mirrors the zod schemas in
// packages/agent/src/providers/apple-protocol.ts; field names and codes must stay identical.
//
//   stdin  {"id"?, "system", "messages":[{"role":"user"|"assistant","content","images"?}],
//           "schema"?, "maxTokens", "temperature"}
//   stdout {"id"?, "text", "usage"} | {"id"?, "json", "usage"} | {"id"?, "error":{"code","message"}}
//   --status → {"status", "contextSize", "vision", "highlights", "embed", "sounds"}
//   --highlights <videoPath> → {"highlights":[{"startMs","endMs"}], "levels":[{"startMs","endMs",
//           "level"}], "keyFrameMs", "errors"?} | {"error":{"code","message"}} (D-75)
//   --embed (stdin {"texts", "language"?}) → {"vectors", "dim", "language"} | {"error"} (D-77,
//           EmbedProtocol.swift)
//   --sounds (stdin {"audioPath", "classes"?, "windowSec"?, "minConfidence"?}) → {"windows",
//           "windowMs"} | {"error"} (D-83, SoundsProtocol.swift)
//
// `images` (user messages only, D-74) lists absolute paths of image files the caller wrote; the
// helper reads them only when the model can see images (macOS 27, `vision` capability) and
// otherwise answers `visionUnavailable`.

/// `--status` availability values, in the agent spec's order.
public enum Status: String, CaseIterable, Sendable {
  case ready, notEnabled, notEligible, modelNotReady, unsupportedOS
}

public enum ErrorCode: String, CaseIterable, Sendable {
  case badRequest, unavailable, contextOverflow, guardrail, generation
  /// The request has images but the model cannot see them (before macOS 27, or no `vision`).
  case visionUnavailable
  /// `--embed`: the language's embedding model is not on this Mac and could not be downloaded.
  case assetsMissing
}

/// Context size reported when the framework gives none (agent spec, plan phase 11).
public let defaultContextSize = 4096

/// Most images one request may carry (the agent sends at most 8 stills per call).
public let maxImagesPerRequest = 16

public struct Message: Equatable, Sendable {
  public enum Role: String, Sendable { case user, assistant }
  public let role: Role
  public let content: String
  /// Absolute paths of image files (user messages only).
  public let images: [String]

  public init(role: Role, content: String, images: [String] = []) {
    self.role = role
    self.content = content
    self.images = images
  }
}

public struct Request: Equatable, Sendable {
  public let id: String?
  public let system: String
  public let messages: [Message]
  public let schema: JSONValue?
  public let maxTokens: Int
  public let temperature: Double

  /// The final user message (validated to exist).
  public var prompt: String { messages[messages.count - 1].content }

  /// `maxTokens`, at most the model's context size (an answer cannot be longer).
  public func maxTokens(cappedAt contextSize: Int) -> Int { min(maxTokens, contextSize) }

  /// Every image path, in message order.
  public var imagePaths: [String] { messages.flatMap(\.images) }

  /// Every input text, for the token estimate (same rule as the fake helper).
  public var inputText: String { system + messages.map(\.content).joined() }

  public struct Failure: Error, Equatable {
    public let id: String?
    public let message: String
  }

  static let fields: Set<String> = ["id", "system", "messages", "schema", "maxTokens", "temperature"]

  /// Parses and validates one request line. On failure the `id` is kept when it was readable.
  public static func parse(line: String) -> Result<Request, Failure> {
    let json: JSONValue
    do {
      json = try JSONValue.parse(line)
    } catch {
      return .failure(Failure(id: nil, message: "request line is not valid JSON (\(error))"))
    }
    guard case .object(let pairs) = json else {
      return .failure(Failure(id: nil, message: "request must be a JSON object"))
    }
    var id: String?
    if case .string(let s)? = json["id"], !s.isEmpty { id = s }
    func fail(_ message: String) -> Result<Request, Failure> {
      .failure(Failure(id: id, message: message))
    }

    if let extra = pairs.first(where: { !fields.contains($0.0) }) {
      return fail("unknown field: \(extra.0)")
    }
    if let raw = json["id"], id == nil || raw.stringValue == nil {
      return fail("id must be a non-empty string")
    }
    guard let system = json["system"]?.stringValue else { return fail("system must be a string") }
    guard case .array(let rawMessages)? = json["messages"], !rawMessages.isEmpty else {
      return fail("messages must be a non-empty array")
    }
    var messages: [Message] = []
    for raw in rawMessages {
      guard case .object(let m) = raw,
        m.allSatisfy({ $0.0 == "role" || $0.0 == "content" || $0.0 == "images" }),
        let roleName = raw["role"]?.stringValue, let role = Message.Role(rawValue: roleName),
        let content = raw["content"]?.stringValue
      else { return fail("each message needs role user|assistant and string content") }
      var images: [String] = []
      if let rawImages = raw["images"] {
        guard role == .user else { return fail("only user messages may have images") }
        guard case .array(let list) = rawImages, !list.isEmpty,
          list.count <= maxImagesPerRequest
        else { return fail("images must be an array of 1 to \(maxImagesPerRequest) paths") }
        for item in list {
          guard let path = item.stringValue, path.hasPrefix("/") else {
            return fail("each image must be an absolute file path")
          }
          images.append(path)
        }
      }
      messages.append(Message(role: role, content: content, images: images))
    }
    if messages.reduce(0, { $0 + $1.images.count }) > maxImagesPerRequest {
      return fail("a request may carry at most \(maxImagesPerRequest) images")
    }
    guard messages[messages.count - 1].role == .user else {
      return fail("the last message must be from the user")
    }
    let schema = json["schema"]
    if let schema, schema.objectKeys == nil { return fail("schema must be a JSON object") }
    guard let maxTokens = json["maxTokens"]?.integralValue, maxTokens > 0,
      maxTokens <= SchemaNode.safeInteger
    else { return fail("maxTokens must be a positive safe integer") }
    guard let temperature = json["temperature"]?.doubleValue, temperature >= 0, temperature <= 2
    else { return fail("temperature must be a number from 0 to 2") }

    return .success(
      Request(
        id: id, system: system, messages: messages, schema: schema, maxTokens: maxTokens,
        temperature: temperature))
  }
}

public struct Usage: Equatable, Sendable {
  public let inputTokens: Int
  public let outputTokens: Int
  /// True when the framework reported no token counts and these are estimates.
  public let estimated: Bool

  public init(inputTokens: Int, outputTokens: Int, estimated: Bool) {
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.estimated = estimated
  }

  /// Estimates both counts from the texts.
  public static func estimate(input: String, output: String) -> Usage {
    Usage(
      inputTokens: estimateTokens(input), outputTokens: estimateTokens(output), estimated: true)
  }
}

/// About 4 characters per token, counted in UTF-16 units like JavaScript `length`;
/// at least 1 for non-empty text.
public func estimateTokens(_ text: String) -> Int {
  let n = text.utf16.count
  return n == 0 ? 0 : max(1, (n + 3) / 4)
}

public enum Answer: Equatable, Sendable {
  case text(String)
  case json(JSONValue)
}

private func line(id: String?, _ pairs: [(String, JSONValue)]) -> String {
  JSONValue.object((id.map { [("id", JSONValue.string($0))] } ?? []) + pairs).encoded()
}

public func encodeAnswer(id: String?, answer: Answer, usage: Usage) -> String {
  let body: (String, JSONValue)
  switch answer {
  case .text(let t): body = ("text", .string(t))
  case .json(let j): body = ("json", j)
  }
  let u = JSONValue.object([
    ("inputTokens", .int(usage.inputTokens)),
    ("outputTokens", .int(usage.outputTokens)),
    ("estimated", .bool(usage.estimated)),
  ])
  return line(id: id, [body, ("usage", u)])
}

public func encodeError(id: String?, code: ErrorCode, message: String) -> String {
  line(id: id, [("error", .object([("code", .string(code.rawValue)), ("message", .string(message))]))])
}

/// `highlights`: this Mac can run `--highlights` (macOS 27 MediaIntelligence, D-75).
/// `embed`: this Mac can run `--embed` (NaturalLanguage contextual embeddings, D-77); it does
/// not need Apple Intelligence, so it can be true whatever `status` says.
/// `sounds`: this Mac can run `--sounds` (SoundAnalysis sound classifier, D-83); like `embed` it
/// does not depend on `status`.
public func encodeStatus(
  _ status: Status, contextSize: Int, vision: Bool, highlights: Bool = false, embed: Bool = false,
  sounds: Bool = false
) -> String {
  JSONValue.object([
    ("status", .string(status.rawValue)), ("contextSize", .int(contextSize)),
    ("vision", .bool(vision)), ("highlights", .bool(highlights)), ("embed", .bool(embed)),
    ("sounds", .bool(sounds)),
  ]).encoded()
}

/// The answer of `--highlights <videoPath>` (D-75), times in whole milliseconds of the video.
/// One of the two analyses may fail while the other succeeds: its part is empty (or `nil` for the
/// key frame) and `errors` names it.
public struct HighlightsAnswer: Equatable, Sendable {
  public struct Range: Equatable, Sendable {
    public let startMs: Int
    public let endMs: Int
    public init(startMs: Int, endMs: Int) {
      self.startMs = startMs
      self.endMs = endMs
    }
  }
  public struct Level: Equatable, Sendable {
    public let startMs: Int
    public let endMs: Int
    /// Highlight level of this step as the framework reports it (on macOS 27.0 whole numbers
    /// from about 0 to 10; the engine normalises over the video), never negative.
    public let level: Double
    public init(startMs: Int, endMs: Int, level: Double) {
      self.startMs = startMs
      self.endMs = endMs
      self.level = level
    }
  }
  public struct Failure: Equatable, Sendable {
    /// `highlights` or `keyFrame`.
    public let request: String
    public let message: String
    public init(request: String, message: String) {
      self.request = request
      self.message = message
    }
  }
  public let highlights: [Range]
  public let levels: [Level]
  public let keyFrameMs: Int?
  public let errors: [Failure]

  public init(highlights: [Range], levels: [Level], keyFrameMs: Int?, errors: [Failure] = []) {
    self.highlights = highlights
    self.levels = levels
    self.keyFrameMs = keyFrameMs
    self.errors = errors
  }
}

/// Seconds to whole milliseconds; nil for a time that is not finite or is negative.
public func milliseconds(_ seconds: Double) -> Int? {
  guard seconds.isFinite, seconds >= 0, seconds < Double(SchemaNode.safeInteger) / 1000 else {
    return nil
  }
  return Int((seconds * 1000).rounded())
}

/// A level rounded to 3 decimals, at least 0 (NaN and infinities become 0).
public func roundedLevel(_ level: Double) -> Double {
  guard level.isFinite else { return 0 }
  return (max(0, level) * 1000).rounded() / 1000
}

public func encodeHighlights(_ a: HighlightsAnswer) -> String {
  var pairs: [(String, JSONValue)] = [
    (
      "highlights",
      .array(
        a.highlights.map { .object([("startMs", .int($0.startMs)), ("endMs", .int($0.endMs))]) })
    ),
    (
      "levels",
      .array(
        a.levels.map {
          .object([
            ("startMs", .int($0.startMs)), ("endMs", .int($0.endMs)), ("level", .double($0.level)),
          ])
        })
    ),
    ("keyFrameMs", a.keyFrameMs.map { .int($0) } ?? .null),
  ]
  if !a.errors.isEmpty {
    pairs.append(
      (
        "errors",
        .array(
          a.errors.map {
            .object([("request", .string($0.request)), ("message", .string($0.message))])
          })
      ))
  }
  return JSONValue.object(pairs).encoded()
}

/// Command-line modes.
public enum Command: Equatable, Sendable {
  case serve
  case status
  case help
  /// `--highlights <videoPath>`: one MediaIntelligence analysis, one line, exit (D-75).
  case highlights(String)
  /// `--embed`: one request on stdin, one line of vectors, exit (D-77).
  case embed
  /// `--sounds`: one request on stdin, one line of sound-class windows, exit (D-83).
  case sounds
  case invalid(String)

  public static func parse(_ args: [String]) -> Command {
    guard let first = args.first else { return .serve }
    if first == "--highlights" {
      guard args.count >= 2 else { return .invalid(first) }
      guard args.count == 2 else { return .invalid(args[2]) }
      return .highlights(args[1])
    }
    let mode: Command
    switch first {
    case "--status": mode = .status
    case "--embed": mode = .embed
    case "--sounds": mode = .sounds
    case "--help", "-h": mode = .help
    default: return .invalid(first)
    }
    return args.count == 1 ? mode : .invalid(args[1])
  }

  public static let usage = """
    usage: vox-apple-llm [--status | --highlights <videoPath> | --embed | --sounds]
      reads JSON-lines requests on stdin and answers one line each on stdout
      --status      print {"status","contextSize","vision","highlights","embed","sounds"} and exit
      --highlights  print the video's highlight ranges, levels and key frame (macOS 27) and exit
      --embed       read {"texts","language"?} on stdin, print {"vectors","dim","language"} and exit
      --sounds      read {"audioPath","classes"?,"windowSec"?,"minConfidence"?} on stdin, print
                    {"windows":[{"startMs","endMs","labels":[{"id","confidence"}]}],"windowMs"} and exit

    """
}
