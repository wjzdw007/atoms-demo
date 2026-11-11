#!/usr/bin/env bash
# Rebuilds public/intro/atoms-intro.mp4 from the sources in this folder.
# Needs: ffmpeg, Google Chrome, and `npm i puppeteer-core @fontsource/ibm-plex-sans` in this folder.
#
#   lines.txt      narration, one sentence per line
#   timeline.mjs   measures each spoken line and lays out cues and scene boundaries
#   film.html      the film: every frame is a pure function of time, window.renderAt(t)
#   render.mjs     drives headless Chrome to write one JPEG per frame
#   audio.cjs      places the narration on the timeline and adds a quiet music bed
#
# Narration voice:
#   default            macOS system voice (`say`)
#   TTS_AGENT_DIR=...  a Fish Audio cloned voice, through a tts_agent checkout that provides
#                      lib/backend_fish.py and its own credentials (run with that project's Python
#                      via TTS_PYTHON=...). This is how the published film was voiced.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf audio && mkdir -p audio
if [ -n "${TTS_AGENT_DIR:-}" ]; then
  "${TTS_PYTHON:-python3}" synth_fish.py "$TTS_AGENT_DIR" lines.txt audio
else
  i=0
  while IFS= read -r line; do
    i=$((i + 1))
    say -v Tingting -r 185 -o "audio/$(printf '%02d' "$i").aiff" "$line"
    ffmpeg -hide_banner -loglevel error -y -i "audio/$(printf '%02d' "$i").aiff" "audio/$(printf '%02d' "$i").wav"
  done < lines.txt
fi

node timeline.mjs
rm -rf frames && node render.mjs
node audio.cjs

ffmpeg -hide_banner -loglevel error -y -framerate 30 -i frames/%05d.jpg -i audio.wav \
  -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 128k -shortest ../public/intro/atoms-intro.mp4
node render.mjs 28 && ffmpeg -hide_banner -loglevel error -y -i stills/028.jpg -q:v 4 ../public/intro/atoms-intro-poster.jpg
echo "built ../public/intro/atoms-intro.mp4"
