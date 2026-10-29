import type { RawTestCase, TestModel } from '../model/test-model.js';

/**
 * What the new engine reads a test case from (E0.12, S4). The model the parser builds is made to be stored and shown, so it holds the
 * Test Data and the steps with every secret replaced by `••••` (FR-EV-03). The engine is different: it types what the test case says,
 * so it has to be given what the tester wrote. Handing it the masked model made it type four bullet characters as the password.
 *
 * The original text is kept in memory only, beside the model it made, never in the model: nothing that is stored, shown or exported
 * carries it. A model that came from somewhere else (read back from storage) has no original, and `engineInputOf` says so, so the
 * caller can refuse to run on text it knows is masked.
 */

const originals = new WeakMap<TestModel, RawTestCase>();

/** Keeps the text a model was made from. Called by the parser once, with the model it returns. */
export function rememberOriginal(model: TestModel, given: RawTestCase): void {
  originals.set(model, given);
}

export interface EngineInput {
  raw: RawTestCase;
  /** The text is what the tester wrote. False: it is the masked copy in the model, and a secret in it is not the secret. */
  fromOriginal: boolean;
}

/** The test case as the engine is to read it. */
export function engineInputOf(model: TestModel): EngineInput {
  const original = originals.get(model);
  if (original) return { raw: original, fromOriginal: true };
  return {
    raw: {
      id: model.id,
      title: model.title,
      type: model.type,
      preconditions: model.source.rawPreconditions,
      steps: model.source.rawSteps,
      testData: model.source.rawTestData,
      expected: model.source.rawExpected,
      requirementId: model.requirementId,
      row: model.source.row,
    },
    fromOriginal: false,
  };
}
