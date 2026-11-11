import { Script } from "node:vm";

/**
 * Server-only check that the app's inline scripts at least parse. Each script is compiled with
 * V8 and never run, so generated code still does not execute on the server. A syntax error is the
 * most common way a generated app is dead on arrival (one bad token stops the whole script), and
 * unlike the reviewer's reading of the code, this verdict is certain.
 */
const OPEN = /<script\b/gi;
const CLOSE = /<\/script\s*>/gi;
const CLASSIC = /^(text|application)\/(java|ecma)script$/i;

/**
 * The inline scripts of a document, in order. The text is model output and can be anything, so
 * this walks it once from left to right: a single pattern for "open tag, body, close tag" rescans
 * to the end of the document for every opening tag that is never closed, which on a large,
 * hostile document blocks the server for seconds.
 */
function* inlineScripts(html: string) {
  const open = new RegExp(OPEN);
  const close = new RegExp(CLOSE);
  for (;;) {
    const tag = open.exec(html);
    if (!tag) return;
    const attrsEnd = html.indexOf(">", open.lastIndex);
    if (attrsEnd === -1) return;
    close.lastIndex = attrsEnd + 1;
    const end = close.exec(html);
    // No closing tag from here on: nothing after this point can be a complete script either.
    if (!end) return;
    yield { attrs: html.slice(open.lastIndex, attrsEnd), code: html.slice(attrsEnd + 1, end.index) };
    open.lastIndex = close.lastIndex;
  }
}

export function checkScripts(html: string) {
  const issues: string[] = [];
  let index = 0;
  for (const { attrs, code } of inlineScripts(html)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    index++;
    // Modules, JSON, import maps and templates are not classic scripts; only classic ones are checked.
    const type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (type && !CLASSIC.test(type)) continue;
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
