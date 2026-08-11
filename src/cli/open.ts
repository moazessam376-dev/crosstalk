import { execFile } from 'node:child_process';

/**
 * Opens a url in the default browser.
 *
 * `execFile`, never `exec` — no shell, so quoting rules do not differ per
 * platform and a url with an ampersand cannot become two commands
 * (docs/CROSS-PLATFORM.md §3).
 *
 * On Windows the usual recipe is `cmd /c start "" <url>`, which needs a shell
 * and drags in `start`'s own quoting rules. `rundll32` is a real executable and
 * takes the url as a single argv entry, so it needs neither.
 */
export function browserCommand(url: string): { file: string; args: string[] } {
  switch (process.platform) {
    case 'win32':
      return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
    case 'darwin':
      return { file: 'open', args: [url] };
    default:
      return { file: 'xdg-open', args: [url] };
  }
}

/** Resolves to false when no browser could be launched; never throws — the daemon is still up. */
export async function openBrowser(url: string): Promise<boolean> {
  const { file, args } = browserCommand(url);
  return new Promise((done) => {
    // `windowsHide`, like every other execFile in this tree: a console window
    // flashing up is a poor look in the one path whose whole symptom is a
    // headless launch behaving oddly.
    const child = execFile(file, args, { windowsHide: true }, (error) => done(error === null));
    child.on('error', () => done(false));
  });
}
