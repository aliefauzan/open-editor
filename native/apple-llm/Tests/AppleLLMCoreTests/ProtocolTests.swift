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
    #expect(encodeStatus(.ready, contextSize: 4096) == #"{"status":"ready","contextSize":4096}"#)
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
  }
}
