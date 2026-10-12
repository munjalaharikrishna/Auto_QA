import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Application } from '../knowledge/schema.js';
import { tokenize } from '../text/index.js';

/**
 * Basic learning (BP-4, the first part of GV-01). Three things a person tells the engine once are remembered, so the
 * next run of the same test case does not ask again:
 *  - a PASS or FAIL decision on an expectation the engine could not prove, kept with who decided and when;
 *  - the element a person picked when the engine could not tell which one was meant;
 *  - the name a person gave to a label ("Login Name" is the Username field).
 * A decision that came with a message on the page becomes a concrete check: the same message after the same step decides
 * the same way. What is learned is data in a file, shown and removable; it never changes the evidence of a run, and a
 * learned check goes through the vacuous assertion guard before it is used (GV-01 rule 2).
 */

export interface LearnedDecision {
  /** What the decision is about: the expectation and what the page showed, as one short hash. */
  fingerprint: string;
  testId: string;
  clause: string;
  decision: 'PASS' | 'FAIL';
  who: string;
  when: string;
  note?: string;
  /** The message that was on the page, when there was one: the concrete check the decision becomes. */
  message?: string;
}

export interface Pick {
  testId: string;
  /** The tester's words for the element. */
  wanted: string;
  ontology: string;
  /** The page it is on (its name in the application knowledge, or its address path). */
  page: string;
  xpath?: string;
  testIdAttribute?: string;
  who: string;
  when: string;
}

export interface LabelMapping {
  /** The words a tester writes. */
  label: string;
  /** The name the application shows. */
  means: string;
  page?: string;
  who: string;
  when: string;
}

interface BookData {
  decisions: LearnedDecision[];
  picks: Pick[];
  labels: LabelMapping[];
}

const squash = (text: string): string =>
  tokenize(text)
    .filter((t) => t.kind === 'WORD' || t.kind === 'NUMBER')
    .map((t) => t.text.toLowerCase())
    .join(' ');

/** The same expectation with the same thing on the page gives the same fingerprint. */
export const fingerprintOf = (clause: string, actual: string): string =>
  createHash('sha256')
    .update(`${squash(clause)}|${squash(actual)}`)
    .digest('hex')
    .slice(0, 16);

export class LearningBook {
  private data: BookData;

  constructor(data: Partial<BookData> = {}) {
    this.data = { decisions: [...(data.decisions ?? [])], picks: [...(data.picks ?? [])], labels: [...(data.labels ?? [])] };
  }

  get decisions(): readonly LearnedDecision[] {
    return this.data.decisions;
  }
  get picks(): readonly Pick[] {
    return this.data.picks;
  }
  get labels(): readonly LabelMapping[] {
    return this.data.labels;
  }

  /** Remembers a decision. The same fingerprint decided again replaces the earlier decision. */
  decide(d: Omit<LearnedDecision, 'when'> & { when?: string }): LearnedDecision {
    const entry: LearnedDecision = { ...d, when: d.when ?? new Date().toISOString() };
    this.data.decisions = [...this.data.decisions.filter((x) => x.fingerprint !== d.fingerprint), entry];
    return entry;
  }

  pick(p: Omit<Pick, 'when'> & { when?: string }): Pick {
    const entry: Pick = { ...p, when: p.when ?? new Date().toISOString() };
    this.data.picks = [...this.data.picks.filter((x) => !(squash(x.wanted) === squash(p.wanted) && x.page === p.page)), entry];
    return entry;
  }

  mapLabel(m: Omit<LabelMapping, 'when'> & { when?: string }): LabelMapping {
    const entry: LabelMapping = { ...m, when: m.when ?? new Date().toISOString() };
    this.data.labels = [...this.data.labels.filter((x) => !(squash(x.label) === squash(m.label) && x.page === m.page)), entry];
    return entry;
  }

  /** What a person decided about this exact expectation and page before. */
  decisionFor(fingerprint: string): LearnedDecision | undefined {
    return this.data.decisions.find((d) => d.fingerprint === fingerprint);
  }

  /** A decision made on the same expectation that came with a message, for a page that shows that message now (the learned check). */
  checkFor(clause: string, shown: readonly string[], saysTheSame: (shown: string, wanted: string) => boolean): LearnedDecision | undefined {
    return this.data.decisions.find(
      (d) => d.message !== undefined && squash(d.clause) === squash(clause) && shown.some((s) => saysTheSame(s, d.message as string)),
    );
  }

  /** Forgets one learned decision (the editing and switch-off screen of E0.10 builds on this). */
  forget(fingerprint: string): boolean {
    const before = this.data.decisions.length;
    this.data.decisions = this.data.decisions.filter((d) => d.fingerprint !== fingerprint);
    return this.data.decisions.length < before;
  }

  /** The knowledge of the application with what was learned added: the picked elements and the names. The original is not changed. */
  applyTo(app: Application): Application {
    const pages = app.pages.map((p) => ({ ...p, components: p.components.map((c) => ({ ...c, aliases: [...c.aliases] })) }));
    const home = (name?: string) => pages.find((p) => name !== undefined && (p.name === name || p.route === name));
    for (const l of this.data.labels) {
      for (const page of l.page ? [home(l.page)].filter((x) => x !== undefined) : pages) {
        const c = page?.components.find((x) => squash(x.name) === squash(l.means) || x.aliases.some((a) => squash(a) === squash(l.means)));
        if (c && !c.aliases.some((a) => squash(a) === squash(l.label))) c.aliases.push(l.label);
      }
    }
    for (const k of this.data.picks) {
      const page = home(k.page);
      if (!page) continue;
      const existing = page.components.find((x) => squash(x.name) === squash(k.wanted) || x.aliases.some((a) => squash(a) === squash(k.wanted)));
      if (existing) {
        if (k.xpath) existing.xpath = k.xpath;
        if (k.testIdAttribute) existing.testId = k.testIdAttribute;
      } else {
        page.components.push({
          name: k.wanted,
          aliases: [],
          ontology: k.ontology,
          ...(k.testIdAttribute ? { testId: k.testIdAttribute } : {}),
          ...(k.xpath ? { xpath: k.xpath } : {}),
          key: false,
        });
      }
    }
    return { ...app, pages };
  }

  toJSON(): BookData {
    return { decisions: this.data.decisions, picks: this.data.picks, labels: this.data.labels };
  }

  save(file: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(this.toJSON(), null, 2)}\n`);
  }

  static load(file: string): LearningBook {
    try {
      return new LearningBook(JSON.parse(readFileSync(file, 'utf8')) as Partial<BookData>);
    } catch {
      return new LearningBook();
    }
  }
}
