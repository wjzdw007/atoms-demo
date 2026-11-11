/**
 * Canned agent output used when no LLM_API_KEY is configured ("演示模式").
 * It keeps the full product flow (streaming, versions, publish, remix) runnable without a model.
 */
const ACCENTS = ["#6d5efc", "#0ea5a4", "#e2603f", "#d6409f", "#2f7df6"];

type MockState = { title: string; notes: string[] };

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function mockPlan(prompt: string, isEdit: boolean) {
  if (isEdit) {
    return `- 按「${prompt.slice(0, 40)}」调整现有应用\n- 更换主题色并记录本次改动\n- 保留已有数据与交互`;
  }
  return `标题：${prompt.replace(/\s+/g, "").slice(0, 10) || "我的应用"}\n做一个轻量的任务清单来承接这个需求（演示模式下为固定模板）。\n- 添加、完成、删除条目\n- 按全部 / 进行中 / 已完成筛选\n- 数据保存在 localStorage，刷新不丢失\n- 顶部显示完成进度`;
}

export function mockHtml(prompt: string, title: string | null, currentHtml: string | null) {
  let state: MockState = { title: title || prompt.slice(0, 12) || "我的应用", notes: [] };
  const previous = currentHtml?.match(/<!--mock:(.*?)-->/);
  if (previous) {
    try {
      state = JSON.parse(decodeURIComponent(previous[1]));
      state.notes = [...state.notes, prompt].slice(-5);
    } catch {
      /* fall back to a fresh state */
    }
  }
  const accent = ACCENTS[state.notes.length % ACCENTS.length];
  const notes = state.notes.length
    ? `<section class="notes"><h2>更新记录</h2><ul>${state.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(state.title)}</title>
<!--mock:${encodeURIComponent(JSON.stringify(state))}-->
<style>
  :root { --accent: ${accent}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "PingFang SC", sans-serif; background: #f4f4f7; color: #1c1c28; }
  main { max-width: 560px; margin: 0 auto; padding: 40px 20px 60px; }
  h1 { font-size: 28px; margin: 0 0 6px; }
  .sub { color: #6b6b80; margin: 0 0 20px; font-size: 14px; }
  .bar { height: 8px; border-radius: 99px; background: #e2e2ea; overflow: hidden; margin-bottom: 20px; }
  .bar i { display: block; height: 100%; background: var(--accent); transition: width .3s; }
  form { display: flex; gap: 8px; margin-bottom: 14px; }
  input[type=text] { flex: 1; padding: 12px 14px; border: 1px solid #d9d9e3; border-radius: 12px; font-size: 15px; outline: none; }
  input[type=text]:focus { border-color: var(--accent); }
  button { border: 0; border-radius: 12px; padding: 0 16px; font-size: 14px; cursor: pointer; }
  .primary { background: var(--accent); color: #fff; height: 44px; }
  .filters { display: flex; gap: 6px; margin-bottom: 12px; }
  .filters button { background: #e7e7ef; color: #44445a; height: 30px; }
  .filters button.on { background: var(--accent); color: #fff; }
  ul.list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  ul.list li { display: flex; align-items: center; gap: 10px; background: #fff; padding: 12px 14px; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  ul.list li.done span { text-decoration: line-through; color: #9a9aad; }
  ul.list span { flex: 1; }
  .del { background: transparent; color: #b0b0c0; font-size: 18px; padding: 0 4px; }
  .empty { text-align: center; color: #9a9aad; padding: 28px 0; }
  .notes { margin-top: 28px; font-size: 13px; color: #6b6b80; }
  .notes h2 { font-size: 13px; margin: 0 0 6px; color: #44445a; }
  .notes ul { margin: 0; padding-left: 18px; }
</style>
</head>
<body>
<main>
  <h1>${esc(state.title)}</h1>
  <p class="sub" id="summary"></p>
  <div class="bar"><i id="progress"></i></div>
  <form id="form"><input type="text" id="text" placeholder="添加一条待办…" autocomplete="off"><button class="primary">添加</button></form>
  <div class="filters" id="filters"></div>
  <ul class="list" id="list"></ul>
  ${notes}
</main>
<script>
  var KEY = "mock-todos";
  var items = JSON.parse(localStorage.getItem(KEY) || "null") || [
    { id: 1, text: "体验智能体生成流程", done: true },
    { id: 2, text: "试着提出一条修改意见", done: false },
    { id: 3, text: "发布并分享链接", done: false }
  ];
  var filter = "all";
  var FILTERS = [["all", "全部"], ["active", "进行中"], ["done", "已完成"]];
  function save() { localStorage.setItem(KEY, JSON.stringify(items)); }
  function render() {
    var done = items.filter(function (i) { return i.done; }).length;
    document.getElementById("summary").textContent = "已完成 " + done + " / " + items.length;
    document.getElementById("progress").style.width = (items.length ? done / items.length * 100 : 0) + "%";
    document.getElementById("filters").innerHTML = FILTERS.map(function (f) {
      return '<button data-f="' + f[0] + '" class="' + (filter === f[0] ? "on" : "") + '">' + f[1] + "</button>";
    }).join("");
    var shown = items.filter(function (i) { return filter === "all" || (filter === "done") === i.done; });
    var list = document.getElementById("list");
    list.innerHTML = "";
    if (!shown.length) { list.innerHTML = '<div class="empty">这里还没有内容</div>'; return; }
    shown.forEach(function (item) {
      var li = document.createElement("li");
      if (item.done) li.className = "done";
      var box = document.createElement("input");
      box.type = "checkbox"; box.checked = item.done;
      box.onchange = function () { item.done = box.checked; save(); render(); };
      var span = document.createElement("span"); span.textContent = item.text;
      var del = document.createElement("button"); del.className = "del"; del.textContent = "×";
      del.onclick = function () { items = items.filter(function (i) { return i !== item; }); save(); render(); };
      li.append(box, span, del); list.append(li);
    });
  }
  document.getElementById("filters").onclick = function (e) {
    if (e.target.dataset.f) { filter = e.target.dataset.f; render(); }
  };
  document.getElementById("form").onsubmit = function (e) {
    e.preventDefault();
    var input = document.getElementById("text");
    var text = input.value.trim();
    if (!text) return;
    items.unshift({ id: Date.now(), text: text, done: false });
    input.value = ""; save(); render();
  };
  render();
</script>
</body>
</html>`;
}
