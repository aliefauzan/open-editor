// Everything that touches Foundation Models. The framework is weak-linked (Package.swift) and
// every use is behind `#available(macOS 26, *)`, so the helper runs on macOS 14 and 15 and
// reports `unsupportedOS` there. Image input (D-74) is behind `#available(macOS 27, *)` and the
// model's `vision` capability.
import AppleLLMCore
import Foundation
import FoundationModels

enum Model {
  struct Info {
    let status: Status
    let contextSize: Int
    /// The model accepts image attachments (macOS 27+ with the `vision` capability).
    let vision: Bool
  }

  /// Availability, context size and image input of the system model.
  static func info() -> Info {
    guard #available(macOS 26, *) else {
      return Info(status: .unsupportedOS, contextSize: defaultContextSize, vision: false)
    }
    let model = SystemLanguageModel.default
    let size = model.contextSize > 0 ? model.contextSize : defaultContextSize
    var vision = false
    if #available(macOS 27, *) { vision = model.capabilities.contains(.vision) }
    let status: Status
    switch model.availability {
    case .available: status = .ready
    case .unavailable(.appleIntelligenceNotEnabled): status = .notEnabled
    case .unavailable(.deviceNotEligible): status = .notEligible
    case .unavailable(.modelNotReady): status = .modelNotReady
    @unknown default: status = .modelNotReady
    }
    return Info(status: status, contextSize: size, vision: vision)
  }
}

@available(macOS 26, *)
enum Generator {
  /// Runs one request in a fresh session and returns the encoded answer or error line.
  static func respond(to request: Request, model info: Model.Info) async -> String {
    let images = request.imagePaths
    if !images.isEmpty {
      guard info.vision else {
        return encodeError(
          id: request.id, code: .visionUnavailable,
          message: "the Apple on-device model cannot see images here (needs macOS 27)")
      }
      if let missing = images.first(where: { !FileManager.default.isReadableFile(atPath: $0) }) {
        return encodeError(
          id: request.id, code: .badRequest, message: "image file not readable: \(missing)")
      }
    }
    let session = LanguageModelSession(
      model: SystemLanguageModel.default, tools: [], transcript: transcript(for: request))
    let options = GenerationOptions(
      temperature: request.temperature,
      maximumResponseTokens: request.maxTokens(cappedAt: info.contextSize))
    let prompt = finalPrompt(for: request)
    do {
      if let json = request.schema {
        let schema: GenerationSchema
        do {
          schema = try GenerationSchema(
            root: dynamicSchema(SchemaNode.from(json)), dependencies: [])
        } catch {
          return encodeError(
            id: request.id, code: .badRequest, message: "schema not supported: \(error)")
        }
        let response = try await session.respond(
          to: prompt, schema: schema, includeSchemaInPrompt: true, options: options)
        let text = response.content.jsonString
        let value = try JSONValue.parse(text)
        return encodeAnswer(
          id: request.id, answer: .json(value),
          usage: usage(of: response, input: request.inputText, output: text))
      }
      let response = try await session.respond(to: prompt, options: options)
      return encodeAnswer(
        id: request.id, answer: .text(response.content),
        usage: usage(of: response, input: request.inputText, output: response.content))
    } catch {
      let (code, message) = classify(error)
      return encodeError(id: request.id, code: code, message: message)
    }
  }

  /// The last user message as a prompt: its text, then its images in order (macOS 27; the
  /// caller checked the `vision` capability).
  static func finalPrompt(for request: Request) -> Prompt {
    let last = request.messages[request.messages.count - 1]
    if #available(macOS 27, *), !last.images.isEmpty {
      let urls = last.images.map { URL(fileURLWithPath: $0) }
      return Prompt {
        last.content
        for url in urls { Attachment(imageURL: url) }
      }
    }
    return Prompt(last.content)
  }

  /// Text then image segments of one earlier user message.
  static func segments(of message: Message) -> [Transcript.Segment] {
    var segments: [Transcript.Segment] = [.text(Transcript.TextSegment(content: message.content))]
    if #available(macOS 27, *) {
      for path in message.images {
        segments.append(
          .attachment(
            Transcript.AttachmentSegment(
              content: .image(Transcript.ImageAttachment(imageURL: URL(fileURLWithPath: path))))))
      }
    }
    return segments
  }

  /// System prompt as instructions, earlier turns as prompt/response entries; the last user
  /// message is sent as the prompt.
  static func transcript(for request: Request) -> Transcript {
    var entries: [Transcript.Entry] = []
    if !request.system.isEmpty {
      entries.append(
        .instructions(
          Transcript.Instructions(
            segments: [.text(Transcript.TextSegment(content: request.system))],
            toolDefinitions: [])))
    }
    for message in request.messages.dropLast() {
      let segments = segments(of: message)
      switch message.role {
      case .user: entries.append(.prompt(Transcript.Prompt(segments: segments)))
      case .assistant:
        entries.append(.response(Transcript.Response(assetIDs: [], segments: segments)))
      }
    }
    return Transcript(entries: entries)
  }

  /// Framework token counts on macOS 27+, else an estimate from the texts.
  static func usage<Content>(
    of response: LanguageModelSession.Response<Content>, input: String, output: String
  ) -> Usage {
    if #available(macOS 27, *) {
      let u = response.usage
      if u.input.totalTokenCount > 0 || u.output.totalTokenCount > 0 {
        return Usage(
          inputTokens: u.input.totalTokenCount, outputTokens: u.output.totalTokenCount,
          estimated: false)
      }
    }
    return Usage.estimate(input: input, output: output)
  }

  /// Maps a framework error to a protocol code and a short message (the framework's
  /// description, not its debug dump with the full context).
  static func classify(_ error: any Error) -> (ErrorCode, String) {
    let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    if #available(macOS 27, *), error is SystemLanguageModel.Error {
      return (.unavailable, message)  // assetsUnavailable, the only case
    }
    if #available(macOS 27, *), let e = error as? LanguageModelError {
      switch e {
      case .contextSizeExceeded: return (.contextOverflow, message)
      case .guardrailViolation, .refusal: return (.guardrail, message)
      case .unsupportedGenerationGuide: return (.badRequest, message)
      default: return (.generation, message)
      }
    }
    if let e = error as? LanguageModelSession.GenerationError {
      switch e {
      case .exceededContextWindowSize: return (.contextOverflow, message)
      case .guardrailViolation, .refusal: return (.guardrail, message)
      case .assetsUnavailable: return (.unavailable, message)
      case .unsupportedGuide: return (.badRequest, message)
      default: return (.generation, message)
      }
    }
    return (.generation, message)
  }

  static func dynamicSchema(_ node: SchemaNode) -> DynamicGenerationSchema {
    switch node {
    case .object(let name, let description, let properties):
      return DynamicGenerationSchema(
        name: name, description: description,
        properties: properties.map {
          DynamicGenerationSchema.Property(
            name: $0.name, description: $0.description, schema: dynamicSchema($0.schema),
            isOptional: $0.isOptional)
        })
    case .array(let items, let minItems, let maxItems):
      return DynamicGenerationSchema(
        arrayOf: dynamicSchema(items), minimumElements: minItems, maximumElements: maxItems)
    case .string:
      return DynamicGenerationSchema(type: String.self)
    case .stringChoice(let name, let choices):
      return DynamicGenerationSchema(name: name, anyOf: choices)
    case .integer(let minimum, let maximum):
      // SchemaNode drops contradictory bounds, so minimum <= maximum here.
      var guides: [GenerationGuide<Int>] = []
      if let minimum, let maximum {
        guides.append(.range(minimum...maximum))
      } else {
        if let minimum { guides.append(.minimum(minimum)) }
        if let maximum { guides.append(.maximum(maximum)) }
      }
      return DynamicGenerationSchema(type: Int.self, guides: guides)
    case .number(let minimum, let maximum):
      var guides: [GenerationGuide<Double>] = []
      if let minimum, let maximum {
        guides.append(.range(minimum...maximum))
      } else {
        if let minimum { guides.append(.minimum(minimum)) }
        if let maximum { guides.append(.maximum(maximum)) }
      }
      return DynamicGenerationSchema(type: Double.self, guides: guides)
    case .boolean:
      return DynamicGenerationSchema(type: Bool.self)
    case .anyOf(let name, let choices):
      return DynamicGenerationSchema(name: name, anyOf: choices.map(dynamicSchema))
    }
  }
}
