import { type QaIr, QaIrSchema } from './schema.js';

export interface IrIssue {
  /** The field, e.g. `steps[1].action`. */
  path: string;
  message: string;
}

export type IrValidation = { ok: true; ir: QaIr } | { ok: false; issues: IrIssue[] };

export const pathText = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>((text, part) => (typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${String(part)}` : String(part)), '') || '(document)';

/** Checks a document against the schema and names every field that is wrong (GV-15 "Validate"). */
export function validateIr(doc: unknown): IrValidation {
  const parsed = QaIrSchema.safeParse(doc);
  if (parsed.success) return { ok: true, ir: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((i) => ({ path: pathText(i.path), message: i.message })) };
}
