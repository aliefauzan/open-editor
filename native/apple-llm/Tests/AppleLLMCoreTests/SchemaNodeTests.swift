import Testing

@testable import AppleLLMCore

@Suite("SchemaNode (JSON Schema to guided-generation tree)")
struct SchemaNodeTests {
  func node(_ json: String) throws -> SchemaNode {
    try SchemaNode.from(JSONValue.parse(json))
  }

  @Test("an object keeps property order; properties not in `required` are optional")
  func object() throws {
    let n = try node(
      #"{"type":"object","description":"d","properties":{"b":{"type":"string","description":"bee"},"a":{"type":"boolean"}},"required":["b"],"additionalProperties":false}"#
    )
    #expect(
      n
        == .object(
          name: "Root", description: "d",
          properties: [
            Property(name: "b", description: "bee", schema: .string, isOptional: false),
            Property(name: "a", description: nil, schema: .boolean, isOptional: true),
          ]))
  }

  @Test("nested objects, arrays and enums get unique path names")
  func names() throws {
    let n = try node(
      #"{"type":"object","properties":{"seqs":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","properties":{"kind":{"type":"string","enum":["speaker","scene"]}},"required":["kind"]}}},"required":["seqs"]}"#
    )
    #expect(
      n
        == .object(
          name: "Root", description: nil,
          properties: [
            Property(
              name: "seqs", description: nil,
              schema: .array(
                items: .object(
                  name: "Root_seqs_item", description: nil,
                  properties: [
                    Property(
                      name: "kind", description: nil,
                      schema: .stringChoice(
                        name: "Root_seqs_item_kind", choices: ["speaker", "scene"]),
                      isOptional: false)
                  ]),
                minItems: 1, maxItems: 3),
              isOptional: false)
          ]))
  }

  @Test("integer bounds: minimum/maximum kept, exclusiveMinimum/Maximum shifted by 1, safe-integer bounds dropped")
  func integers() throws {
    #expect(try node(#"{"type":"integer","minimum":1,"maximum":5}"#) == .integer(minimum: 1, maximum: 5))
    #expect(
      try node(#"{"type":"integer","exclusiveMinimum":0,"exclusiveMaximum":10}"#)
        == .integer(minimum: 1, maximum: 9))
    #expect(
      try node(#"{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}"#)
        == .integer(minimum: nil, maximum: nil))
  }

  @Test("number bounds are kept; exclusive bounds are dropped")
  func numbers() throws {
    #expect(
      try node(#"{"type":"number","minimum":0.5,"maximum":2}"#) == .number(minimum: 0.5, maximum: 2))
    #expect(
      try node(#"{"type":"number","exclusiveMinimum":0}"#) == .number(minimum: nil, maximum: nil))
  }

  @Test("const and enum strings become a string choice; an enum of numbers keeps its base type")
  func choices() throws {
    #expect(try node(#"{"const":"x"}"#) == .stringChoice(name: "Root", choices: ["x"]))
    #expect(try node(#"{"enum":["a","b"]}"#) == .stringChoice(name: "Root", choices: ["a", "b"]))
    #expect(try node(#"{"type":"integer","enum":[1,2]}"#) == .integer(minimum: nil, maximum: nil))
  }

  @Test("nullable types make a property optional (type array and anyOf with null)")
  func nullable() throws {
    let n = try node(
      #"{"type":"object","properties":{"a":{"type":["integer","null"]},"b":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["a","b"]}"#
    )
    #expect(
      n
        == .object(
          name: "Root", description: nil,
          properties: [
            Property(
              name: "a", description: nil, schema: .integer(minimum: nil, maximum: nil),
              isOptional: true),
            Property(name: "b", description: nil, schema: .string, isOptional: true),
          ]))
  }

  @Test("anyOf with several branches becomes a choice of schemas")
  func anyOf() throws {
    #expect(
      try node(#"{"anyOf":[{"type":"string"},{"type":"integer"}]}"#)
        == .anyOf(name: "Root", choices: [.string, .integer(minimum: nil, maximum: nil)]))
    #expect(
      try node(#"{"type":["string","boolean"]}"#)
        == .anyOf(name: "Root", choices: [.string, .boolean]))
  }

  @Test("keywords it cannot express are dropped (oneOf, $ref, maxLength, pattern, format)")
  func dropped() throws {
    #expect(try node(#"{"oneOf":[{"type":"integer"}]}"#) == .string)
    #expect(try node(##"{"$ref":"#/$defs/x"}"##) == .string)
    #expect(
      try node(#"{"type":"string","maxLength":3,"pattern":"^a","format":"email"}"#) == .string)
    #expect(
      try node(#"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"boolean"}"#)
        == .boolean)
  }

  @Test("an array without items has string items; an object without properties has none")
  func defaults() throws {
    #expect(try node(#"{"type":"array"}"#) == .array(items: .string, minItems: nil, maxItems: nil))
    #expect(
      try node(#"{"type":"object"}"#) == .object(name: "Root", description: nil, properties: []))
  }

  @Test("a schema without a type infers object from properties and array from items")
  func inferred() throws {
    #expect(
      try node(#"{"properties":{"a":{"type":"boolean"}},"required":["a"]}"#)
        == .object(
          name: "Root", description: nil,
          properties: [Property(name: "a", description: nil, schema: .boolean, isOptional: false)]))
    #expect(
      try node(#"{"items":{"type":"boolean"}}"#)
        == .array(items: .boolean, minItems: nil, maxItems: nil))
  }
}
