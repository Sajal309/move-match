#!/usr/bin/env python3
"""Fetch and verify the official MediaPipe Pose Landmarker Lite model."""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets/models/model-manifest.json"
APP_ASSET = ROOT / "modules/pose-tracker/assets/pose_landmarker_lite.task"


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    expected = manifest["sha256"]
    if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected.lower()):
        print("Model manifest needs a reviewed 64-character SHA-256 before the model can be fetched.", file=sys.stderr)
        return 2

    APP_ASSET.parent.mkdir(parents=True, exist_ok=True)
    partial = APP_ASSET.with_suffix(".task.part")
    request = urllib.request.Request(manifest["url"], headers={"User-Agent": "MOVE-MATCH-build/1"})
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(request, timeout=90) as response, partial.open("wb") as out:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                out.write(chunk)
        actual = digest.hexdigest()
        if actual != expected:
            partial.unlink(missing_ok=True)
            print(f"SHA-256 mismatch: expected {expected}, received {actual}", file=sys.stderr)
            return 3
        partial.replace(APP_ASSET)
        print(f"Verified MediaPipe model SHA-256 {actual}")
        return 0
    except Exception as error:  # Report download/config issues without leaving partial assets.
        partial.unlink(missing_ok=True)
        print(f"Model fetch failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
