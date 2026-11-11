// Narration track: each clip delayed to its cue. Music bed: a quiet synthesized pad whose chord
// changes every 8 seconds, kept well under the voice.
const { execFileSync } = require("node:child_process");
const TL = require("./timeline.json");
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

const inputs = TL.cues.flatMap((c) => ["-i", c.file]);
const delays = TL.cues.map((c, i) => `[${i}:a]aresample=48000,adelay=${Math.round(c.start * 1000)}:all=1[v${i}]`);
const mix =
  TL.cues.map((_, i) => `[v${i}]`).join("") +
  `amix=inputs=${TL.cues.length}:normalize=0,apad=whole_dur=${TL.total},highpass=f=70,` +
  `acompressor=threshold=-18dB:ratio=3:attack=10:release=180,loudnorm=I=-16:TP=-1.5:LRA=7[voice]`;
ff([...inputs, "-filter_complex", [...delays, mix].join(";"), "-map", "[voice]", "-t", String(TL.total), "voice.wav"]);

// Chords (Hz): Am9, Fmaj7, Cmaj7, G6, looping. Each voice is a soft sine with slow tremolo.
const chords = [
  [110, 164.81, 220, 246.94, 329.63],
  [87.31, 174.61, 220, 261.63, 329.63],
  [130.81, 196, 246.94, 329.63, 392],
  [98, 196, 246.94, 293.66, 392],
];
const pick = (k) => chords.map((c, i) => `eq(mod(floor(t/8),4),${i})*${c[k]}`).join("+");
const voices = [0, 1, 2, 3, 4]
  .map((k) => `${(0.2 - k * 0.022).toFixed(3)}*sin(2*PI*(${pick(k)})*t)*(0.75+0.25*sin(2*PI*${(0.07 + k * 0.013).toFixed(3)}*t))`)
  .join("+");
// Fade each chord in and out at its 8-second boundaries so changes do not click.
const env = "(min(1,mod(t,8)/1.2)*min(1,(8-mod(t,8))/1.2))";
ff(["-f", "lavfi", "-i", `aevalsrc='(${voices})*${env}':s=48000:d=${TL.total}`, "-af",
  `lowpass=f=1400,aecho=0.8:0.7:260|520:0.35|0.22,afade=t=in:d=2.5,afade=t=out:st=${(TL.total - 3).toFixed(2)}:d=3,volume=0.22`, "music.wav"]);
ff(["-i", "voice.wav", "-i", "music.wav", "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]", "-map", "[a]", "-ac", "2", "audio.wav"]);
console.log("audio built");
