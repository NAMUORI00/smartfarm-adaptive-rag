"""Export a checksum-pinned research policy; never changes service configuration."""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "api"))
from app.research_retrieval import export_release  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--snapshots", type=Path, required=True,
                        help="JSON from app.research_retrieval.snapshot_hashes(active_store)")
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--expires-at", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = args.calibration.read_bytes()
    provenance = json.loads((ROOT / "data/qact-profile/research-algorithm.json").read_text())
    release = export_release(calibration=json.loads(payload), calibration_bytes=payload,
        snapshots=json.loads(args.snapshots.read_text()), source_sha256=provenance["source_sha256"],
        profile_id=args.profile_id, expires_at=args.expires_at)
    encoded = (json.dumps(release, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    # Exclusive creation prevents accidentally replacing a pinned release.
    with args.output.open("xb") as output:
        output.write(encoded)
    print(json.dumps({"path": str(args.output), "sha256": sha256(encoded).hexdigest()}))


if __name__ == "__main__":
    main()
