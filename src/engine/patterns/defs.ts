// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the text of a test step or a variable token contains a literal ${…}, which is what is being tested
import type { PatternDef, PatternExamples } from './engine.js';

/**
 * The built-in patterns. This file and the rest of `src/engine/patterns/` are the only places in the engine that
 * write regular expressions (RX-01). Every pattern has a version and its own examples (RX-24): each example in
 * `match` gives the text the pattern is run on and the exact text of its first match; each in `noMatch` must give
 * nothing. The pattern suite runs them all.
 *
 * Priorities (RX-23): quoted text 100, URL and email 90, variables 80, placeholders 70, dates 60, other values
 * 40-55, words 10. A higher priority wins when two patterns claim the same text.
 */

const def = (name: string, req: string, priority: number, re: RegExp, examples: PatternExamples, version = '1.0.0'): PatternDef => ({
  name,
  req,
  version,
  priority,
  source: re.source,
  flags: re.flags,
  examples,
});

const MONTH =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

/** Detectors: find a kind of value in a sentence (RX-02 to RX-09). */
export const VALUE_PATTERNS: PatternDef[] = [
  def('email', 'RX-02', 90, /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/, {
    match: [
      ['a@b.com', 'a@b.com'],
      ['Enter john.doe+test@example.co.uk now', 'john.doe+test@example.co.uk'],
      ['email is Admin_1@Mail-Server.org.', 'Admin_1@Mail-Server.org'],
      ['mail x@y.io and z@w.io', 'x@y.io'],
      ['use "qa@brightcone.ai"', 'qa@brightcone.ai'],
    ],
    noMatch: ['a@b', '@home', 'user@', 'hello world', 'a@.com', 'user at example dot com'],
  }),
  def('phone', 'RX-03', 50, /\+\d{1,3}(?:[\s.-]\(?\d{2,5}\)?){2,4}(?!\d)|\+\d{8,15}(?!\d)|(?<![\d(])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/, {
    match: [
      ['call +1 415 555 2671', '+1 415 555 2671'],
      ['(415) 555-2671', '(415) 555-2671'],
      ['415-555-2671', '415-555-2671'],
      ['phone +91 98765 43210', '+91 98765 43210'],
      ['+44 20 7946 0958', '+44 20 7946 0958'],
      ['+14155552671', '+14155552671'],
    ],
    noMatch: ['12345', '2024-02-21', 'call me', '555-1234', '1,000', 'order 99'],
  }),
  def(
    'url',
    'RX-04',
    90,
    /\b(?:https?|ftp|file):\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}])?|\blocalhost:\d+(?:\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}])?/i,
    {
      match: [
        ['open https://x.com/Path?A=1 now', 'https://x.com/Path?A=1'],
        ['go to http://localhost:3000/login.', 'http://localhost:3000/login'],
        ['visit www.example.com/a/b, then', 'www.example.com/a/b'],
        ['ftp://files.example.org/pub', 'ftp://files.example.org/pub'],
        ['localhost:8080/app', 'localhost:8080/app'],
        ['(see https://a.io/x)', 'https://a.io/x'],
      ],
      noMatch: ['http://', 'hello', 'www', 'user@example.com', 'the url is missing', 'example.com'],
    },
  ),
  def(
    'date',
    'RX-05',
    60,
    new RegExp(
      [
        '(?<![\\d/.-])\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])(?![\\d/.-])',
        '(?<![\\d/.-])(?:0?[1-9]|[12]\\d|3[01])[/.-](?:0?[1-9]|[12]\\d|3[01])[/.-](?:\\d{4}|\\d{2})(?![\\d]|[/.]\\d)',
        `(?<!\\w)\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH})\\.?,?\\s+\\d{4}(?!\\d)`,
        `(?<!\\w)(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}(?!\\d)`,
      ].join('|'),
      'i',
    ),
    {
      match: [
        ['on 2024-02-21 the', '2024-02-21'],
        ['born 21/02/2024.', '21/02/2024'],
        ['date 02-21-24', '02-21-24'],
        ['due 5 March 2025', '5 March 2025'],
        ['on Feb 21, 2024', 'Feb 21, 2024'],
        ['31.12.1999', '31.12.1999'],
      ],
      noMatch: ['2024-13-45', '1/2', 'hello', '99/99/9999', 'version 1.2.3', '192.168.1.1', '12/2024'],
    },
  ),
  def(
    'time',
    'RX-06',
    50,
    /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s?[AaPp]\.?[Mm]\.?)?(?![\d:])|(?<![\d:.])(?:1[0-2]|0?[1-9])\s?[AaPp]\.?[Mm]\.?(?!\w)/,
    {
      match: [
        ['at 10:30', '10:30'],
        ['at 9:05 PM sharp', '9:05 PM'],
        ['23:59:59', '23:59:59'],
        ['meet at 9 am', '9 am'],
        ['from 07:00 to 17:00', '07:00'],
        ['12:00p.m.', '12:00p.m.'],
      ],
      noMatch: ['25:00', '12:75', '9', 'hello', '1:2', 'room 245', '1.30'],
    },
  ),
  def(
    'currency',
    'RX-07',
    55,
    /[$€£¥₹]\s?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d,])|[$€£¥₹]\s?\d+(?:\.\d{1,2})?(?!\d)|(?<![\d.,])\d+(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR)\b/,
    {
      match: [
        ['price $29.99', '$29.99'],
        ['pay ₹1,000 now', '₹1,000'],
        ['cost €5', '€5'],
        ['£1,234,567.50 total', '£1,234,567.50'],
        ['100 USD', '100 USD'],
        ['$ 15', '$ 15'],
      ],
      noMatch: ['29.99', '$', 'dollar', 'USD', 'price', 'pay now'],
    },
  ),
  def('percentage', 'RX-08', 55, /(?<![\w.])\d+(?:\.\d+)?\s?%|(?<![\w.])\d+(?:\.\d+)?\s?(?:percent|per cent)\b/i, {
    match: [
      ['discount 15%', '15%'],
      ['at 12.5 %', '12.5 %'],
      ['50 percent off', '50 percent'],
      ['100%', '100%'],
      ['3 per cent', '3 per cent'],
    ],
    noMatch: ['%', '50', 'percent', 'hello%', 'a % b', 'rate'],
  }),
  def('number', 'RX-09', 40, /(?<![\p{L}\p{N}_.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\p{L}\p{N}_]|\.\d)/u, {
    match: [
      ['5', '5'],
      ['pi is 3.14.', '3.14'],
      ['1,000 items', '1,000'],
      ['total 1,234,567.89', '1,234,567.89'],
      ['code 007', '007'],
      ['enter 42 times', '42'],
    ],
    noMatch: ['abc', 'Admin123', 'v2', '1.2.3', 'x7', 'none here'],
  }),
];

/** Extractors: pull a value out of a sentence (RX-12 to RX-20). */
export const EXTRACT_PATTERNS: PatternDef[] = [
  def(
    'testDataQuoted',
    'RX-12',
    45,
    /\b(?:enter|type|input|fill(?:\s+in)?|set|provide|key\s+in)\s+(?:"(?<v1>[^"]*)"|'(?<v2>[^']*)'|“(?<v3>[^”]*)”|‘(?<v4>[^’]*)’)(?:\s+(?:as|in|into|for|on|to|with)\s+(?:the\s+)?(?<field>[^"'“”‘’.,;]+?))?(?=\s*(?:[.,;]|$|\s+and\b))/i,
    {
      match: [
        ["Enter 'cypress' as username", "Enter 'cypress' as username"],
        ['Type "Admin123" in the password field', 'Type "Admin123" in the password field'],
        ['enter “John” as first name.', 'enter “John” as first name'],
        ["Input 'x' into Search", "Input 'x' into Search"],
        ['Fill in "a@b.com" for email, then click', 'Fill in "a@b.com" for email'],
      ],
      noMatch: ['Click the Login button', 'Enter username', "The 'cypress' value", 'type here', 'Enter the password'],
    },
  ),
  def('testDataPair', 'RX-12', 40, /(?<![\w])(?<key>[A-Za-z][A-Za-z ]{0,30}?)\s*[:=]\s*(?<value>[^\n;,]*[^\s\n;,])/, {
    match: [
      ['Username: cypress', 'Username: cypress'],
      ['Password = selenium', 'Password = selenium'],
      ['Email: a@b.com; Name: Joe', 'Email: a@b.com'],
      ['first name: Mary Ann', 'first name: Mary Ann'],
      ['Token:abc123', 'Token:abc123'],
    ],
    noMatch: ['Username', 'no data here', 'Click login', '12:30', ': value'],
  }),
  def('quotedString', 'RX-13', 100, /"([^"]*)"|(?<![\p{L}\p{N}])'([^']*)'(?![\p{L}\p{N}])|“([^”]*)”|‘([^’]*)’|„([^“”]*)[“”]|«([^»]*)»/u, {
    match: [
      ['Enter "Invalid credentials" now', '"Invalid credentials"'],
      ["Type 'cypress' here", "'cypress'"],
      ['Message “Required” shows', '“Required”'],
      ['Value ‘x y’ ok', '‘x y’'],
      ['empty "" value', '""'],
      ['it\'s fine and "ok"', '"ok"'],
    ],
    noMatch: ["it's fine", "don't click", 'no quotes here', 'the users’ list', "the users' list and the dogs' bowls"],
  }),
  def('placeholder', 'RX-14', 70, /<[A-Za-z][\w .-]{0,40}>|\[[A-Za-z][\w .-]{0,40}\]/, {
    match: [
      ['Enter <username>', '<username>'],
      ['type [password] here', '[password]'],
      ['use <first name> and <last name>', '<first name>'],
      ['[Email address]', '[Email address]'],
      ['<user_id>', '<user_id>'],
    ],
    noMatch: ['a < b > c', '[1]', '[]', '<>', 'x<y', 'array[0]'],
  }),
  def('variable', 'RX-15', 80, /\$\{[A-Za-z_][\w.]*\}|\{\{\s*[A-Za-z_][\w.]*\s*\}\}/, {
    match: [
      ['Enter ${user}', '${user}'],
      ['type {{email}} here', '{{email}}'],
      ['{{ user.name }}', '{{ user.name }}'],
      ['${env.PASSWORD}', '${env.PASSWORD}'],
      ['use {{a}} and ${b}', '{{a}}'],
    ],
    noMatch: ['$5', '{user}', '{{}}', '${}', '$ {x}', 'plain text'],
  }),
  def(
    'browserCommand',
    'RX-16',
    45,
    /(?<back>\b(?:go|navigate|move)\s+back(?:ward)?\b|\bbrowser'?s?\s+back(?:\s+button)?\b|\bpress\s+(?:the\s+)?(?:browser\s+)?back\b)|(?<forward>\b(?:go|navigate|move)\s+forward\b|\bbrowser'?s?\s+forward(?:\s+button)?\b|\bpress\s+(?:the\s+)?(?:browser\s+)?forward\b)|(?<refresh>\b(?:refresh|reload)(?:\s+the)?\s+(?:page|browser|screen)\b|\b(?:refresh|reload)\b(?!\s+(?:button|icon|link)))|(?<newTab>\b(?:open|create)\s+(?:a\s+)?new\s+(?:tab|window)\b)|(?<closeTab>\bclose\s+(?:the\s+)?(?:current\s+)?(?:tab|window)\b)/i,
    {
      match: [
        ['Go back to the Login page', 'Go back'],
        ['Click the browser back button', 'browser back button'],
        ['Refresh the page', 'Refresh the page'],
        ['Open a new tab', 'Open a new tab'],
        ['then go forward', 'go forward'],
        ['Close the current tab', 'Close the current tab'],
        ['reload', 'reload'],
      ],
      noMatch: ['feedback form', 'background colour', 'Click the Reload button', 'Back to list link', 'new tab label', 'tabs are shown'],
    },
  ),
  def(
    'waitDuration',
    'RX-17',
    45,
    /\b(?:wait|pause|sleep|delay)(?:\s+for)?\s+(?<n>\d+(?:\.\d+)?)\s*(?<u>ms|milliseconds?|secs?|seconds?|s|mins?|minutes?|m)\b/i,
    {
      match: [
        ['Wait 5 seconds', 'Wait 5 seconds'],
        ['wait for 2 min', 'wait for 2 min'],
        ['pause 500ms', 'pause 500ms'],
        ['Wait for 1.5 s then click', 'Wait for 1.5 s'],
        ['sleep 3 minutes', 'sleep 3 minutes'],
      ],
      noMatch: ['wait for the page', 'wait until loaded', 'wait 5', 'Enter 5 secs', 'waiting 5 seconds', 'delay'],
    },
  ),
  def(
    'keyboardKey',
    'RX-18',
    45,
    /\b(?:press|hit|use)\s+(?:the\s+)?(?<key>(?:(?:ctrl|control|alt|shift|cmd|command|meta)\s*\+\s*)*(?:enter|return|tab|esc(?:ape)?|space(?:bar)?|backspace|delete|home|end|page\s?up|page\s?down|arrow\s?(?:up|down|left|right)|f(?:1[0-2]|[1-9])))(?:\s+key)?\b|(?<combo>\b(?:ctrl|control|alt|shift|cmd|command|meta)\s*\+\s*(?:[a-z0-9]|tab|enter|esc(?:ape)?|f(?:1[0-2]|[1-9]))\b)/i,
    {
      match: [
        ['Press Enter', 'Press Enter'],
        ['press the Tab key', 'press the Tab key'],
        ['Hit Shift+Tab', 'Hit Shift+Tab'],
        ['use Ctrl+A to select', 'Ctrl+A'],
        ['Press F5', 'Press F5'],
        ['Ctrl + C then paste', 'Ctrl + C'],
      ],
      noMatch: ['Enter username', 'Tab to the next field', 'press the button', 'the delete button', 'Shift schedule', 'use a pen'],
    },
  ),
  def(
    'filePath',
    'RX-19',
    55,
    /(?<![\w\\])[A-Za-z]:\\(?:[^\\/:*?"<>|\s]+\\)*[^\\/:*?"<>|\s.,;]+(?:\.[A-Za-z0-9]{1,6})?|(?<![\w.:/\\-])(?:\.{1,2}\/|\/)(?:[\w.-]+\/)*[\w-]+\.[A-Za-z0-9]{1,6}\b|(?<![\w/.:\\-])(?:[\w-]+\/)+[\w-]+\.(?:pdf|jpe?g|png|gif|txt|csv|xlsx?|docx?|json|xml|zip)\b/,
    {
      match: [
        ['Upload C:\\data\\photo.jpg now', 'C:\\data\\photo.jpg'],
        ['file ./files/a.pdf', './files/a.pdf'],
        ['use /home/user/report.txt', '/home/user/report.txt'],
        ['attach files/a.pdf', 'files/a.pdf'],
        ['../up/one.csv', '../up/one.csv'],
        ['D:\\Docs\\Reports\\q1.xlsx', 'D:\\Docs\\Reports\\q1.xlsx'],
      ],
      noMatch: ['and/or', 'C:', '1/2/3', './', 'www.example.com/a.html', 'yes/no'],
    },
  ),
  def(
    'apiEndpoint',
    'RX-20',
    55,
    /\b(?<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?<path>(?:https?:\/\/[^\s/]+)?\/[\w\-./{}:?=&%~+@]*[\w\-/}])|(?<![\w.:/])\/(?:api|v\d+|rest|graphql)\b[\w\-./{}:?=&%]*[\w\-/}]?/,
    {
      match: [
        ['Send GET /api/users/1', 'GET /api/users/1'],
        ['POST /api/login with data', 'POST /api/login'],
        ['DELETE https://x.io/v1/items/9', 'DELETE https://x.io/v1/items/9'],
        ['call /api/v2/orders?id=3', '/api/v2/orders?id=3'],
        ['PUT /users/{id}', 'PUT /users/{id}'],
      ],
      noMatch: ['GET the user', 'POST', '/home page', 'and/or', 'get the api', 'the api'],
    },
  ),
];

/** One-time passcodes (AU-04, AU-06): the code in a mail, and the message an application shows for a refused one. */
export const AUTH_PATTERNS: PatternDef[] = [
  def('otpCode', 'AU-04', 50, /(?<=\b(?:code|otp|passcode|pin|token)\b[^\d\n]{0,30})(?<![\d.])\d{4,8}(?!\d)|(?<![\d.,:/@-])\d{6}(?![\d.,@-])/i, {
    match: [
      ['Your verification code is 482913', '482913'],
      ['OTP: 1234', '1234'],
      ['Use passcode 55667788 to sign in', '55667788'],
      ['123456 is your login number', '123456'],
      ['Your PIN is 9081. It expires in 10 minutes.', '9081'],
      ['Code: 000123', '000123'],
    ],
    noMatch: ['No digits here', 'Call 555-1234 now', 'Order 12345678901', 'Visit 2026-10-29', 'version 1.2.3456', 'Your code has expired'],
  }),
  def(
    'otpRejected',
    'AU-06',
    50,
    /\b(?:invalid|incorrect|wrong|expired|not valid)\b[^.\n]{0,40}\b(?:otp|code|passcode|token)\b|\b(?:otp|code|passcode|token)\b[^.\n]{0,40}\b(?:invalid|incorrect|wrong|expired|not valid|is not correct)\b/i,
    {
      match: [
        ['Invalid OTP', 'Invalid OTP'],
        ['The code you entered is incorrect', 'code you entered is incorrect'],
        ['Verification code expired', 'code expired'],
        ['Wrong passcode, try again', 'Wrong passcode'],
        ['Incorrect verification code', 'Incorrect verification code'],
      ],
      noMatch: ['Invalid username or password', 'Enter your code', 'Login successful', 'Employee code saved', 'Dashboard', 'Required'],
    },
  ),
];

/** Patterns the normalizer and the tokenizer use (NM-11, NM-12, NM-13, NM-16, TK-04 to TK-10). */
export const TEXT_PATTERNS: PatternDef[] = [
  def('identifier', 'NM-16', 65, /\b[A-Za-z]{1,10}(?:[-_][A-Za-z0-9]+)*[-_]\d+[A-Za-z0-9_-]*\b/, {
    match: [
      ['Run TC_LOGIN_001 now', 'TC_LOGIN_001'],
      ['employee EMP-0042 exists', 'EMP-0042'],
      ['see TC-01', 'TC-01'],
      ['ticket QA_12', 'QA_12'],
      ['id ORD-2024-0001', 'ORD-2024-0001'],
    ],
    noMatch: ['e-mail', 'sign-in', 'Login page', 'user_name', 'step one'],
  }),
  def('technicalTerm', 'NM-13', 62, /\b(?:data|aria)-[a-z][a-z0-9-]*\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/, {
    match: [
      ['use getByRole here', 'getByRole'],
      ['the data-testid attribute', 'data-testid'],
      ['aria-label of x', 'aria-label'],
      ['call userName()', 'userName'],
      ['an iPhone', 'iPhone'],
    ],
    noMatch: ['Click Login', 'LOGIN', 'plain words only', 'Username', 'e-mail'],
  }),
  def('hiddenChar', 'TK-10', 55, /[\u200B-\u200D\u2060\uFEFF\u00AD]/, {
    match: [
      ['a\u200Bb', '\u200B'],
      ['x\uFEFFy', '\uFEFF'],
      ['soft\u00ADhyphen', '\u00AD'],
      ['\u200Dstart', '\u200D'],
      ['word\u2060joiner', '\u2060'],
    ],
    noMatch: ['plain', 'a b', 'tab\there', 'ünïcode', 'emoji 🙂'],
  }),
  def('mask', 'TK-10', 55, /\*{2,}|•{2,}|●{2,}|#{3,}/, {
    match: [
      ['password ****', '****'],
      ['shows ••••••', '••••••'],
      ['***', '***'],
      ['●●● hidden', '●●●'],
      ['## ### x', '###'],
    ],
    noMatch: ['a * b', 'one star *', 'bullet •', '# heading', 'plain'],
  }),
  def('word', 'TK-01', 10, /[\p{L}\p{N}_]+(?:['-][\p{L}\p{N}_]+)*/u, {
    match: [
      ['Click', 'Click'],
      ['e-mail address', 'e-mail'],
      ["don't", "don't"],
      ['Admin123 now', 'Admin123'],
      ['_private', '_private'],
      ['Ünïcode', 'Ünïcode'],
    ],
    noMatch: ['', '   ', '...', '-- --', '!?'],
  }),
  def(
    'abbreviation',
    'NM-11',
    30,
    /\b(?:pwd|passwd|btn|txt\s?box|ddl|drop\s?down\s+list|chk\s?box|usr\s?name|uname|msg|err|num|req|mand|nav|lbl|img|dob|addr|qty|tel|ph\s?no)\b/i,
    {
      match: [
        ['Enter pwd', 'pwd'],
        ['Click the Login btn', 'btn'],
        ['In the txt box', 'txt box'],
        ['Select from DDL', 'DDL'],
        ['Tick the chkbox', 'chkbox'],
        ['Enter usr name', 'usr name'],
      ],
      noMatch: ['password', 'button', 'text box', 'number', 'dropdown', 'messages'],
    },
  ),
  def('contraction', 'NM-12', 30, /\b(?:can't|won't|shan't|(?:do|does|did|is|are|was|were|have|has|had|could|would|should|must|might|need)n't)\b/i, {
    match: [
      ["It can't be empty", "can't"],
      ["The user doesn't see it", "doesn't"],
      ["shouldn't appear", "shouldn't"],
      ["Login won't work", "won't"],
      ["it isn't shown", "isn't"],
      ["They weren't saved", "weren't"],
    ],
    noMatch: ['cannot', 'does not', "John's page", "it's", "rock 'n' roll", 'no contractions'],
  }),
];

export const BUILTIN_PATTERNS: PatternDef[] = [...VALUE_PATTERNS, ...EXTRACT_PATTERNS, ...AUTH_PATTERNS, ...TEXT_PATTERNS];
