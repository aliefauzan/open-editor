// JSON Schema → the subset that Foundation Models guided generation can express
// (`DynamicGenerationSchema`). Keywords it cannot express (oneOf, $ref, maxLength, pattern,
// format, …) are dropped; the caller still validates the answer with zod (agent spec).

public struct Property: Equatable, Sendable {
  public let name: String
  public let description: String?
  public let schema: SchemaNode
  public let isOptional: Bool

  public init(name: String, description: String?, schema: SchemaNode, isOptional: Bool) {
    self.name = name
    self.description = description
    self.schema = schema
    self.isOptional = isOptional
  }
}

public indirect enum SchemaNode: Equatable, Sendable {
  case object(name: String, description: String?, properties: [Property])
  case array(items: SchemaNode, minItems: Int?, maxItems: Int?)
  case string
  case stringChoice(name: String, choices: [String])
  case integer(minimum: Int?, maximum: Int?)
  case number(minimum: Double?, maximum: Double?)
  case boolean
  case anyOf(name: String, choices: [SchemaNode])

  /// Converts a JSON Schema. Object, choice and anyOf names are unique paths from `name`
  /// (`Root`, `Root_seqs_item`, …), as guided generation needs unique schema names; a path that
  /// is already taken (property `a_b` next to nested `a` → `b`) gets a `_2`, `_3`, … suffix.
  public static func from(_ json: JSONValue, name: String = "Root") -> SchemaNode {
    var names = Names()
    return convert(json, name: name, names: &names).node
  }

  /// JSON Schema's ±(2^53 - 1), which zod writes for every integer; dropped as a bound.
  static let safeInteger = 9_007_199_254_740_991

  struct Names {
    var used: Set<String> = []

    mutating func unique(_ base: String) -> String {
      var candidate = base
      var n = 2
      while used.contains(candidate) {
        candidate = "\(base)_\(n)"
        n += 1
      }
      used.insert(candidate)
      return candidate
    }
  }

  private static func convert(_ json: JSONValue, name: String, names: inout Names)
    -> (node: SchemaNode, nullable: Bool)
  {
    // Nullable unions: anyOf / type arrays with a null branch make the value optional.
    if case .array(let branches)? = json["anyOf"] {
      let nonNull = branches.filter { !isNullSchema($0) }
      let nullable = nonNull.count < branches.count
      if nonNull.count == 1, let only = nonNull.first {
        return (convert(only, name: name, names: &names).node, nullable)
      }
      if !nonNull.isEmpty {
        let own = names.unique(name)
        var choices: [SchemaNode] = []
        for (i, branch) in nonNull.enumerated() {
          choices.append(convert(branch, name: "\(own)_\(i)", names: &names).node)
        }
        return (.anyOf(name: own, choices: choices), nullable)
      }
    }

    var types: [String] = []
    switch json["type"] {
    case .string(let t)?: types = [t]
    case .array(let list)?: types = list.compactMap(\.stringValue)
    default: break
    }
    let nullable = types.contains("null")
    types.removeAll { $0 == "null" }

    if types.count > 1 {
      let own = names.unique(name)
      var choices: [SchemaNode] = []
      for (i, type) in types.enumerated() {
        choices.append(typed(type, json, name: "\(own)_\(i)", names: &names))
      }
      return (.anyOf(name: own, choices: choices), nullable)
    }
    if let type = types.first { return (typed(type, json, name: name, names: &names), nullable) }

    // No type: infer from the keywords present.
    if let choices = stringChoices(json) {
      return (.stringChoice(name: names.unique(name), choices: choices), false)
    }
    if json["properties"] != nil { return (typed("object", json, name: name, names: &names), false) }
    if json["items"] != nil { return (typed("array", json, name: name, names: &names), false) }
    return (.string, false)
  }

  private static func isNullSchema(_ json: JSONValue) -> Bool {
    json["type"]?.stringValue == "null" || json["const"] == .null
  }

  private static func stringChoices(_ json: JSONValue) -> [String]? {
    if case .string(let c)? = json["const"] { return [c] }
    if case .array(let values)? = json["enum"], !values.isEmpty {
      let strings = values.compactMap(\.stringValue)
      if strings.count == values.count { return strings }
    }
    return nil
  }

  /// Drops both bounds when they contradict (minimum above maximum).
  private static func ordered<T: Comparable>(_ minimum: T?, _ maximum: T?) -> (T?, T?) {
    if let minimum, let maximum, minimum > maximum { return (nil, nil) }
    return (minimum, maximum)
  }

  private static func typed(_ type: String, _ json: JSONValue, name: String, names: inout Names)
    -> SchemaNode
  {
    switch type {
    case "object":
      let own = names.unique(name)
      var required: Set<String> = []
      if case .array(let r)? = json["required"] { required = Set(r.compactMap(\.stringValue)) }
      var properties: [Property] = []
      if case .object(let pairs)? = json["properties"] {
        for (key, schema) in pairs {
          let (node, nullable) = convert(schema, name: "\(own)_\(key)", names: &names)
          properties.append(
            Property(
              name: key, description: schema["description"]?.stringValue, schema: node,
              isOptional: nullable || !required.contains(key)))
        }
      }
      return .object(
        name: own, description: json["description"]?.stringValue, properties: properties)
    case "array":
      let items = json["items"].map { convert($0, name: "\(name)_item", names: &names).node } ?? .string
      // A negative count is no bound; a minimum of 0 is the default.
      let minItems = json["minItems"]?.integralValue.flatMap { $0 > 0 ? $0 : nil }
      let maxItems = json["maxItems"]?.integralValue.flatMap { $0 >= 0 ? $0 : nil }
      let (lo, hi) = ordered(minItems, maxItems)
      return .array(items: items, minItems: lo, maxItems: hi)
    case "string":
      if let choices = stringChoices(json) {
        return .stringChoice(name: names.unique(name), choices: choices)
      }
      return .string
    case "integer":
      var minimum = json["minimum"]?.integralValue
      var maximum = json["maximum"]?.integralValue
      // Exclusive bounds move inward by 1; at Int.max / Int.min they stay put (and are then
      // dropped below as beyond the safe-integer range) instead of overflowing.
      if minimum == nil, let x = json["exclusiveMinimum"]?.integralValue {
        minimum = x < Int.max ? x + 1 : x
      }
      if maximum == nil, let x = json["exclusiveMaximum"]?.integralValue {
        maximum = x > Int.min ? x - 1 : x
      }
      if let m = minimum, m <= -safeInteger || m >= safeInteger { minimum = nil }
      if let m = maximum, m >= safeInteger || m <= -safeInteger { maximum = nil }
      let (lo, hi) = ordered(minimum, maximum)
      return .integer(minimum: lo, maximum: hi)
    case "number":
      let (lo, hi) = ordered(json["minimum"]?.doubleValue, json["maximum"]?.doubleValue)
      return .number(minimum: lo, maximum: hi)
    case "boolean":
      return .boolean
    default:
      return .string
    }
  }
}
