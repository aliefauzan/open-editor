// A small JSON value with ordered object keys (JSON Schema property order drives the order of
// guided generation) and a strict parser and compact one-line encoder.

public enum JSONValue: Sendable {
  case null
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([JSONValue])
  case object([(String, JSONValue)])

  /// Value of `key` in an object (first match), else nil.
  public subscript(key: String) -> JSONValue? {
    guard case .object(let pairs) = self else { return nil }
    return pairs.first { $0.0 == key }?.1
  }

  public var objectKeys: [String]? {
    guard case .object(let pairs) = self else { return nil }
    return pairs.map(\.0)
  }

  public var stringValue: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  /// A number as Double (int or double), else nil.
  public var doubleValue: Double? {
    switch self {
    case .int(let i): return Double(i)
    case .double(let d): return d
    default: return nil
    }
  }

  /// An integral number as Int (`64` or `64.0`), else nil.
  public var integralValue: Int? {
    switch self {
    case .int(let i): return i
    case .double(let d):
      guard d.rounded() == d, abs(d) < 9.0e15 else { return nil }
      return Int(d)
    default: return nil
    }
  }
}

extension JSONValue: Equatable {
  public static func == (a: JSONValue, b: JSONValue) -> Bool {
    switch (a, b) {
    case (.null, .null): return true
    case (.bool(let x), .bool(let y)): return x == y
    case (.int(let x), .int(let y)): return x == y
    case (.double(let x), .double(let y)): return x == y
    case (.string(let x), .string(let y)): return x == y
    case (.array(let x), .array(let y)): return x == y
    case (.object(let x), .object(let y)):
      return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    default: return false
    }
  }
}

public struct JSONError: Error, Equatable, CustomStringConvertible {
  public let message: String
  public let offset: Int
  public var description: String { "\(message) at byte \(offset)" }
}

// MARK: - Parser

extension JSONValue {
  /// Parses exactly one JSON value (RFC 8259); surrounding whitespace is allowed.
  public static func parse(_ text: String) throws(JSONError) -> JSONValue {
    var p = Parser(bytes: Array(text.utf8))
    p.skipWhitespace()
    let value = try p.value(depth: 0)
    p.skipWhitespace()
    guard p.i == p.bytes.count else { throw p.fail("unexpected trailing data") }
    return value
  }
}

private struct Parser {
  let bytes: [UInt8]
  var i = 0
  static let maxDepth = 256

  init(bytes: [UInt8]) { self.bytes = bytes }

  func fail(_ message: String) -> JSONError { JSONError(message: message, offset: i) }

  var peek: UInt8? { i < bytes.count ? bytes[i] : nil }

  mutating func skipWhitespace() {
    while let c = peek, c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 { i += 1 }
  }

  mutating func expect(_ literal: String) throws(JSONError) {
    for b in literal.utf8 {
      guard peek == b else { throw fail("invalid literal") }
      i += 1
    }
  }

  mutating func value(depth: Int) throws(JSONError) -> JSONValue {
    guard depth < Parser.maxDepth else { throw fail("nesting too deep") }
    guard let c = peek else { throw fail("unexpected end of input") }
    switch c {
    case UInt8(ascii: "{"): return try object(depth: depth)
    case UInt8(ascii: "["): return try array(depth: depth)
    case UInt8(ascii: "\""): return .string(try string())
    case UInt8(ascii: "t"):
      try expect("true")
      return .bool(true)
    case UInt8(ascii: "f"):
      try expect("false")
      return .bool(false)
    case UInt8(ascii: "n"):
      try expect("null")
      return .null
    case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return try number()
    default: throw fail("unexpected character")
    }
  }

  mutating func object(depth: Int) throws(JSONError) -> JSONValue {
    i += 1
    var pairs: [(String, JSONValue)] = []
    skipWhitespace()
    if peek == UInt8(ascii: "}") {
      i += 1
      return .object(pairs)
    }
    while true {
      skipWhitespace()
      guard peek == UInt8(ascii: "\"") else { throw fail("expected a string key") }
      let key = try string()
      skipWhitespace()
      guard peek == UInt8(ascii: ":") else { throw fail("expected ':'") }
      i += 1
      skipWhitespace()
      pairs.append((key, try value(depth: depth + 1)))
      skipWhitespace()
      if peek == UInt8(ascii: ",") {
        i += 1
        continue
      }
      guard peek == UInt8(ascii: "}") else { throw fail("expected ',' or '}'") }
      i += 1
      return .object(pairs)
    }
  }

  mutating func array(depth: Int) throws(JSONError) -> JSONValue {
    i += 1
    var items: [JSONValue] = []
    skipWhitespace()
    if peek == UInt8(ascii: "]") {
      i += 1
      return .array(items)
    }
    while true {
      skipWhitespace()
      items.append(try value(depth: depth + 1))
      skipWhitespace()
      if peek == UInt8(ascii: ",") {
        i += 1
        continue
      }
      guard peek == UInt8(ascii: "]") else { throw fail("expected ',' or ']'") }
      i += 1
      return .array(items)
    }
  }

  mutating func hex4() throws(JSONError) -> UInt16 {
    guard i + 4 <= bytes.count else { throw fail("short \\u escape") }
    var v: UInt16 = 0
    for _ in 0..<4 {
      let c = bytes[i]
      let d: UInt8
      switch c {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): d = c - UInt8(ascii: "0")
      case UInt8(ascii: "a")...UInt8(ascii: "f"): d = c - UInt8(ascii: "a") + 10
      case UInt8(ascii: "A")...UInt8(ascii: "F"): d = c - UInt8(ascii: "A") + 10
      default: throw fail("bad hex digit")
      }
      v = v << 4 | UInt16(d)
      i += 1
    }
    return v
  }

  mutating func string() throws(JSONError) -> String {
    i += 1  // opening quote
    var units: [UInt8] = []
    while true {
      guard let c = peek else { throw fail("unterminated string") }
      i += 1
      switch c {
      case UInt8(ascii: "\""):
        return String(decoding: units, as: UTF8.self)
      case UInt8(ascii: "\\"):
        guard let e = peek else { throw fail("unterminated escape") }
        i += 1
        switch e {
        case UInt8(ascii: "\""): units.append(0x22)
        case UInt8(ascii: "\\"): units.append(0x5C)
        case UInt8(ascii: "/"): units.append(0x2F)
        case UInt8(ascii: "b"): units.append(0x08)
        case UInt8(ascii: "f"): units.append(0x0C)
        case UInt8(ascii: "n"): units.append(0x0A)
        case UInt8(ascii: "r"): units.append(0x0D)
        case UInt8(ascii: "t"): units.append(0x09)
        case UInt8(ascii: "u"):
          var scalar = UInt32(try hex4())
          if (0xD800...0xDBFF).contains(scalar) {
            guard peek == UInt8(ascii: "\\"), i + 1 < bytes.count, bytes[i + 1] == UInt8(ascii: "u")
            else { throw fail("lone high surrogate") }
            i += 2
            let low = UInt32(try hex4())
            guard (0xDC00...0xDFFF).contains(low) else { throw fail("bad low surrogate") }
            scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
          } else if (0xDC00...0xDFFF).contains(scalar) {
            throw fail("lone low surrogate")
          }
          guard let u = Unicode.Scalar(scalar) else { throw fail("invalid code point") }
          units.append(contentsOf: Array(String(Character(u)).utf8))
        default: throw fail("invalid escape")
        }
      case 0x00..<0x20:
        throw fail("control character in string")
      default:
        units.append(c)
      }
    }
  }

  mutating func number() throws(JSONError) -> JSONValue {
    let start = i
    if peek == UInt8(ascii: "-") { i += 1 }
    guard let first = peek, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(first) else {
      throw fail("expected a digit")
    }
    if first == UInt8(ascii: "0") {
      i += 1
      if let c = peek, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c) {
        throw fail("leading zero")
      }
    } else {
      while let c = peek, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c) { i += 1 }
    }
    var isInteger = true
    if peek == UInt8(ascii: ".") {
      isInteger = false
      i += 1
      guard let c = peek, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c) else {
        throw fail("expected a digit after '.'")
      }
      while let c = peek, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c) { i += 1 }
    }
    if peek == UInt8(ascii: "e") || peek == UInt8(ascii: "E") {
      isInteger = false
      i += 1
      if peek == UInt8(ascii: "+") || peek == UInt8(ascii: "-") { i += 1 }
      guard let c = peek, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c) else {
        throw fail("expected an exponent digit")
      }
      while let c = peek, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c) { i += 1 }
    }
    let text = String(decoding: bytes[start..<i], as: UTF8.self)
    if isInteger, let v = Int(text) { return .int(v) }
    guard let d = Double(text), d.isFinite else { throw fail("number out of range") }
    return .double(d)
  }
}

// MARK: - Encoder

extension JSONValue {
  /// Compact JSON on one line (no raw newlines), object keys in stored order.
  public func encoded() -> String {
    var out = ""
    write(into: &out)
    return out
  }

  private func write(into out: inout String) {
    switch self {
    case .null: out += "null"
    case .bool(let b): out += b ? "true" : "false"
    case .int(let i): out += String(i)
    case .double(let d):
      if !d.isFinite {
        out += "null"
      } else if d.rounded() == d, abs(d) < 1e15 {
        out += String(Int(d))
      } else {
        out += String(d)
      }
    case .string(let s): JSONValue.writeString(s, into: &out)
    case .array(let items):
      out += "["
      for (n, item) in items.enumerated() {
        if n > 0 { out += "," }
        item.write(into: &out)
      }
      out += "]"
    case .object(let pairs):
      out += "{"
      for (n, (key, value)) in pairs.enumerated() {
        if n > 0 { out += "," }
        JSONValue.writeString(key, into: &out)
        out += ":"
        value.write(into: &out)
      }
      out += "}"
    }
  }

  private static func writeString(_ s: String, into out: inout String) {
    out += "\""
    for u in s.unicodeScalars {
      switch u {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\u{00}"..."\u{1F}", "\u{2028}", "\u{2029}":
        let hex = String(u.value, radix: 16)
        out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
      default: out.unicodeScalars.append(u)
      }
    }
    out += "\""
  }
}
