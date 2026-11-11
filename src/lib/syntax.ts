import { Script } from "node:vm";
import { scanScripts, scriptKind } from "./html";

/**
 * Server-only check that the app's inline scripts at least parse. Each script is compiled with
 * V8 and never run, so generated code still does not execute on the server. A syntax error is the
 * most common way a generated app is dead on arrival (one bad token stops the whole script), and
 * unlike the reviewer's reading of the code, this verdict is certain.
 */
export function checkScripts(html: string) {
  const issues: string[] = [];
  let index = 0;
  for (const { attrs, code } of scanScripts(html).scripts) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    index++;
    // Modules, JSON, import maps and templates are not classic scripts; only classic ones are checked.
    if (scriptKind(attrs) !== "classic") continue;
    if (!code.trim()) continue;
    try {
      new Script(code, { filename: "inline-script" });
    } catch (error) {
      if (!(error instanceof SyntaxError)) continue;
      const line = error.stack?.match(/^inline-script:(\d+)/)?.[1];
      issues.push(`第 ${index} 段脚本有语法错误${line ? `（脚本内第 ${line} 行）` : ""}：${error.message}`);
    }
    if (issues.length >= 3) break;
  }
  return issues;
}
