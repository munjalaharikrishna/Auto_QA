/**
 * U1 step 1: the small shared parts of the project-first UI. Icons are drawn here (no icon font), and every part takes its colours from
 * the tokens in styles.css, so light and dark both follow.
 */

const PATHS = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  cases: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  runs: 'M7 5l12 7-12 7z',
  review: 'M4 13h3l2 3h6l2-3h3M5 13l2-7h10l2 7v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z',
  automation: 'M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14',
  releases: 'M5 21V4M5 4h11l-2 4 2 4H5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  check: 'M5 12l4 4L19 6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  swap: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  guide: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM20 17v4H6.5A2.5 2.5 0 0 1 4 18.5',
  projects: 'M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, stroke = 2 }: { name: IconName; size?: number; stroke?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** A coloured label: the five statuses, the review reasons and the project's own kinds. */
export type ChipKind = 'pass' | 'fail' | 'need' | 'blocked' | 'notv' | 'info' | 'accent' | 'muted';
export function Chip({ kind, children }: { kind: ChipKind; children: React.ReactNode }) {
  return <span className={`chip-${kind} ui-chip`}>{children}</span>;
}

/** The two or three letters of a project, on its tile. */
export function initialsOf(name: string): string {
  const words = name
    .split(' ')
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => (w[0] as string).toUpperCase())
    .join('');
}

export function ProjectTile({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span className="project-tile" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
