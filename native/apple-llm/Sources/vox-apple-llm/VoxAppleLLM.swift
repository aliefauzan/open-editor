// vox-apple-llm: Apple on-device Foundation Models over JSON lines (agent spec
// "Apple on-device model"). Reads one request per stdin line and writes one answer per stdout
// line, in order. Opens no files and no network connections: it only sees the request text.
import AppleLLMCore
import Foundation

@main
enum VoxAppleLLM {
  static func main() async {
    switch Command.parse(Array(CommandLine.arguments.dropFirst())) {
    case .status:
      let (status, contextSize) = Model.status()
      writeLine(encodeStatus(status, contextSize: contextSize))
      exit(0)
    case .help:
      FileHandle.standardOutput.write(Data(Command.usage.utf8))
      exit(0)
    case .invalid(let arg):
      FileHandle.standardError.write(Data("unknown argument: \(arg)\n\(Command.usage)".utf8))
      exit(2)
    case .serve:
      await serve()
      exit(0)
    }
  }

  /// Answers requests until stdin closes. The model's status is read once per request, so a
  /// model that finishes downloading while the helper runs is picked up.
  static func serve() async {
    while let line = readLine(strippingNewline: true) {
      writeLine(await answer(line))
    }
  }

  static func answer(_ line: String) async -> String {
    let request: Request
    switch Request.parse(line: line) {
    case .failure(let f): return encodeError(id: f.id, code: .badRequest, message: f.message)
    case .success(let r): request = r
    }
    let (status, _) = Model.status()
    guard status == .ready else {
      return encodeError(
        id: request.id, code: .unavailable, message: "Apple on-device model: \(status.rawValue)")
    }
    if #available(macOS 26, *) {
      return await Generator.respond(to: request)
    }
    return encodeError(
      id: request.id, code: .unavailable, message: "Apple on-device model: unsupportedOS")
  }

  /// Writes one line to stdout unbuffered, so the caller sees each answer at once.
  static func writeLine(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  }
}
