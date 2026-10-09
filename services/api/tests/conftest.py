from __future__ import annotations

import os


# API modules construct one application at import time.  Unit tests use the
# explicit degraded provider so test collection never downloads model weights.
os.environ.setdefault("SMARTFARM_EMBEDDING_PROVIDER", "hash")
