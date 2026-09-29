import AVFoundation
import CoreImage
import QuartzCore
import MediaPipeTasksVision
import NitroModules
import VisionCamera

private struct PosePointJSON: Encodable {
  let index: Int
  let x: Float
  let y: Float
  let z: Float
  let visibility: Float
  let presence: Float
}

private struct PosePacketJSON: Encodable {
  let timestampMs: Int64
  let width: Int
  let height: Int
  let inferenceMs: Double
  let landmarks: [PosePointJSON]
}

private final class PoseResultSink: NSObject, PoseLandmarkerLiveStreamDelegate {
  private let lock = NSLock()
  private var payload = ""
  private var inferenceMetadata: [Int: (started: CFTimeInterval, width: Int, height: Int)] = [:]
  var onInferenceComplete: (() -> Void)?

  func markStarted(timestamp: Int, width: Int, height: Int) {
    lock.lock()
    inferenceMetadata[timestamp] = (CACurrentMediaTime(), width, height)
    lock.unlock()
  }

  func forget(timestamp: Int) {
    lock.lock()
    inferenceMetadata.removeValue(forKey: timestamp)
    lock.unlock()
  }

  func latest() -> String {
    lock.lock()
    defer { lock.unlock() }
    return payload
  }

  func reset() {
    lock.lock()
    payload = ""
    inferenceMetadata.removeAll()
    lock.unlock()
  }

  func poseLandmarker(
    _ poseLandmarker: MediaPipeTasksVision.PoseLandmarker,
    didFinishDetection result: PoseLandmarkerResult?,
    timestampInMilliseconds timestamp: Int,
    error: Error?
  ) {
    defer { onInferenceComplete?() }
    let now = CACurrentMediaTime()
    lock.lock()
    let metadata = inferenceMetadata.removeValue(forKey: timestamp)
    lock.unlock()

    guard error == nil,
          let result,
          let firstPose = result.landmarks.first,
          let metadata else { return }

    let points = firstPose.enumerated().map { index, point in
      PosePointJSON(
        index: index,
        x: point.x,
        y: point.y,
        z: point.z,
        visibility: point.visibility?.floatValue ?? 0,
        presence: point.presence?.floatValue ?? 0
      )
    }
    let packet = PosePacketJSON(
      timestampMs: Int64(timestamp),
      width: metadata.width,
      height: metadata.height,
      inferenceMs: (now - metadata.started) * 1_000,
      landmarks: points
    )
    guard let data = try? JSONEncoder().encode(packet),
          let json = String(data: data, encoding: .utf8) else { return }
    lock.lock()
    payload = json
    lock.unlock()
  }
}

final class HybridPoseLandmarker: HybridPoseLandmarkerSpec {
  private let sink = PoseResultSink()
  private let context = CIContext(options: [.useSoftwareRenderer: false])
  private let lock = NSLock()
  private var landmarker: MediaPipeTasksVision.PoseLandmarker?
  private var inferenceInFlight = false
  private var lastSubmissionMs: Int64 = -1
  private var submittedFrames = 0
  private var droppedFrames = 0
  private var lastError = ""

  override init() {
    super.init()
    sink.onInferenceComplete = { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.inferenceInFlight = false
      self.lock.unlock()
    }
    do {
      let resourceBundle = Bundle(for: HybridPoseLandmarker.self)
        .url(forResource: "MoveMatchPoseTrackerResources", withExtension: "bundle")
        .flatMap(Bundle.init(url:))
      guard let modelPath = resourceBundle?.path(forResource: "pose_landmarker_lite", ofType: "task") else {
        throw NSError(domain: "MoveMatchPoseTracker", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bundled pose model is missing"])
      }
      let options = PoseLandmarkerOptions()
      options.baseOptions.modelAssetPath = modelPath
      options.runningMode = .liveStream
      options.numPoses = 1
      options.minPoseDetectionConfidence = 0.5
      options.minPosePresenceConfidence = 0.5
      options.minTrackingConfidence = 0.5
      options.poseLandmarkerLiveStreamDelegate = sink
      landmarker = try MediaPipeTasksVision.PoseLandmarker(options: options)
    } catch {
      lastError = "model_error"
    }
  }

  func process(frame: any HybridFrameSpec) throws -> String {
    guard let nativeFrame = frame as? any NativeFrame,
          let sampleBuffer = nativeFrame.sampleBuffer,
          let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return sink.latest() }
    let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard timestamp.isValid, timestamp.isNumeric else { return sink.latest() }
    let captureTimestampMs = Int64(CMTimeGetSeconds(timestamp) * 1_000)
    lock.lock()
    guard !inferenceInFlight, captureTimestampMs > lastSubmissionMs, let task = landmarker else {
      droppedFrames += 1
      lock.unlock()
      return sink.latest()
    }
    let timestampMs = max(captureTimestampMs, lastSubmissionMs + 1)
    lastSubmissionMs = timestampMs
    inferenceInFlight = true
    lock.unlock()

    // Copy into an owned pixel buffer before returning control to VisionCamera.
    // MediaPipe's asynchronous result callback may run after the camera frame is disposed.
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    var ownedBuffer: CVPixelBuffer?
    let attributes = [kCVPixelBufferCGImageCompatibilityKey: true,
                      kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                              kCVPixelFormatType_32BGRA, attributes, &ownedBuffer) == kCVReturnSuccess,
          let ownedBuffer else {
      lock.lock()
      lastError = "frame_copy_failed"
      inferenceInFlight = false
      lock.unlock()
      return sink.latest()
    }
    let inferenceTimestamp = Int(timestampMs)
    do {
      context.render(CIImage(cvPixelBuffer: pixelBuffer), to: ownedBuffer)
      let image = try MPImage(pixelBuffer: ownedBuffer)
      sink.markStarted(timestamp: inferenceTimestamp, width: width, height: height)
      try task.detectAsync(image: image, timestampInMilliseconds: inferenceTimestamp)
      lock.lock()
      submittedFrames += 1
      lock.unlock()
    } catch {
      sink.forget(timestamp: inferenceTimestamp)
      lock.lock()
      lastError = "frame_or_model_error"
      inferenceInFlight = false
      lock.unlock()
    }
    return sink.latest()
  }

  func reset() throws {
    sink.reset()
    lock.lock()
    lastSubmissionMs = -1
    submittedFrames = 0
    droppedFrames = 0
    lastError = ""
    lock.unlock()
  }

  func diagnostics() throws -> String {
    lock.lock()
    defer { lock.unlock() }
    let value: [String: Any] = [
      "modelLoaded": landmarker != nil,
      "submittedFrames": submittedFrames,
      "droppedFrames": droppedFrames,
      "lastError": lastError
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let json = String(data: data, encoding: .utf8) else { return "{}" }
    return json
  }
}
