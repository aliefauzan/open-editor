import Testing

@testable import AppleLLMCore

@Suite("JSONValue")
struct JSONValueTests {
  @Test("parses every JSON kind and keeps object key order")
  func parsesKinds() throws {
    let v = try JSONValue.parse(#"{"z":1,"a":[true,false,null],"m":-2.5e1,"s":"x"}"#)
    #expect(
      v
        == .object([
          ("z", .int(1)),
          ("a", .array([.bool(true), .bool(false), .null])),
          ("m", .double(-25)),
          ("s", .string("x")),
        ]))
    #expect(v.objectKeys == ["z", "a", "m", "s"])
  }

  @Test("decodes escapes, \\u escapes and surrogate pairs")
  func escapes() throws {
    let v = try JSONValue.parse(#""a\"b\\c\/d\n\t\u00e9\ud83d\ude00""#)
    #expect(v == .string("a\"b\\c/d\n\té😀"))
  }

  @Test(
    "a lone surrogate escape decodes to U+FFFD and the next escape is kept",
    arguments: [
      (#""\ud800""#, "\u{FFFD}"),
      (#""\udc00a""#, "\u{FFFD}a"),
      (#""\ud800\u0041""#, "\u{FFFD}A"),
      (#""\ud800\ud83d\ude00""#, "\u{FFFD}😀"),
      (#""\ud800x""#, "\u{FFFD}x"),
    ])
  func loneSurrogates(_ text: String, _ expected: String) throws {
    #expect(try JSONValue.parse(text) == .string(expected))
  }

  @Test("an integral number with a fraction or exponent stays a double; a plain one is an int")
  func numbers() throws {
    #expect(try JSONValue.parse("64") == .int(64))
    #expect(try JSONValue.parse("64.0") == .double(64))
    #expect(try JSONValue.parse("1e2") == .double(100))
    #expect(try JSONValue.parse("-0") == .int(0))
  }

  @Test(
    "rejects malformed JSON",
    arguments: ["", "{", "[1,]", "{\"a\":1,}", "tru", "\"unterminated", "01", "1 2", "{\"a\" 1}", "\"\\x\"",
      "\"\u{01}\"", "NaN"])
  func rejects(_ text: String) {
    #expect(throws: JSONError.self) { try JSONValue.parse(text) }
  }

  @Test("encodes compactly on one line, escaping control characters and quotes")
  func encodes() {
    let v = JSONValue.object([
      ("text", .string("line1\nline2\r\t\"q\"\\ \u{01}")),
      ("n", .int(3)),
      ("d", .double(0.5)),
      ("inf", .double(.infinity)),
      ("list", .array([.bool(true), .null])),
    ])
    #expect(
      v.encoded()
        == #"{"text":"line1\nline2\r\t\"q\"\\ \u0001","n":3,"d":0.5,"inf":null,"list":[true,null]}"#)
  }

  @Test("encode then parse round-trips")
  func roundTrip() throws {
    let v = JSONValue.object([("é", .string("😀\u{2028}")), ("a", .array([.double(1.25), .int(-7)]))])
    #expect(try JSONValue.parse(v.encoded()) == v)
  }
}
