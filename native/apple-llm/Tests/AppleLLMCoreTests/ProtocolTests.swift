import Testing

@testable import AppleLLMCore

@Suite("Protocol")
struct ProtocolTests {
  let minimal =
    #"{"system":"s","messages":[{"role":"user","content":"hi"}],"maxTokens":64,"temperature":0.2}"#

  @Test("parses a minimal request")
  func minimalRequest() throws {
    let r = try Request.parse(line: minimal).get()
    #expect(r.id == nil)
    #expect(r.system == "s")
    #expect(r.messages == [Message(role: .user, content: "hi")])
    #expect(r.schema == nil)
    #expect(r.maxTokens == 64)
    #expect(r.temperature == 0.2)
  }

  @Test("parses id, earlier turns, a schema and an integral maxTokens written as 64.0")
  func fullRequest() throws {
    let line =
      #"{"id":"r1","system":"","messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":"c"}],"schema":{"type":"object"},"maxTokens":64.0,"temperature":1}"#
    let r = try Request.parse(line: line).get()
    #expect(r.id == "r1")
    #expect(r.messages.map(\.role) == [.user, .assistant, .user])
    #expect(r.schema == .object([("type", .string("object"))]))
    #expect(r.maxTokens == 64)
    #expect(r.temperature == 1)
  }

  @Test(
    "rejects invalid requests with badRequest, keeping the id when there is one",
    arguments: [
      #"not json"#,
      #"[1]"#,
      #"{"id":"x","system":"s","messages":[],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"assistant","content":"a"}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"system","content":"a"}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a","extra":1}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":0,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":1.5,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":8,"temperature":2.5}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":8,"temperature":-1}"#,
      #"{"id":"x","messages":[{"role":"user","content":"a"}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"schema":"string","maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":8,"temperature":0,"tools":[]}"#,
      #"{"id":"","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":1e300,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":9007199254740992,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"schema":null,"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":{"role":"user","content":"a"},"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a"}],"maxTokens":8,"temperature":"0"}"#,
      #"{"id":"x","system":"s","messages":[{"role":"assistant","content":"a","images":["/a.png"]},{"role":"user","content":"b"}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a","images":[]}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a","images":["a.png"]}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a","images":[1]}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a","images":"/a.png"}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a","images":["/1","/2","/3","/4","/5","/6","/7","/8","/9","/10","/11","/12","/13","/14","/15","/16","/17"]}],"maxTokens":8,"temperature":0}"#,
      #"{"id":"x","system":"s","messages":[{"role":"user","content":"a","images":["/1","/2","/3","/4","/5","/6","/7","/8","/9"]},{"role":"assistant","content":"b"},{"role":"user","content":"c","images":["/1","/2","/3","/4","/5","/6","/7","/8"]}],"maxTokens":8,"temperature":0}"#,
    ])
  func rejects(_ line: String) {
    guard case .failure(let failure) = Request.parse(line: line) else {
      Issue.record("expected a failure for \(line)")
      return
    }
    #expect(!failure.message.isEmpty)
    if line.hasPrefix(#"{"id":"x""#) { #expect(failure.id == "x") }
  }

  @Test("encodes text, JSON, error and status lines in protocol shape")
  func encoders() {
    let usage = Usage(inputTokens: 12, outputTokens: 3, estimated: true)
    #expect(
      encodeAnswer(id: "r1", answer: .text("hi\nthere"), usage: usage)
        == #"{"id":"r1","text":"hi\nthere","usage":{"inputTokens":12,"outputTokens":3,"estimated":true}}"#
    )
    #expect(
      encodeAnswer(id: nil, answer: .json(.object([("n", .int(3))])), usage: usage)
        == #"{"json":{"n":3},"usage":{"inputTokens":12,"outputTokens":3,"estimated":true}}"#)
    #expect(
      encodeError(id: "r2", code: .contextOverflow, message: "too long")
        == #"{"id":"r2","error":{"code":"contextOverflow","message":"too long"}}"#)
    #expect(
      encodeStatus(.ready, contextSize: 4096, vision: false)
        == #"{"status":"ready","contextSize":4096,"vision":false,"highlights":false}"#)
    #expect(
      encodeStatus(.ready, contextSize: 8192, vision: true)
        == #"{"status":"ready","contextSize":8192,"vision":true,"highlights":false}"#)
    #expect(
      encodeStatus(.ready, contextSize: 8192, vision: true, highlights: true)
        == #"{"status":"ready","contextSize":8192,"vision":true,"highlights":true}"#)
  }

  @Test("--highlights answer: ranges and levels in whole ms, key frame or null, errors only when set")
  func highlightsAnswer() {
    let a = HighlightsAnswer(
      highlights: [.init(startMs: 4500, endMs: 14500)],
      levels: [.init(startMs: 0, endMs: 500, level: 0.25)],
      keyFrameMs: 4000)
    #expect(
      encodeHighlights(a)
        == #"{"highlights":[{"startMs":4500,"endMs":14500}],"levels":[{"startMs":0,"endMs":500,"level":0.25}],"keyFrameMs":4000}"#
    )
    let partial = HighlightsAnswer(
      highlights: [], levels: [], keyFrameMs: nil,
      errors: [.init(request: "highlights", message: "failed")])
    #expect(
      encodeHighlights(partial)
        == #"{"highlights":[],"levels":[],"keyFrameMs":null,"errors":[{"request":"highlights","message":"failed"}]}"#
    )
    #expect(milliseconds(4.5) == 4500)
    #expect(milliseconds(0.0004) == 0)
    #expect(milliseconds(-1) == nil)
    #expect(milliseconds(.nan) == nil)
    #expect(milliseconds(.infinity) == nil)
    #expect(roundedLevel(0.12345) == 0.123)
    #expect(roundedLevel(8) == 8)
    #expect(roundedLevel(-0.2) == 0)
    #expect(roundedLevel(.nan) == 0)
  }

  @Test("status and error code names match the agent spec and the TS schemas")
  func names() {
    #expect(
      Status.allCases.map(\.rawValue) == [
        "ready", "notEnabled", "notEligible", "modelNotReady", "unsupportedOS",
      ])
    #expect(
      ErrorCode.allCases.map(\.rawValue) == [
        "badRequest", "unavailable", "contextOverflow", "guardrail", "generation",
        "visionUnavailable",
      ])
  }

  @Test("token estimate: about 4 UTF-16 units per token, at least 1 for non-empty text")
  func estimate() {
    #expect(estimateTokens("") == 0)
    #expect(estimateTokens("a") == 1)
    #expect(estimateTokens("abcd") == 1)
    #expect(estimateTokens("abcde") == 2)
    #expect(estimateTokens("😀😀") == 1)  // 4 UTF-16 units, like JS `length`
  }

  @Test("command-line arguments")
  func arguments() {
    #expect(Command.parse([]) == .serve)
    #expect(Command.parse(["--status"]) == .status)
    #expect(Command.parse(["--help"]) == .help)
    #expect(Command.parse(["-h"]) == .help)
    #expect(Command.parse(["--bogus"]) == .invalid("--bogus"))
    #expect(Command.parse(["--status", "x"]) == .invalid("x"))
    #expect(Command.parse(["--highlights", "/v/a.mp4"]) == .highlights("/v/a.mp4"))
    #expect(Command.parse(["--highlights"]) == .invalid("--highlights"))
    #expect(Command.parse(["--highlights", "/v/a.mp4", "x"]) == .invalid("x"))
  }

  @Test("a lone surrogate escape in a request becomes U+FFFD, like JavaScript strings allow")
  func loneSurrogate() throws {
    let line =
      #"{"id":"x","system":"\ud800","messages":[{"role":"user","content":"a\udc00"}],"maxTokens":8,"temperature":0}"#
    let r = try Request.parse(line: line).get()
    #expect(r.system == "\u{FFFD}")
    #expect(r.prompt == "a\u{FFFD}")
  }

  @Test("maxTokens is capped at the context size")
  func cappedMaxTokens() throws {
    let r = try Request.parse(line: minimal).get()
    #expect(r.maxTokens(cappedAt: 4096) == 64)
    #expect(r.maxTokens(cappedAt: 32) == 32)
  }

  @Test("user messages may carry absolute image paths (D-74), kept in order")
  func images() throws {
    let line =
      #"{"system":"","messages":[{"role":"user","content":"a","images":["/t/1.png"]},{"role":"assistant","content":"b"},{"role":"user","content":"c","images":["/t/2.png","/t/3.png"]}],"maxTokens":8,"temperature":0}"#
    let r = try Request.parse(line: line).get()
    #expect(r.messages[0].images == ["/t/1.png"])
    #expect(r.messages[1].images.isEmpty)
    #expect(r.imagePaths == ["/t/1.png", "/t/2.png", "/t/3.png"])
    #expect(r.prompt == "c")
    #expect(try Request.parse(line: minimal).get().imagePaths.isEmpty)
  }
}
