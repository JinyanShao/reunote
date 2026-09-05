#!/usr/bin/env swift
import AppKit

let width = 660
let height = 420
let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let root = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let iconURL = root.appendingPathComponent("src-tauri/icons/icon.png")
let outputURL = root.appendingPathComponent("src-tauri/icons/dmg-background.png")

guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: width,
  pixelsHigh: height,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .calibratedRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fatalError("Unable to create DMG background bitmap")
}

guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fatalError("Unable to create DMG background graphics context")
}

func color(_ red: Int, _ green: Int, _ blue: Int, alpha: CGFloat = 1) -> NSColor {
  NSColor(
    calibratedRed: CGFloat(red) / 255,
    green: CGFloat(green) / 255,
    blue: CGFloat(blue) / 255,
    alpha: alpha
  )
}

func yFromTop(_ top: CGFloat) -> CGFloat {
  CGFloat(height) - top
}

func drawText(
  _ text: String,
  x: CGFloat,
  top: CGFloat,
  font: NSFont,
  foreground: NSColor
) {
  let attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: foreground,
  ]
  let size = text.size(withAttributes: attributes)
  text.draw(
    at: NSPoint(x: x, y: yFromTop(top) - size.height),
    withAttributes: attributes
  )
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = NSImageInterpolation.high

color(247, 248, 251).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

let grid = NSBezierPath()
grid.lineWidth = 0.6
for x in stride(from: 12, through: width, by: 24) {
  grid.move(to: NSPoint(x: x, y: 22))
  grid.line(to: NSPoint(x: x, y: 304))
}
for y in stride(from: 22, through: 304, by: 24) {
  grid.move(to: NSPoint(x: 0, y: y))
  grid.line(to: NSPoint(x: width, y: y))
}
color(221, 225, 234, alpha: 0.62).setStroke()
grid.stroke()

if let icon = NSImage(contentsOf: iconURL) {
  icon.draw(
    in: NSRect(x: 44, y: yFromTop(34) - 54, width: 54, height: 54),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
  )
}

drawText(
  "reunote",
  x: 116,
  top: 36,
  font: NSFont.systemFont(ofSize: 23, weight: .semibold),
  foreground: color(30, 36, 48)
)
drawText(
  "拖到 Applications 完成安装",
  x: 116,
  top: 68,
  font: NSFont.systemFont(ofSize: 13, weight: .regular),
  foreground: color(99, 108, 126)
)

color(74, 96, 181).setFill()
NSRect(x: 116, y: yFromTop(91), width: 54, height: 3).fill()
color(230, 139, 72).setFill()
NSRect(x: 174, y: yFromTop(91), width: 18, height: 3).fill()

let arrowY = yFromTop(210)
let arrow = NSBezierPath()
arrow.lineWidth = 2.5
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 274, y: arrowY))
arrow.line(to: NSPoint(x: 386, y: arrowY))
arrow.move(to: NSPoint(x: 374, y: arrowY + 9))
arrow.line(to: NSPoint(x: 386, y: arrowY))
arrow.line(to: NSPoint(x: 374, y: arrowY - 9))
color(86, 105, 171, alpha: 0.82).setStroke()
arrow.stroke()

drawText(
  "本地优先 · macOS 13+",
  x: 44,
  top: 382,
  font: NSFont.systemFont(ofSize: 11, weight: .medium),
  foreground: color(126, 134, 149)
)
drawText(
  "reunote 1.0",
  x: 555,
  top: 382,
  font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
  foreground: color(145, 151, 164)
)

context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let data = bitmap.representation(using: NSBitmapImageRep.FileType.png, properties: [:]) else {
  fatalError("Unable to encode DMG background PNG")
}
try data.write(to: outputURL, options: Data.WritingOptions.atomic)
print(outputURL.path)
