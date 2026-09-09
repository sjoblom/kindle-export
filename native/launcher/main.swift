import AppKit
import Foundation

// The double-clickable front end. It exists so that using this needs no
// terminal: it starts the local server, waits for it to answer, opens the
// browser at it, and — the part a shell script cannot do — gives the user a
// Dock icon with a working Quit that actually stops the server. Without that
// last part a stray server keeps the port and the next launch fails, which is
// precisely the failure someone non-technical cannot diagnose.

let port = 8484
let serverURL = URL(string: "http://127.0.0.1:\(port)")!

/// Books land somewhere predictable rather than wherever the OS set the working
/// directory, which for a double-clicked app is `/`.
let outDir = FileManager.default
  .homeDirectoryForCurrentUser
  .appendingPathComponent("Documents/Kindle Export")

let logURL = FileManager.default
  .homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Logs/Kindle Export.log")

func resource(_ relativePath: String) -> URL {
  Bundle.main.bundleURL
    .appendingPathComponent("Contents/Resources")
    .appendingPathComponent(relativePath)
}

/// Whether something is already listening, i.e. a server is up.
func serverIsUp() -> Bool {
  guard let socket = try? Socket(port: UInt16(port)) else { return false }
  defer { socket.close() }
  return socket.connectSucceeds()
}

/// Minimal blocking TCP connect; enough to answer "is the port open?".
final class Socket {
  private let fd: Int32
  private let port: UInt16

  init(port: UInt16) throws {
    self.port = port
    fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { throw POSIXError(.EBADF) }
  }

  func connectSucceeds() -> Bool {
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")

    let result = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    return result == 0
  }

  func close() { Darwin.close(fd) }
}

func showFatalError(_ message: String) {
  let alert = NSAlert()
  alert.messageText = "Kindle Export could not start"
  alert.informativeText = "\(message)\n\nDetails are in:\n\(logURL.path)"
  alert.alertStyle = .critical
  alert.addButton(withTitle: "OK")
  alert.runModal()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var server: Process?

  func applicationDidFinishLaunching(_: Notification) {
    buildMenu()

    // A second launch should surface the running app rather than fighting it
    // for the port.
    if serverIsUp() {
      NSWorkspace.shared.open(serverURL)
      return
    }

    do {
      try startServer()
    } catch {
      showFatalError(error.localizedDescription)
      NSApp.terminate(nil)
      return
    }

    waitForServerThenOpenBrowser()
  }

  private func startServer() throws {
    try FileManager.default.createDirectory(
      at: outDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)

    let node = resource("node/bin/node")
    let entry = resource("app/dist/cli.js")

    for required in [node, entry] where !FileManager.default.fileExists(atPath: required.path) {
      throw NSError(
        domain: "KindleExport", code: 1,
        userInfo: [
          NSLocalizedDescriptionKey:
            "The app bundle is incomplete — \(required.lastPathComponent) is missing."
        ])
    }

    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    let log = try FileHandle(forWritingTo: logURL)
    log.seekToEndOfFile()

    let process = Process()
    process.executableURL = node
    process.arguments = [
      entry.path, "serve",
      "--port", String(port),
      // Explicit, because the working directory of a double-clicked app is not
      // anywhere the user would think to look.
      "--out-dir", outDir.path
    ]
    process.currentDirectoryURL = outDir
    process.standardOutput = log
    process.standardError = log
    // The server opens the browser itself when run from a terminal; here the
    // launcher does it, once the port actually answers.
    process.environment = ProcessInfo.processInfo.environment.merging(
      ["KINDLE_EXPORT_NO_OPEN": "1"]
    ) { _, new in new }

    try process.run()
    server = process
  }

  private func waitForServerThenOpenBrowser() {
    DispatchQueue.global(qos: .userInitiated).async {
      // Node plus the module graph takes a moment; poll rather than guess.
      for _ in 0..<100 {
        if serverIsUp() {
          DispatchQueue.main.async { NSWorkspace.shared.open(serverURL) }
          return
        }
        if let server = self.server, !server.isRunning {
          DispatchQueue.main.async {
            showFatalError("The server stopped while starting up.")
            NSApp.terminate(nil)
          }
          return
        }
        Thread.sleep(forTimeInterval: 0.1)
      }

      DispatchQueue.main.async {
        showFatalError("The server did not start within 10 seconds.")
        NSApp.terminate(nil)
      }
    }
  }

  func applicationWillTerminate(_: Notification) {
    // The whole reason this is an app and not a script: quitting has to take
    // the server with it, or the port stays held and the next launch fails.
    guard let server, server.isRunning else { return }
    server.terminate()
    // Give it a moment to close its listener before the process group dies.
    let deadline = Date().addingTimeInterval(3)
    while server.isRunning && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
    if server.isRunning { kill(server.processIdentifier, SIGKILL) }
  }

  /// Reopening from the Dock brings the page back rather than doing nothing.
  func applicationShouldHandleReopen(
    _: NSApplication, hasVisibleWindows _: Bool
  ) -> Bool {
    NSWorkspace.shared.open(serverURL)
    return true
  }

  private func buildMenu() {
    let mainMenu = NSMenu()
    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)

    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Open Kindle Export",
      action: #selector(openApp),
      keyEquivalent: "o"
    ).target = self
    appMenu.addItem(
      withTitle: "Show Books in Finder",
      action: #selector(showBooks),
      keyEquivalent: "b"
    ).target = self
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(
      withTitle: "Quit Kindle Export",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )

    appMenuItem.submenu = appMenu
    NSApp.mainMenu = mainMenu
  }

  @objc private func openApp() {
    NSWorkspace.shared.open(serverURL)
  }

  @objc private func showBooks() {
    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: outDir.path)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
