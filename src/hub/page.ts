/** The whole hub: one page, no framework, no build step. Message text is only ever set with textContent. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crosstalk</title>
<style>
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb; --error: #dc2626; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #60a5fa; --error: #f87171; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
h1 { font-size: 15px; margin: 0; }
#status { color: var(--muted); margin-left: auto; }
main { flex: 1; overflow-y: auto; padding: 8px 16px; }
.msg { padding: 6px 0; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); font-size: 12px; }
.from { color: var(--accent); font-weight: 600; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
form { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); }
input, textarea, select, button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
#to { width: 140px; }
#text { flex: 1; resize: vertical; min-height: 38px; }
button { cursor: pointer; }
#error { color: var(--error); padding: 0 16px; min-height: 1.5em; }
</style>
</head>
<body>
<header><h1>Crosstalk</h1><select id="run" aria-label="Run"></select><span id="status">connecting…</span></header>
<main id="log"></main>
<div id="error" role="alert"></div>
<form id="compose">
  <input id="to" value="all" aria-label="To: names or all">
  <textarea id="text" placeholder="Message as human" aria-label="Message"></textarea>
  <button>Send</button>
</form>
<script>
const $ = (id) => document.getElementById(id);
let source;

function row(msg) {
  const el = document.createElement('div');
  el.className = 'msg';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const from = document.createElement('span');
  from.className = 'from';
  from.textContent = msg.from;
  meta.append(new Date(msg.ts).toLocaleTimeString() + ' ', from, ' → ' + msg.to.join(', '));
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = msg.text;
  el.append(meta, text);
  return el;
}

function watch(run) {
  if (source) source.close();
  source = new EventSource('/api/stream?run=' + encodeURIComponent(run));
  // The server replays the run on every connection, so start clean each time.
  source.onopen = () => { $('log').replaceChildren(); $('status').textContent = 'live · ' + run; };
  source.onerror = () => { $('status').textContent = 'reconnecting…'; };
  source.onmessage = (event) => {
    const log = $('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(row(JSON.parse(event.data)));
    if (atBottom) log.scrollTop = log.scrollHeight;
  };
}

async function loadRuns() {
  const { current, runs } = await (await fetch('/api/runs')).json();
  if (!current) {
    $('status').textContent = 'no run yet; one starts when an agent joins';
    setTimeout(loadRuns, 3000);
    return;
  }
  $('run').replaceChildren(...runs.slice().reverse().map((id) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id === current ? id + ' (current)' : id;
    return option;
  }));
  $('run').value = current;
  watch(current);
}

$('run').onchange = () => watch($('run').value);
$('compose').onsubmit = async (event) => {
  event.preventDefault();
  $('error').textContent = '';
  const response = await fetch('/api/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: $('to').value, text: $('text').value }),
  });
  const body = await response.json();
  if (!response.ok) { $('error').textContent = body.error; return; }
  $('text').value = '';
};
loadRuns();
</script>
</body>
</html>
`;
