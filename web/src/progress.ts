// No React here, so the rule is tested on its own (src/server/progress.test.ts).

export type CaseState = 'done' | 'asks' | 'now' | 'ok' | 'bad';
/**
 * U1 step 4: what a run is doing, read from its log. A workbook run writes "[3/19] TC03: …" for each case it prepares and "TC03: running …"
 * as it runs them, so the page shows how far it is and the state of each case without a new server call.
 */
export function progressOf(lines: readonly string[]): { total?: number; cases: Array<{ id: string; state: CaseState; note: string }>; now?: string } {
  const cases = new Map<string, { id: string; state: CaseState; note: string }>();
  let total: number | undefined;
  let now: string | undefined;
  for (const raw of lines) {
    const mark = raw[0];
    const line = raw.replace(/^[…?!✓✗]\s*/u, '');
    const counted = /^\[(\d+)\/(\d+)\]\s+([^:]+):\s*(.*)$/.exec(line);
    const plain = /^([A-Za-z][\w-]*\d[\w-]*):\s*(.*)$/.exec(line);
    const id = counted?.[3] ?? plain?.[1];
    if (!id) continue;
    if (counted) total = Number(counted[2]);
    const note = (counted?.[4] ?? plain?.[2] ?? '').slice(0, 140);
    const lower = note.toLowerCase();
    const state: CaseState =
      mark === '?' || lower.includes('needs review') || lower.includes('waiting')
        ? 'asks'
        : lower.includes('pass')
          ? 'ok'
          : lower.includes('fail') || lower.includes('blocked')
            ? 'bad'
            : lower.includes('running') || lower.includes('exploring')
              ? 'now'
              : 'done';
    cases.set(id, { id, state, note });
    now = id;
  }
  return { ...(total ? { total } : {}), cases: [...cases.values()], ...(now ? { now } : {}) };
}
