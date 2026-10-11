/**
 * Extension point for an optional helper (FR-AI-01, D11). The platform is complete without one: the
 * default does nothing. If a helper is ever added it must be a local model (FR-AI-02), its output is
 * only a suggestion that goes through the same parsing, validation and review (FR-AI-03), and it is
 * never used while tests run (FR-AI-04).
 */
export interface AssistProvider {
  /** A rewrite of a step or check the parser could not read, for the tester to accept or not. */
  suggestRewrite(input: { raw: string; kind: 'step' | 'check'; reason: string }): Promise<string | undefined>;
}

/** The default: no suggestions. */
export const noAssist: AssistProvider = {
  async suggestRewrite() {
    return undefined;
  },
};
