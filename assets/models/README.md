# Model manifest

`model-manifest.json` pins the MediaPipe Pose Landmarker Lite Float16 model version, upstream URL, license and SHA-256. The checked model asset is bundled from `modules/pose-tracker/assets/pose_landmarker_lite.task` into both native builds. Run `pnpm model:fetch` to download the official model and verify its bytes against this manifest before changing the bundled file.
