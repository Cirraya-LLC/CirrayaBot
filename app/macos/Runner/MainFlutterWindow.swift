import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    self.contentViewController = flutterViewController
    // The template opens at 800x600, too narrow for the three columns.
    let size = NSSize(width: 1320, height: 840)
    let screen = self.screen?.visibleFrame ?? NSRect(origin: .zero, size: size)
    self.setFrame(NSRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2,
                         width: min(size.width, screen.width), height: min(size.height, screen.height)),
                  display: true)
    self.minSize = NSSize(width: 900, height: 560)

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
