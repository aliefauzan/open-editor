// swift-tools-version: 6.0
// vox-apple-llm: JSON-lines helper for Apple's on-device Foundation Models (agent spec
// "Apple on-device model", plan D-10, D-16). Targets macOS 14; every Foundation Models call is
// behind `#available(macOS 26, *)`, and the framework is weak-linked so the binary starts on
// macOS 14 and 15 and reports `unsupportedOS`. Build: swift build -c release --package-path native/apple-llm
import PackageDescription

let package = Package(
  name: "apple-llm",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "vox-apple-llm", targets: ["vox-apple-llm"])
  ],
  targets: [
    // Pure Swift: protocol, JSON, JSON Schema pruning. No Foundation Models, no I/O.
    .target(name: "AppleLLMCore"),
    .executableTarget(
      name: "vox-apple-llm",
      dependencies: ["AppleLLMCore"],
      linkerSettings: [
        .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels"])
      ]
    ),
    .testTarget(name: "AppleLLMCoreTests", dependencies: ["AppleLLMCore"]),
  ]
)
