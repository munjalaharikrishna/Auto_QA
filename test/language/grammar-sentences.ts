/**
 * The grammar sentences of E0.4: at least ten for each model GR-01 to GR-10, and ten for GR-11 (positional parameter
 * translation) with the exact parts each must be read into. The golden file next to this one holds the approved QA-IR
 * of every sentence; a change in how a sentence is read shows up as a difference in it.
 */

export type Mode = 'step' | 'expected';

export const GRAMMAR_SENTENCES: Record<string, { mode: Mode; sentences: string[] }> = {
  'GR-01': {
    mode: 'step',
    sentences: [
      'Click Login',
      "Click the 'Save' button",
      'Click on the Add Button',
      'Hover over the Profile menu',
      'Open the Login page',
      'Check the Remember me checkbox',
      'Clear the Search field',
      'Close the dialog',
      'Expand the Details section',
      "Delete the 'Draft' record",
    ],
  },
  'GR-02': {
    mode: 'step',
    sentences: [
      'Enter cypress in username field',
      "Type 'abc' in the Email field",
      "Fill the Email field with 'abc'",
      "Select 'India' from the Country dropdown",
      "Enter 'John' in the First name field",
      "Type 'hello' into the Search box",
      'Enter 25 in the Age field',
      'Select Canada from the Country dropdown',
      "Search for 'laptop' in the Search field",
      "Enter 'a@b.com' in the Email field",
    ],
  },
  'GR-03': {
    mode: 'step',
    sentences: [
      "Enter 'abc' in the Email field if the Email field is empty",
      "Type 'x' in the Name field when the Name field is empty",
      "Click the 'Save' button if the Save button is enabled",
      "Click the 'Next' button when the Next button is enabled",
      "Select 'India' from the Country dropdown if the Country dropdown is enabled",
      "Enter 'abc' in the Email field unless the Email field is disabled",
      "Click the 'Save' button if the Save button is visible",
      'Check the Remember me checkbox if the Remember me checkbox is unchecked',
      'Clear the Search field if the Search field is not empty',
      "Enter 'abc' in the Email field when the Email field is empty",
    ],
  },
  'GR-04': {
    mode: 'step',
    sentences: [
      'Click Save, a toast appears',
      "Click the 'Login' button, the Dashboard page is displayed",
      "Click the 'Add' button, the Add Employee page is displayed",
      "Click the 'Logout' button, the Login page is displayed",
      "Click the 'Save' button, an error message is displayed",
      "Click the 'Delete' button, a confirmation dialog appears",
      "Click the 'Reset' button, the Email field is empty",
      "Click the 'Search' button, the Results table is displayed",
      "Click the 'Close' button, the dialog is hidden",
      "Click the 'Next' button, the Next button is disabled",
    ],
  },
  'GR-05': {
    mode: 'step',
    sentences: [
      'Verify the Login button is disabled',
      'Verify the Save button is enabled',
      'Verify the Email field is empty',
      'Verify the Remember me checkbox is checked',
      'Verify the Password field is masked',
      'Verify the Login section is at the middle of the page',
      "Verify the Search field has value 'abc'",
      'Verify the Username field is empty',
      'Verify the Next button is disabled',
      'Verify the Continue button is enabled',
    ],
  },
  'GR-06': {
    mode: 'step',
    sentences: [
      'Verify an error message is displayed',
      'Verify the Dashboard heading is displayed',
      'Verify the user is redirected to the Dashboard page',
      'Verify the user is logged in',
      'Verify a validation message is displayed',
      'Verify the Reports page is displayed',
      'Verify the user stays on the Login page',
      'Verify the Success message is displayed',
      'Verify the Logout link is visible',
      "Verify the Email field contains 'abc'",
    ],
  },
  'GR-07': {
    mode: 'expected',
    sentences: [
      'If the password is invalid, an error message is displayed',
      'If the username is invalid then an error message should be displayed',
      'If the Email field is empty, a validation message is displayed',
      'If the password is invalid, the user is not logged in',
      'If the username is blank, a validation message is displayed',
      'If the Email field is empty, the Save button is disabled',
      'If the password is incorrect, an error message is displayed',
      'If the email is invalid, a validation message is displayed',
      'If the code is invalid, an error message appears',
      'If the Name field is empty, the Save button is disabled',
    ],
  },
  'GR-08': {
    mode: 'expected',
    sentences: [
      'When the Email field is empty, Login is disabled',
      'When the password is invalid, an error message is displayed',
      'When the username is blank, a validation message is displayed',
      'When the Email field is empty, the Save button is disabled',
      'When the Name field is valid, the Save button is enabled',
      'When the user is logged in, the Dashboard page is displayed',
      'When the password is wrong, an error message is shown',
      'When the code is invalid, an error message appears',
      'When the Email field is empty, the Submit button is disabled',
      'When the Name field is blank, a validation message is displayed',
    ],
  },
  'GR-09': {
    mode: 'step',
    sentences: [
      'After clicking Reset, the Email field is empty',
      'After clicking Save, a message is displayed',
      "After clicking the 'Login' button, the Dashboard page is displayed",
      'After clicking Logout, the Login page is displayed',
      "After clicking the 'Add' button, the Add Employee page is displayed",
      'After clicking Cancel, the dialog is hidden',
      "After clicking the 'Search' button, the Results table is displayed",
      "After entering 'abc' in the Email field, the Email field contains 'abc'",
      "After selecting 'India' from the Country dropdown, the Country dropdown has value 'India'",
      'After clicking Delete, the record is deleted',
    ],
  },
  'GR-10': {
    mode: 'step',
    sentences: [
      'Before clicking Save, the Save button is enabled',
      'Before clicking Login, the Login button is enabled',
      'Before clicking Reset, the Reset button is visible',
      'Before clicking Submit, the Submit button is enabled',
      "Before clicking the 'Next' button, the Next button is enabled",
      'Before clicking Delete, the Delete button is enabled',
      'Before clicking Cancel, the Cancel button is visible',
      'Before clicking Add, the Add button is displayed',
      'Before clicking Search, the Search field is empty',
      'Before clicking Logout, the user is logged in',
    ],
  },
};

/** GR-11: the parts each sentence must be read into (action, target and value). */
export const POSITIONAL: Array<{ sentence: string; action: string; target: string; value?: string }> = [
  { sentence: 'Enter cypress in username field', action: 'ENTER_VALUE', target: 'username', value: 'cypress' },
  { sentence: "Type 'abc' in the Email field", action: 'ENTER_VALUE', target: 'Email', value: 'abc' },
  { sentence: "Fill the Email field with 'abc'", action: 'ENTER_VALUE', target: 'Email', value: 'abc' },
  { sentence: "Select 'India' from the Country dropdown", action: 'SELECT', target: 'Country', value: 'India' },
  { sentence: "Search for 'laptop' in the Search field", action: 'SEARCH', target: 'Search', value: 'laptop' },
  { sentence: "Enter 'John' into the First name field", action: 'ENTER_VALUE', target: 'First name', value: 'John' },
  { sentence: 'Enter 25 in the Age field', action: 'ENTER_VALUE', target: 'Age', value: '25' },
  { sentence: "Type 'hello' on the Message box", action: 'ENTER_VALUE', target: 'Message', value: 'hello' },
  { sentence: 'Select Canada from the Country dropdown', action: 'SELECT', target: 'Country', value: 'Canada' },
  { sentence: "Enter 'x@y.io' in the Contact email field", action: 'ENTER_VALUE', target: 'Contact email', value: 'x@y.io' },
];
