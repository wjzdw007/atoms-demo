import { describe, expect, it } from "vitest";
import { parseReview, plannerRequest } from "@/lib/agents";
import { checkHtml, extractHtml } from "@/lib/html";
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
