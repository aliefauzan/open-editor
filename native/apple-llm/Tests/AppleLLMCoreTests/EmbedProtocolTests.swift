import Testing

@testable import AppleLLMCore

@Suite("Embed protocol (D-77)")
struct EmbedProtocolTests {
  @Test("parses texts and an optional language; surrounding whitespace is fine")
  func parses() throws {
    let r = try EmbedRequest.parse(#"  {"texts":["a","",""],"language":"id"}"# + "\n").get()
    #expect(r == EmbedRequest(texts: ["a", "", ""], language: "id"))
    let bare = try EmbedRequest.parse(#"{"texts":["hello"]}"#).get()
    #expect(bare.language == nil)
  }

  @Test(
    "rejects bad requests",
    arguments: [
      "nope", "[]", #"{"texts":[]}"#, #"{"texts":"a"}"#, #"{"texts":[1]}"#,
      #"{"texts":["a"],"extra":1}"#, #"{"texts":["a"],"language":"english!"}"#,
      #"{"texts":["a"],"language":7}"#,
    ])
  func rejects(_ line: String) {
    if case .success = EmbedRequest.parse(line) { Issue.record("accepted \(line)") }
  }

  @Test("at most 512 texts of at most 4000 UTF-16 units")
  func limits() {
    let many = "{\"texts\":[" + Array(repeating: "\"a\"", count: maxEmbedTexts + 1).joined(separator: ",") + "]}"
    if case .success = EmbedRequest.parse(many) { Issue.record("accepted 513 texts") }
    let long = "{\"texts\":[\"" + String(repeating: "x", count: maxEmbedTextLength + 1) + "\"]}"
    if case .success = EmbedRequest.parse(long) { Issue.record("accepted a long text") }
    let edge = "{\"texts\":[\"" + String(repeating: "x", count: maxEmbedTextLength) + "\"]}"
    #expect((try? EmbedRequest.parse(edge).get()) != nil)
  }

  @Test("language codes")
  func languageCodes() {
    for ok in ["en", "id", "zh-Hans", "pt-BR", "fil"] { #expect(isLanguageCode(ok), "\(ok)") }
    for bad in ["", "e", "english", "en-", "en_US", "e1", "en-x"] {
      #expect(!isLanguageCode(bad), "\(bad)")
    }
  }

  @Test("mean pooling: the average token vector; zeros for no tokens; wrong lengths skipped")
  func pooling() {
    #expect(meanPool([[1, 2], [3, 4]], dim: 2) == [2, 3])
    #expect(meanPool([], dim: 3) == [0, 0, 0])
    #expect(meanPool([[1, 1], [9, 9, 9]], dim: 2) == [1, 1])
  }

  @Test("answer line: vectors rounded to 6 decimals, dim and language")
  func encodes() {
    #expect(
      encodeEmbedding(vectors: [[0.1234567, -1], [0, .nan]], dim: 2, language: "en")
        == #"{"vectors":[[0.123457,-1],[0,0]],"dim":2,"language":"en"}"#)
  }
}
