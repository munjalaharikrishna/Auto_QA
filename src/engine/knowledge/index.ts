export { applicationClass, diffKnowledge, type KnowledgeChange, KnowledgeStore } from './application.js';
export { type ElementWord, knowledgeFromRuns, readScreens, SCREENS_FILE } from './from-runs.js';
export { CORE_LABELS, type Consolidation, consolidate, keysOf, labelKey, nameWords } from './labels.js';
export { componentOnPage, type Identity, identifyPage, keyComponents, type PageResolution, pageNames, resolvePage, type SeenElement } from './pages.js';
export {
  type Application,
  ApplicationSchema,
  type Component,
  ComponentSchema,
  type KnownMessage,
  MESSAGE_KINDS,
  MessageSchema,
  type Page,
  PageSchema,
} from './schema.js';
export {
  diffScreens,
  elementIdentity,
  mergeScreens,
  type Screen,
  type ScreenChange,
  type ScreenElement,
  ScreenElementSchema,
  ScreenSchema,
  screenWord,
} from './screens.js';
