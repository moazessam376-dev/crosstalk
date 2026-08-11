import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CT-1. `ct` on PATH can be a *different checkout* than the build you are running.
 *
 * Observed: `npm link` pointed `ct` and `crosstalk` at `D:\Opensource\crosstalk-leader`
 * (`70cd496`) while the project had been initialised by `D:\Opensource\crosstalk`
 * (`88abd4d`). Every agent that followed the kickoff line Crosstalk itself
 * printed ran the older build against the newer project, and nothing in `init`,
 * `up` or `doctor` said so.
 *
 * The failure is silent by construction: both builds work, both speak the same
 * protocol well enough to connect, and the skew only shows up as behaviour that
 * does not match the source you are reading.
 */

/**
 * The package root of a module inside this package.
 *
 * `dist/harness/doctor.js` and `src/harness/doctor.ts` are both two levels
 * below the root, which is the same assumption `distPath` makes.
 */
export function packageRootFromModule(moduleUrl: string): string {
  return dirname(dirname(dirname(fileURLToPath(moduleUrl))));
}

/** The package root containing a `dist/cli/index.js` entry point. */
export function packageRootFromEntry(entry: string): string {
  return dirname(dirname(dirname(resolve(entry))));
}

export interface InstallProbe {
  /** Resolves a bare command name on PATH. */
  find: (name: string) => Promise<string | undefined>;
  /** Follows symlinks. */
  realpathOf: (path: string) => Promise<string>;
  readText: (path: string) => Promise<string>;
}

const DEFAULT_PROBE: InstallProbe = {
  find: findOnPath,
  realpathOf: (path) => realpath(path),
  readText: (path) => readFile(path, 'utf8'),
};

async function findOnPath(name: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
    : [''];

  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory || '.', `${name}${extension}`);
      try {
        await access(candidate, constants.F_OK);
        return candidate;
      } catch {
        // Keep looking on PATH.
      }
    }
  }
  return undefined;
}

/**
 * The package root of a globally-linked `crosstalk`/`ct`, or undefined when
 * there is none on PATH.
 *
 * Two shapes, because npm installs differently per platform:
 *
 * - POSIX: a symlink straight at `dist/cli/index.js`, so `realpath` is enough.
 * - Windows: a `.cmd`/`.ps1` shim that *names* the entry relative to its own
 *   directory as `%~dp0` or `$basedir`. Reading it is the only way through; the
 *   shim is not a link and `realpath` returns the shim itself.
 *
 * Returns undefined rather than throwing for anything it cannot read. A machine
 * with no global install is the normal case, not a fault.
 */
export async function linkedInstallRoot(probe: InstallProbe = DEFAULT_PROBE): Promise<string | undefined> {
  for (const name of ['crosstalk', 'ct']) {
    const executable = await probe.find(name);
    if (executable === undefined) continue;

    const entry = await resolveEntry(executable, probe);
    if (entry !== undefined) return packageRootFromEntry(entry);
  }
  return undefined;
}

const ENTRY_PATTERN = /([^\s"';]*dist[\\/]cli[\\/]index\.js)/i;

async function resolveEntry(executable: string, probe: InstallProbe): Promise<string | undefined> {
  const real = await probe.realpathOf(executable).catch(() => executable);
  if (real.toLowerCase().endsWith('.js')) return real;

  const text = await probe.readText(real).catch(() => undefined);
  if (text === undefined) return undefined;

  const match = ENTRY_PATTERN.exec(text);
  if (match === null) return undefined;

  // `%~dp0` (cmd) and `$basedir` (sh/ps1) both mean "the directory this shim
  // is in", and both already carry a trailing separator in npm's templates.
  const base = dirname(real);
  const named = match[1]!
    .replace(/%~dp0[\\/]?/gi, `${base}${sep}`)
    .replace(/\$basedir[\\/]?/gi, `${base}${sep}`);
  return resolve(named);
}

/** Absolute path of the script node is actually executing. */
export function runningCliPath(): string {
  return resolve(process.argv[1] ?? '');
}
