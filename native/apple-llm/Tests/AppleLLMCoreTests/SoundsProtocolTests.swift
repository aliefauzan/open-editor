import Testing

@testable import AppleLLMCore

@Suite("Sounds protocol (D-83)")
struct SoundsProtocolTests {
  @Test("parses a path with defaults, and every optional field")
  func parses() throws {
    let bare = try SoundsRequest.parse(#"  {"audioPath":"/a/b.m4a"}"# + "\n").get()
    #expect(bare == SoundsRequest(audioPath: "/a/b.m4a", classes: nil))
    #expect(bare.windowSec == 1.5 && bare.minConfidence == 0.5)
    let full = try SoundsRequest.parse(
      #"{"audioPath":"/a.m4a","classes":["laughter","chuckle_chortle"],"windowSec":3,"minConfidence":0.25}"#
    ).get()
    #expect(
      full
        == SoundsRequest(
          audioPath: "/a.m4a", classes: ["laughter", "chuckle_chortle"], windowSec: 3,
          minConfidence: 0.25))
  }

  @Test(
    "rejects bad requests",
    arguments: [
      "nope", "[]", "{}", #"{"audioPath":"a.m4a"}"#, #"{"audioPath":7}"#,
      #"{"audioPath":"/a","extra":1}"#, #"{"audioPath":"/a","classes":[]}"#,
      #"{"audioPath":"/a","classes":"laughter"}"#, #"{"audioPath":"/a","classes":["Laughter"]}"#,
      #"{"audioPath":"/a","classes":[""]}"#, #"{"audioPath":"/a","classes":[1]}"#,
      #"{"audioPath":"/a","windowSec":0.1}"#, #"{"audioPath":"/a","windowSec":16}"#,
      #"{"audioPath":"/a","windowSec":"1"}"#, #"{"audioPath":"/a","minConfidence":1.5}"#,
      #"{"audioPath":"/a","minConfidence":-0.1}"#,
    ])
  func rejects(_ line: String) {
    if case .success = SoundsRequest.parse(line) { Issue.record("accepted \(line)") }
  }

  @Test("class ids")
  func classIds() {
    for ok in ["laughter", "chuckle_chortle", "keyboard_musical", "a", "x2"] {
      #expect(isSoundClassId(ok), "\(ok)")
    }
    for bad in ["", "Laughter", "belly laugh", "a-b", String(repeating: "a", count: 65)] {
      #expect(!isSoundClassId(bad), "\(bad)")
    }
  }

  @Test("keeps the requested classes above the bar, highest first, 3 decimals")
  func keeps() {
    let raw: [(id: String, confidence: Double)] = [
      ("speech", 0.9), ("laughter", 0.61234), ("applause", 0.7), ("music", 0.2),
      ("cheering", 0.7), ("giggling", .nan),
    ]
    #expect(
      keptLabels(raw, classes: ["laughter", "applause", "cheering", "music", "giggling"], minConfidence: 0.5)
        == [
          .init(id: "applause", confidence: 0.7), .init(id: "cheering", confidence: 0.7),
          .init(id: "laughter", confidence: 0.612),
        ])
    #expect(keptLabels(raw, classes: nil, minConfidence: 0.8) == [.init(id: "speech", confidence: 0.9)])
    #expect(keptLabels(raw, classes: ["music"], minConfidence: 0.5).isEmpty)
    #expect(roundedConfidence(1.2) == 1 && roundedConfidence(-1) == 0 && roundedConfidence(.infinity) == 0)
  }

  @Test("encodes the answer in protocol shape")
  func encodes() {
    let a = SoundsAnswer(
      windows: [
        .init(startMs: 0, endMs: 1500, labels: [.init(id: "laughter", confidence: 0.75)]),
        .init(
          startMs: 3000, endMs: 4500,
          labels: [.init(id: "applause", confidence: 0.9), .init(id: "cheering", confidence: 0.5)]),
      ], windowMs: 1500)
    #expect(
      encodeSounds(a)
        == #"{"windows":[{"startMs":0,"endMs":1500,"labels":[{"id":"laughter","confidence":0.75}]},{"startMs":3000,"endMs":4500,"labels":[{"id":"applause","confidence":0.9},{"id":"cheering","confidence":0.5}]}],"windowMs":1500}"#
    )
    #expect(encodeSounds(SoundsAnswer(windows: [], windowMs: 1500)) == #"{"windows":[],"windowMs":1500}"#)
  }
}
