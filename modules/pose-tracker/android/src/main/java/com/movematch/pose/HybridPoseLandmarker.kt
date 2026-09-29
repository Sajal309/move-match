package com.margelo.nitro.movematch.pose

import android.graphics.Bitmap
import android.graphics.Color
import android.os.SystemClock
import android.graphics.ImageFormat
import android.media.Image
import androidx.camera.core.ImageProxy
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult
import com.margelo.nitro.camera.HybridFrameSpec
import com.margelo.nitro.camera.public.NativeFrame
import com.movematch.pose.PoseTrackerAppContext
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private data class PosePoint(
  val index: Int,
  val x: Float,
  val y: Float,
  val z: Float,
  val visibility: Float,
  val presence: Float,
)

private data class PosePacket(
  val timestampMs: Long,
  val width: Int,
  val height: Int,
  val inferenceMs: Double,
  val landmarks: List<PosePoint>,
) {
  fun toJson(): String {
    val points = landmarks.map { point ->
      JSONObject().put("index", point.index).put("x", point.x).put("y", point.y)
        .put("z", point.z).put("visibility", point.visibility).put("presence", point.presence)
    }
    return JSONObject().put("timestampMs", timestampMs).put("width", width).put("height", height)
      .put("inferenceMs", inferenceMs).put("landmarks", points).toString()
  }
}

private data class InferenceMetadata(val startedAtMs: Long, val width: Int, val height: Int, val generation: Int)

class HybridPoseLandmarker : HybridPoseLandmarkerSpec() {
  private val latest = AtomicReference<PosePacket?>(null)
  private val inferenceInFlight = AtomicBoolean(false)
  private val inFlightBitmap = AtomicReference<Bitmap?>(null)
  private val generation = AtomicInteger(0)
  private val lastTimestamp = AtomicLong(-1)
  private val metadataByTimestamp = ConcurrentHashMap<Long, InferenceMetadata>()
  private val submittedFrames = AtomicInteger(0)
  private val droppedFrames = AtomicInteger(0)
  private val lastError = AtomicReference("")
  private val task: PoseLandmarker? = createLandmarker()

  private fun createLandmarker(): PoseLandmarker? {
    return try {
      val context = PoseTrackerAppContext.application ?: return null
      val options = PoseLandmarker.PoseLandmarkerOptions.builder()
        .setBaseOptions(BaseOptions.builder().setModelAssetPath("pose_landmarker_lite.task").build())
        .setRunningMode(RunningMode.LIVE_STREAM)
        .setNumPoses(1)
        .setMinPoseDetectionConfidence(0.5f)
        .setMinPosePresenceConfidence(0.5f)
        .setMinTrackingConfidence(0.5f)
        .setResultListener { result, _ -> acceptResult(result) }
        .setErrorListener { error ->
          lastError.set("model_error:${error.message ?: "unknown"}")
          metadataByTimestamp.clear()
          inFlightBitmap.getAndSet(null)?.recycle()
          inferenceInFlight.set(false)
        }
        .build()
      PoseLandmarker.createFromOptions(context, options)
    } catch (error: Throwable) {
      lastError.set("model_error:${error.message ?: "unknown"}")
      null
    }
  }

  override fun process(frame: HybridFrameSpec): String {
    val imageProxy = (frame as? NativeFrame)?.image as? ImageProxy ?: return latest.get()?.toJson().orEmpty()
    val image = imageProxy.image ?: return latest.get()?.toJson().orEmpty()
    val landmarker = task ?: return latest.get()?.toJson().orEmpty()
    if (!inferenceInFlight.compareAndSet(false, true)) {
      droppedFrames.incrementAndGet()
      return latest.get()?.toJson().orEmpty()
    }

    val now = SystemClock.elapsedRealtime()
    val previous = lastTimestamp.getAndUpdate { old -> maxOf(now, old + 1) }
    val timestamp = maxOf(now, previous + 1)
    val ownedBitmap = try {
      image.toOwnedBitmap()
    } catch (error: Throwable) {
      inferenceInFlight.set(false)
      lastError.set("low_confidence")
      return latest.get()?.toJson().orEmpty()
    }
    try {
      val mpImage = BitmapImageBuilder(ownedBitmap).build()
      val frameGeneration = generation.get()
      metadataByTimestamp[timestamp] = InferenceMetadata(timestamp, ownedBitmap.width, ownedBitmap.height, frameGeneration)
      inFlightBitmap.set(ownedBitmap)
      landmarker.detectAsync(mpImage, timestamp)
      submittedFrames.incrementAndGet()
    } catch (error: Throwable) {
      metadataByTimestamp.remove(timestamp)
      inFlightBitmap.getAndSet(null)?.recycle()
      inferenceInFlight.set(false)
      lastError.set("model_error:${error.message ?: "unknown"}")
    }
    return latest.get()?.toJson().orEmpty()
  }

  private fun acceptResult(result: PoseLandmarkerResult) {
    val startedAt = result.timestampMs()
    val metadata = metadataByTimestamp.remove(startedAt)
    val points = result.landmarks().firstOrNull().orEmpty().mapIndexed { index, point ->
      PosePoint(index, point.x(), point.y(), point.z(), point.visibility().orElse(0f), point.presence().orElse(0f))
    }
    val elapsed = (SystemClock.elapsedRealtime() - (metadata?.startedAtMs ?: startedAt)).coerceAtLeast(0)
    if (metadata != null && metadata.generation == generation.get() && points.size == 33) {
      latest.set(PosePacket(startedAt, metadata.width, metadata.height, elapsed.toDouble(), points))
      lastError.set("")
    }
    inFlightBitmap.getAndSet(null)?.recycle()
    inferenceInFlight.set(false)
  }

  override fun reset() {
    generation.incrementAndGet()
    latest.set(null)
    lastTimestamp.set(-1)
    submittedFrames.set(0)
    droppedFrames.set(0)
    lastError.set("")
  }

  override fun diagnostics(): String = JSONObject()
    .put("modelLoaded", task != null)
    .put("submittedFrames", submittedFrames.get())
    .put("droppedFrames", droppedFrames.get())
    .put("lastError", lastError.get())
    .toString()

  private fun Image.toOwnedBitmap(): Bitmap {
    require(format == ImageFormat.YUV_420_888) { "VisionCamera must negotiate YUV_420_888 frames" }
    val width = width
    val height = height
    val argb = IntArray(width * height)
    val y = planes[0]
    val u = planes[1]
    val v = planes[2]
    for (row in 0 until height) {
      val rowStart = row * y.rowStride
      for (column in 0 until width) {
        val luminance = (y.buffer.get(rowStart + column * y.pixelStride).toInt() and 0xff) - 16
        val chromaRow = (row / 2) * u.rowStride
        val chromaColumn = (column / 2) * u.pixelStride
        val uValue = (u.buffer.get(chromaRow + chromaColumn).toInt() and 0xff) - 128
        val vValue = (v.buffer.get((row / 2) * v.rowStride + (column / 2) * v.pixelStride).toInt() and 0xff) - 128
        val c = (luminance.coerceAtLeast(0) * 298)
        val red = ((c + 409 * vValue + 128) shr 8).coerceIn(0, 255)
        val green = ((c - 100 * uValue - 208 * vValue + 128) shr 8).coerceIn(0, 255)
        val blue = ((c + 516 * uValue + 128) shr 8).coerceIn(0, 255)
        argb[row * width + column] = Color.rgb(red, green, blue)
      }
    }
    return Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888)
  }
}
