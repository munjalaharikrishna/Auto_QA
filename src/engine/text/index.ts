export { type CompoundMatch, compactKey, findCompounds, sameCompound } from './compound.js';
export {
  type NormalizedText,
  type NormalizeOptions,
  type NormChange,
  normalize,
  originalSpan,
  originalText,
  quotedValues,
  type Span,
  touchesData,
} from './normalize.js';
export { contentTokens, type Token, type TokenKind, tokenize } from './tokenize.js';
