// The JSON-lines protocol (agent spec "Apple on-device model"). Mirrors the zod schemas in
// packages/agent/src/providers/apple-protocol.ts; field names and codes must stay identical.
//
//   stdin  {"id"?, "system", "messages":[{"role":"user"|"assistant","content"}], "schema"?,
//           "maxTokens", "temperature"}
//   stdout {"id"?, "text", "usage"} | {"id"?, "json", "usage"} | {"id"?, "error":{"code","message"}}
//   --status → {"status", "contextSize"}

/// `--status` availability values, in the agent spec's order.
public enum Status: String, CaseIterable, Sendable {
  case ready, notEnabled, notEligible, modelNotReady, unsupportedOS
}

public enum ErrorCode: String, CaseIterable, Sendable {
  case badRequest, unavailable, contextOverflow, guardrail, generation
}

/// Context size reported when the framework gives none (agent spec, plan phase 11).
public let defaultContextSize = 4096

public struct Message: Equatable, Sendable {
  public enum Role: String, Sendable { case user, assistant }
  public let role: Role
  public let content: String

  public init(role: Role, content: String) {
    self.role = role
    self.content = content
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
      guard case .object(let m) = raw, m.allSatisfy({ $0.0 == "role" || $0.0 == "content" }),
        let roleName = raw["role"]?.stringValue, let role = Message.Role(rawValue: roleName),
        let content = raw["content"]?.stringValue
      else { return fail("each message needs role user|assistant and string content") }
      messages.append(Message(role: role, content: content))
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

public func encodeStatus(_ status: Status, contextSize: Int) -> String {
  JSONValue.object([("status", .string(status.rawValue)), ("contextSize", .int(contextSize))])
    .encoded()
}

/// Command-line modes.
public enum Command: Equatable, Sendable {
  case serve
  case status
  case help
  case invalid(String)

  public static func parse(_ args: [String]) -> Command {
    guard let first = args.first else { return .serve }
    let mode: Command
    switch first {
    case "--status": mode = .status
    case "--help", "-h": mode = .help
    default: return .invalid(first)
    }
    return args.count == 1 ? mode : .invalid(args[1])
  }

  public static let usage = """
    usage: vox-apple-llm [--status]
      reads JSON-lines requests on stdin and answers one line each on stdout
      --status  print {"status","contextSize"} and exit

    """
}
