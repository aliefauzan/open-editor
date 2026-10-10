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
  /// (`Root`, `Root_seqs_item`, …), as guided generation needs unique schema names.
  public static func from(_ json: JSONValue, name: String = "Root") -> SchemaNode {
    convert(json, name: name).node
  }

  /// JSON Schema's ±(2^53 - 1), which zod writes for every integer; dropped as a bound.
  static let safeInteger = 9_007_199_254_740_991

  private static func convert(_ json: JSONValue, name: String) -> (node: SchemaNode, nullable: Bool)
  {
    // Nullable unions: anyOf / type arrays with a null branch make the value optional.
    if case .array(let branches)? = json["anyOf"] {
      let nonNull = branches.filter { !isNullSchema($0) }
      let nullable = nonNull.count < branches.count
      if nonNull.count == 1, let only = nonNull.first {
        return (convert(only, name: name).node, nullable)
      }
      if !nonNull.isEmpty {
        let choices = nonNull.enumerated().map { convert($1, name: "\(name)_\($0)").node }
        return (.anyOf(name: name, choices: choices), nullable)
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
      let choices = types.map { typed($0, json, name: name) }
      return (.anyOf(name: name, choices: choices), nullable)
    }
    if let type = types.first { return (typed(type, json, name: name), nullable) }

    // No type: infer from the keywords present.
    if let choices = stringChoices(json) { return (.stringChoice(name: name, choices: choices), false) }
    if json["properties"] != nil { return (typed("object", json, name: name), false) }
    if json["items"] != nil { return (typed("array", json, name: name), false) }
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

  private static func typed(_ type: String, _ json: JSONValue, name: String) -> SchemaNode {
    switch type {
    case "object":
      var required: Set<String> = []
      if case .array(let r)? = json["required"] { required = Set(r.compactMap(\.stringValue)) }
      var properties: [Property] = []
      if case .object(let pairs)? = json["properties"] {
        for (key, schema) in pairs {
          let (node, nullable) = convert(schema, name: "\(name)_\(key)")
          properties.append(
            Property(
              name: key, description: schema["description"]?.stringValue, schema: node,
              isOptional: nullable || !required.contains(key)))
        }
      }
      return .object(
        name: name, description: json["description"]?.stringValue, properties: properties)
    case "array":
      let items = json["items"].map { convert($0, name: "\(name)_item").node } ?? .string
      return .array(
        items: items, minItems: json["minItems"]?.integralValue,
        maxItems: json["maxItems"]?.integralValue)
    case "string":
      if let choices = stringChoices(json) { return .stringChoice(name: name, choices: choices) }
      return .string
    case "integer":
      var minimum = json["minimum"]?.integralValue
      var maximum = json["maximum"]?.integralValue
      if minimum == nil, let x = json["exclusiveMinimum"]?.integralValue { minimum = x + 1 }
      if maximum == nil, let x = json["exclusiveMaximum"]?.integralValue { maximum = x - 1 }
      if let m = minimum, m <= -safeInteger { minimum = nil }
      if let m = maximum, m >= safeInteger { maximum = nil }
      return .integer(minimum: minimum, maximum: maximum)
    case "number":
      return .number(minimum: json["minimum"]?.doubleValue, maximum: json["maximum"]?.doubleValue)
    case "boolean":
      return .boolean
    default:
      return .string
    }
  }
}
