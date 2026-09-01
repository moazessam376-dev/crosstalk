import { createElement } from 'react';

/**
 * A page with a corner folded and the format written on it.
 *
 * The operator asked for this by example: "for files it always have it's
 * unique icons, for example MD or HTML things like this". So the badge is the
 * format's own name, drawn rather than looked up — same reasoning as
 * `HarnessMark`: an icon library or a webfont would be a third runtime
 * dependency in a project whose hard rule is two, for six glyphs.
 *
 * The label is *text inside the SVG*, which means a format nobody anticipated
 * still gets a correct badge instead of a generic one. That matters more than
 * it sounds: the alternative is a switch that silently draws "FILE" for
 * anything unlisted, and the operator's `.mdx` or `.tsx` would look broken
 * rather than merely unfamiliar.
 */

/** The short name a format goes by. Four characters is what fits the page. */
export function formatLabel(type: string, name: string): string {
  const known: Record<string, string> = {
    'text/markdown': 'MD',
    'text/html': 'HTML',
    'text/plain': 'TXT',
    'text/csv': 'CSV',
    'application/pdf': 'PDF',
    'application/json': 'JSON',
    'application/zip': 'ZIP',
    'video/mp4': 'MP4',
    'video/quicktime': 'MOV',
    'video/webm': 'WEBM',
    'image/svg+xml': 'SVG',
    'image/png': 'PNG',
    'image/jpeg': 'JPG',
    'image/gif': 'GIF',
    'image/webp': 'WEBP',
    'image/heic': 'HEIC',
  };
  const byType = known[type.toLowerCase()];
  if (byType !== undefined) return byType;

  // Fall back to the author's own extension rather than to a generic word. An
  // unlisted format is unfamiliar, not broken, and the badge should say which.
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toUpperCase();
  return ext === '' || ext.length > 4 ? 'FILE' : ext;
}

export interface FileMarkProps {
  type: string;
  name: string;
  size?: number;
}

export function FileMark({ type, name, size = 28 }: FileMarkProps) {
  const label = formatLabel(type, name);
  // Four characters at the same size as two would overflow the page, so the
  // longer labels are set smaller rather than clipped.
  const fontSize = label.length >= 4 ? 5.2 : label.length === 3 ? 6.2 : 7.4;

  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      className: 'file-mark',
      focusable: 'false',
    },
    // The page, with the corner cut where the fold goes.
    createElement('path', {
      d: 'M5.5 2.5h8.2l4.8 4.8v14.2a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1v-18a1 1 0 0 1 1-1z',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinejoin: 'round',
    }),
    // The fold itself, which is what reads as "document" at 28 pixels.
    createElement('path', {
      d: 'M13.7 2.5v4.8h4.8',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinejoin: 'round',
    }),
    createElement(
      'text',
      {
        x: 12,
        y: 17.4,
        textAnchor: 'middle',
        fill: 'currentColor',
        stroke: 'none',
        fontSize,
        fontFamily: 'var(--font-mono, monospace)',
        letterSpacing: label.length >= 4 ? '-0.2' : '0',
      },
      label,
    ),
  );
}
