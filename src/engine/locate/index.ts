export { accessibleName, broadFit, type LocateOptions, locate, roleFits, toLocatorSpec } from './candidates.js';
export {
  contentFrameOf,
  framePath,
  frameSelector,
  isNavigationRace,
  prepareFrame,
  readSettled,
  sameFrame,
  selectorIn,
  type VisibleFrame,
  visibleFrames,
} from './frames.js';
export { type InspectOptions, type InspectResult, inspectPage, inspectPageDetailed, readDom } from './inspector.js';
export { pageIdentityOf, screenKeyOf } from './page-identity.js';
export {
  type Box,
  type DomElement,
  type Ignored,
  LEVELS,
  type Level,
  type LocateQuery,
  type LocateResult,
  type Tried,
  WEIGHT,
} from './types.js';
