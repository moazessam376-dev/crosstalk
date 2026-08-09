# Cross-platform rules

Crosstalk must behave identically on Windows, macOS and Linux — for the person installing it and for the person contributing to it. This is the canonical reference; `AGENTS.md` and `CLAUDE.md` point here rather than restating it.

The guiding constraint: **a contributor on Windows with no build tools, no bash, and no admin rights must be able to clone, install, test and run this project.** Every rule below exists because something breaks that promise.

---

## 1. The install promise

`npx crosstalk-ai init` behaves the same on all three platforms. That promise is why:

- **No native modules.** Not `better-sqlite3`, not `node-pty`, not anything requiring `node-gyp`. A native module means Visual Studio Build Tools on Windows and Xcode Command Line Tools on macOS, and the first user without them files an issue about a compiler error. This is the single most important rule in this document.
- **No Python, no Docker, no `make`.** Node ≥ 20 and git ≥ 2.5 are the entire prerequisite list.
- **The hub UI ships pre-built.** Installing users never run a bundler.

If you are about to add a dependency, check its transitive tree for native bindings first. A dependency that is pure JS today and adds a native optional dependency tomorrow is still a break.

## 2. Shell and scripts

- **Every entry point is an npm script.** No `.sh` files, no `Makefile`, no `.bat`. A contributor on PowerShell must run the same command as one on zsh.
- Inside npm scripts, use only syntax that works in both `cmd.exe` and POSIX shells: no `&&` chains that depend on shell semantics beyond npm's own, no `$VAR`, no `2>/dev/null`, no single-quoted arguments (`cmd.exe` does not strip single quotes).
- Cross-platform env vars in scripts are **not** available without a dependency, and we are not adding one. If a script needs configuration, read it from a file in code instead.

## 3. Spawning processes

- **Always `execFile`, never `exec`.** `exec` goes through a shell, which means quoting rules differ per platform and a path with a space becomes a security and correctness problem. `execFile` takes an argv array and passes it through untouched.
- **`.cmd` and `.bat` cannot be launched by `execFile` on Windows without a shell.** This is the trap that catches everyone: `git` is `git.exe` and works fine, but `npm`, `gh`, `cursor-agent` and most CLI tools installed via npm are `.cmd` shims. Resolve the real executable before spawning:

  ```ts
  // Resolve once, at startup, and cache. Never shell out to `where`/`which` per call.
  async function resolveBin(name: string): Promise<string> {
    if (process.platform !== 'win32') return name;
    for (const ext of (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')) {
      const hit = await findOnPath(name + ext.toLowerCase());
      if (hit) return hit;
    }
    throw new Error(`${name} not found on PATH`);
  }
  ```

  A `.cmd` resolved to its full path still needs `shell: true` to run on Windows. Where that is unavoidable, pass the argv array — never build a command string.
- **Signals differ.** `SIGTERM` is not delivered on Windows the way it is elsewhere. Daemon shutdown must handle `SIGINT`, `SIGTERM` *and* a clean HTTP shutdown endpoint, and must not rely on a signal arriving at all.

## 4. Paths

- **`node:path` for every join, resolve and relative.** Never concatenate with `/` or `\`.
- **Store paths repo-relative in `crosstalk.yaml`; resolve at runtime.** A committed config containing `D:\Opensource\...` is a bug and will break the next contributor.
- **Windows `MAX_PATH` is 260 characters** unless long paths are enabled, which we cannot assume. `.crosstalk/worktrees/<id>` already spends 25 characters before the repo path; participant ids are therefore limited to `[a-z0-9-]{1,24}`, validated by `doctor`.
- **Windows and macOS are case-insensitive by default.** Two participants named `Codex` and `codex` resolve to one worktree directory. `doctor` rejects ids that differ only by case.

## 5. Files, locking and permissions

- **Windows will not let you delete or rename a file another process has open.** `crosstalk down` removing a worktree while an agent still has files open fails with `EBUSY` or `EPERM`. Retry with backoff, and if it still fails, report *which* worktree is held and by what, rather than leaving a half-removed tree.
- **`chmod 0o600` is a no-op on Windows.** The daemon token file is not protected there. Say so in `doctor` output. Claiming a permission we do not have is worse than the missing permission.
- **Writes that must not tear use temp-plus-rename.** `rename` is atomic on all three platforms when source and destination are on the same volume — which is why the temp file goes in the same directory, not in the OS temp dir.
- **Line endings.** `.gitattributes` normalises the repo to LF. The event log is opened in binary append mode so no translation occurs; a test asserts the written bytes contain no `\r`.

## 6. Watching the filesystem

`fs.watch` is the least portable API in Node:

| Platform | Behaviour |
|---|---|
| Linux | inotify; `recursive: true` unsupported on older Node/kernels; subject to `max_user_watches`, which real users hit |
| macOS | FSEvents; coalesces rapid changes, so two writes can surface as one event |
| Windows | ReadDirectoryChangesW; generally fine, but reports renames as delete+create |

Therefore: **`fs.watch` is an optimisation, never the mechanism.** Anything that must not miss a change polls at a documented interval, with `fs.watch` used only to shorten the latency between polls. This applies to the tier-3 file inbox.

## 7. Terminal output

- **Do not assume Unicode.** Older Windows consoles on a legacy codepage render box-drawing characters as mojibake. Detect and fall back to ASCII:

  ```ts
  const unicodeOk = process.platform !== 'win32'
    || process.env.WT_SESSION !== undefined      // Windows Terminal
    || process.env.TERM_PROGRAM === 'vscode';
  ```
- **Do not assume colour.** Respect `NO_COLOR` and `process.stdout.isTTY`.
- Keep `doctor` output readable when piped to a file: no cursor movement, no spinners in non-TTY mode.

## 8. State locations

v1 keeps **all** state inside the repo at `.crosstalk/`, and config at `crosstalk.yaml` in the repo root. There is deliberately no `~/.config` versus `%APPDATA%` versus `~/Library/Application Support` divergence, because that split is three code paths and three bug reports for no benefit at this stage. If global state is ever needed, it gets its own design discussion, not an ad-hoc `os.homedir()` call.

## 9. Testing and CI

- **CI runs `windows-latest`, `macos-latest`, `ubuntu-latest` on Node 20 and 22.** A change that is green on one platform is not done.
- **Tests that touch git build a real throwaway repository** under `os.tmpdir()` via `mkdtemp`. Do not mock git: the failures worth catching here are git's actual behaviour per platform.
- **Never assert on absolute paths.** Compare with `path.relative` or match on the basename.
- **Never assert on line-ending-sensitive string equality** for anything read from disk without normalising first.
- Temp directories must be cleaned up even when a test fails, or Windows CI runners accumulate locked worktrees across runs.

## 10. The end-user journey, per platform

What a new user actually experiences. `doctor` is responsible for making each of these true.

**All platforms** — `npx crosstalk-ai init`, answer the harness prompts, paste the printed kickoff line into each agent. No compiler, no admin rights, no PATH surgery.

**Windows** — runs in PowerShell or Windows Terminal with no extra setup. `doctor` warns that the daemon token file is world-readable, and warns early if the repository path is long enough that worktree paths risk `MAX_PATH`.

**macOS** — no Xcode Command Line Tools needed, because nothing compiles. If git itself is missing, macOS prompts to install the CLT; `doctor` names that as the remedy rather than printing a raw `ENOENT`.

**Linux** — no `node-gyp`, no `python3`, no distro packages. If the tier-3 file inbox is in use and inotify watches are exhausted, `doctor` names `fs.inotify.max_user_watches` explicitly, because the raw `ENOSPC` from `fs.watch` is one of the most confusing errors in Node.

**Every failure message names the remedy, not just the condition.** "git not found" is a bad error. "git not found on PATH — install from https://git-scm.com and reopen your terminal" is the standard.
