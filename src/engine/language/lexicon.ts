/**
 * The one list of words for the states an element can be in and the kinds of test data (D2, U7). The predicates the grammar
 * reads checks with, the synonym sets and the data classes used to keep their own copies of these words, and the copies
 * drifted: "masked" was five words in one and six in another, "duplicate" meant an existing value in one and a copy that
 * must be refused in another. They are written here once; everything else is built from them. This file imports nothing,
 * so any layer can read it.
 */

/** The states of an element or a field, by the name the predicates and the synonym sets use. The first word is the canonical one. */
export const STATE_WORDS = {
  masked: ['masked', 'masked characters', 'hidden characters', 'asterisks', 'dots', 'obscured', 'hides', 'masks'],
  enabled: ['enabled', 'clickable', 'active', 'usable', 'editable'],
  disabled: ['disabled', 'greyed out', 'grayed out', 'inactive', 'unclickable', 'read-only', 'readonly'],
  checked: ['checked', 'ticked', 'selected', 'chosen', 'picked'],
  unchecked: ['unchecked', 'unticked', 'deselected'],
  empty: ['empty', 'blank', 'cleared', 'emptied', 'has no value', 'holds nothing'],
} as const;

/** The kinds of test data a step can ask for, by the name of the data class. Each word belongs to one class. */
export const DATA_WORDS = {
  VALID: ['valid', 'correct', 'right', 'proper', 'good', 'legal', 'acceptable'],
  INVALID: ['invalid', 'wrong', 'incorrect', 'bad', 'illegal', 'unacceptable', 'improper', 'unintended'],
  BLANK: ['blank', 'empty', 'nothing', 'no value', 'left blank', 'left empty'],
  EXISTING: ['existing', 'already registered', 'already existing', 'registered', 'present'],
  NON_EXISTING: ['non-existing', 'non existing', 'nonexistent', 'unregistered', 'not registered', 'not existing', 'unknown'],
  DUPLICATE: ['duplicate', 'duplicated', 'repeated'],
} as const;

/** The words a check may end on to say what kind of value something is: "the password is invalid". A part of the first two classes. */
export const DATA_CLASS_CHECK_WORDS = ['invalid', 'valid', 'incorrect', 'correct', 'wrong'] as const;
