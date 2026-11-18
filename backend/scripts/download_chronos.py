#!/usr/bin/env python3
"""Download the Chronos-Bolt-mini checkpoint into backend/models/.

Run once, then the backend picks it up automatically:
    python3 backend/scripts/download_chronos.py

Override the destination with CHRONOS_MODEL_PATH or --path.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

REPO_ID = "autogluon/chronos-bolt-mini"
DEFAULT_PATH = Path(__file__).resolve().parents[1] / "models" / "chronos-bolt-mini"
# Only the files the inference pipeline needs (no dataset/space assets).
ALLOW_PATTERNS = ["*.json", "*.safetensors", "*.py", "*.model", "*.txt"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the Chronos-Bolt-mini model.")
    parser.add_argument(
        "--path",
        default=os.getenv("CHRONOS_MODEL_PATH", str(DEFAULT_PATH)),
        help=f"destination directory (default: {DEFAULT_PATH})",
    )
    args = parser.parse_args()

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        raise SystemExit(
            "huggingface-hub is required. Install the model extras with:\n"
            "  uv pip install -r backend/requirements-ml.txt"
        )

    destination = Path(args.path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {REPO_ID} -> {destination}")
    saved = snapshot_download(
        repo_id=REPO_ID, local_dir=str(destination), allow_patterns=ALLOW_PATTERNS
    )
    print(f"Done: {saved}")


if __name__ == "__main__":
    main()
