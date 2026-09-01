# Live terminal mirroring for supervised sessions: transport, buffering, rendering

Primary-source research note. Compiled 2026-08-31. Every specification, source
file and package version was read on that date. Every local measurement was
taken on that date on the machine described in §0.3.

**Why this exists.** The hub has to open a live terminal mirror for each of 1–6
concurrent agent sessions, let the operator scroll back through it, and let them
type into it — without stalling the daemon or the browser. The measured scale is
already known: a vault-1 seat produced a **16.9 MB / 1,779-line** transcript,
another **16.1 MB / 2,512 lines**, a third **14.3 MB / 1,875 lines** (MEASURED,
§0.3). Interactive pty output is a different and worse shape than those
transcripts, and this note establishes exactly how.

## Reading conventions

- **MEASURED** — a number produced by an experiment described here, or published
  by the project that owns the code with its method stated.
- **DOCUMENTED** — a constant, default or normative rule read out of a
  specification or a project's own source. Not a performance claim.
- **CLAIMED** — an assertion by a first party with no reproducible artifact.
- Local measurements are marked **[local]** and are reproducible from the scripts
  described inline. They were taken on one machine; treat them as orders of
  magnitude, not as portable constants.

---

## 0. The headline, before the detail

### 0.1 Six findings that decide the architecture

**One. The binding constraint on transport is not throughput, it is the
six-connection-per-origin cap, and this daemon cannot escape it via HTTP/2.**
Chromium hard-codes 6 sockets per host group for normal HTTP and **255 for
WebSocket**; Firefox ships 6 and **200** respectively. HTTP/2 would lift the HTTP
number to ~100 streams on one connection — but no browser speaks HTTP/2 over
cleartext, and the daemon is plain `http` on loopback. Six mirrors plus the
existing `/stream` is seven EventSources on one origin, and the seventh will
never connect. §1.1–1.3.

**Two. A full-screen agent TUI emits no newlines at all.** MEASURED [local]: an
interactive full-screen program at 120×40 produced 30,595 bytes over 10 s
containing **1,143 CSI sequences, 243 bare carriage returns, and zero newline
characters**. Every line-oriented design — line ring buffers, "give me the last N
lines", server-side ANSI stripping into text lines, a virtualized list over
pre-parsed lines — has nothing to operate on for this traffic. §4.1.

**Three. The reference implementation for the server side already exists and is
byte-oriented, not line-oriented.** VS Code's `TerminalRecorder` is a ring of raw
pty *bytes* capped at `MaxRecorderDataSize = 10 * 1024 * 1024`, trimmed from the
front by character count, with terminal-resize boundaries preserved, replayed
verbatim into xterm.js on reconnect. That is the whole mechanism. §2.2.

**Four. The current `/stream` write path has an unbounded, measured failure
mode.** `writeFrame` ignores `response.write()`'s return value. MEASURED [local]:
one client that connects and never reads caused **704.5 MB queued in the socket's
write buffer in 5 seconds and RSS growth from 41.4 MB to 1,362.5 MB**. Node
documents the endpoint of this exactly: "Node.js will buffer all written chunks
until maximum memory usage occurs, at which point it will abort unconditionally."
§5.5, §8.1.

**Five. The interactive-seat path is broken on macOS, and the reason is the
`script` trick — including in the version being written right now.** MEASURED
[local]: an interactive seat exits with **code 1** immediately, because
`openSession` spawns with `stdio: ['pipe','pipe','pipe']` and macOS `script`
requires a *character device or tty* on its own stdin —
`script: tcgetattr/ioctl: Operation not supported on socket`. It fails on a
socketpair and on a real FIFO alike. There is no pipe you can hand it that it
will also let you write to. §5.1, §8.4, and **§10 for the in-flight rewrite,
which has the same defect**.

**Six. Per-pty cost is negligible; retention and delivery are the entire
problem.** MEASURED [local]: **~4.05–4.33 file descriptors per pty** in the
daemon process and **no measurable RSS growth** at 1, 3, 6 and 20 concurrent
ptys when output is discarded. The OS ceilings are far away (macOS
`PTMX_MAX_DEFAULT` 511, hard cap 999; Linux `kernel.pty.max` 4096). What degrades
is the single-threaded reader: aggregate read throughput saturates near **27
MB/s** and per-pty throughput falls **6.3×** from 1 to 20 ptys. §6.

### 0.2 The numbers you will want on one screen

| Fact | Value | Source |
|---|---|---|
| Chrome max sockets per host (normal) | **6** | Chromium `client_socket_pool_manager.cc` |
| Chrome max sockets per host (WebSocket) | **255** | same |
| Firefox `max-persistent-connections-per-server` | **6** | Firefox `all.js` |
| Firefox `network.websocket.max-connections` | **200** | same |
| HTTP/2 recommended min concurrent streams | **≥ 100** | RFC 9113 §6.5.2 |
| Browsers supporting cleartext HTTP/2 | **none** | IETF HTTP WG FAQ |
| tmux `history-limit` default | **2000 lines** | tmux `options-table.c` |
| GNU screen `defscrollback` default | **100 lines** | GNU screen manual |
| xterm.js `scrollback` default | **1000 lines** | xterm.js `ITerminalOptions` |
| VS Code `terminal.integrated.scrollback` | **1000 lines** | VS Code `terminalConfiguration.ts` |
| VS Code `persistentSessionScrollback` | **100 lines** | VS Code `terminalPlatformConfiguration.ts` |
| VS Code terminal replay ring cap | **10 MB of raw bytes** | VS Code `terminalRecorder.ts` |
| VS Code pty flow-control high/low watermark | **100,000 / 5,000 chars** | VS Code `terminal.ts` |
| xterm.js write-buffer discard watermark | **50,000,000 bytes** | xterm.js `WriteBuffer.ts` |
| xterm.js "typically unresponsive" threshold | **> 500 kB pending** | xterm.js `WriteBuffer.ts` comment |
| xterm.js memory per cell | **12 bytes** (3 × uint32) | xterm.js `BufferLine.ts` |
| WebGL vs canvas renderer | **0.69 vs 4.80 ms/frame** at 87×26 | xterm.js PR #1790 |
| macOS pty ceiling | **511 default / 999 hard** | xnu `tty_ptmx.c` |
| Linux pty ceiling | **4096 global / 1024 reserved** | kernel `devpts.rst` |
| Node default `highWaterMark` (non-Windows) | **65,536 bytes** | Node `stream.md` |
| node-pty latest | **1.1.0**, published 2025-12-22 | npm registry |
| node-pty prebuilds shipped | darwin arm64/x64, win32 arm64/x64 — **no Linux** | published tarball |

### 0.3 The measurement rig

All **[local]** numbers: macOS Darwin 25.5.0, arm64, Node **v22.23.0**,
node-pty **1.1.0**. Local system limits read directly:
`kern.tty.ptmx_max: 511`, `kern.maxfiles: 30720`,
`kern.maxfilesperproc: 10240`, `ulimit -n: 1048576`.

Three pty capture samples were taken with node-pty at 120×40 and are referenced
throughout:

| Sample | What it is | Bytes | Duration | Rate | CSI seqs | bare CR | newlines | % bytes that are escapes |
|---|---|---|---|---|---|---|---|---|
| `topui` | interactive full-screen TUI redraw | 30,595 | 10.005 s | **3,058 B/s** | 1,143 | 243 | **0** | **24.8%** |
| `gitlog` | `git log --stat -200`, colour on | 279,263 | 863 ms | **323,596 B/s** | 2,730 | 3 | 5,029 | 3.9% |
| `top -l` | line-mode scrolling status output | 1,715,623 | ~8 s | **~214 KB/s** | 0 | 0 | 5,380 | 0% |

`topui` is the shape a Claude Code / Codex / Cursor TUI has. `gitlog` is the
shape a build or test log has. Both shapes will appear in the same mirror.

The vault-1 transcript sizes quoted at the top were read from
`~/.claude/projects/-Users-moazessam-bench-vault-1-team--crosstalk-worktrees-*/`:
16.9 MB/1,779 lines, 16.1 MB/2,512 lines, 14.3 MB/1,875 lines, plus five smaller
files, average line length 5.5–14.9 kB.

---

## 1. Transport

### 1.1 What the EventSource spec actually guarantees

Source: [WHATWG HTML Living Standard, Server-sent
events](https://html.spec.whatwg.org/multipage/server-sent-events.html), read
2026-08-31. All DOCUMENTED.

**Encoding.** "Event streams in this specification must always be encoded as
UTF-8." There is no binary mode. Raw pty bytes that are not valid UTF-8 — and
partial multi-byte sequences split across pty reads *are* invalid UTF-8 — cannot
be put on the wire as-is. They must be JSON-escaped, base64-encoded, or buffered
until the sequence completes. §1.4 measures the cost of each.

**Framing.** Fields are `data`, `event`, `id`, `retry`. The `data` field
processing is "Append the field value to the data buffer, then append a single
U+000A LINE FEED (LF) character to the data buffer" — so a payload containing
newlines becomes one `data:` line per newline, and the reassembled payload gains
a trailing LF that the sender did not write. That last detail is a real hazard
for terminal bytes: a naive multi-line encoder silently appends a newline to
every frame.

**`id` and resume.** "If the field value does not contain U+0000 NULL, then set
the last event ID buffer to the field value. Otherwise, ignore the field." The id
also has to avoid LF and CR — the spec describes the `Last-Event-ID` header value
as "essentially any UTF-8 encoded string, that does not contain U+0000 NULL,
U+000A LF, or U+000D CR." On reconnect the UA sets `('Last-Event-ID',
lastEventIDValue)` on the request automatically. Note the id sticks across
events: "If an event doesn't have an 'id' field, but an earlier event did set the
event source's last event ID string, then the event's lastEventId field will be
set to the value of whatever the last seen 'id' field was."

**Reconnection is not automatic in the cases you care most about.** The spec's
response-processing step is explicit: "if res's status is not 200, or if res's
`Content-Type` is not `text/event-stream`, then **fail the connection**." Failing
is terminal — "it does not attempt to reconnect", `readyState` goes to `CLOSED`,
and an `error` event fires. Only a *network error* triggers "reestablish the
connection", and even then the UA may give up if it "knows that to be futile."

This is the trap for a session mirror. A daemon that answers `404` for a session
id that has not started yet, or `503` while it restarts, gets a permanently dead
EventSource with no retry — and the hub's `useLog` today only sets
`connected = false` on `onerror`, so the symptom is a board that says
"disconnected" forever. A mirror must therefore either always return 200 (with an
in-band error frame), or implement its own reconnect on top of `onerror`.

**The default retry delay is unspecified.** "This must initially be an
implementation-defined value, probably in the region of a few seconds." Send an
explicit `retry:` if you care.

**And the spec itself names the connection-limit problem.** "Clients that support
HTTP's per-server connection limitation might run into trouble when opening
multiple pages from a site if each page has an EventSource to the same domain."
Its suggested mitigations are unique domain names per connection, a per-page
enable/disable, or "sharing a single EventSource object using a shared worker."
The spec imposes no normative limit itself — the limit is the browser's.

### 1.2 The six-connection cap, from the browsers' own source

**Chromium** — `net/socket/client_socket_pool_manager.cc`
([chromium.googlesource.com](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/socket/client_socket_pool_manager.cc)),
read 2026-08-31. DOCUMENTED:

```cpp
std::array<size_t, kSocketPoolTypesSize> g_max_sockets_per_group =
    std::to_array<size_t>({
        6,   // kNormal
        255  // kWebSocket
    });
```

with the comments "Default to allow up to 6 connections per host. Experiment and
tuning may try other values (greater than 0)." and, for the WebSocket entry,
"WebSocket connections are long-lived, and should be treated differently than
normal other connections. Use a limit of 255, so the limit for wss will be the
same as the limit for ws." The same file sets `g_max_sockets_per_proxy_chain` to
128 and a soft cap per pool of 256.

**Firefox** — `modules/libpref/init/all.js`, read 2026-08-31. DOCUMENTED:

```js
pref("network.http.max-persistent-connections-per-server", 6);
pref("network.http.max-urgent-start-excessive-connections-per-host", 3);
pref("network.websocket.max-connections", 200);
```

**MDN** states the consequence plainly ([Using server-sent
events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events),
read 2026-08-31): "When **not used over HTTP/2**, SSE suffers from a limitation
to the maximum number of open connections, which can be especially painful when
opening multiple tabs, as the limit is _per browser_ and is set to a very low
number (6)." And: "This limit is per browser + domain."

Three independent primary sources agree. The number is 6, it is per origin, and
it counts every in-flight HTTP/1.1 request on that origin — the hub's existing
`/stream`, its `/mirror` poll every 10 s (`src/ui/state/useMirror.ts`), asset
loads, and every terminal mirror.

**The arithmetic for this project.** The hub holds `/stream` open permanently.
That leaves 5. Six session mirrors on separate EventSources need 6. The seventh
request queues behind the first that finishes — and none of them finish, because
they are all long-lived streams. This is a deadlock, not a slowdown, and it
happens at exactly the "1–6 concurrent sessions" the daemon is specified to
supervise.

### 1.3 HTTP/2 lifts it, and this daemon cannot have HTTP/2

RFC 9113 ([rfc-editor.org](https://www.rfc-editor.org/rfc/rfc9113.html), June
2022) — DOCUMENTED. `SETTINGS_MAX_CONCURRENT_STREAMS`: "Initially, there is no
limit to this value" and "It is recommended that this value be no smaller than
100, so as to not unnecessarily limit parallelism."
`SETTINGS_INITIAL_WINDOW_SIZE` "initial value is 2^16-1 (65,535) octets."
§9.1 Connection Management: "Clients SHOULD NOT open more than one HTTP/2
connection to a given host and port pair." MDN concurs: "When using HTTP/2, the
maximum number of simultaneous _HTTP streams_ is negotiated between the server
and the client (defaults to 100)."

So HTTP/2 turns "6 connections" into "~100 streams on 1 connection", which would
solve the problem outright. **But the daemon serves plain `http://127.0.0.1:PORT`
with `node:http`.** HTTP/2 without TLS (h2c) requires prior knowledge or an
upgrade dance, and the IETF HTTP Working Group's own FAQ
([http2.github.io/faq](https://http2.github.io/faq/)) states: "some
implementations have stated that they will only support HTTP/2 when it is used
over an encrypted connection, and currently **no browser supports HTTP/2
unencrypted**." Node's `http2` module can serve h2c; no browser will speak it.

Getting HTTP/2 here would mean terminating TLS on loopback with a self-signed
certificate the operator has to trust. For a tool whose front door is "open
this localhost URL", that is a worse trade than avoiding the problem. **CLAIMED,
mine, not sourced:** this is a judgement call, not a documented fact.

The remaining HTTP/1.1-compatible escapes are:

1. **One connection carrying every session's output**, demultiplexed client-side.
   Costs 1 of the 6 regardless of session count.
2. **WebSocket**, which draws from a different, far larger pool (255 in Chrome,
   200 in Firefox — §1.2).
3. **A `SharedWorker`** holding one EventSource and fanning out via
   `postMessage`, which the WHATWG spec itself names. Adds a worker lifecycle and
   a second messaging layer for no gain over option 1 in a single-tab tool.

### 1.4 SSE text framing overhead, measured

Terminal bytes must be escaped to survive SSE's line-oriented text format. Four
encodings were measured [local] against the three capture samples, replayed at
two chunk sizes. WebSocket overhead is computed from RFC 6455 §5.2 framing
(2-byte base header, 4 bytes for payloads ≥126, 10 bytes for ≥65536; server→client
frames are unmasked).

| Sample | chunk | frames | raw bytes | WebSocket | SSE + `JSON.stringify` | SSE + base64 | SSE multi-`data:` |
|---|---|---|---|---|---|---|---|
| `topui` (TUI) | 512 B | 60 | 30,595 | **+0.8%** | **+22.9%** | +36.5% | +2.9% |
| `topui` (TUI) | 4096 B | 8 | 30,595 | +0.1% | **+20.0%** | +33.8% | +0.4% |
| `gitlog` | 512 B | 545 | 279,263 | +0.8% | +12.0% | +36.7% | +13.9% |
| `gitlog` | 4096 B | 69 | 279,263 | +0.1% | +9.0% | +33.7% | +11.2% |
| `top -l` | 512 B | 3,351 | 1,715,623 | +0.8% | +4.3% | +36.8% | +5.1% |
| `top -l` | 4096 B | 419 | 1,715,623 | +0.1% | **+1.1%** | +33.8% | +2.3% |

**Reading this.** Base64 is a flat ~34–37% tax and is the worst option except for
its one virtue: it is the only encoding that survives arbitrary bytes, including
a UTF-8 sequence split across a pty read. `JSON.stringify` costs 1–23% depending
entirely on how escape-dense the traffic is — and TUI traffic is the dense end,
because a single ESC byte costs six characters (`\\u001b`) once JSON-escaped. The multi-`data:` split is
cheapest but is the encoding that silently appends a trailing LF (§1.1) and does
nothing for bare CR, which `topui` contains 243 of.

**But scale these against the actual rates.** The TUI sample runs at 3,058 B/s.
A 23% framing tax on 3 kB/s is 700 bytes per second per session. This is not a
throughput problem at any plausible session count. The framing argument for
WebSocket is real but small; **the connection-cap argument is the one that
decides it.**

### 1.5 Where SSE actually becomes the bottleneck: nowhere near here

MEASURED [local], loopback, one Node `http` server writing
`id: N\ndata: <4106-byte JSON-escaped pty chunk>\n\n` frames as fast as the
socket accepts, for 3 seconds:

| Client | throughput | frames/s | `write()` returned false | peak socket buffer | `writableHighWaterMark` |
|---|---|---|---|---|---|
| reads as fast as it can | **298.9 MB/s** | 67,120 | 13,424 | 66,969 B | 65,536 |
| deliberately slow (resumes 1 ms per 50 ms) | **37.0 MB/s** | 8,313 | 1,662 | 66,969 B | 65,536 |

SSE text framing over loopback sustains ~299 MB/s — roughly **900×** the
`gitlog` rate and **100,000×** the TUI rate. In both runs the server respected
`write()`'s return value and the socket's queued bytes never exceeded ~67 kB.
`writableHighWaterMark` is 65,536, which matches Node's documented default: "For
byte streams, it defaults to `65536` (64 KiB) on non-Windows platforms and
`16384` (16 KiB) on Windows" (`doc/api/stream.md`,
`stream.getDefaultHighWaterMark`; the value was bumped in **v22.0.0**, PR 52037).

**Conclusion for Q1.** SSE's text framing is not the bottleneck at any rate this
project will produce. The reasons to prefer WebSocket are (a) the connection
pool, 255/200 vs 6, and (b) that a mirror needs a *client→server* channel for
typed input anyway, which EventSource cannot provide — MDN: "This is a one-way
connection, so you can't send events from a client to a server."

The reasons to prefer SSE are that it already exists here, it reconnects itself
with `Last-Event-ID`, it is trivially debuggable with `curl`, and it survives
every proxy. Long-polling and chunked `fetch` streaming are strictly worse than
SSE for this: both consume the same scarce HTTP/1.1 connection, and neither gets
`Last-Event-ID` for free.

### 1.6 Transport verdict

| Option | conns used for 6 mirrors | input channel | resume | verdict |
|---|---|---|---|---|
| One EventSource per session | **6 of 6** — deadlocks with `/stream` | no | free | **Rejected** |
| One multiplexed EventSource + `POST` for input | **1** | separate POST | free | **Recommended** |
| One WebSocket per session | 6 of 255 | yes | hand-rolled | Viable, heavier |
| One multiplexed WebSocket | 1 of 255 | yes | hand-rolled | Viable, best ceiling |
| Chunked `fetch` streaming | same as SSE | separate POST | hand-rolled | No advantage |
| Long-poll | same, plus reconnect churn | separate POST | cursor | Fallback only |

---

## 2. Server-side buffering of pty output

### 2.1 What the established projects cap, and at what

All DOCUMENTED, read from each project's own source or manual on 2026-08-31.

**tmux** — `options-table.c`:

```c
{ .name = "history-limit",
  .type = OPTIONS_TABLE_NUMBER,
  .scope = OPTIONS_TABLE_SESSION,
  .minimum = 0,
  .maximum = INT_MAX,
  .default_num = 2000,
  .unit = "lines",
  .text = "Maximum number of lines to keep in the history for each pane. "
          "If changed, the new value applies only to new panes."
}
```

2,000 lines per pane, and — this matters — tmux stores a **parsed grid**, not raw
bytes. Its retrieval API, `capture-pane`, exposes exactly the two operations this
project needs: `-p` writes to stdout, `-S start-line` / `-E end-line` select the
range where "Zero is the first visible line" and negative numbers index into
history, `-S -` means from the beginning of history. And crucially `-e` "includes
escape sequences for text/background attributes" — tmux parses on ingest and
*re-synthesises* SGR on the way out. It does not keep the original byte stream.

**GNU screen** — the GNU manual, §12.1.2 Scrollback: "Command: `defscrollback
num` … Same as the `scrollback` command except that the default setting for new
windows is changed. **Defaults to 100.**"

**VS Code** — three separate caps, and the layering is the lesson.

- `terminal.integrated.scrollback`, default **1000**, described as "Controls the
  maximum number of lines the terminal keeps in its buffer. We pre-allocate
  memory based on this value in order to ensure a smooth experience. As such, as
  the value increases, so will the amount of memory."
  (`terminalConfiguration.ts`)
- `terminal.integrated.persistentSessionScrollback`, default **100**: "Controls
  the maximum amount of lines that will be restored when reconnecting to a
  persistent terminal session. Increasing this will restore more lines of
  scrollback at the cost of more memory and **increase the time it takes to
  connect to terminals on start up**." (`terminalPlatformConfiguration.ts`)
- The pty-host recording ring, **10 MB of raw bytes** (§2.2).

The middle one is the direct answer to "opening a session mirror must feel
instant": VS Code ships a **10× smaller** reconnect tail than its live scrollback
specifically because restore time is connect time. It is not a memory decision;
it is a latency decision.

**ttyd** — `-m, --max-clients` default **0, no limit**. Its README claims "Built
on top of libuv and WebGL2 for speed" (CLAIMED, no artifact). Its actual
buffering strategy is visible in `src/pty.c`: `read_cb` begins with
`uv_read_stop(stream)` — it stops reading the pty entirely after every chunk and
does not resume until the WebSocket write for that chunk has completed. Plus an
explicit client-driven pause protocol in `server.h`: `#define PAUSE '2'` /
`#define RESUME '3'`. ttyd's answer to buffering is **not to buffer** — it pushes
backpressure straight into the pty.

**gotty** — `--max-connection` default **0**. Its README describes it as a
server that "simply relays output from the TTY to clients"; no scrollback, no
resume. Not a useful reference for this problem.

### 2.2 VS Code's `TerminalRecorder` is the shape to copy

`src/vs/platform/terminal/common/terminalRecorder.ts`, read 2026-08-31. This is
the closest existing thing to what Crosstalk needs, and it is ~90 lines.

```ts
const enum Constants {
	MaxRecorderDataSize = 10 * 1024 * 1024 // 10MB
}

interface RecorderEntry {
	cols: number;
	rows: number;
	data: string[];
}
```

The mechanism, in full:

- One entry per *terminal size*. A resize pushes a new entry; a resize with no
  data since the last one replaces it rather than accumulating empties.
- `handleData` appends the raw chunk to the current entry's `data` array and adds
  its length to a running `_totalDataLength`.
- The trim loop runs `while (this._totalDataLength > MaxRecorderDataSize)` and
  drops from the **front**: whole chunks when they fit entirely inside the
  overage, otherwise `firstEntry.data[0] = firstEntry.data[0].substr(remainingToDelete)`
  — a partial cut of the oldest chunk. An emptied entry is shifted off.
- `generateReplayEventSync()` joins each entry's chunks into one string and emits
  `{ cols, rows, data }` per entry.

Three design decisions worth naming, because each is a choice this project also
has to make:

1. **It stores raw bytes, not lines and not a parsed grid.** Opposite of tmux.
   The cost is that you cannot answer "give me lines 400–450" without replaying;
   the benefit is that replay is byte-exact and costs nothing on ingest.
2. **It caps by bytes, not by lines.** Given §4.1 — a TUI emits zero newlines — a
   line cap on this traffic would be a cap of one.
3. **It accepts cutting mid-escape-sequence.** `substr(remainingToDelete)` has no
   idea where sequence boundaries are. The replay therefore may begin partway
   through a CSI sequence. VS Code tolerates this because xterm.js's parser
   discards an unterminated prefix and resynchronises. That is a real, shipped
   precedent for "don't try to be clever about escape boundaries at the cut."

### 2.3 The flow-control contract VS Code puts around it

`src/vs/platform/terminal/common/terminal.ts`, DOCUMENTED:

```ts
export const enum FlowControlConstants {
	/**
	 * The number of _unacknowledged_ chars to have been sent before the pty is paused in order for
	 * the client to catch up.
	 */
	HighWatermarkChars = 100000,
	/**
	 * ... this is the number of _unacknowledged_ chars to have been caught up to on the client
	 * before resuming the pty again. ... In reality this balance is hard to accomplish though so
	 * heavy commands will likely pause as latency grows, not flooding the connection is the
	 * important thing as it's shared with other core functionality.
	 */
	LowWatermarkChars = 5000,
	/**
	 * The number characters that are accumulated on the client side before sending an ack event.
	 * This must be less than or equal to LowWatermarkChars or the terminal max never unpause.
	 */
	CharCountAckSize = 5000
}
```

Same file: `LocalReconnectConstants` with `GraceTime = 60000` and
`ShortGraceTime = 6000` — how long an orphaned pty is kept alive waiting for a
client to come back.

xterm.js's own [flow control
guide](https://xtermjs.org/docs/guides/flowcontrol/) recommends the identical
shape with slightly different numbers: `HIGH = 100000`, `LOW = 10000` as a
starting point, or a callback-counting variant with
`CALLBACK_BYTE_LIMIT = 100000`, `HIGH = 5`, `LOW = 2` pending callbacks. It
warns: "a custom flow control mechanism can easily stop the whole stream forever
if the limits are not calculated/applied correctly."

Note the constraint VS Code embeds in a comment and xterm.js repeats: the ack
size **must** be ≤ the low watermark, or the pty never resumes. That is the
single most likely way to get this wrong.

### 2.4 The shape to build

Synthesising §2.1–2.3, a bounded per-session buffer that answers both "last N"
and "everything after X" is:

- **A byte ring with a sequence number per appended chunk.** Chunks, not lines.
  Each chunk gets a monotonically increasing `seq` (or, better, a byte offset —
  see below) and the ring drops from the front when total bytes exceed the cap.
- **Index by cumulative byte offset, not by chunk index.** A cursor of "bytes
  produced so far" survives a partial front-trim, lets a client ask for "give me
  from offset X", and lets the server answer "X is older than my oldest retained
  byte, here is a fresh tail instead" — which is the honest answer, and the one
  a chunk index cannot express after a partial cut.
- **Record resize boundaries alongside**, exactly as `TerminalRecorder` does, so
  a replay can restore geometry before replaying the bytes that assumed it.
- **Cap by bytes**, at a number chosen for *replay latency*, not memory. VS Code
  picked 10 MB for the ring and a separate 100-line restore for the same reason.

Sizing for this project: the TUI sample runs at 3,058 B/s. 10 MB is **~54 minutes**
of one interactive agent session. The `gitlog` sample runs at 324 kB/s — 10 MB is
**31 seconds** of a build log. Both numbers are real and they are three orders of
magnitude apart, which is the argument for a byte cap with a *time* floor rather
than a byte cap alone: a session that has been quiet for four hours should still
have its last four hours, and one that just ran a noisy test suite should not
evict them.

---

## 3. Client-side rendering

### 3.1 xterm.js renderers, with the maintainers' own numbers

The only published benchmark comparing xterm.js renderers is
[PR #1790](https://github.com/xtermjs/xterm.js/pull/1790), by the maintainer
(Tyriar), measured by injecting timing around `_renderRows`. MEASURED, by the
project, method stated:

| Benchmark | canvas (avg ms/frame) | WebGL (avg ms/frame) | faster by |
|---|---|---|---|
| Macbook 87×26 | 4.80 | **0.69** | 596% |
| Macbook 300×80 | 15.28 | **3.69** | 314% |
| Windows 87×26 | 7.31 | **0.73** | 901% |
| Windows 300×80 | 19.34 | **2.06** | 839% |
| Macbook 87×26 CJK | 14.63 | **5.93** | 147% |
| Macbook 87×26 Emoji | 27.47 | **19.28** | 42% |

Hardware: Macbook Pro mid-2014 (Intel Iris Pro) and a GTX 760. Stated caveat:
"The injected code is necessary because it's difficult to measure otherwise as
the number of frames and average frame time isn't captured by the timeline."

Two things to take from this. First, at 300×80 — close to the 120×40 a mirror
would use — the canvas renderer costs **15.28 ms/frame**, which is already past
the 16.7 ms budget for 60 fps *before* any React work on the same thread. Second,
the emoji row is the honest one: 19.28 ms/frame on WebGL. Agent CLIs emit emoji
and box-drawing constantly.

The DOM renderer, which is xterm.js's default, has **no published benchmark at
all**. The README says only "Xterm.js is *really* fast and includes an optional
GPU-accelerated renderer" (CLAIMED). The
[`@xterm/addon-webgl` README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl)
"enables a WebGL2-based renderer" and warns about context loss: "The browser may
drop WebGL contexts for various reasons like OOM or after the system has been
suspended", offering disposal of the addon as "An easy, but suboptimal way" to
handle it. A hub left open overnight on a laptop that sleeps **will** hit this,
so the WebGL addon needs a `onContextLoss` handler that falls back rather than
going blank.

VS Code's own setting, `terminal.integrated.gpuAcceleration`, defaults to
`'auto'` with values `['auto','on','off']` — i.e. even Microsoft does not commit
to the GPU path unconditionally.

### 3.2 xterm.js memory per line, computed from its source

`src/common/buffer/BufferLine.ts`, DOCUMENTED:

```
// Buffer memory layout:
//
// [0]: content `uint32_t` - wcwidth(2) comb(1) codepoint(21)
// [1]: fg      `uint32_t` - flags(8) r(8) g(8) b(8)
// [2]: bg      `uint32_t` - flags(8) r(8) g(8) b(8)

const enum Constants {
  /** The number of 32 bit array indices taken by one cell. */
  CELL_INDICIES = 3,
```

and the constructor is `this._data = new Uint32Array(cols * Constants.CELL_INDICIES)`.

**12 bytes per cell**, plus a `BufferLine` object, plus two sparse side-caches
(`_combined` for combining characters, `_extendedAttrs`) and a `_cache` string
per line. `src/common/buffer/Buffer.ts` holds them in
`new CircularList<IBufferLine>(rows + scrollback)` with
`MAX_BUFFER_SIZE = 4294967295`.

Computed, typed-array bytes only — the true figure is higher by the per-line
object overhead:

| scrollback | 80 cols | 120 cols | 200 cols |
|---|---|---|---|
| 1,000 (default) | 0.96 MB | **1.44 MB** | 2.4 MB |
| 10,000 | 9.6 MB | **14.4 MB** | 24 MB |
| 100,000 | 96 MB | **144 MB** | 240 MB |
| 1,000,000 | 960 MB | **1.44 GB** | 2.4 GB |

This is per terminal. Six mirrors at 10,000 lines × 120 cols is ~86 MB of typed
arrays *before* object overhead — tolerable. Six at 100,000 lines is ~864 MB,
which is not. VS Code's `scrollback` default of 1000 with the note "We
pre-allocate memory based on this value" is the calibrated answer from the
project that ships this to millions of users.

**The 1M-line scrollback in the brief is not reachable with xterm.js as the
store.** It is reachable if xterm.js holds a window and the *server* holds the
history — which is the recommendation in §9.

### 3.3 The write buffer, and the number that decides "instant"

`src/common/input/WriteBuffer.ts`, DOCUMENTED — and the comment is the single
most useful sentence in this entire note:

```ts
const enum Constants {
  /**
   * Safety watermark to avoid memory exhaustion and browser engine crash on fast data input.
   * Enable flow control to avoid this limit and make sure that your backend correctly
   * propagates this to the underlying pty. (see docs for further instructions)
   * Since this limit is meant as a safety parachute to prevent browser crashs,
   * it is set to a very high number. Typically xterm.js gets unresponsive with
   * a 100 times lower number (>500 kB).
   */
  DISCARD_WATERMARK = 50000000, // ~50 MB
  /**
   * The max number of ms to spend on writes before allowing the renderer to
   * catch up with a 0ms setTimeout. A value of < 33 to keep us close to
   * 30fps, and a value of < 16 to try to run at 60fps.
   */
  WRITE_TIMEOUT_MS = 12,
  /**
   * Threshold of max held chunks in the write buffer, that were already processed.
   */
  WRITE_BUFFER_LENGTH_THRESHOLD = 50
}
```

**"Typically xterm.js gets unresponsive with a 100 times lower number (>500 kB)."**
CLAIMED by the maintainers, no artifact attached, but it is their own code and it
is the operative constraint for "opening a session mirror must feel instant".

Cross-check it against the tail sizes the reference projects ship. VS Code
restores **100 lines** on reconnect. At 120 columns, 100 lines of dense
escape-carrying output is comfortably under 100 kB. VS Code's replay ring is
10 MB — twenty times the "gets unresponsive" threshold — which is precisely why
`persistentSessionScrollback` exists as a *separate, smaller* setting. The ring
is what you keep; the tail is what you push.

**Implication.** An "open the mirror" request must ship a tail measured in the
**low hundreds of kB**, not the 10 MB ring, and certainly not the 17 MB
transcript. Everything older is paged in on demand.

### 3.4 xterm.js versus a virtualized list over pre-parsed lines

The question in the brief is whether a read-only mirror is better served by a
virtualized list. The honest answer has two halves.

**For scrolling text output, a virtualized list is genuinely cheaper.** No VT
parser, no 12-bytes-per-cell grid, no renderer; just N absolutely-positioned rows
with pre-computed spans. React virtualizers do this in a few kB. If the mirror
only ever showed `gitlog`-shaped traffic — 5,029 newlines, 3.9% escape bytes,
3 bare CRs — this would be the right call and it would let 1M lines work.

**For an agent CLI it does not work at all, and §4.1 is the proof.** The `topui`
sample contains **zero newlines**. There are no lines to virtualize. The
"lines" the operator sees are a 2-D grid that the program repaints by moving the
cursor and overwriting cells. Reconstructing them requires a VT parser that
maintains a grid — which is what xterm.js *is*. Writing a second one to feed a
virtualized list is strictly more work than using the first.

There is a middle path worth naming, because it is what tmux does: parse
server-side into a grid, and serve *rendered* lines to a dumb client. That is
§4.3, and its cost is that you now own a VT emulator on the server.

**Verdict for Q3.** xterm.js is the right call for the live window, because it is
the only component that handles the TUI case correctly. Use `@xterm/addon-webgl`
with a context-loss fallback. Keep `scrollback` at or near the 1000 default and
page history from the server rather than growing the client buffer — which also
means the mirror never approaches the 500 kB write-buffer cliff or the 144 MB
grid.

---

## 4. ANSI handling

### 4.1 What an agent TUI actually emits — the decisive measurement

MEASURED [local], full-screen interactive program under node-pty at 120×40 for
10 seconds:

```
bytes:      30,595        newlines:            0
chunks:     36            bare carriage returns: 243
CSI seqs:   1,143         bytes that are escapes: 24.8%
rate:       3,058 B/s     chunks/s:            3.6
```

**Zero newlines in 30 kB.** Compare the same measurement on `git log --stat`:
5,029 newlines, 3 bare CRs, 3.9% escape bytes. And on `npm install` under a pty:
638 bytes, 2 newlines, 136 CSI sequences, **85.3% of bytes are escapes**.

These are three completely different traffic shapes and a mirror will see all
three inside a single session — the agent's TUI frame, the build it shells out
to, and the spinner in between.

### 4.2 What breaks if you strip

Stripping ANSI server-side and shipping text destroys, in order of severity:

1. **Cursor addressing.** `ESC[H`, `ESC[<n>;<m>H`, `ESC[<n>A/B/C/D` are how a TUI
   positions every character it writes. Strip them and the 1,143 sequences in the
   `topui` sample collapse into one unbroken run of text with no structure at
   all — 23,004 bytes of glyphs in no order that means anything.
2. **Progress redraws.** 243 bare `\r` in 10 seconds. A bare CR means "return to
   column 0 and overwrite". Strip the CR and every progress-bar frame becomes a
   separate visible line; keep the CR but strip the erase sequences (`ESC[K`,
   `ESC[2K`) and stale characters from the longer previous frame survive past the
   end of the shorter new one.
3. **Alternate screen.** `ESC[?1049h/l` is how a full-screen program takes over
   and then restores the shell's scrollback. Strip it and the TUI's frames get
   interleaved into the scroll history permanently.
4. **Semantic colour.** Agent CLIs use colour to distinguish a diff's additions
   from deletions and an error from a warning. This one is merely lossy, not
   structural.

`ESC[K` deserves a specific callout because it is the one people forget: it
clears from the cursor to end of line, and it is what makes a shrinking spinner
frame not leave debris. Any half-measure that keeps CR and drops CSI produces
exactly that debris.

### 4.3 Where the reference projects draw the line

- **VS Code**: ships raw bytes, both live and on replay. `TerminalRecorder`
  stores `string[]` of unmodified pty output and replays it verbatim. Zero
  server-side parsing. It also, as noted in §2.2, cuts the oldest chunk
  mid-sequence without concern.
- **tmux**: parses on ingest into a grid, and re-synthesises escapes on demand —
  `capture-pane -e` "includes escape sequences for text/background attributes".
  It owns a full VT emulator, which is why it can answer "lines 400–450" and VS
  Code cannot.
- **ttyd**: relays raw pty bytes over WebSocket with a one-byte `OUTPUT '0'`
  message-type prefix and no parsing.

Two of the three ship raw. The one that parses does so because it *is* the
terminal, not a mirror of one.

### 4.4 Library choice, if you parse anyway

- **Stripping:** Node has this built in. `util.stripVTControlCharacters(str)`,
  added **v16.11.0**, "Returns `str` with any ANSI escape codes removed." Zero
  dependencies. The `strip-ansi` README itself now says: "Node.js has this
  built-in now with `stripVTControlCharacters`. … The Node.js version is actually
  based on this package."
- **Matching:** `ansi-regex` (chalk org) is the upstream of both. Note its
  maintainers' explicit stance, which matters for a server that runs it on
  untrusted subprocess output: "If you run the regex against untrusted user input
  in a server context, you should give it a timeout. **I do not consider ReDoS a
  valid vulnerability for this package.**"
- **Full emulation server-side:** `@xterm/headless` — "a headless terminal that
  can be run in node.js. This is useful in combination with the frontend `xterm`
  for example to keep track of a terminal's state on a remote server where the
  process is hosted." Marked "⚠ This package is experimental". Paired with
  `@xterm/addon-serialize`, which "enables xterm.js to serialize a terminal
  framebuffer into string or html" and is also marked "⚠ This is an experimental
  addon that is still under construction ⚠".

That last pairing is the tmux strategy available off the shelf: run a headless
xterm.js per session on the daemon, feed it the pty, and serialize a bounded
window on demand. It is the only way to get "give me lines 400–450" for TUI
traffic. Both halves are labelled experimental by their own maintainers, which is
the risk.

**Verdict for Q4.** Ship raw bytes to the client. Do not strip. Follow VS Code,
not tmux. Revisit `@xterm/headless` only if server-side line addressing or
search across a session becomes a requirement.

---

## 5. node-pty versus the `script` trick

### 5.1 The `script` trick is broken in this codebase, on this platform

`src/harness/session.ts:44-46` defines:

```ts
export function underPty(argv: string[]): string[] {
  return ['script', '-q', '/dev/null', ...argv];
}
```

and `defaultSpawn` (`session.ts:138-144`) spawns with
`stdio: ['pipe', 'pipe', 'pipe']`.

MEASURED [local], against the built `dist/harness/session.js`:

```
underPty(['claude','--remote-control'])
  = ["script","-q","/dev/null","claude","--remote-control"]
interactive seat exited with code: 1
```

And the cause, reproduced directly:

```
spawn('script', ['-q','/dev/null','/bin/sh','-c','echo HELLO'],
      { stdio: ['pipe','pipe','pipe'] })
  → exit 1, stderr: "script: tcgetattr/ioctl: Operation not supported on socket"

same command with stdio ['ignore','pipe','pipe']
  → exit 0, stdout: "^D\b\bHELLO\r\nBYE\r\n"
```

macOS `script` calls `tcgetattr` on **its own stdin** to copy the terminal
settings into the pty it allocates. `openSession` must give it a pipe on stdin,
because `send()` writes turns to `child.stdin`. The two requirements are mutually
exclusive. Every interactive seat therefore dies at spawn, and `send()` — armed
by `setTimeout(..., readyDelayMs ?? 4000)` — writes into a pipe whose reader is
gone.

Note also the second half of the output above: `^D\b\b` — `script` prepends its
own control characters even under `-q`. A mirror that replayed `script`'s stdout
verbatim would show them.

**The stdin requirement cannot be satisfied by any writable pipe.** MEASURED
[local], the same command with four different things on stdin:

| stdin | result |
|---|---|
| `'pipe'` (Node's socketpair) | exit 1, `tcgetattr/ioctl: Operation not supported on socket` |
| a real `mkfifo` FIFO | exit 1, same error |
| `'ignore'` (i.e. `/dev/null`, a character device) | exit 0, works |
| a tty (`'inherit'` from a terminal) | exit 0, works |

So `script` accepts a character device or a terminal and rejects anything you
could write turns into. `stdio: ['ignore', 'pipe', 'pipe']` makes the seat
*start* — and permanently removes `send()` and the operator's keystrokes, which
is the feature. The only way to have both a pty and a writable input channel is
to allocate the pty yourself, which is node-pty.

**Two further problems with the approach even if the stdin issue were solved:**

- **Nothing reads the output.** `openSession` pipes stdout and stderr and no
  consumer is ever attached — `grep` across `src/cli/compose.ts`,
  `src/harness/*.ts` and `src/daemon/*.ts` finds `linesOf()` in `runner.ts:101`
  documented as "Unused by the wake path" and nothing else. An undrained pipe
  fills its OS buffer and then blocks the writer, so a working `script` would
  stall the agent rather than merely losing its output.
- **`script` cannot resize.** There is no way to send `SIGWINCH` with new
  dimensions to the pty `script` allocated. A mirror whose browser window changes
  size cannot tell the agent, so the TUI keeps painting at the original geometry.

### 5.2 node-pty: what installing it actually costs

MEASURED [local], `npm install node-pty` into a clean directory:

```
added 2 packages in 19s          (real 19.11s, user 1.28s, sys 0.82s)
version: 1.1.0
build/ directory: absent  → the prebuilt binary was used, nothing compiled
node_modules/node-pty: 66 MB
```

The 66 MB breaks down as `win32-x64` **30 MB**, `win32-arm64` **28 MB**,
`darwin-arm64` 136 kB, `darwin-x64` 64 kB. **88% of the install is Windows
binaries that a macOS or Linux user will never load.**

DOCUMENTED, from the published tarball and `package.json` (node-pty **1.1.0**,
published **2025-12-22**):

- `"install": "node scripts/prebuild.js || node-gyp rebuild"`. `prebuild.js`
  exits 0 if `prebuilds/${process.platform}-${process.arch}` exists and 1
  otherwise, which triggers the source build.
- Prebuilds shipped: `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64`.
  **There are no Linux prebuilds.** Every Linux install compiles from source and
  therefore needs the documented prerequisites: "sudo apt install -y make python
  build-essential".
- macOS from source: "Xcode is needed to compile the sources, this can be
  installed from the App Store." Windows: `windows-build-tools`, the Windows SDK
  "Desktop C++ Apps" components, and Spectre-mitigated MSVC libraries.
- The addon is built against `node-addon-api` `^7.1.0`, i.e. Node-API, so the
  binary is ABI-stable across Node versions — a Node upgrade does not force a
  rebuild. This is a meaningful improvement over the pre-Node-API era.
- Runtime floor: "Node.JS 16 or Electron 19 is required to use `node-pty`."
- "Note that node-pty is not thread safe so running it across multiple worker
  threads in node.js could cause issues." — rules out sharding ptys across worker
  threads to beat the §6.2 reader ceiling.
- "All processes launched from node-pty will launch at the same permission level
  of the parent process."
- Windows support is conpty-only: "Support for the `winpty` library has been
  removed. Windows 10 version 1809 (build 18309) or later is now required."

### 5.3 A packaging bug you will hit on macOS, and its one-line fix

MEASURED [local], reproducible. A plain `npm install node-pty` on macOS produces
a package where **every `pty.spawn()` throws**:

```
Error: posix_spawnp failed.
    at new UnixTerminal (.../node-pty/lib/unixTerminal.js:92:24)
```

The cause is in the published tarball's file modes:

```
-rw-r--r--  0 0  0  50480  package/prebuilds/darwin-arm64/spawn-helper
-rw-r--r--  0 0  0   9248  package/prebuilds/darwin-x64/spawn-helper
```

`spawn-helper` is shipped **mode 0644 — not executable**. `chmod +x` on it makes
every spawn work immediately:

```
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
→ OK exit {"exitCode":0,"signal":0}
→ OUT: "hello-from-pty\r\n/dev/ttys002\r\n"
```

Any adoption of node-pty here needs a postinstall step that restores the bit, or
a `npm_config_build_from_source=true` install (which `prebuild.js` handles
explicitly: it deletes the prebuilds directory and falls through to `node-gyp
rebuild`) at the cost of requiring Xcode. **This is a real, current, shipped
defect in node-pty 1.1.0 as published, verified on 2026-08-31.** It is not
mentioned in the README.

### 5.4 node-pty flow control

DOCUMENTED, node-pty README:

```js
const PAUSE = '\x13';   // XOFF
const RESUME = '\x11';  // XON
const ptyProcess = pty.spawn(shell, [], {handleFlowControl: true});
ptyProcess.write(PAUSE);   // pty will block and pause the child program
ptyProcess.write(RESUME);  // pty will enter flow mode and resume the child program
ptyProcess.handleFlowControl = false;   // temporarily disable
```

"By default `PAUSE` and `RESUME` are XON/XOFF control codes… the messages can be
customized as `flowControlPause: string` and `flowControlResume: string` in the
constructor options. `PAUSE` and `RESUME` are not passed to the underlying
pseudoterminal if flow control is enabled."

That last clause is the important one: with `handleFlowControl: true`, node-pty
intercepts those bytes rather than forwarding them, so the child never sees them.
Which also means: if the agent CLI legitimately needs `Ctrl-S`/`Ctrl-Q`, you must
override the codes. Combine with the VS Code watermarks from §2.3.

### 5.5 Backpressure: what Node documents, and what actually happens

Node's `doc/api/stream.md` is unambiguous, DOCUMENTED:

> "While a stream is not draining, calls to `write()` will buffer `chunk`, and
> return false. … Once `write()` returns false, do not write more chunks until
> the `'drain'` event is emitted. **While calling `write()` on a stream that is
> not draining is allowed, Node.js will buffer all written chunks until maximum
> memory usage occurs, at which point it will abort unconditionally.** Even
> before it aborts, high memory usage will cause poor garbage collector
> performance and high RSS (which is not typically released back to the system,
> even after the memory is no longer required)."

MEASURED [local], a server that ignores the return value with a client that
connects and never reads, over 5 seconds:

| | value |
|---|---|
| frames written | 165,900 |
| bytes written | **704.5 MB** |
| peak `res.writableLength` | **703.4 MB** |
| RSS start → peak | **41.4 MB → 1,362.5 MB** |
| RSS growth | **1,321 MB** |

Five seconds. One stalled client. 1.3 GB.

For contrast, the same server *respecting* the return value (§1.5) never let the
socket queue exceed 66,969 bytes even against a deliberately slow reader.

**The pty side has no equivalent safety valve.** A pty master fd is an OS buffer
of a few kB; when it fills, the child's `write()` blocks. That is real
backpressure and it is why ttyd's `uv_read_stop` strategy works. But once you
have read from the pty into Node, that backpressure is gone — the bytes are in
your heap, and the only thing that reapplies pressure is deliberately pausing the
pty (§5.4). There is no automatic path from "browser is slow" to "agent stops
printing"; you have to build it, and the VS Code watermarks are the tested shape.

### 5.6 Verdict for Q5

node-pty, with three caveats: (1) a postinstall `chmod +x` for the macOS
`spawn-helper`, (2) 66 MB of install weight, mostly unused Windows binaries,
(3) Linux users compile from source and need `make python build-essential`.

Against that, `script -q /dev/null` currently does not work at all in this
codebase on macOS (§5.1), cannot be resized, cannot be flow-controlled, and
injects its own control characters. The dependency is worth it. It is also
already the dependency that VS Code, Hyper, Theia and every project in node-pty's
"Real-world Uses" list took for exactly this reason.

---

## 6. Many concurrent sessions

### 6.1 The OS ceilings, sourced and locally verified

**macOS** — Apple's xnu source, `bsd/kern/tty_ptmx.c`, DOCUMENTED:

```c
#define PTMX_MAX_DEFAULT        511     /* 512 entries */
#define PTMX_MAX_HARD           999     /* 1000 entries, due to PTSD_TEMPLATE */
static int ptmx_max = PTMX_MAX_DEFAULT; /* default # of clones we allow */
```

with the sysctl clamped to `new_value > 0 && new_value <= PTMX_MAX_HARD`, and a
failure path that prints `"ptmx_get_ioctl failed due to ptmx_max limit %d\n"`.
Verified on this machine: `kern.tty.ptmx_max: 511`, `kern.maxfiles: 30720`,
`kern.maxfilesperproc: 10240`.

**Linux** — kernel `Documentation/filesystems/devpts.rst`, DOCUMENTED:

```
Total count of pty pairs in all instances is limited by sysctls::

    kernel.pty.max = 4096	- global limit
    kernel.pty.reserve = 1024	- reserved for filesystems mounted from the initial mount namespace
    kernel.pty.nr		- current count of ptys
```

"Per-instance limit could be set by adding mount option `max=<count>`."

Neither ceiling is remotely near 6, or 20, or 100.

### 6.2 Measured cost per pty

MEASURED [local]. N ptys, each running a maximally chatty shell loop emitting
coloured lines as fast as it can, for 6 seconds, with the reader discarding
everything:

| ptys | aggregate read | per-pty read | fds added | fds/pty | RSS before → after |
|---|---|---|---|---|---|
| 1 | 8.55 MB/s | **8.55 MB/s** | 5 | 5.00 | 45.3 → 40.6 MB |
| 3 | 17.5 MB/s | **5.82 MB/s** | 13 | 4.33 | 45.2 → 41.1 MB |
| 6 | 24.7 MB/s | **4.11 MB/s** | 25 | 4.17 | 41.1 → 41.1 MB |
| 20 | 27.3 MB/s | **1.36 MB/s** | 81 | 4.05 | 45.3 → 41.7 MB |

**Three readings.**

1. **~4 file descriptors per pty** in the daemon process, converging to 4.05 at
   20. Against `kern.maxfilesperproc: 10240`, that is a ceiling around 2,500
   ptys per daemon process — three orders of magnitude past the requirement, and
   past the OS pty ceiling anyway.
2. **Memory per pty is unmeasurable when you discard.** RSS did not grow at any
   N. Whatever memory a mirror costs is entirely a function of the retention
   policy, not the pty.
3. **The single-threaded reader is the real ceiling.** Aggregate throughput
   saturates around **27 MB/s** and per-pty throughput falls **6.3×** from 1 to
   20 sessions. Note that node-pty is documented as not thread-safe, so moving
   ptys to worker threads is not the escape hatch.

### 6.3 What breaks first, at 3 / 6 / 20

Calibrate against the real rates: an agent TUI is **3 kB/s** and a build log
burst is **324 kB/s** (§0.3). The chatty-loop numbers above are 4–8 MB/s per pty,
i.e. 1,000–3,000× the realistic sustained rate.

- **At 3 sessions.** Nothing breaks on the pty side. Aggregate steady-state
  ≈ 9 kB/s; bursts ≈ 1 MB/s. The daemon's own `/stream` connection plus three
  mirrors is 4 of the 6 browser connections. **First thing to break: nothing.**
- **At 6 sessions.** `/stream` + 6 mirrors = **7 connections on one origin, and
  the cap is 6.** One mirror simply never connects, with no error the browser
  surfaces beyond a request that never starts. **First thing to break: the
  HTTP/1.1 connection cap** — and it breaks at exactly the documented maximum
  session count. This is the finding that forces multiplexing.
- **At 20 sessions.** Assuming the cap is solved by multiplexing: 20 × 3 kB/s
  ≈ 60 kB/s steady, still trivial. But if three of them are running builds
  simultaneously, ~1 MB/s arrives at one browser tab, and §3.3's ">500 kB pending
  makes xterm.js unresponsive" is two seconds away for whichever mirror is
  visible. **First thing to break: the client's write buffer**, unless flow
  control (§2.3) is in place. Second: the daemon's read throughput, which at 20
  ptys is already down to 1.36 MB/s per pty.

---

## 7. Incremental delivery patterns

### 7.1 The three resumable-streaming primitives, from their owners

**`Last-Event-ID`** (WHATWG, DOCUMENTED). Free with SSE, automatic on reconnect,
and the ids must avoid NUL, LF and CR. Its limitation for a mirror is that
EventSource keeps exactly *one* last-event-id per connection — which means a
single multiplexed stream carrying six sessions can only resume from one global
cursor, not six per-session ones. That is fine if the multiplexed stream is
ordered globally (one sequence across all sessions) and fatal if it is not.

**Cursor / sequence tokens.** This repo already implements the discipline
correctly and documents the trap: `src/daemon/server.ts:851-853` — "`since` is
exclusive on both this path and SSE resume, so one word means one thing and a
reconnect can neither duplicate nor skip an event. `readFrom` is inclusive, hence
`since + 1`." And `/events` returns "The last seq *in this response*: a client
paging with `since=lastSeq` cannot step over a gap when the page was truncated."
That is exactly the right contract and it should be reused verbatim for pty
offsets.

**Range requests.** Nothing in the reference set uses HTTP ranges for terminal
scrollback. tmux uses an application-level range (`capture-pane -S -E`), VS Code
uses a whole-tail replay. Byte ranges over a ring buffer are a poor fit because
the ring's oldest offset moves; an application-level "from offset X, or the
oldest I still have" is honest and a `Range` header is not.

### 7.2 The shape the first parties actually ship

VS Code's reconnect is the canonical "replay then follow":
`generateReplayEventSync()` returns `{ events: ReplayEntry[] }` where
`ReplayEntry = { cols, rows, data }` — one entry per size epoch, each with its
accumulated raw bytes. The client writes those into xterm.js in order, resizing
between entries, and then live data follows on the same channel. Bounded by
`persistentSessionScrollback` (**100 lines**, chosen because "Increasing this
will … increase the time it takes to connect to terminals on start up") on top of
a 10 MB ring.

There is no paging-backwards in VS Code at all. tmux has it (`capture-pane -S`),
but only because tmux owns a parsed grid.

### 7.3 Recommended shape for "open a session mirror"

Three phases, and the first must be small:

1. **Bounded tail, over a normal `GET`, not the stream.** `GET /sessions/:id/tail`
   returns the last ~128–256 kB of raw bytes plus the current `{cols, rows}` and
   the byte offset of the first and last byte returned. Sized against §3.3's
   500 kB unresponsiveness threshold, with headroom. It is a plain request, so it
   is cacheable, cancellable, and does not occupy a long-lived connection.
2. **Follow live, on the already-open multiplexed stream.** The client subscribes
   by sending `{subscribe: sessionId, from: <offset from step 1>}` over its input
   channel; the daemon starts fanning that session's chunks into the one stream.
   No new connection is opened, so the 6-cap is untouched no matter how many
   mirrors are open.
3. **Page backwards on demand.** `GET /sessions/:id/before?offset=X&bytes=N`
   returns the N bytes preceding X, or fewer plus a flag saying X is now older
   than the ring's oldest retained byte. For a TUI's cursor-addressed output these
   older bytes cannot be rendered into a scrollback window without replaying from
   a known-good state — so for phase 3 the honest UI is "download the raw log"
   rather than "scroll up forever", unless a headless emulator is added (§4.4).

**Name the gap.** Steps 1 and 2 are well-trodden and cheap. Step 3 is the one
that has no good precedent for TUI traffic and where the brief's "scroll back
through 10k–1M lines" ambition meets physics: for scrolling text it works; for a
cursor-addressed TUI it requires either a server-side emulator or accepting that
history is a downloadable artifact rather than a scrollable one.

---

## 8. What this repo already has, and what is missing

### 8.1 `src/daemon/server.ts` — `/stream`, and the parts that transfer

**What exists** (`#openStream`, lines 1050–1078):

```ts
const header = request.headers['last-event-id'];
const resumeFrom = readNonNegativeInt(
  typeof header === 'string' ? header : url.searchParams.get('since'), 0, 'Last-Event-ID');

response.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});

for (const event of await this.#log.readFrom(resumeFrom + 1)) writeFrame(response, event);

const heartbeat = setInterval(() => { response.write(':hb\n\n'); }, HEARTBEAT_MS);
const subscriber: Subscriber = { response, heartbeat };
this.#subscribers.add(subscriber);
request.on('close', () => { clearInterval(heartbeat); this.#subscribers.delete(subscriber); });
```

**Reusable as-is and genuinely well built:**

- The header set is right, `x-accel-buffering: no` included, with the comment
  explaining why.
- The `Last-Event-ID` / `?since=` dual resume with a single exclusive convention
  (§7.1) — this is the hard part of resumable streaming and it is correct.
- The 15-second comment-line heartbeat (`HEARTBEAT_MS = 15_000`), with the right
  rationale: "A comment line: EventSource ignores it, and it keeps the connection
  from being reaped by an idle timeout somewhere in between."
- Subscriber teardown on `request.on('close')`, including the interval.
- The deliberate choice to send **unnamed** frames so `onmessage` fires — the
  comment names the exact failure it prevents ("connected, silent, and reporting
  `connected`"). Any mirror multiplexed onto this stream must respect that: use a
  `kind` discriminator *inside* the JSON payload, not an SSE `event:` name.

**Missing or wrong for terminal mirroring:**

1. **No backpressure.** `#append` does
   `for (const subscriber of this.#subscribers) writeFrame(subscriber.response, event)`
   (line 1211) and `writeFrame` (line 1267) ignores the return value, as does the
   heartbeat's `response.write(':hb\n\n')`. §5.5 measured what this costs: 1.3 GB
   of RSS in five seconds against one stalled client. Today the blast radius is
   small because events are small and rare; with pty chunks it is the primary
   risk to "must not stall the daemon".
2. **Unbounded replay on connect.** `resumeFrom` defaults to 0, so a fresh
   EventSource replays the *entire* log synchronously before it is added to
   `#subscribers`. MEASURED [local] on the real beacon-1 log shape scaled up: 87
   events → 0.5 ms; 17,400 events (~11.8 MB) → **66.6 ms**; and 20,000
   pty-shaped chunks of 4 kB (80 MB) → **168 ms** of event-loop-blocking work
   *plus* 80 MB of allocation, per connection.
3. **No per-connection or per-session cap.** `MAX_LIMIT = 1000` guards `/events`
   but nothing guards `/stream`.
4. **No fan-out control.** Every subscriber gets every event. A mirror needs
   per-session subscription, which means the `Subscriber` record needs a
   subscription set and `#append`'s loop needs a filter.

### 8.2 `src/core/log.ts` — do not put pty bytes in here

`EventLog` holds **the entire log in memory** (`#events: CrosstalkEvent[]`),
`structuredClone`s on every read (`read()`, `readFrom()`), and `readFrom` is a
linear `filter` over the whole array. `append()` serialises writes through
`#appendTail` and re-clones.

That is a sound design for a protocol log of 87 events. It is the wrong container
for pty output by several orders of magnitude — MEASURED above at 168 ms and
80 MB per replay for 20k chunks, and `readFrom`'s `O(n)` filter means every
reconnect walks the whole history.

Also worth preserving deliberately: putting pty bytes in `events.jsonl` would
make the protocol log unreadable and unreplayable, and would couple mirror
retention to protocol durability. **Terminal output is not protocol history.**

### 8.3 `src/daemon/presence.ts` — the precedent is already written down

`Presence` is the model to follow, and its own doc comment argues the case better
than this note could:

> "Presence is a fact about now. The log is the record of what was decided. They
> do not belong in the same place."

and

> "Not an event, and deliberately. … a tool-call ping per edit would have buried
> 87 real events under thousands."

A terminal mirror is the same category as `Activity`: transient, overwritten,
bounded, deliberately outside the event log. `PRESENCE_TTL_MS = 5 * 60_000` and
the "stale entries are dropped rather than aged" rule are directly analogous to a
ring buffer's eviction policy. **Reuse the reasoning, and site the pty ring
next to `Presence` in the daemon rather than in `core/`.**

### 8.4 `src/harness/session.ts` and `runner.ts`

- `underPty()` and `defaultSpawn` are mutually incompatible on macOS (§5.1);
  the interactive seat path exits with code 1.
- No output consumer exists anywhere. `linesOf()` (`runner.ts:99-102`) is
  explicitly documented as "Unused by the wake path" and reads `child.stdout`
  through `readline`, which is line-oriented and therefore wrong for TUI traffic
  (§4.1) even if it were wired up.
- `send()` already does the right thing for a terminal: `interactive` mode
  replaces newlines with spaces and appends `\n` as the submit key, with the
  comment explaining why. That logic transfers to a pty write unchanged.
- `HarnessSession`'s interface (`send`, `canPush`, `exited`, `stop`) is the right
  seam. A node-pty implementation slots in behind it with `onData` and `resize`
  added.

### 8.5 `src/ui/state/useLog.ts` and `Stream.tsx`

`useLog` is fine for protocol events and will not survive terminal volume:

```ts
setEvents((current) => sortBySequence([...current, event]));
```

That copies the whole array and **re-sorts it on every single message** —
`O(n log n)` per event, `O(n² log n)` across a session. At 87 events it is
invisible. At 3.6 pty chunks/second for six hours (~78,000 chunks) it is not.
Frames also arrive in order over a single ordered stream, so the sort is
defending against something that cannot happen on the SSE path.

`Stream.tsx` renders **every** event as a card with no virtualization
(`visibleEvents.map(...)` straight into the DOM) and re-derives claims, roster
and colours on every render. Correct for the board; not a foundation for a
terminal.

`useMirror.ts` polls `/mirror` every 10 s with `fetch` — one more consumer of the
6-connection budget, though a short-lived one.

**The right move is not to extend either.** A terminal mirror is a different
component with a different data model: a byte stream into an xterm.js instance,
not React state.

### 8.6 Summary table

| Machinery | State | Verdict |
|---|---|---|
| SSE headers + heartbeat (`#openStream`) | Correct | **Reuse** |
| `Last-Event-ID` / `?since=` exclusive-cursor discipline | Correct, documented | **Reuse the contract** |
| Unnamed-frame convention | Correct, load-bearing | **Reuse; discriminate inside the payload** |
| Subscriber set + close teardown | Correct | **Reuse, extend with subscriptions** |
| `writeFrame` backpressure | Absent | **Fix — measured 1.3 GB failure** |
| `/stream` replay bound | Absent | **Add a cap** |
| Per-session fan-out filter | Absent | **Add** |
| `EventLog` as pty store | Wrong container | **Do not use** |
| `Presence`'s state-not-history reasoning | Correct precedent | **Follow it** |
| `underPty` / `script` | Broken on macOS | **Replace with node-pty** |
| pty output consumer | Does not exist | **Build** |
| `HarnessSession` interface | Right seam | **Extend with `onData` / `resize`** |
| `useLog` re-sort per message | `O(n² log n)` | **Do not reuse for terminal** |
| `Stream.tsx` unvirtualized cards | Fine for board | **Separate component** |

---

## 9. Recommended architecture

### 9.1 The design

**Daemon side.**

1. **Replace `script` with node-pty** behind the existing `HarnessSession`
   interface, adding `onData(cb)` and `resize(cols, rows)`. Add a postinstall
   `chmod +x` for `prebuilds/darwin-*/spawn-helper` (§5.3). Spawn with
   `handleFlowControl: true`.
2. **One `SessionMirror` per seat**, living beside `Presence` in `src/daemon/`,
   never in `EventLog`. It is a byte ring modelled on VS Code's
   `TerminalRecorder`: raw chunks, a `{cols, rows}` epoch per resize, a running
   total, trim-from-front when over cap. Cap at **8 MB** with a **30-minute
   floor** — 8 MB is ~44 minutes of TUI traffic at the measured 3 kB/s and ~25
   seconds of a 324 kB/s build burst, and the floor stops one noisy test run
   from evicting the whole session.
3. **Index by cumulative byte offset**, not chunk index, so a cursor survives a
   partial front-trim and the daemon can honestly answer "your offset is older
   than my oldest byte" (§2.4).
4. **`GET /sessions/:id/tail?bytes=N`** — default **192 kB**, hard cap 512 kB.
   Returns raw bytes plus `{cols, rows, firstOffset, lastOffset, truncated}`.
   Chosen against xterm.js's ">500 kB pending makes it unresponsive" (§3.3) and
   VS Code's "restore size is connect time" (§2.1).
5. **Multiplex live output onto the existing `/stream`.** One connection for the
   whole hub, forever. Frames stay unnamed; add `kind: 'pty'` plus `session` and
   `offset` inside the JSON payload. Subscription is per-session and explicit:
   the client asks, the daemon adds the session to that `Subscriber`'s set.
6. **Fix `writeFrame` to honour `write()`'s return value** for every subscriber,
   pty and protocol alike. When a subscriber is not draining, drop its pty frames
   and mark it `gapped`; on `drain`, send a `{kind:'gap', session, fromOffset}`
   and let the client re-tail. Never queue pty bytes for a slow client —
   §5.5 measured what that costs, and a terminal mirror is the one payload where
   dropping is correct, because the *current screen* is what matters.
7. **Apply VS Code's watermarks to the pty itself** when a session's subscribers
   are collectively behind: pause at **100,000** unacknowledged chars, resume at
   **5,000**, ack every **5,000** (§2.3). Keep the ack size ≤ the low watermark
   or the pty never resumes.
8. **Cap `/stream`'s replay** so a reconnect cannot block the loop for 168 ms
   (§8.1).

**Browser side.**

9. **xterm.js with `@xterm/addon-webgl`**, `scrollback` left near the 1000
   default, and an `onContextLoss` handler that disposes the addon and falls back
   to the DOM renderer rather than going blank (§3.1).
10. **Never put pty bytes in React state.** The mirror component owns an
    xterm.js instance and writes to it imperatively from the stream. React
    renders the chrome around it.
11. **Open sequence:** tail (192 kB) → subscribe from `lastOffset` → follow.
    Page backwards via `GET /sessions/:id/before?offset=&bytes=` only for
    line-shaped history; for TUI-shaped history offer "download raw log" instead
    of pretending to scroll (§7.3).
12. **Input** goes over the existing `POST` path, reusing `session.ts`'s
    already-correct newline-to-submit handling.
13. **Fix `useLog`'s per-message re-sort** regardless — it is `O(n² log n)` and
    the SSE path delivers in order (§8.5).

### 9.2 Tradeoffs, named

| Decision | What it buys | What it costs |
|---|---|---|
| Multiplexed SSE over per-session WebSocket | 1 of 6 connections regardless of session count; keeps the working `Last-Event-ID` resume; `curl`-debuggable | One global cursor, not per-session (§7.1); 1–23% framing tax (§1.4); input needs a separate POST |
| node-pty over `script` | Works at all on macOS; resize; flow control; no injected control chars | 66 MB install; Linux compiles from source; a `chmod` workaround; a native dependency in a currently pure-JS project |
| Byte ring over line ring or parsed grid | Correct for TUI traffic (zero newlines); zero ingest cost; byte-exact replay | Cannot answer "lines 400–450"; no server-side search; scroll-back is bounded by what the client can replay |
| Ship raw ANSI over stripping | Nothing breaks (§4.2); matches VS Code and ttyd | Client must be a terminal emulator; no cheap text search or copy on the server |
| Drop-and-gap over queue-for-slow-client | Bounded daemon memory, always | A slow client sees a discontinuity and must re-tail |
| xterm.js over a virtualized list | Handles cursor addressing, alt-screen, CR redraws | 12 bytes/cell; ~1.44 MB per 1000-line 120-col buffer; a real dependency |
| 8 MB ring + 192 kB tail | Instant open; bounded memory | ~25 seconds of retention during a build burst |

### 9.3 Risks, specifically

1. **The 6-connection cap is a cliff, not a slope, and it lands at exactly 6
   sessions.** If mirrors ever get their own connections — during a refactor, or
   because a second tab is open — the failure is a request that silently never
   starts. Add a test that opens `/stream` plus six mirrors and asserts one
   connection is used.
2. **`Last-Event-ID` gives one cursor for a multiplexed stream.** Ordering must
   be global across sessions or resume will skip. If per-session cursors become
   necessary, that is the point at which WebSocket wins and the transport
   decision should be revisited.
3. **node-pty's `spawn-helper` mode bug is upstream and undocumented.** It could
   be fixed (breaking a `chmod` that then targets a missing path — make it
   tolerant) or could recur on a new platform triple. Pin the version and assert
   `pty.spawn` works in the doctor.
4. **No Linux prebuilds.** Any Linux user without `make python build-essential`
   gets a failed install of the whole package, not a degraded one. `doctor`
   should check for a working pty before `up` promises interactive seats.
5. **xterm.js's 500 kB unresponsiveness threshold is CLAIMED, not measured by
   anyone published.** The 192 kB tail has ~2.6× headroom against an unverified
   number. Measure it on the actual hub before trusting it, especially with the
   emoji-heavy output agent CLIs produce (§3.1's 19.28 ms/frame emoji row).
6. **WebGL context loss on laptop sleep is documented and will happen** to a hub
   left open overnight — which is the primary use case. The fallback path must be
   tested, not just written.
7. **`@xterm/headless` and `@xterm/addon-serialize` are both labelled
   experimental by their maintainers.** They are the only route to server-side
   line addressing for TUI traffic; do not build a feature that depends on them
   without accepting that.
8. **The flow-control deadlock.** xterm.js's own guide warns "a custom flow
   control mechanism can easily stop the whole stream forever if the limits are
   not calculated/applied correctly", and VS Code's comment states the invariant:
   ack size must be ≤ low watermark. Encode that as an assertion, not a comment.
9. **The interactive seat is broken today (§5.1).** Any measurement of "what the
   mirror will show" taken before that is fixed is measuring nothing.

---

## 10. Addendum: the in-flight implementation

Between the start of this research (18:10) and its writing (18:45) the working
tree changed. `src/harness/screen.ts` (533 lines), `src/harness/sessions.ts` (75
lines), and edits to `session.ts`, `server.ts` and `compose.ts` appeared. Section
8's audit describes the code as it was read at 18:10–18:25; this section
describes what is being built now, because it changes which parts of §9 are
still open questions.

### 10.1 What it does

It takes **the tmux strategy** (§4.3), not the VS Code one: parse the pty output
server-side into a grid and serve the *result*.

- `Screen` is a hand-written VT emulator — CSI dispatch for `H f A B C D E F G d
  J K L M P X s u m`, OSC skipping, charset selection, reverse index, private
  modes with alt-screen handled as a clear, and SGR folding 256-colour and
  truecolour down to a palette index.
- `ScreenSnapshot` carries a `version` that ticks only when a *fingerprint of the
  finished screen* changes, not merely when a write touched cells. The comment
  states the reason exactly: a TUI "repaints by homing the cursor and rewriting
  the same frame, which touches every cell and changes nothing."
- `SessionRegistry` keys live sessions by seat, passed as an argument rather than
  a singleton so the CLI path costs nothing.
- `GET /sessions/:id/screen` serves the snapshot; `POST /sessions/:id/input`
  takes `{turn}` or `{keys}` and is gated to the human seat.
- `HarnessSession` gains `key(bytes)` for raw keystrokes alongside `send(turn)`.
- `underPty` now wraps in `sh -c 'stty rows R cols C; exec "$@"'` with
  `PTY_SIZE = { rows: 32, cols: 110 }`, and `TERM=xterm-256color` is set.
- `child.stdout` and `child.stderr` are now drained into the screen, which fixes
  the undrained-pipe stall noted in §8.4.

### 10.2 Where this research supports it

- **It sidesteps the six-connection cap entirely** (§1.2), because it polls a
  plain `GET` with a version cursor instead of holding a second stream open. The
  finding that forces multiplexing in §9 does not apply to a polling design.
  This is the single biggest thing the design gets right.
- **"Cost is bounded by the screen, not the session"** is correct and is exactly
  why tmux can answer range queries and VS Code cannot. A 32×110 grid is 3,520
  cells; at xterm.js's 12 bytes/cell equivalent that is ~42 kB, against §3.2's
  1.44 MB for a 1000-line client buffer.
- **Version-gated polling is the right economy.** §0.3 measured 3.6 chunks/s from
  a TUI and 24.8% escape bytes; most of those repaints change nothing a reader
  could see, and the fingerprint check is what stops them becoming traffic.
- **Refusing to ship raw escapes to the browser** avoids §3.3's 500 kB
  write-buffer cliff and needs no xterm.js in the bundle at all.
- **Alt-screen-as-clear** is the right call; §4.2 lists it as one of the four
  things that break when handled wrongly.

### 10.3 Where this research contradicts or complicates it

1. **It is dead on macOS, for the reason in §5.1.** MEASURED [local] against the
   *new* `underPty` shape, spawned exactly as `defaultSpawn` does:

   ```
   script -q /dev/null sh -c 'stty rows 32 cols 110 2>/dev/null; exec "$@"' sh <argv>
   stdio: ['pipe','pipe','pipe']
   → exit 1, stderr: script: tcgetattr/ioctl: Operation not supported on socket
   ```

   The `stty` wrapper is a real improvement and it does work — with
   `stdio: ['ignore', ...]` the same command exits 0 and reports
   `COLS=110 ROWS=32`. But `'ignore'` removes the input channel that
   `key()` and `POST /sessions/:id/input` exist to provide. §5.1's table shows
   there is no third option: a socketpair fails, a real FIFO fails, only a
   character device or a tty works.

   Side by side, MEASURED [local], same job:

   | | exit | geometry | input channel | output |
   |---|---|---|---|---|
   | `script`, stdin `'pipe'` | **1** | — | — | `tcgetattr` error |
   | `script`, stdin `'ignore'` | 0 | `COLS=110 ROWS=32` | **none** | `^D\b\bCOLS=110 ROWS=32\r\nBYE\r\n` |
   | node-pty | 0 | `COLS=110 ROWS=32` | **works** | `COLS=110 ROWS=32\r\ntyped-input\r\nGOT=typed-input\r\n` |

   Note also the `^D\b\b` prefix `script` emits even under `-q`. It lands in the
   screen parser as a literal backspace sequence.

2. **The `stty` fix cannot survive a resize.** `PTY_SIZE` is a constant, set once
   at spawn from inside the shell. There is no way to deliver `SIGWINCH` with new
   dimensions to a pty `script` allocated, so a hub window that changes size can
   never tell the agent. node-pty's `resize(cols, rows)` is the only route.

3. **There is no scrollback, and the brief asks for one.** A screen snapshot
   answers "what does it show now" and cannot answer "scroll back through this
   session". §2 and §7 are about the history problem, and a grid-only design does
   not address it. That may be the right scope call — but it should be a stated
   scope call, not an omission. Note that the 8 MB byte ring of §9.1 and the grid
   of §10.1 are **complementary**, not alternatives: the ring gives history and
   download, the grid gives the cheap live view.

4. **A hand-written VT emulator is a long maintenance tail.** §4.4 names the
   off-the-shelf alternative (`@xterm/headless` + `@xterm/addon-serialize`),
   with the honest caveat that both are labelled experimental by their
   maintainers. 533 lines that handle ~20 CSI finals is a reasonable 90% — but
   the missing 10% shows up as a subtly wrong mirror, which is the failure mode
   hardest to notice and hardest to debug. Scroll regions (`DECSTBM`, `ESC[r`)
   are explicitly listed as "no visible effect" and are used by full-screen
   programs that scroll a sub-window.

5. **Polling has its own cost that the version cursor does not remove.** Each
   poll is still an HTTP round trip against the 6-connection budget alongside
   `useMirror`'s existing 10 s `/mirror` poll (§8.5). At 6 seats polled
   independently at, say, 250 ms, that is 24 requests/second on an origin capped
   at 6 concurrent — workable because each is short, but it should be one
   batched `GET /sessions/screens?since=<versions>` rather than six.

### 10.4 The recommendation, revised

The two designs are not in conflict; take both halves.

- **Keep the `Screen` + version-cursor design for the live view.** It is the
  right answer to the connection cap and the right economy for TUI repaints, and
  §10.2 lists five independent reasons the research supports it. Batch the poll
  across seats (§10.3.5).
- **Replace `script` with node-pty regardless.** It is not an optimisation; the
  feature does not run on macOS without it (§10.3.1), cannot be resized
  (§10.3.2), and injects `^D\b\b` into the parser. Everything else in the
  in-flight design is unaffected by the swap — `Screen` takes the same bytes from
  `onData` that it currently takes from `child.stdout`.
- **Add the byte ring (§9.1 steps 2–4) when scrollback is actually wanted**, and
  scope it out explicitly until then.
- **Fix `writeFrame`'s missing backpressure anyway** (§8.1). It is independent of
  all of this and it is a measured 1.3 GB failure waiting on one stalled tab.

---

## Source index

**Specifications**

- WHATWG HTML Living Standard, Server-sent events — https://html.spec.whatwg.org/multipage/server-sent-events.html (read 2026-08-31)
- RFC 9113, *HTTP/2* (June 2022) — https://www.rfc-editor.org/rfc/rfc9113.html (§6.5.2 SETTINGS_MAX_CONCURRENT_STREAMS, §9.1 Connection Management)
- RFC 6455, *The WebSocket Protocol* (December 2011) — https://www.rfc-editor.org/rfc/rfc6455.txt (§5.2 Base Framing Protocol)
- IETF HTTP Working Group, HTTP/2 FAQ — https://http2.github.io/faq/ ("currently no browser supports HTTP/2 unencrypted")
- MDN, *Using server-sent events* — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events

**Browser source**

- Chromium, `net/socket/client_socket_pool_manager.cc` — https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/socket/client_socket_pool_manager.cc (`g_max_sockets_per_group` = {6 normal, 255 WebSocket})
- Firefox, `modules/libpref/init/all.js` — `network.http.max-persistent-connections-per-server` 6; `network.websocket.max-connections` 200

**Terminal multiplexers and web terminals**

- tmux, `options-table.c` — https://github.com/tmux/tmux/blob/master/options-table.c (`history-limit` default 2000)
- tmux manual, `capture-pane` — https://man.openbsd.org/tmux
- GNU screen manual, §12.1.2 Scrollback — https://www.gnu.org/software/screen/manual/screen.html (`defscrollback` defaults to 100)
- ttyd — https://github.com/tsl0922/ttyd, `src/pty.c` (`uv_read_stop` in `read_cb`), `src/server.h` (`PAUSE '2'` / `RESUME '3'`, `max_clients`)
- GoTTY — https://github.com/yudai/gotty (`--max-connection` default 0)

**VS Code (the closest reference implementation)**

- `src/vs/platform/terminal/common/terminalRecorder.ts` — `MaxRecorderDataSize = 10 * 1024 * 1024`, front-trim algorithm, `generateReplayEventSync`
- `src/vs/platform/terminal/common/terminal.ts` — `FlowControlConstants` (100000 / 5000 / 5000), `LocalReconnectConstants` (60000 / 6000)
- `src/vs/platform/terminal/common/terminalProcess.ts` — `ReplayEntry { cols, rows, data }`
- `src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts` — `scrollback` default 1000, `gpuAcceleration` default `'auto'`, `enablePersistentSessions` default true
- `src/vs/platform/terminal/common/terminalPlatformConfiguration.ts` — `persistentSessionScrollback` default 100, `persistentSessionReviveProcess` default `'onExit'`
- https://code.visualstudio.com/docs/terminal/advanced — process reconnection vs process revive

**xterm.js**

- `src/common/input/WriteBuffer.ts` — `DISCARD_WATERMARK = 50000000`, `WRITE_TIMEOUT_MS = 12`, `WRITE_BUFFER_LENGTH_THRESHOLD = 50`, and the ">500 kB" comment
- `src/common/buffer/BufferLine.ts` — `CELL_INDICIES = 3`, `new Uint32Array(cols * 3)`
- `src/common/buffer/Buffer.ts` — `MAX_BUFFER_SIZE = 4294967295`, `CircularList(rows + scrollback)`
- `ITerminalOptions` — https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/ (`scrollback` "Defaults to 1000")
- Flow control guide — https://xtermjs.org/docs/guides/flowcontrol/ (HIGH 100000 / LOW 10000; CALLBACK_BYTE_LIMIT 100000, HIGH 5, LOW 2)
- WebGL renderer benchmark — https://github.com/xtermjs/xterm.js/pull/1790 (canvas vs WebGL ms/frame table)
- Performance testing wiki — https://github.com/xtermjs/xterm.js/wiki/Performance-testing (methodology only, no published numbers)
- `@xterm/addon-webgl`, `@xterm/addon-serialize`, `@xterm/headless` READMEs — both addons and headless are labelled experimental

**Node.js and node-pty**

- Node `doc/api/stream.md` — `write()` return semantics, `'drain'`, "buffer all written chunks until maximum memory usage occurs, at which point it will abort unconditionally"; `getDefaultHighWaterMark` 65536 non-Windows / 16384 Windows / 16 objectMode, bumped in v22.0.0 (PR 52037)
- Node `doc/api/util.md` — `util.stripVTControlCharacters(str)`, added v16.11.0
- node-pty README — https://github.com/microsoft/node-pty (prerequisites, flow control, thread safety, Node 16+)
- node-pty 1.1.0 published tarball and npm metadata (published 2025-12-22) — prebuild platforms, `spawn-helper` mode 0644, `scripts/prebuild.js`, `node-addon-api ^7.1.0`
- `strip-ansi`, `ansi-regex` READMEs (chalk org) — Node built-in note; ReDoS stance

**OS**

- Apple xnu, `bsd/kern/tty_ptmx.c` — https://github.com/apple-oss-distributions/xnu (`PTMX_MAX_DEFAULT 511`, `PTMX_MAX_HARD 999`)
- Linux, `Documentation/filesystems/devpts.rst` — `kernel.pty.max = 4096`, `kernel.pty.reserve = 1024`

**This repository (read at commit `0bc8ff1`)**

- `src/daemon/server.ts` — `#openStream` (1050–1078), `#append` broadcast (1211), `writeFrame` (1267), `#awaitTurn` (879–913), constants `MAX_BODY_BYTES` 1 MiB / `MAX_LIMIT` 1000 / `AWAIT_CAP_S` 50 / `HEARTBEAT_MS` 15000
- `src/core/log.ts` — in-memory array, `structuredClone` per read, `readFrom` linear filter
- `src/daemon/presence.ts` — `PRESENCE_TTL_MS`, `Activity`, the state-not-history argument
- `src/harness/session.ts` — `underPty` (44–46), `defaultSpawn` (138–144), `send` newline handling (112)
- `src/harness/runner.ts` — `linesOf` (99–102), "Unused by the wake path"
- `src/ui/state/useLog.ts` — per-message `sortBySequence([...current, event])` (63)
- `src/ui/layout/Stream.tsx` — unvirtualized `visibleEvents.map`
- `src/ui/state/useMirror.ts` — 10 s `/mirror` poll
- `src/cli/compose.ts` — `openSession` call site (134), no stdout consumer
- `docs/specs/2026-08-10-daemon-http-contract.md` §6 — the SSE contract, and the note that "`EventSource` takes no headers in any browser"

**Local measurements (2026-08-31; macOS Darwin 25.5.0 arm64, Node v22.23.0, node-pty 1.1.0)**

Reproducible from the scripts described inline in §0.3, §1.4, §1.5, §5.1, §5.2,
§5.3, §5.5, §6.2 and §8.1. Raw pty capture samples, framing comparison,
concurrency sweep, SSE loopback throughput, the stalled-client buffering test,
the `EventLog.readFrom` replay cost, and the `script`/node-pty spawn diagnostics
were all produced on one machine and should be read as orders of magnitude.
