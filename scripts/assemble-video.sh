#!/usr/bin/env bash
# Turns the recorded scene clips (scripts/record-video.ts) into 1080p MP4s and one silent draft for the voice-over.
#   bash scripts/assemble-video.sh ../entrega/video
set -euo pipefail
dir="${1:-../entrega/video}"
mkdir -p "$dir/clips"
: > "$dir/clips/list.txt"
for f in "$dir"/raw/[0-9][0-9]-*.webm; do
  n=$(basename "$f" .webm)
  # 1280x720 page capture → 1920x1080, constant 30 fps, H.264 (YouTube / Clipchamp friendly)
  ffmpeg -loglevel error -y -i "$f" -vf "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 18 -an "$dir/clips/$n.mp4"
  echo "file '$n.mp4'" >> "$dir/clips/list.txt"
  printf '%s %ss\n' "$n" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$dir/clips/$n.mp4" | cut -d. -f1)"
done
ffmpeg -loglevel error -y -f concat -safe 0 -i "$dir/clips/list.txt" -c copy "$dir/paylet-draft-silent.mp4"
echo "draft: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$dir/paylet-draft-silent.mp4" | cut -d. -f1)s"
