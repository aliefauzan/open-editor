// vox-apple-llm: Apple on-device Foundation Models over JSON lines (agent spec
// "Apple on-device model"). Reads one request per stdin line and writes one answer per stdout
// line, in order. Opens no network connections. The only files it reads are the image files a
// request names (D-74) and the video `--highlights` names (D-75); it writes none. `--embed` (D-77)
// reads one request from stdin.
import AppleLLMCore
import Foundation

@main
enum VoxAppleLLM {
  static func main() async {
    switch Command.parse(Array(CommandLine.arguments.dropFirst())) {
    case .status:
      let info = Model.info()
      writeLine(
        encodeStatus(
          info.status, contextSize: info.contextSize, vision: info.vision,
          highlights: Highlights.available, embed: Embed.available))
      exit(0)
    case .highlights(let path):
      let out = await Highlights.analyze(path: path)
      writeLine(out.line)
      exit(out.ok ? 0 : 1)
    case .embed:
      let out = await Embed.run(readStdin())
      writeLine(out.line)
      exit(out.ok ? 0 : 1)
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
    let info = Model.info()
    guard info.status == .ready else {
      return encodeError(
        id: request.id, code: .unavailable,
        message: "Apple on-device model: \(info.status.rawValue)")
    }
    if #available(macOS 26, *) {
      return await Generator.respond(to: request, model: info)
    }
    return encodeError(
      id: request.id, code: .unavailable, message: "Apple on-device model: unsupportedOS")
  }

  /// All of stdin as UTF-8 text (`--embed` reads one request).
  static func readStdin() -> String {
    String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
  }

  /// Writes one line to stdout unbuffered, so the caller sees each answer at once.
  static func writeLine(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  }
}
