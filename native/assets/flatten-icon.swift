// Makes the App Store icon opaque (App Store Connect rejects an icon with an
// alpha channel). ios-icon.svg is ../../app-icon.svg without the rounded
// corners: iOS applies its own mask. Regenerate (from native/):
//   qlmanage -t -s 1024 -o /tmp assets/ios-icon.svg
//   swift assets/flatten-icon.swift /tmp/ios-icon.svg.png \
//     ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil)!
let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let w = img.width, h = img.height
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(CGColor(red: 0.043, green: 0.043, blue: 0.055, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
let out = ctx.makeImage()!
let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dst, out, nil)
CGImageDestinationFinalize(dst)
