// Builds timeline.json from the measured narration clips: when each line starts/ends and where
// scenes begin. Scene changes get a longer pause than lines inside a scene.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const lines = readFileSync("lines.txt", "utf8").trim().split("\n");
const sceneOfLine = [1, 2, 2, 3, 4, 5, 5, 5, 6, 6, 7, 8, 9, 9];
const LEAD_IN = 2.0, GAP = 0.8, SCENE_GAP = 1.8, TAIL = 5.5;

let t = LEAD_IN;
const cues = [];
lines.forEach((text, i) => {
  const file = `audio/${String(i + 1).padStart(2, "0")}.wav`;
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  if (i > 0) t += sceneOfLine[i] !== sceneOfLine[i - 1] ? SCENE_GAP : GAP;
  cues.push({ n: i + 1, scene: sceneOfLine[i], start: +t.toFixed(3), end: +(t + dur).toFixed(3), text, file });
  t += dur;
});
const total = +(t + TAIL).toFixed(3);
const scenes = [];
for (let s = 1; s <= Math.max(...sceneOfLine); s++) {
  const first = cues.find((c) => c.scene === s);
  const prev = cues.filter((c) => c.scene === s - 1).pop();
  // A scene starts midway through the pause before its first line.
  scenes.push({ n: s, start: s === 1 ? 0 : +((prev.end + first.start) / 2 - 0.35).toFixed(3) });
}
scenes.forEach((s, i) => (s.end = i < scenes.length - 1 ? scenes[i + 1].start : total));
writeFileSync("timeline.json", JSON.stringify({ fps: 30, total, cues, scenes }, null, 1));
console.log("total", total, "s;", scenes.map((s) => `S${s.n}@${s.start}`).join(" "));
