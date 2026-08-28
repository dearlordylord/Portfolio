#!/usr/bin/env xcrun swift

// PROTOTYPE-ONLY macOS authoring tool.
//
// This file intentionally uses Apple's AVFoundation/VideoToolbox writer rather
// than a generic HEVC encoder. A normal HEVC stream is opaque; the codec choice
// and alpha-channel settings below are what request Apple's auxiliary alpha
// layer. The command fails closed when the writer cannot apply those settings,
// when an input frame has no alpha channel, or when the finished asset does not
// advertise an alpha track through AVFoundation.

import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import ImageIO
import VideoToolbox

#if canImport(Darwin)
import Darwin
#endif

// The source/display contract is the supplied RGBA archive. The coded MOV
// deliberately adds one cleared row at the bottom so every source pixel is
// retained on Macs whose HEVC-alpha path rejects the odd 900x507 height.
// `contentRect` below is expressed in top-left/display coordinates; the
// bitmap context is shifted by `paddingRowCount` in its lower-left Quartz
// coordinate system so the visual content remains in the same orientation as
// the source renderer.
private let sourceWidth = 900
private let sourceHeight = 507
private let encodedWidth = 900
private let encodedHeight = 508
private let paddingRowCount = 1
private let paddingRowEdge = "bottom"
private let paddingAlpha = "transparent"
private let cleanAperture = "none"
private let sourceFrameCount = 150
private let sourceFrameRate = 15
private let sourceInputPattern = "frame_%03d_delay-0.067s.webp"
private let defaultAssetID = "hero-hevc-alpha-v1"
private let defaultAlphaQuality: Float = 1.0
private let defaultKeyframeInterval = 15
private let defaultBitrate = 8_000_000

private enum EncoderError: LocalizedError {
    case usage(String)
    case invalidInput(String)
    case unavailable(String)
    case encoding(String)
    case validation(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message): return message
        case .invalidInput(let message): return "invalid input: \(message)"
        case .unavailable(let message): return "HEVC-with-alpha unavailable: \(message)"
        case .encoding(let message): return "encoding failed: \(message)"
        case .validation(let message): return "output validation failed: \(message)"
        }
    }
}

private struct Options {
    let inputDirectory: URL
    let outputURL: URL
    let manifestURL: URL
    let repoRoot: URL
    let assetID: String
    let alphaQuality: Float
    let keyframeInterval: Int
    let bitrate: Int
    let dryRun: Bool
    let force: Bool
    let allowTrackedOutput: Bool

    static func parse(arguments: [String]) throws -> Options {
        let currentDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .standardizedFileURL
        var inputDirectory: URL?
        var outputURL: URL?
        var manifestURL: URL?
        var repoRoot = currentDirectory
        var assetID = defaultAssetID
        var alphaQuality = defaultAlphaQuality
        var keyframeInterval = defaultKeyframeInterval
        var bitrate = defaultBitrate
        var dryRun = false
        var force = false
        var allowTrackedOutput = false

        func path(_ value: String) -> URL {
            if value.hasPrefix("/") {
                return URL(fileURLWithPath: value).standardizedFileURL
            }
            return currentDirectory.appendingPathComponent(value).standardizedFileURL
        }

        func requiredValue(_ name: String, at index: inout Int) throws -> String {
            index += 1
            guard index < arguments.count else {
                throw EncoderError.usage("missing value for \(name)\n\(usageText)")
            }
            return arguments[index]
        }

        var index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--help", "-h":
                print(usageText)
                exit(EXIT_SUCCESS)
            case "--input":
                inputDirectory = path(try requiredValue("--input", at: &index))
            case "--output":
                outputURL = path(try requiredValue("--output", at: &index))
            case "--manifest":
                manifestURL = path(try requiredValue("--manifest", at: &index))
            case "--repo-root":
                repoRoot = path(try requiredValue("--repo-root", at: &index))
            case "--asset-id":
                assetID = try requiredValue("--asset-id", at: &index)
            case "--alpha-quality":
                let value = try requiredValue("--alpha-quality", at: &index)
                guard let parsed = Float(value), parsed.isFinite, parsed >= 0, parsed <= 1 else {
                    throw EncoderError.usage("--alpha-quality must be a finite number from 0 to 1")
                }
                alphaQuality = parsed
            case "--keyframe-interval":
                let value = try requiredValue("--keyframe-interval", at: &index)
                guard let parsed = Int(value), parsed > 0, parsed <= sourceFrameCount else {
                    throw EncoderError.usage("--keyframe-interval must be an integer from 1 to \(sourceFrameCount)")
                }
                keyframeInterval = parsed
            case "--bitrate":
                let value = try requiredValue("--bitrate", at: &index)
                guard let parsed = Int(value), parsed > 0 else {
                    throw EncoderError.usage("--bitrate must be a positive integer")
                }
                bitrate = parsed
            case "--dry-run":
                dryRun = true
            case "--force":
                force = true
            case "--allow-tracked-output":
                allowTrackedOutput = true
            default:
                throw EncoderError.usage("unknown option \(arguments[index])\n\(usageText)")
            }
            index += 1
        }

        let resolvedInput = inputDirectory ?? currentDirectory.appendingPathComponent("Кадры")
            .standardizedFileURL
        let resolvedOutput = outputURL ?? currentDirectory
            .appendingPathComponent("motion-artifacts/hevc-alpha/hero-hevc-alpha.mov")
            .standardizedFileURL
        let resolvedManifest = (manifestURL ?? resolvedOutput
            .deletingPathExtension()
            .appendingPathExtension("manifest.json"))
            .standardizedFileURL

        guard !assetID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw EncoderError.usage("--asset-id must not be empty")
        }
        guard keyframeInterval <= sourceFrameCount else {
            throw EncoderError.usage("keyframe interval exceeds source frame count")
        }

        return Options(
            inputDirectory: resolvedInput,
            outputURL: resolvedOutput,
            manifestURL: resolvedManifest,
            repoRoot: repoRoot.standardizedFileURL,
            assetID: assetID,
            alphaQuality: alphaQuality,
            keyframeInterval: keyframeInterval,
            bitrate: bitrate,
            dryRun: dryRun,
            force: force,
            allowTrackedOutput: allowTrackedOutput
        )
    }
}

private let usageText = """
Usage: npm run prototype:encode:hevc-alpha -- [options]

Reads the fixed 150-frame RGBA WebP archive (900x507 at 15 fps) and writes an
Apple HEVC-with-alpha QuickTime MOV using AVFoundation. The source/display
content remains 900x507; the coded MOV is 900x508 with exactly one explicitly
cleared transparent bottom row. Defaults are intentionally staged under
motion-artifacts/hevc-alpha/ (ignored by git), never public production assets.

Options:
  --input PATH                 frame directory (default: ./Кадры)
  --output PATH                MOV path (default: ./motion-artifacts/hevc-alpha/hero-hevc-alpha.mov)
  --manifest PATH              JSON sidecar path (default: alongside MOV)
  --repo-root PATH             repository root used for tracked-output guard
  --asset-id ID                immutable asset label for the staging manifest
  --alpha-quality 0...1        VideoToolbox alpha target quality (default: 1)
  --keyframe-interval N        maximum keyframe interval in frames (default: 15)
  --bitrate BPS                average bitrate hint (default: 8000000)
  --dry-run                    validate all frames and writer settings; write nothing
  --force                      replace the exact requested staging output
  --allow-tracked-output       explicitly permit a non-staging output path
"""

private struct AlphaRange {
    var minimum: UInt8 = 255
    var maximum: UInt8 = 0

    mutating func include(_ value: UInt8) {
        minimum = Swift.min(minimum, value)
        maximum = Swift.max(maximum, value)
    }

    mutating func merge(_ other: AlphaRange) {
        minimum = Swift.min(minimum, other.minimum)
        maximum = Swift.max(maximum, other.maximum)
    }
}

private struct PixelBufferFrame {
    let pixelBuffer: CVPixelBuffer
    let alphaRange: AlphaRange
}

private struct InputSummary {
    var minimumAlpha = UInt8(255)
    var maximumAlpha = UInt8(0)

    mutating func include(_ range: AlphaRange) {
        minimumAlpha = Swift.min(minimumAlpha, range.minimum)
        maximumAlpha = Swift.max(maximumAlpha, range.maximum)
    }
}

private struct OutputValidation {
    let width: Int
    let height: Int
    let codedWidth: Int
    let codedHeight: Int
    let frameCount: Int
    let frameRate: Double
    let durationSeconds: Double
    let codec: String
    let containsAlphaChannel: Bool
    let decodedAlphaMinimum: UInt8
    let decodedAlphaMaximum: UInt8
    let decodedContentAlphaMinimum: UInt8
    let decodedContentAlphaMaximum: UInt8
    let decodedPaddingAlphaMinimum: UInt8
    let decodedPaddingAlphaMaximum: UInt8
}

private struct Manifest: Encodable {
    struct ContentRect: Encodable {
        let x: Int
        let y: Int
        let width: Int
        let height: Int
    }

    struct Source: Encodable {
        let inputPattern: String
        let sourceSetSha256: String
        let width: Int
        let height: Int
        let frameCount: Int
        let frameRate: Int
        let durationSeconds: Double
    }

    struct Encode: Encodable {
        let codec: String
        let container: String
        let alphaMode: String
        let alphaQuality: Double
        let maxKeyframeInterval: Int
        let averageBitRate: Int
        let codedWidth: Int
        let codedHeight: Int
        let contentRect: ContentRect
        let paddingRowCount: Int
        let paddingRowEdge: String
        let paddingAlpha: String
        let cleanAperture: String
    }

    struct Output: Encodable {
        let fileName: String
        let bytes: Int
        let sha256: String
        let width: Int
        let height: Int
        let codedWidth: Int
        let codedHeight: Int
        let contentRect: ContentRect
        let paddingRowCount: Int
        let paddingRowEdge: String
        let paddingAlpha: String
        let cleanAperture: String
        let frameCount: Int
        let frameRate: Int
        let durationSeconds: Double
        let codec: String
        let containsAlphaChannel: Bool
        let decodedAlphaMinimum: Int
        let decodedAlphaMaximum: Int
        let decodedContentAlphaMinimum: Int
        let decodedContentAlphaMaximum: Int
        let decodedPaddingAlphaMinimum: Int
        let decodedPaddingAlphaMaximum: Int
    }

    let schemaVersion: Int
    let assetId: String
    let source: Source
    let encode: Encode
    let output: Output
}

// Pixel-buffer rows are addressed from the lower-left Quartz origin here.
// The manifest's contentRect uses the conventional top-left/display origin:
// x=0, y=0, width=900, height=507 with one transparent row at the bottom.
private let encodedContentRows = paddingRowCount..<encodedHeight
private let encodedPaddingRows = 0..<paddingRowCount

private func manifestContentRect() -> Manifest.ContentRect {
    Manifest.ContentRect(x: 0, y: 0, width: sourceWidth, height: sourceHeight)
}

private func frameURL(index: Int, in directory: URL) -> URL {
    let name = String(format: "frame_%03d_delay-0.067s.webp", index)
    return directory.appendingPathComponent(name)
}

private func frameURLs(in directory: URL) throws -> [URL] {
    var urls: [URL] = []
    urls.reserveCapacity(sourceFrameCount)
    for index in 0..<sourceFrameCount {
        let url = frameURL(index: index, in: directory)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw EncoderError.invalidInput("missing frame \(url.path)")
        }
        urls.append(url)
    }
    return urls
}

/// Hash the exact ordered source set, including each filename as a delimiter.
/// Binding names prevents an accidental rename/reorder from reusing a
/// manifest, while the NUL separator makes the hash algorithm unambiguous.
private func orderedSourceSetSHA256(urls: [URL]) throws -> String {
    var hasher = SHA256()
    for url in urls {
        let bytes: Data
        do {
            bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw EncoderError.invalidInput("could not hash source frame \(url.path): \(error.localizedDescription)")
        }
        hasher.update(data: Data(url.lastPathComponent.utf8))
        hasher.update(data: Data([0]))
        hasher.update(data: bytes)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func loadImage(at url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        throw EncoderError.invalidInput("ImageIO could not open \(url.path)")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw EncoderError.invalidInput("ImageIO could not decode \(url.path)")
    }
    switch image.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast:
        throw EncoderError.invalidInput("frame \(url.lastPathComponent) has no alpha channel")
    default:
        return image
    }
}

private func makePixelBuffer(from image: CGImage, frameName: String) throws -> PixelBufferFrame {
    guard image.width == sourceWidth, image.height == sourceHeight else {
        throw EncoderError.invalidInput(
            "frame \(frameName) is \(image.width)x\(image.height); expected \(sourceWidth)x\(sourceHeight)"
        )
    }

    let attributes: [String: Any] = [
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        kCVPixelBufferWidthKey as String: encodedWidth,
        kCVPixelBufferHeightKey as String: encodedHeight,
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ]
    var pixelBuffer: CVPixelBuffer?
    let createStatus = CVPixelBufferCreate(
        kCFAllocatorDefault,
        encodedWidth,
        encodedHeight,
        kCVPixelFormatType_32BGRA,
        attributes as CFDictionary,
        &pixelBuffer
    )
    guard createStatus == kCVReturnSuccess, let pixelBuffer else {
        throw EncoderError.encoding("CVPixelBufferCreate returned \(createStatus)")
    }

    let lockStatus = CVPixelBufferLockBaseAddress(pixelBuffer, [])
    guard lockStatus == kCVReturnSuccess else {
        throw EncoderError.encoding("CVPixelBufferLockBaseAddress returned \(lockStatus)")
    }
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

    guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
        throw EncoderError.encoding("pixel buffer has no base address")
    }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue
        | CGBitmapInfo.byteOrder32Little.rawValue
    guard let context = CGContext(
        data: baseAddress,
        width: encodedWidth,
        height: encodedHeight,
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        throw EncoderError.encoding("could not create BGRA bitmap context")
    }
    context.interpolationQuality = .high
    // Clearing the complete coded surface makes the padding guarantee
    // explicit even if CoreVideo returns recycled memory. Draw only into the
    // source content rect, leaving exactly one transparent bottom row.
    context.clear(CGRect(x: 0, y: 0, width: encodedWidth, height: encodedHeight))
    context.draw(
        image,
        in: CGRect(x: 0, y: paddingRowCount, width: sourceWidth, height: sourceHeight)
    )

    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let bytes = baseAddress.assumingMemoryBound(to: UInt8.self)
    var alphaRange = AlphaRange()
    // Keep the source alpha evidence separate from the synthetic padding row;
    // otherwise an opaque source would appear to have transparency merely
    // because the coded surface is padded.
    for row in encodedContentRows {
        let rowBytes = bytes.advanced(by: row * bytesPerRow)
        for column in 0..<sourceWidth {
            alphaRange.include(rowBytes[column * 4 + 3])
        }
    }

    CVBufferSetAttachment(
        pixelBuffer,
        kCVImageBufferAlphaChannelModeKey,
        kCVImageBufferAlphaChannelMode_PremultipliedAlpha,
        .shouldPropagate
    )
    return PixelBufferFrame(pixelBuffer: pixelBuffer, alphaRange: alphaRange)
}

private func decodedAlphaRange(
    from pixelBuffer: CVPixelBuffer,
    rows: Range<Int>
) throws -> AlphaRange {
    guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else {
        throw EncoderError.validation("AVAssetReader did not return BGRA pixels for decoded alpha inspection")
    }
    guard CVPixelBufferGetWidth(pixelBuffer) == encodedWidth,
          CVPixelBufferGetHeight(pixelBuffer) == encodedHeight else {
        throw EncoderError.validation("decoded pixel buffer dimensions do not match \(encodedWidth)x\(encodedHeight)")
    }
    guard rows.lowerBound >= 0, rows.upperBound <= encodedHeight, !rows.isEmpty else {
        throw EncoderError.validation("decoded alpha inspection row range is outside the coded surface")
    }

    let lockStatus = CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    guard lockStatus == kCVReturnSuccess else {
        throw EncoderError.validation("could not lock decoded pixel buffer (status \(lockStatus))")
    }
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
        throw EncoderError.validation("decoded pixel buffer has no base address")
    }

    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let bytes = baseAddress.assumingMemoryBound(to: UInt8.self)
    var range = AlphaRange()
    for row in rows {
        let rowBytes = bytes.advanced(by: row * bytesPerRow)
        for column in 0..<encodedWidth {
            range.include(rowBytes[column * 4 + 3])
        }
    }
    return range
}

private func inspectInput(urls: [URL]) throws -> InputSummary {
    var summary = InputSummary()
    for url in urls {
        let image = try loadImage(at: url)
        let frame = try makePixelBuffer(from: image, frameName: url.lastPathComponent)
        summary.include(frame.alphaRange)
    }
    guard summary.minimumAlpha < 255 else {
        throw EncoderError.invalidInput("all decoded pixels are opaque; no usable transparency was found")
    }
    guard summary.maximumAlpha > 0 else {
        throw EncoderError.invalidInput("all decoded pixels are transparent; no visible color was found")
    }
    return summary
}

private func compressionSettings(options: Options) -> [String: Any] {
    [
        // AVFoundation's bitrate/frame-rate keys belong inside the
        // AVVideoCompressionPropertiesKey dictionary when supplied together
        // with VideoToolbox alpha properties.
        AVVideoAverageBitRateKey: options.bitrate,
        AVVideoExpectedSourceFrameRateKey: sourceFrameRate,
        kVTCompressionPropertyKey_AlphaChannelMode as String: kVTAlphaChannelMode_PremultipliedAlpha,
        kVTCompressionPropertyKey_TargetQualityForAlpha as String: options.alphaQuality,
        kVTCompressionPropertyKey_AllowTemporalCompression as String: true,
        kVTCompressionPropertyKey_AllowFrameReordering as String: false,
        kVTCompressionPropertyKey_AllowOpenGOP as String: false,
        kVTCompressionPropertyKey_MaxKeyFrameInterval as String: options.keyframeInterval,
        kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration as String:
            Double(options.keyframeInterval) / Double(sourceFrameRate),
    ]
}

private func outputSettings(options: Options) -> [String: Any] {
    [
        AVVideoCodecKey: AVVideoCodecType.hevcWithAlpha,
        AVVideoWidthKey: encodedWidth,
        AVVideoHeightKey: encodedHeight,
        AVVideoCompressionPropertiesKey: compressionSettings(options: options),
    ]
}

private struct WriterBundle {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
}

private func makeWriter(at url: URL, options: Options) throws -> WriterBundle {
    let settings = outputSettings(options: options)
    let writer: AVAssetWriter
    do {
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    } catch {
        throw EncoderError.unavailable("could not create AVAssetWriter: \(error.localizedDescription)")
    }
    guard writer.canApply(outputSettings: settings, forMediaType: .video) else {
        throw EncoderError.unavailable(
            "AVAssetWriter rejected AVVideoCodecType.hevcWithAlpha or its alpha/keyframe settings"
        )
    }
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    guard writer.canAdd(input) else {
        throw EncoderError.unavailable("AVAssetWriter cannot add the HEVC video input")
    }
    writer.add(input)
    writer.shouldOptimizeForNetworkUse = true

    let pixelAttributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: encodedWidth,
        kCVPixelBufferHeightKey as String: encodedHeight,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: pixelAttributes
    )
    return WriterBundle(writer: writer, input: input, adaptor: adaptor)
}

private func writerError(_ writer: AVAssetWriter, fallback: String) -> EncoderError {
    .encoding(writer.error?.localizedDescription ?? fallback)
}

private func encode(urls: [URL], options: Options) throws -> InputSummary {
    var bundle: WriterBundle?
    var completed = false
    defer {
        if !completed {
            bundle?.writer.cancelWriting()
            try? FileManager.default.removeItem(at: options.outputURL)
        }
        cleanupWriterSidecars(for: options.outputURL)
    }

    let configured = try makeWriter(at: options.outputURL, options: options)
    bundle = configured
    guard configured.writer.startWriting() else {
        throw writerError(configured.writer, fallback: "AVAssetWriter.startWriting returned false")
    }
    configured.writer.startSession(atSourceTime: .zero)

    var summary = InputSummary()
    for (index, url) in urls.enumerated() {
        let image = try loadImage(at: url)
        let frame = try makePixelBuffer(from: image, frameName: url.lastPathComponent)
        summary.include(frame.alphaRange)

        while !configured.input.isReadyForMoreMediaData {
            if configured.writer.status == .failed {
                throw writerError(configured.writer, fallback: "writer failed while waiting for input")
            }
            if configured.writer.status == .cancelled || configured.writer.status == .completed {
                throw EncoderError.encoding("writer stopped before frame \(index) could be appended")
            }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
        }

        let presentationTime = CMTime(value: CMTimeValue(index), timescale: CMTimeScale(sourceFrameRate))
        guard configured.adaptor.append(frame.pixelBuffer, withPresentationTime: presentationTime) else {
            throw writerError(configured.writer, fallback: "pixel buffer append returned false at frame \(index)")
        }
    }

    guard summary.minimumAlpha < 255 else {
        throw EncoderError.invalidInput("all decoded pixels are opaque; no usable transparency was found")
    }
    guard summary.maximumAlpha > 0 else {
        throw EncoderError.invalidInput("all decoded pixels are transparent; no visible color was found")
    }

    configured.input.markAsFinished()
    configured.writer.endSession(atSourceTime: CMTime(value: CMTimeValue(sourceFrameCount), timescale: CMTimeScale(sourceFrameRate)))
    let finished = DispatchSemaphore(value: 0)
    configured.writer.finishWriting { finished.signal() }
    finished.wait()
    guard configured.writer.status == .completed else {
        throw writerError(configured.writer, fallback: "AVAssetWriter did not complete")
    }
    completed = true
    return summary
}

private func fourCC(_ code: FourCharCode) -> String {
    let bytes: [UInt8] = [
        UInt8((code >> 24) & 0xff),
        UInt8((code >> 16) & 0xff),
        UInt8((code >> 8) & 0xff),
        UInt8(code & 0xff),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? String(code)
}

private func validateOutput(at url: URL) throws -> OutputValidation {
    let asset = AVAsset(url: url)
    let tracks = asset.tracks(withMediaType: .video)
    guard tracks.count == 1, let track = tracks.first else {
        throw EncoderError.validation("expected one video track, found \(tracks.count)")
    }

    let alphaTracks = asset.tracks(withMediaCharacteristic: .containsAlphaChannel)
    let containsAlpha = alphaTracks.contains { $0.trackID == track.trackID }
    guard containsAlpha else {
        throw EncoderError.validation("AVFoundation did not report containsAlphaChannel for the video track")
    }

    let width = Int(abs(track.naturalSize.width).rounded())
    let height = Int(abs(track.naturalSize.height).rounded())
    guard width == encodedWidth, height == encodedHeight else {
        throw EncoderError.validation("dimensions are \(width)x\(height); expected coded \(encodedWidth)x\(encodedHeight)")
    }

    let duration = CMTimeGetSeconds(asset.duration)
    let expectedDuration = Double(sourceFrameCount) / Double(sourceFrameRate)
    guard duration.isFinite, abs(duration - expectedDuration) <= 0.5 / Double(sourceFrameRate) else {
        throw EncoderError.validation("duration is \(duration)s; expected \(expectedDuration)s")
    }

    // On the selected macOS SDK this API is declared as [CMFormatDescription].
    // Keep the explicit bridge for older SDK overlays that expose [Any].
    let descriptions = track.formatDescriptions.map { $0 as! CMFormatDescription }
    let codecTypes = descriptions.map(CMFormatDescriptionGetMediaSubType)
    let hasHEVCCodec = codecTypes.contains {
        $0 == kCMVideoCodecType_HEVC || $0 == kCMVideoCodecType_HEVCWithAlpha
    }
    guard hasHEVCCodec else {
        let codecs = codecTypes.map(fourCC).joined(separator: ", ")
        throw EncoderError.validation("video codec is \(codecs.isEmpty ? "unknown" : codecs); expected HEVC")
    }
    let codec = codecTypes.first.map(fourCC) ?? "hvc1"

    let reader: AVAssetReader
    do {
        reader = try AVAssetReader(asset: asset)
    } catch {
        throw EncoderError.validation("could not read samples: \(error.localizedDescription)")
    }
    // Decode every output sample to BGRA so the encoded alpha is checked, not
    // merely inferred from a container characteristic. If the decoder cannot
    // expose an alpha-bearing BGRA buffer, validation fails closed.
    let readerOutputSettings: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: encodedWidth,
        kCVPixelBufferHeightKey as String: encodedHeight,
    ]
    let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: readerOutputSettings)
    guard reader.canAdd(readerOutput) else {
        throw EncoderError.validation("AVAssetReader cannot inspect the video samples")
    }
    reader.add(readerOutput)
    guard reader.startReading() else {
        throw EncoderError.validation(reader.error?.localizedDescription ?? "AVAssetReader did not start")
    }
    var sampleCount = 0
    var decodedAlpha = AlphaRange()
    var decodedContentAlpha = AlphaRange()
    var decodedPaddingAlpha = AlphaRange()
    while let sampleBuffer = readerOutput.copyNextSampleBuffer() {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            throw EncoderError.validation("decoded sample \(sampleCount) has no image buffer")
        }
        let fullRange = try decodedAlphaRange(from: imageBuffer, rows: 0..<encodedHeight)
        let contentRange = try decodedAlphaRange(from: imageBuffer, rows: encodedContentRows)
        let paddingRange = try decodedAlphaRange(from: imageBuffer, rows: encodedPaddingRows)
        guard paddingRange.minimum == 0, paddingRange.maximum == 0 else {
            throw EncoderError.validation(
                "decoded padding row is not fully transparent in sample \(sampleCount) "
                    + "(alpha \(paddingRange.minimum)...\(paddingRange.maximum))"
            )
        }
        decodedAlpha.merge(fullRange)
        decodedContentAlpha.merge(contentRange)
        decodedPaddingAlpha.merge(paddingRange)
        sampleCount += 1
        if sampleCount > sourceFrameCount {
            throw EncoderError.validation("sample count exceeds \(sourceFrameCount)")
        }
    }
    guard reader.status == .completed, sampleCount == sourceFrameCount else {
        throw EncoderError.validation(
            "sample count is \(sampleCount); expected \(sourceFrameCount) (reader status \(reader.status.rawValue))"
        )
    }
    guard decodedAlpha.minimum < 255 else {
        throw EncoderError.validation("decoded coded-surface alpha is fully opaque")
    }
    guard decodedAlpha.maximum > 0 else {
        throw EncoderError.validation("decoded coded-surface alpha is fully transparent")
    }
    guard decodedContentAlpha.minimum < 255 else {
        throw EncoderError.validation("decoded content alpha is fully opaque")
    }
    guard decodedContentAlpha.maximum > 0 else {
        throw EncoderError.validation("decoded content alpha is fully transparent")
    }
    guard decodedPaddingAlpha.minimum == 0, decodedPaddingAlpha.maximum == 0 else {
        throw EncoderError.validation("decoded padding row is not transparent in every sample")
    }

    let nominalFrameRate = Double(track.nominalFrameRate)
    let measuredFrameRate = nominalFrameRate > 0 ? nominalFrameRate : Double(sampleCount) / duration
    guard measuredFrameRate.isFinite, abs(measuredFrameRate - Double(sourceFrameRate)) <= 0.1 else {
        throw EncoderError.validation("frame rate is \(measuredFrameRate); expected \(sourceFrameRate)")
    }

    return OutputValidation(
        width: width,
        height: height,
        codedWidth: width,
        codedHeight: height,
        frameCount: sampleCount,
        frameRate: measuredFrameRate,
        durationSeconds: duration,
        codec: codec,
        containsAlphaChannel: containsAlpha,
        decodedAlphaMinimum: decodedAlpha.minimum,
        decodedAlphaMaximum: decodedAlpha.maximum,
        decodedContentAlphaMinimum: decodedContentAlpha.minimum,
        decodedContentAlphaMaximum: decodedContentAlpha.maximum,
        decodedPaddingAlphaMinimum: decodedPaddingAlpha.minimum,
        decodedPaddingAlphaMaximum: decodedPaddingAlpha.maximum
    )
}

private func sha256(at url: URL) throws -> String {
    let data: Data
    do {
        data = try Data(contentsOf: url, options: .mappedIfSafe)
    } catch {
        throw EncoderError.validation("could not read output for SHA-256: \(error.localizedDescription)")
    }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func rounded(_ value: Double) -> Double {
    (value * 1_000_000).rounded() / 1_000_000
}

private func writeManifest(
    validation: OutputValidation,
    summary: InputSummary,
    sourceSetSHA256: String,
    options: Options
) throws -> (manifest: Manifest, digest: String, bytes: Int) {
    let attributes = try FileManager.default.attributesOfItem(atPath: options.outputURL.path)
    guard let fileSize = attributes[.size] as? NSNumber else {
        throw EncoderError.validation("could not determine output byte size")
    }
    let digest = try sha256(at: options.outputURL)
    let manifest = Manifest(
        schemaVersion: 1,
        assetId: options.assetID,
        source: .init(
            inputPattern: sourceInputPattern,
            sourceSetSha256: sourceSetSHA256,
            width: sourceWidth,
            height: sourceHeight,
            frameCount: sourceFrameCount,
            frameRate: sourceFrameRate,
            durationSeconds: Double(sourceFrameCount) / Double(sourceFrameRate)
        ),
        encode: .init(
            codec: "hevcWithAlpha",
            container: "mov",
            alphaMode: "premultiplied",
            alphaQuality: Double(options.alphaQuality),
            maxKeyframeInterval: options.keyframeInterval,
            averageBitRate: options.bitrate,
            codedWidth: encodedWidth,
            codedHeight: encodedHeight,
            contentRect: manifestContentRect(),
            paddingRowCount: paddingRowCount,
            paddingRowEdge: paddingRowEdge,
            paddingAlpha: paddingAlpha,
            cleanAperture: cleanAperture
        ),
        output: .init(
            fileName: options.outputURL.lastPathComponent,
            bytes: fileSize.intValue,
            sha256: digest,
            width: validation.width,
            height: validation.height,
            codedWidth: validation.codedWidth,
            codedHeight: validation.codedHeight,
            contentRect: manifestContentRect(),
            paddingRowCount: paddingRowCount,
            paddingRowEdge: paddingRowEdge,
            paddingAlpha: paddingAlpha,
            cleanAperture: cleanAperture,
            frameCount: validation.frameCount,
            frameRate: sourceFrameRate,
            durationSeconds: rounded(validation.durationSeconds),
            codec: validation.codec,
            containsAlphaChannel: validation.containsAlphaChannel,
            decodedAlphaMinimum: Int(validation.decodedAlphaMinimum),
            decodedAlphaMaximum: Int(validation.decodedAlphaMaximum),
            decodedContentAlphaMinimum: Int(validation.decodedContentAlphaMinimum),
            decodedContentAlphaMaximum: Int(validation.decodedContentAlphaMaximum),
            decodedPaddingAlphaMinimum: Int(validation.decodedPaddingAlphaMinimum),
            decodedPaddingAlphaMaximum: Int(validation.decodedPaddingAlphaMaximum)
        )
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    do {
        let data = try encoder.encode(manifest)
        try data.write(to: options.manifestURL, options: .atomic)
    } catch {
        throw EncoderError.validation("could not write manifest: \(error.localizedDescription)")
    }
    // Keep the alpha range in the command output as an auditable input fact;
    // it is deliberately not used to claim browser/device qualification.
    print("Input alpha range: \(summary.minimumAlpha)...\(summary.maximumAlpha)")
    return (manifest, digest, fileSize.intValue)
}

private func isInside(_ child: URL, _ parent: URL) -> Bool {
    let childPath = child.standardizedFileURL.path
    let parentPath = parent.standardizedFileURL.path
    return childPath == parentPath || childPath.hasPrefix(parentPath + "/")
}

/// AVAssetWriter may leave a sideband file beside a MOV while it is being
/// authored. Remove only files belonging to this exact output basename in its
/// exact staging directory. In particular, do not glob a broad .sb-* pattern
/// or recurse: unrelated candidates may be present beside the requested output.
private func cleanupWriterSidecars(for outputURL: URL) {
    let fileManager = FileManager.default
    let directory = outputURL.deletingLastPathComponent().standardizedFileURL
    guard fileManager.fileExists(atPath: directory.path),
          let entries = try? fileManager.contentsOfDirectory(
              at: directory,
              includingPropertiesForKeys: [.isRegularFileKey],
              options: []
          ) else {
        return
    }
    let exactPrefix = "\(outputURL.lastPathComponent).sb-"
    for entry in entries {
        guard entry.deletingLastPathComponent().standardizedFileURL == directory,
              entry.lastPathComponent.hasPrefix(exactPrefix),
              entry.lastPathComponent.count > exactPrefix.count,
              let values = try? entry.resourceValues(forKeys: [.isRegularFileKey]),
              values.isRegularFile == true else {
            continue
        }
        try? fileManager.removeItem(at: entry)
    }
}

private func preparePaths(options: Options) throws {
    guard FileManager.default.fileExists(atPath: options.inputDirectory.path) else {
        throw EncoderError.invalidInput("input directory does not exist: \(options.inputDirectory.path)")
    }
    guard options.outputURL.pathExtension.lowercased() == "mov" else {
        throw EncoderError.usage("--output must end in .mov")
    }
    guard options.outputURL != options.manifestURL else {
        throw EncoderError.usage("--manifest must not overwrite the MOV")
    }

    let stagingRoot = options.repoRoot.appendingPathComponent("motion-artifacts")
    if !options.allowTrackedOutput && isInside(options.outputURL, options.repoRoot)
        && !isInside(options.outputURL, stagingRoot) {
        throw EncoderError.usage(
            "refusing output inside the repository's tracked tree; use motion-artifacts/ or pass --allow-tracked-output explicitly"
        )
    }
    if !options.allowTrackedOutput && isInside(options.manifestURL, options.repoRoot)
        && !isInside(options.manifestURL, stagingRoot) {
        throw EncoderError.usage(
            "refusing manifest inside the repository's tracked tree; use motion-artifacts/ or pass --allow-tracked-output explicitly"
        )
    }

    if !options.dryRun {
        try FileManager.default.createDirectory(
            at: options.outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: options.manifestURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        cleanupWriterSidecars(for: options.outputURL)
        if FileManager.default.fileExists(atPath: options.outputURL.path) {
            guard options.force else {
                throw EncoderError.usage("output exists; pass --force to replace exactly \(options.outputURL.path)")
            }
            try FileManager.default.removeItem(at: options.outputURL)
        }
        if FileManager.default.fileExists(atPath: options.manifestURL.path) {
            guard options.force else {
                throw EncoderError.usage("manifest exists; pass --force to replace exactly \(options.manifestURL.path)")
            }
            try FileManager.default.removeItem(at: options.manifestURL)
        }
    }
}

private func checkWriterCapability(options: Options, at url: URL) throws {
    // Capability probing must leave AVAssetWriter in the unknown state: it
    // must not finish or cancel a writer that has not started writing.
    _ = try makeWriter(at: url, options: options)
    try? FileManager.default.removeItem(at: url)
    cleanupWriterSidecars(for: url)
}

private func printNextSteps(options: Options, digest: String, sourceSetSHA256: String, bytes: Int) {
    let destination = options.repoRoot.appendingPathComponent("public/video-prototype/hero-hevc-alpha.mov").path
    print("""

    SHA-256: \(digest)
    Ordered source-set SHA-256: \(sourceSetSHA256)
    Bytes: \(bytes)
    Staging MOV: \(options.outputURL.path)
    Staging manifest: \(options.manifestURL.path)

    Next import/deploy steps (manual review required):
      1. Keep the MOV and manifest in ignored staging until Safari/iOS edge and seek tests pass.
      2. After review, copy the exact file with:
         cp -- "\(options.outputURL.path)" "\(destination)"
      3. Add a checked-in manifest binding asset ID \(options.assetID), that immutable URL, and SHA-256 \(digest) to real-device alpha evidence.
      4. Only after that evidence exists, expose the prototype H path with the matching asset ID; query qualification is an untrusted manual override, not production trust.
      5. Run `npm run build`, `npm run verify:dist`, and the supported Safari/iOS device matrix before deployment.
    """)
}

private func run(options: Options) throws {
    try preparePaths(options: options)
    // Treat every invocation as a startup boundary. The helper is deliberately
    // basename-scoped and non-recursive, so this cannot remove another asset's
    // writer sideband file.
    cleanupWriterSidecars(for: options.outputURL)
    let urls = try frameURLs(in: options.inputDirectory)
    let sourceSetSHA256 = try orderedSourceSetSHA256(urls: urls)
    let temporaryWriterURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("portfolio-hevc-alpha-\(ProcessInfo.processInfo.globallyUniqueString).mov")

    if options.dryRun {
        let summary = try inspectInput(urls: urls)
        try checkWriterCapability(options: options, at: temporaryWriterURL)
        print("HEVC-alpha dry-run passed")
        print("Input: \(options.inputDirectory.path)")
        print("Frames: \(sourceFrameCount) at \(sourceFrameRate) fps (\(Double(sourceFrameCount) / Double(sourceFrameRate))s)")
        print("Source/display content: \(sourceWidth)x\(sourceHeight)")
        print("Coded MOV: \(encodedWidth)x\(encodedHeight), padding \(paddingRowCount) \(paddingRowEdge) row (\(paddingAlpha))")
        print("Input alpha range: \(summary.minimumAlpha)...\(summary.maximumAlpha)")
        print("Ordered source-set SHA-256: \(sourceSetSHA256)")
        print("AVAssetWriter: canApply hevcWithAlpha + alpha settings")
        print("No MOV or manifest was written.")
        return
    }

    do {
        let summary = try encode(urls: urls, options: options)
        let finalSourceSetSHA256 = try orderedSourceSetSHA256(urls: urls)
        guard finalSourceSetSHA256 == sourceSetSHA256 else {
            throw EncoderError.invalidInput("source frames changed while encoding; refusing a mismatched manifest")
        }
        let validation = try validateOutput(at: options.outputURL)
        guard validation.containsAlphaChannel else {
            throw EncoderError.validation("containsAlphaChannel is false")
        }
        let result = try writeManifest(
            validation: validation,
            summary: summary,
            sourceSetSHA256: sourceSetSHA256,
            options: options
        )
        cleanupWriterSidecars(for: options.outputURL)
        print("HEVC-alpha encode and AVFoundation validation passed")
        print(
            "Validated: coded \(validation.codedWidth)x\(validation.codedHeight), "
                + "content \(sourceWidth)x\(sourceHeight), "
                + "\(validation.frameCount) samples, \(validation.frameRate) fps, "
                + "\(validation.durationSeconds)s, codec \(validation.codec), "
                + "containsAlphaChannel=true, decoded alpha "
                + "\(validation.decodedAlphaMinimum)...\(validation.decodedAlphaMaximum), "
                + "content alpha \(validation.decodedContentAlphaMinimum)..."
                + "\(validation.decodedContentAlphaMaximum), padding alpha "
                + "\(validation.decodedPaddingAlphaMinimum)...\(validation.decodedPaddingAlphaMaximum)"
        )
        printNextSteps(options: options, digest: result.digest, sourceSetSHA256: sourceSetSHA256, bytes: result.bytes)
    } catch {
        try? FileManager.default.removeItem(at: options.outputURL)
        try? FileManager.default.removeItem(at: options.manifestURL)
        cleanupWriterSidecars(for: options.outputURL)
        throw error
    }
}

do {
    let options = try Options.parse(arguments: CommandLine.arguments)
    try run(options: options)
} catch {
    FileHandle.standardError.write(Data("HEVC-alpha encoder: \(error.localizedDescription)\n".utf8))
    exit(EXIT_FAILURE)
}
