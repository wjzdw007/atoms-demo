/** Helpers shared by the server (saving versions) and the browser (live preview). */

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

/**
 * The preview runs in a sandboxed iframe with an opaque origin, where localStorage throws.
 * This shim gives generated apps a working localStorage/sessionStorage that is relayed to
 * the host page via postMessage (the host persists it per user on the server), and reports runtime errors so the agent can be asked to fix them.
 * It must stay on one line so error line numbers still match the generated source.
 */
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
    `function listen(){window.addEventListener("error",function(e){post({type:"error",message:(e.message||"Script error")+(e.lineno?" (第 "+e.lineno+" 行)":"")})});` +
    `window.addEventListener("unhandledrejection",function(e){post({type:"error",message:"Unhandled promise rejection: "+(e.reason&&e.reason.message||e.reason)})})}` +
    `listen();${streamer}})();</script>`
  );
}

export function buildSrcdoc(html: string, storage: Record<string, string> = {}) {
  const injected = shim(storage);
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
