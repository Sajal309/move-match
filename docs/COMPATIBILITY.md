# Native compatibility manifest

Last reviewed: 2026-09-25. The dependency lockfile and the Expo SDK 57 bundled-native-module map determine this matrix. iOS simulator and Android ARM64 debug builds compile; runtime and camera behavior remain unverified.

## Selected versions

| Component | Pinned/resolved version | Evidence |
|---|---:|---|
| Expo SDK / `expo` package | SDK 57 / 57.0.25 | `pnpm-lock.yaml`; manifest allows `~57.0.10` |
| React Native | 0.86.3 | Expo SDK 57 compatibility map |
| React | 19.2.3 | Lockfile |
| Expo Router | 57.0.23 | Lockfile |
| VisionCamera | 5.2.3 | Exact app dependency; V5 frame-output API |
| VisionCamera Worklets | 5.2.3 | Exact app dependency; same release line |
| React Native Worklets | 0.10.1 | Expo SDK 57 compatibility map |
| Reanimated | 4.5.1 | Exact app dependency |
| React Native Skia | 2.6.2 | Expo SDK 57 compatibility map |
| Nitro Modules | 0.37.1 | Exact app/module dependency |
| Nitro Image | 0.15.2 | Exact app dependency |
| Nitrogen | 0.37.1 | Exact custom-module codegen dependency |
| MediaPipe Tasks Vision Android | 1.0.0 | Pinned in module Gradle file; used by Google’s official MediaPipe Android samples |
| MediaPipe Tasks Vision iOS | 1.0.0 | Pinned in `MoveMatchPoseTracker.podspec`; native compile still needed to confirm CocoaPods resolution |
| Pose model | Pose Landmarker Lite Float16 | Google model URL and SHA-256 in both model manifests |
| Node.js / pnpm | 24.19.0 / 11.19.0 | Local workspace runtime / `packageManager`; minimum Node is 22.13 |
| Xcode / CocoaPods | 27.0 / 1.16.2 | Installed; `pod install` and simulator Debug build succeeded |
| JDK / Gradle wrapper | Android Studio JBR 25 / 9.3.1 | Debug APK compiled with `JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED`; this is needed for JDK 25 CMake/Prefab tasks. Gradle also provisioned JDK 17 for compilation. |
| Android Gradle Plugin / Kotlin | 8.12.0 / 2.1.20 | React Native 0.86.3 version catalog |
| Android min / compile / target SDK | 24 / 36 / 36 | React Native 0.86.3 version catalog |
| Android NDK / build tools | 27.1.12297006 / 36.0.0 | React Native 0.86.3 version catalog |
| iOS deployment target | 17.0 | App config and pose-tracker podspec; matches the PRD’s proposed support floor |

The camera adapter uses V5 `useFrameOutput`, `react-native-vision-camera-worklets`, and frame disposal in a `finally` block. Do not mix in V1–V4 `useFrameProcessor` examples. The custom `modules/pose-tracker` module copies camera frames to owned native buffers before asynchronous inference. Generated Nitro bridge sources are produced by `pnpm --filter @move-match/pose-tracker codegen` and are included by `pnpm native:prebuild`.

## Model and licenses

The checked-in `modules/pose-tracker/assets/pose_landmarker_lite.task` hash is `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`. The bundled model manifest records Apache-2.0. The fetch script downloads the official Google model URL and refuses bytes that do not match the reviewed workspace hash.

## Native build status

Nitrogen codegen and Expo prebuild generated both platform projects. CocoaPods 1.16.2 `pod install` succeeded. Xcode 27.0 compiled and installed the iOS Debug app in the iPhone 17 Pro / iOS 26.5 simulator; Metro bundled the Expo Router entry and the first-launch React Native UI is visible after a clean simulator reboot. Camera behavior was not observed. Android Gradle 9.3.1 compiled the ARM64 debug APK at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`; required SDK Build Tools 35, NDK 27.1 and CMake 3.22.1 were installed. The custom pose-tracker Gradle file now declares its React Native, CameraX, Expo Modules and Nitro dependencies, and imports its generated Nitro spec. The existing AVD is offline, so the APK was not installed or launched. Android camera/MediaPipe runtime, 16 KB page compatibility, physical frame rotation/mirroring, latency, thermal behavior and camera lifecycle remain unverified.

## References

- [Expo SDK versions](https://docs.expo.dev/versions/latest/)
- [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [VisionCamera V5 frame output](https://visioncamera.margelo.com/docs/frame-output)
- [VisionCamera native frame plugins](https://visioncamera.margelo.com/docs/native-frame-processor-plugins)
- [Google MediaPipe Pose Landmarker for Android](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/android)
- [Google MediaPipe Pose Landmarker for iOS](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/ios)
- [Google MediaPipe Android sample using Tasks Vision 1.0.0](https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/pose_landmarker/android/app/build.gradle)
- [MediaPipe Lite model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf)
