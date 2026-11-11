// Renders film.html frame by frame with headless Chrome. The page is a pure function of time
// (window.renderAt(t)), so frames can be produced in any order and in parallel.
//   node render.mjs            -> all frames into frames/
//   node render.mjs 3 12 40    -> preview stills at those seconds into stills/
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const TL = JSON.parse(readFileSync("timeline.json", "utf8"));
const html = readFileSync("film.html", "utf8").replace("/*TIMELINE*/null/*END*/", JSON.stringify(TL));
writeFileSync("film.built.html", html);
const url = `file://${process.cwd()}/film.built.html?render`;
const stills = process.argv.slice(2).map(Number);
const WORKERS = stills.length ? 1 : 5;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb"],
});
const jobs = stills.length
  ? stills.map((t) => ({ t, path: `stills/${String(t).padStart(3, "0")}.jpg` }))
  : Array.from({ length: Math.ceil(TL.total * TL.fps) }, (_, i) => ({ t: i / TL.fps, path: `frames/${String(i).padStart(5, "0")}.jpg` }));
mkdirSync(stills.length ? "stills" : "frames", { recursive: true });

let next = 0, done = 0;
const started = Date.now();
await Promise.all(Array.from({ length: WORKERS }, async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.error("page error:", e.message); process.exit(1); });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  while (next < jobs.length) {
    const job = jobs[next++];
    await page.evaluate((t) => window.renderAt(t), job.t);
    await page.screenshot({ path: job.path, type: "jpeg", quality: 93 });
    if (++done % 300 === 0) console.log(`${done}/${jobs.length} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  await page.close();
}));
await browser.close();
console.log(`rendered ${done} ${stills.length ? "stills" : "frames"} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
