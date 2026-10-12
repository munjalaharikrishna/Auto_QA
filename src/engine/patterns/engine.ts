import vm from 'node:vm';

/**
 * The pattern engine (L4). It is the only place in `src/engine/` that holds regular expressions (RX-01). A pattern is
 * data: a name, a version, a priority, a source and its own examples (RX-24). The engine
 *  - refuses a broken pattern when it is loaded, naming it (RX-22),
 *  - runs every pattern under a hard time limit, so a pattern that backtracks without end is stopped and reported
 *    instead of hanging the run (RX-21),
 *  - lets the higher priority win when two patterns claim the same text, and lists those conflicts (RX-23).
 * It reads text and returns spans; it never changes text. Same input, same output (GV-05).
 */

export interface PatternExamples {
  /** Texts the pattern must find something in, with the exact text of the first match. */
  match: ReadonlyArray<readonly [text: string, first: string]>;
  /** Texts the pattern must find nothing in. */
  noMatch: readonly string[];
}

export interface PatternDef {
  name: string;
  /** The requirement this pattern serves, e.g. `RX-02`, or `NM-11` for a pattern the other layers use. */
  req: string;
  /** Bumped whenever the source changes (RX-24). */
  version: string;
  /** Higher wins when two patterns match the same text (RX-23). */
  priority: number;
  source: string;
  /** Always run as global; `g` is added when missing. */
  flags: string;
  examples: PatternExamples;
}

export interface PatternMatch {
  pattern: string;
  priority: number;
  start: number;
  end: number;
  text: string;
  /** Numbered groups, `undefined` where a group did not take part. */
  groups: Array<string | undefined>;
  /** Named groups that took part. */
  named: Record<string, string>;
}

export interface PatternConflict {
  winner: { pattern: string; start: number; end: number };
  loser: { pattern: string; start: number; end: number };
}

export interface PatternTimeout {
  pattern: string;
  limitMs: number;
  inputLength: number;
}

export interface ScanResult {
  /** The matches that stand, in text order. */
  matches: PatternMatch[];
  /** The matches that lost to a higher priority one. */
  conflicts: PatternConflict[];
  /** The patterns stopped at the time limit. They contribute no matches. */
  timeouts: PatternTimeout[];
}

export class PatternError extends Error {
  constructor(
    readonly pattern: string,
    message: string,
  ) {
    super(`pattern "${pattern}": ${message}`);
    this.name = 'PatternError';
  }
}

export const DEFAULT_LIMIT_MS = 50;

const RUN = new vm.Script(`(function(){
  var out = [];
  for (var k = 0; k < __names.length; k++) {
    var re = __re[__names[k]];
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(__text)) !== null) {
      var named = {};
      if (m.groups) for (var g in m.groups) if (m.groups[g] !== undefined) named[g] = m.groups[g];
      out.push([__names[k], m.index, m[0], Array.prototype.slice.call(m, 1), named]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return JSON.stringify(out);
})()`);

type RawHit = [string, number, string, Array<string | null>, Record<string, string>];

export class PatternSet {
  private readonly defs = new Map<string, PatternDef>();
  private readonly context: vm.Context;
  readonly limitMs: number;

  constructor(defs: readonly PatternDef[], options: { limitMs?: number } = {}) {
    this.limitMs = options.limitMs ?? DEFAULT_LIMIT_MS;
    const sandbox: { __re: Record<string, RegExp>; __names: string[]; __text: string } = { __re: Object.create(null), __names: [], __text: '' };
    this.context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    for (const def of defs) this.add(def, sandbox.__re);
  }

  private add(def: PatternDef, store: Record<string, RegExp>): void {
    if (this.defs.has(def.name)) throw new PatternError(def.name, 'the name is used twice');
    const flags = def.flags.includes('g') ? def.flags : `${def.flags}g`;
    try {
      // Checked in this realm first so the error names the pattern; the copy that runs is built inside the sandbox.
      new RegExp(def.source, flags);
      store[def.name] = new vm.Script(`new RegExp(${JSON.stringify(def.source)}, ${JSON.stringify(flags)})`).runInContext(this.context);
    } catch (error) {
      throw new PatternError(def.name, `is not a valid regular expression (${(error as Error).message})`);
    }
    this.defs.set(def.name, { ...def, flags });
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  get(name: string): PatternDef {
    const def = this.defs.get(name);
    if (!def) throw new PatternError(name, 'is not defined');
    return def;
  }

  get names(): string[] {
    return [...this.defs.keys()];
  }

  get definitions(): PatternDef[] {
    return [...this.defs.values()];
  }

  /** The versions of every pattern, for the run's version stamp (GV-12, RX-24). */
  get versions(): Record<string, string> {
    return Object.fromEntries([...this.defs.values()].map((d) => [d.name, d.version]));
  }

  /**
   * Runs the named patterns (all when none are named) over the text. Every raw match is returned, with no conflict
   * resolution, unless the caller asks for it with `resolve`. A pattern that runs over the time limit is stopped.
   */
  scan(text: string, names: readonly string[] = this.names, options: { resolve?: boolean } = {}): ScanResult {
    for (const name of names) this.get(name);
    const timeouts: PatternTimeout[] = [];
    let hits: RawHit[] | undefined = this.run(text, names, this.limitMs * Math.max(1, names.length));
    if (!hits) {
      // Something ran over: find which pattern by running each alone, keep what the others found.
      hits = [];
      for (const name of names) {
        const own = this.run(text, [name], this.limitMs);
        if (own) hits.push(...own);
        else timeouts.push({ pattern: name, limitMs: this.limitMs, inputLength: text.length });
      }
    }
    const matches = hits.map(([pattern, start, matched, groups, named]) => ({
      pattern,
      priority: this.get(pattern).priority,
      start,
      end: start + matched.length,
      text: matched,
      groups: groups.map((g) => g ?? undefined),
      named,
    }));
    if (options.resolve === false) return { matches: sortMatches(matches), conflicts: [], timeouts };
    return { ...resolveConflicts(matches), timeouts };
  }

  /**
   * Stopped at the limit; `undefined` when it ran over. The limit is wall-clock time, so a busy machine can stall one
   * run for no fault of the pattern: it gets one more try before it is reported. A pattern that really backtracks
   * without end runs over both times and costs twice the limit.
   */
  private run(text: string, names: readonly string[], limitMs: number): RawHit[] | undefined {
    return this.runOnce(text, names, limitMs) ?? this.runOnce(text, names, limitMs);
  }

  private runOnce(text: string, names: readonly string[], limitMs: number): RawHit[] | undefined {
    const sandbox = this.context as { __names: string[]; __text: string };
    sandbox.__names = [...names];
    sandbox.__text = text;
    try {
      const json = RUN.runInContext(this.context, { timeout: Math.max(1, Math.round(limitMs)) }) as string;
      return JSON.parse(json) as RawHit[];
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return undefined;
      throw error;
    } finally {
      sandbox.__text = '';
    }
  }

  /** The first match of one pattern, or undefined. A timeout counts as no match; use `scan` to see it. */
  first(name: string, text: string): PatternMatch | undefined {
    return this.scan(text, [name], { resolve: false }).matches[0];
  }

  /** Whether the pattern matches the whole text, not just part of it. */
  matchesWhole(name: string, text: string): boolean {
    return this.scan(text, [name], { resolve: false }).matches.some((m) => m.start === 0 && m.end === text.length);
  }
}

const byPosition = (a: PatternMatch, b: PatternMatch): number => a.start - b.start || b.end - a.end || a.pattern.localeCompare(b.pattern);

const sortMatches = (matches: PatternMatch[]): PatternMatch[] => [...matches].sort(byPosition);

/**
 * Priority, then the longer match, then the earlier one, then the name: a total order, so the result never depends on
 * the order the patterns were run (RX-23). A match is kept when it overlaps nothing already kept.
 */
export function resolveConflicts(matches: readonly PatternMatch[]): { matches: PatternMatch[]; conflicts: PatternConflict[] } {
  const ranked = [...matches].sort(
    (a, b) => b.priority - a.priority || b.end - b.start - (a.end - a.start) || a.start - b.start || a.pattern.localeCompare(b.pattern),
  );
  const kept: PatternMatch[] = [];
  const conflicts: PatternConflict[] = [];
  for (const m of ranked) {
    const winner = kept.find((k) => m.start < k.end && k.start < m.end);
    if (winner) {
      if (winner.pattern !== m.pattern) {
        conflicts.push({
          winner: { pattern: winner.pattern, start: winner.start, end: winner.end },
          loser: { pattern: m.pattern, start: m.start, end: m.end },
        });
      }
    } else kept.push(m);
  }
  return { matches: sortMatches(kept), conflicts: conflicts.sort((a, b) => a.loser.start - b.loser.start || a.loser.pattern.localeCompare(b.loser.pattern)) };
}
