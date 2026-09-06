"""Which ffmpeg/ffprobe binaries the engine shells out to.

The TypeScript adapters (`packages/tools/karos-video/src/config.ts`) already
honour `KAROS_VIDEO_FFMPEG_BIN` / `KAROS_VIDEO_FFPROBE_BIN` for the ffmpeg
calls they make themselves; the Python side used to hardcode "ffmpeg" and
"ffprobe" from PATH, so the two halves of one pipeline could resolve two
different binaries. Both now read the same variables. Unset means PATH,
which is correct in the container (apps/agent-server/Dockerfile installs
ffmpeg there) and is the only place that needs no override.
"""
import os

FFMPEG = os.environ.get("KAROS_VIDEO_FFMPEG_BIN") or "ffmpeg"
FFPROBE = os.environ.get("KAROS_VIDEO_FFPROBE_BIN") or "ffprobe"
