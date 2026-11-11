/** Helpers shared by the server (saving versions) and the browser (live preview). */
import { parse } from "acorn";

/** Pulls the HTML document out of raw model output (tolerates code fences and trailing chatter). */
export function extractHtml(raw: string) {
  let text = raw.trim();
  if (text.startsWith("```")) text = text.replace(/^```[a-zA-Z]*\s*\n?/, "");
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) text = text.slice(start);
  const end = text.toLowerCase().lastIndexOf("</html>");
  if (end !== -1) text = text.slice(0, end + "</html>".length);
  else text = text.replace(/\n?```\s*$/, "");
  return text.trim();
}

/** Cheap structural checks run by the QA step before a version is saved. */
export function checkHtml(html: string) {
  const issues: string[] = [];
  const lower = html.toLowerCase();
  if (!lower.includes("<html")) issues.push("缺少 <html> 根节点");
  if (!lower.includes("</html>")) issues.push("文档没有正常结束，可能被截断");
  if (!lower.includes("<body")) issues.push("缺少 <body>");
  const opens = (lower.match(/<script[\s>]/g) ?? []).length;
  const closes = (lower.match(/<\/script>/g) ?? []).length;
  if (opens !== closes) issues.push("<script> 标签未闭合");
  return issues;
}

const SCRIPT_OPEN = /<script\b/gi;
const SCRIPT_CLOSE = /<\/script\s*>/gi;

export type InlineScript = {
  /** The tag's attributes, as written. */
  attrs: string;
  code: string;
  /** Where the code starts and ends in the document. */
  codeStart: number;
  codeEnd: number;
};

/**
 * The complete `<script>` elements of a document, in order, and where a script starts that is
 * never closed (null if every one is). The text is model output and can be anything, so this
 * walks it once from left to right: a single pattern for "open tag, body, close tag" rescans to
 * the end of the document for every opening tag that is never closed, which on a large, hostile
 * document blocks for seconds.
 */
export function scanScripts(html: string): { scripts: InlineScript[]; unclosedAt: number | null } {
  const open = new RegExp(SCRIPT_OPEN);
  const close = new RegExp(SCRIPT_CLOSE);
  const scripts: InlineScript[] = [];
  for (;;) {
    const tag = open.exec(html);
    if (!tag) return { scripts, unclosedAt: null };
    const attrsEnd = html.indexOf(">", open.lastIndex);
    if (attrsEnd === -1) return { scripts, unclosedAt: tag.index };
    close.lastIndex = attrsEnd + 1;
    const end = close.exec(html);
    // No closing tag from here on: nothing after this point can be a complete script either.
    if (!end) return { scripts, unclosedAt: tag.index };
    scripts.push({
      attrs: html.slice(open.lastIndex, attrsEnd),
      code: html.slice(attrsEnd + 1, end.index),
      codeStart: attrsEnd + 1,
      codeEnd: end.index,
    });
    open.lastIndex = close.lastIndex;
  }
}

const CLASSIC_SCRIPT = /^(text|application)\/(java|ecma)script$/i;

/** "classic", "module", or null for anything that is not JavaScript (JSON, templates, external files). */
export function scriptKind(attrs: string): "classic" | "module" | null {
  if (/\bsrc\s*=/i.test(attrs)) return null;
  const type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1];
  if (!type || CLASSIC_SCRIPT.test(type)) return "classic";
  return type.toLowerCase() === "module" ? "module" : null;
}

// ---------------------------------------------------------------------------------------------
// Loop guard
//
// A generated app can contain a loop that never ends (a counter updated outside the loop body is
// all it takes). In a browser that runs the preview in the page's own process, that freezes the
// whole site's tab, not just the app. So before an app is shown, every loop in its scripts gets a
// call to a guard at the top of its body. The guard (see the shim below) throws once a loop has
// kept the app busy for several seconds without ever returning to the browser, which turns a
// frozen page into an ordinary runtime error the user can ask the agent to fix.
//
// Only the copy that is shown is changed; the saved code stays as the model wrote it. The call is
// inserted on the same line, so error line numbers still match the code tab.
// ---------------------------------------------------------------------------------------------

const GUARD = "window.__atomsLoop&&__atomsLoop();";
const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);
type Ast = { type: string; start: number; end: number; body?: Ast; [key: string]: unknown };

const guarded = new Map<string, string>();

function guardScript(code: string, kind: "classic" | "module") {
  const key = kind + code;
  const known = guarded.get(key);
  if (known !== undefined) return known;
  let result = code;
  try {
    const ast = parse(code, { ecmaVersion: "latest", sourceType: kind === "module" ? "module" : "script" }) as unknown as Ast;
    const edits: { at: number; text: string }[] = [];
    const visit = (node: Ast) => {
      if (LOOPS.has(node.type) && node.body) {
        const body = node.body;
        if (body.type === "BlockStatement") edits.push({ at: body.start + 1, text: GUARD });
        else edits.push({ at: body.start, text: `{${GUARD}` }, { at: body.end, text: "}" });
      }
      for (const key in node) {
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) if (item && typeof (item as Ast).type === "string") visit(item as Ast);
        } else if (value && typeof (value as Ast).type === "string") visit(value as Ast);
      }
    };
    visit(ast);
    // Back to front, so earlier positions stay valid. Where a loop's unbraced body ends at the
    // same place another begins its own, closing braces go before opening ones.
    edits.sort((a, b) => b.at - a.at || (a.text === "}" ? 1 : -1));
    for (const edit of edits) result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  } catch {
    // Does not parse (or is too deeply nested to walk): it runs as written, unguarded.
    result = code;
  }
  if (guarded.size > 40) guarded.clear();
  guarded.set(key, result);
  return result;
}

/** The document with every loop of its inline scripts guarded against never ending. */
export function guardLoops(html: string) {
  let out = "";
  let at = 0;
  for (const script of scanScripts(html).scripts) {
    const kind = scriptKind(script.attrs);
    if (!kind || !script.code.trim()) continue;
    out += html.slice(at, script.codeStart) + guardScript(script.code, kind);
    at = script.codeEnd;
  }
  return out + html.slice(at);
}

/**
 * What of a document that is still being written can be shown already: everything up to a script
 * whose end has not arrived yet, with loops guarded. A script is held back until it is complete
 * because it can only be guarded as a whole (and would not run before then anyway). `final` is
 * for the last call, when nothing more is coming. Each result starts with the previous one.
 */
export function streamablePart(html: string, final: boolean) {
  if (final) return guardLoops(html);
  let cut = scanScripts(html).unclosedAt ?? html.length;
  // An opening tag that has only half arrived ("<scr") is held back as well.
  if (cut === html.length) {
    for (let n = Math.min(6, html.length); n > 0; n--) {
      if (html.slice(-n).toLowerCase() === "<script".slice(0, n)) {
        cut = html.length - n;
        break;
      }
    }
  }
  return guardLoops(html.slice(0, cut));
}

/**
 * The preview runs in a sandboxed iframe with an opaque origin, where localStorage throws.
 * This shim gives generated apps a working localStorage/sessionStorage that is relayed to
 * the host page via postMessage (the host persists it per user on the server), and reports runtime errors so the agent can be asked to fix them.
 * It must stay on one line so error line numbers still match the generated source.
 */
const LOOP_LIMIT_MS = 4000;
const LOOP_MESSAGE = "一个循环连续运行了 4 秒还没有结束，已被中止（很可能是死循环：循环条件里用到的变量没有在循环体内更新）";

function shim(storage: Record<string, string>, stream = false) {
  const data = JSON.stringify(storage).replace(/</g, "\\u003c");
  // Stream mode: the host posts code chunks and this frame feeds them to its own HTML parser with
  // document.write, so the app paints progressively like a slowly loading page instead of being
  // reloaded on every update. document.open() drops window listeners, hence the re-attach.
  const streamer = stream
    ? `var opened=false;function onMsg(e){var m=e.data;if(!m||m.source!=="atoms-host")return;` +
      `if(m.type==="chunk"){if(!opened){opened=true;document.open();listen();window.addEventListener("message",onMsg)}document.write(m.text)}` +
      `else if(m.type==="end"&&opened){document.close()}}` +
      `window.addEventListener("message",onMsg);post({type:"ready"});`
    : "";
  return (
    `<script>(function(){var d=${data};function post(m){m.source="atoms-preview";try{parent.postMessage(m,"*")}catch(e){}}` +
    `function make(sync){return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},` +
    `setItem:function(k,v){d[k]=String(v);sync()},removeItem:function(k){delete d[k];sync()},` +
    `clear:function(){d={};sync()},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}` +
    `var s=make(function(){post({type:"storage",data:d})});` +
    `try{Object.defineProperty(window,"localStorage",{value:s,configurable:true});` +
    `Object.defineProperty(window,"sessionStorage",{value:s,configurable:true})}catch(e){}` +
    // Loop guard (see guardLoops): called at the top of every loop body. It only looks at the
    // clock every 64 turns, and the clock restarts whenever the app returns to the browser (the
    // microtask), so only a loop that blocks for LOOP_LIMIT_MS in one go is stopped.
    `var gt=0,gn=0;window.__atomsLoop=function(){if((++gn&63)!==0)return;var now=Date.now();` +
    `if(!gt){gt=now;Promise.resolve().then(function(){gt=0});return}` +
    `if(now-gt>${LOOP_LIMIT_MS}){gt=0;var m=${JSON.stringify(LOOP_MESSAGE)};post({type:"error",message:m});var x=new Error(m);x.atomsGuard=1;throw x}};` +
    // A dialog blocks the app while it is open; the host must not take that for a hang.
    `["alert","confirm","prompt"].forEach(function(k){var f=window[k];if(typeof f!=="function")return;` +
    `window[k]=function(){post({type:"modal",open:true});try{return f.apply(window,arguments)}finally{post({type:"modal",open:false})}}});` +
    `function listen(){window.addEventListener("message",function(e){var m=e.data;if(m&&m.source==="atoms-host"&&m.type==="ping")post({type:"pong"})});` +
    `window.addEventListener("error",function(e){if(e.error&&e.error.atomsGuard)return;post({type:"error",message:(e.message||"Script error")+(e.lineno?" (第 "+e.lineno+" 行)":"")})});` +
    `window.addEventListener("unhandledrejection",function(e){post({type:"error",message:"Unhandled promise rejection: "+(e.reason&&e.reason.message||e.reason)})})}` +
    `listen();${streamer}})();</script>`
  );
}

export function buildSrcdoc(html: string, storage: Record<string, string> = {}) {
  const injected = shim(storage);
  html = guardLoops(html);
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + injected + html.slice(at);
  }
  return injected + html;
}

/** An empty document that waits for code chunks from the host (see the stream mode note above). */
export function buildStreamDoc(storage: Record<string, string> = {}) {
  return shim(storage, true);
}
