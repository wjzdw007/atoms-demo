import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { parseReview, plannerRequest } from "@/lib/agents";
import { buildSrcdoc, checkHtml, extractHtml, guardLoops, scanScripts, streamablePart } from "@/lib/html";
import { checkScripts } from "@/lib/syntax";

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("extractHtml", () => {
  it("strips code fences and chatter around the document", () => {
    const raw = "好的，代码如下：\n```html\n" + page("<p>hi</p>") + "\n```\n希望对你有帮助";
    expect(extractHtml(raw)).toBe(page("<p>hi</p>"));
  });
});

describe("checkHtml", () => {
  it("accepts a complete document", () => {
    expect(checkHtml(page("<script>let a = 1;</script>"))).toEqual([]);
  });
  it("flags a truncated document", () => {
    expect(checkHtml("<html><body><script>let a = 1;")).toHaveLength(2);
  });
});

describe("checkScripts", () => {
  it("passes scripts that parse", () => {
    expect(checkScripts(page("<script>const a = () => 1; class B {}</script>"))).toEqual([]);
  });
  it("reports a syntax error with its script and line", () => {
    const issues = checkScripts(page("<script>let ok = 1;</script><script>\nlet a = 1;\nfunction ( {\n</script>"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 2 段脚本");
    expect(issues[0]).toContain("第 3 行");
  });
  it("ignores external scripts, modules and data blocks", () => {
    const html = page(
      '<script src="https://cdn.example.com/x.js"></script>' +
        '<script type="module">import x from "y"; export const a = 1;</script>' +
        '<script type="application/json">{"not": "javascript" oops}</script>',
    );
    expect(checkScripts(html)).toEqual([]);
  });
  it("stays fast on a large document full of scripts that are never closed", () => {
    // Model output can be anything. Each of these used to be rescanned to the end of the document
    // (seconds of blocked server at this size); the scan is now a single pass.
    for (const filler of ["<script>", "<script ", "<script></script "]) {
      const html = page(filler.repeat(Math.floor(800_000 / filler.length)));
      const started = Date.now();
      expect(checkScripts(html)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
  it("still checks the scripts that are closed in such a document", () => {
    const issues = checkScripts(page("<script>let a = ;</script>" + "<script>".repeat(1000)));
    expect(issues).toHaveLength(1);
  });
  it("only compiles: the script never runs", () => {
    const g = globalThis as { __ran?: boolean };
    checkScripts(page("<script>globalThis.__ran = true;</script>"));
    expect(g.__ran).toBeUndefined();
  });
});

describe("parseReview", () => {
  it("passes when the verdict is a pass", () => {
    expect(parseReview("结论：通过")).toEqual({ passed: true, findings: [] });
  });
  it("collects at most four findings", () => {
    const raw = "结论：需要修改\n- 一\n- 二\n- 三\n- 四\n- 五";
    expect(parseReview(raw)).toEqual({ passed: false, findings: ["一", "二", "三", "四"] });
  });
  it("treats a verdict without findings as a pass", () => {
    expect(parseReview("结论：需要修改").passed).toBe(true);
  });
});

describe("plannerRequest", () => {
  it("treats a first message as a new app", () => {
    expect(plannerRequest("做一个番茄钟", [], false)).toBe("这是一个新应用的需求：\n做一个番茄钟");
  });

  it("keeps the earlier requests when nothing has been built yet", () => {
    // The first attempt failed, then the user only says "继续": the plan must still be about 2048.
    const request = plannerRequest("继续", ["实现一个2048的游戏"], false);
    expect(request).toContain("- 实现一个2048的游戏");
    expect(request).toContain("还没有生成出可用的应用");
    expect(request).toContain("继续");
  });

  it("asks for a change once there is an app", () => {
    const request = plannerRequest("加一个深色模式", ["做一个番茄钟"], true);
    expect(request).toContain("- 做一个番茄钟");
    expect(request).toContain("这是对已有应用的修改请求：\n加一个深色模式");
  });
});

describe("guardLoops", () => {
  /** Runs a guarded script the way the preview would, with a guard that gives up after `limit` turns. */
  function run(code: string, limit = 10_000) {
    const html = guardLoops(page(`<script>${code}</script>`));
    const script = scanScripts(html).scripts[0].code;
    let turns = 0;
    const sandbox = {
      window: {} as Record<string, unknown>,
      __atomsLoop: () => {
        if (++turns > limit) throw new Error("stopped");
      },
      out: [] as unknown[],
    };
    sandbox.window.__atomsLoop = sandbox.__atomsLoop;
    new Script(script).runInNewContext(sandbox, { timeout: 2000 });
    return { out: sandbox.out, turns, script };
  }

  it("leaves what loops compute unchanged, in every form a loop can take", () => {
    const { out, turns } = run(`
      let n = 0;
      for (let i = 0; i < 3; i++) n += i;
      for (const k in { a: 1, b: 2 }) n += k.length;
      for (const v of [10, 20]) n += v;
      while (n < 40) n++;
      do n += 5; while (n < 50);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) n++;
      let i = 0; while (i < 3) i++
      outer: for (;;) { for (;;) { break outer; } }
      const text = "while (true) {}"; const re = /for \\(;;\\)/;
      out.push(n, i, text.length, re.source.length > 0);
    `);
    expect(out).toEqual([54, 3, 15, true]);
    expect(turns).toBeGreaterThan(15);
  });
  it("stops a loop that never ends, like the one that froze a generated chess game", () => {
    // The step that moves along the line is outside the loop it belongs to.
    const stuck = `
      let r = 0;
      while (r < 8) { out.push(r); }
      r += 1;`;
    expect(() => run(stuck)).toThrow("stopped");
    expect(() => run("for (;;);")).toThrow("stopped");
    expect(() => run("do ; while (true)")).toThrow("stopped");
  });
  it("keeps every line where it was, so error line numbers still match the code", () => {
    const code = "let a = 0;\nwhile (a < 2)\n  a++;\nfor (;;) {\n  break;\n}\n";
    expect(run(code).script.split("\n")).toHaveLength(code.split("\n").length);
  });
  it("leaves alone what it cannot or should not touch", () => {
    const untouched = page(
      "<script>while (</script>" +
        '<script type="application/json">{"while": "(true) {}"}</script>' +
        '<script src="x.js"></script>' +
        "<p>while (true) {}</p>",
    );
    expect(guardLoops(untouched)).toBe(untouched);
    expect(guardLoops(page('<script type="module">for (const x of [1]) { await x; }</script>'))).toContain("__atomsLoop");
  });
  it("is what the preview document is built from, next to the guard itself", () => {
    const doc = buildSrcdoc(page("<script>while (go()) step();</script>"));
    expect(doc).toContain("window.__atomsLoop=function");
    expect(doc).toContain("while (go()) {window.__atomsLoop&&__atomsLoop();step();}");
  });
});

describe("streamablePart", () => {
  it("holds a script back until it is complete, and only ever appends", () => {
    const full = page("<h1>hi</h1><script>while (a) b();</script><p>tail</p><script>for (;;) {}");
    let previous = "";
    for (let end = 0; end <= full.length; end++) {
      const part = streamablePart(full.slice(0, end), false);
      expect(part.startsWith(previous)).toBe(true);
      // Nothing of a script is passed on before all of it is there.
      const opens = (part.match(/<script/g) ?? []).length;
      const closes = (part.match(/<\/script>/g) ?? []).length;
      expect(opens).toBe(closes);
      previous = part;
    }
    expect(previous).toContain("while (a) {window.__atomsLoop&&__atomsLoop();b();}");
    expect(previous).not.toContain("for (;;)");
    // When nothing more is coming, the unfinished rest goes out as it is.
    const last = streamablePart(full, true);
    expect(last.startsWith(previous)).toBe(true);
    expect(last).toContain("<script>for (;;) {}</body>");
  });
});
