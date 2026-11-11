"""Narration with the cloned voice used by the user's other project (Fish Audio s2-pro).

Reuses that project's backend as-is, including its credential loading and pronunciation
handling. Usage (with that project's virtualenv):
    python synth_fish.py /path/to/tts_agent lines.txt audio
"""
import sys
from pathlib import Path

tts_agent, lines_file, out_dir = sys.argv[1:4]
sys.path.insert(0, tts_agent)
from lib.backend import VoiceRef  # noqa: E402
from lib.backend_fish import FishAudioBackend  # noqa: E402

backend = FishAudioBackend(speed=1.0)
backend.warmup()
out = Path(out_dir)
out.mkdir(parents=True, exist_ok=True)
for i, line in enumerate(Path(lines_file).read_text(encoding="utf-8").strip().splitlines(), 1):
    result = backend.synthesize(line, VoiceRef(ref_audio="default"), out / f"{i:02d}.wav")
    print(f"{i:02d} {result.duration_s:5.2f}s  {line[:22]}", flush=True)
