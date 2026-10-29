/**
 * AU-01, AU-02: the login type of an application, and what each type needs. The profile holds no secret: a secret is a
 * name in the credential store (DS-04), so the profile can be saved, shown and exported without exposing one (AU-07).
 */

export const LOGIN_TYPES = ['password', 'email-otp', 'totp', 'fixed-otp', 'sms-otp'] as const;
export type LoginType = (typeof LOGIN_TYPES)[number];

export interface LoginProfile {
  type: LoginType;
  /** Email OTP: the mailbox the code is sent to. */
  mailbox?: {
    /** Which adapter reads it (AU-09). Only `local` exists; a real provider is not chosen yet (PD-5). */
    adapter: string;
    address: string;
    /** Only a mail from a sender that holds this text. */
    sender?: string;
    /** Only a mail whose subject holds this text. */
    subjectContains?: string;
    /** The credential store name of the mailbox password, for a provider that needs one. */
    passwordRef?: string;
  };
  /** Authenticator app: the credential store name of the secret key, and the shape of the code. */
  totp?: { secretRef: string; digits?: number; period?: number; algorithm?: 'SHA1' | 'SHA256' | 'SHA512' };
  /** A fixed test code: the credential store name that holds it. */
  fixed?: { codeRef: string };
  /** How long to wait for a code, in seconds. Default 60 (AU-06). */
  waitSeconds?: number;
}

export const DEFAULT_WAIT_SECONDS = 60;

/** What a login type asks for: the fields that are required, and the optional ones. Nothing else is asked (AU-02). */
export const LOGIN_FIELDS: Record<LoginType, { label: string; required: string[]; optional: string[]; supported: boolean }> = {
  password: { label: 'Username and password', required: [], optional: [], supported: true },
  'email-otp': {
    label: 'Username, password and email code',
    required: ['mailbox.adapter', 'mailbox.address'],
    optional: ['mailbox.sender', 'mailbox.subjectContains', 'mailbox.passwordRef', 'waitSeconds'],
    supported: true,
  },
  totp: {
    label: 'Username, password and authenticator code',
    required: ['totp.secretRef'],
    optional: ['totp.digits', 'totp.period', 'totp.algorithm'],
    supported: true,
  },
  'fixed-otp': { label: 'Username, password and a fixed test code', required: ['fixed.codeRef'], optional: [], supported: true },
  'sms-otp': { label: 'Username, password and SMS code', required: [], optional: [], supported: false },
};

/** The adapters that exist. A provider is added here when the owner confirms which one the target application uses. */
export const MAIL_ADAPTERS: readonly string[] = ['local'];

const read = (profile: LoginProfile, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], profile);

/** What is wrong with a profile, in words, or nothing. The settings screen shows these next to the field. */
export function validateProfile(profile: LoginProfile): string[] {
  const def = LOGIN_FIELDS[profile.type];
  if (!def) return [`"${profile.type}" is not a login type`];
  if (!def.supported) return [`${def.label} is not supported yet`];
  const problems: string[] = [];
  for (const field of def.required) {
    const v = read(profile, field);
    if (v === undefined || v === '') problems.push(`${def.label} needs ${field}`);
  }
  if (profile.type === 'email-otp' && profile.mailbox && !MAIL_ADAPTERS.includes(profile.mailbox.adapter))
    problems.push(`the mail adapter "${profile.mailbox.adapter}" does not exist; there is: ${MAIL_ADAPTERS.join(', ')}`);
  if (profile.type === 'totp' && profile.totp?.digits !== undefined && (profile.totp.digits < 6 || profile.totp.digits > 8))
    problems.push('an authenticator code has 6 to 8 digits');
  if (profile.waitSeconds !== undefined && !(profile.waitSeconds > 0)) problems.push('the wait for a code must be more than zero seconds');
  return problems;
}

/** The login type the application's knowledge names (`authentication.mfa`). */
export const loginTypeOfMfa = (mfa: 'none' | 'totp' | 'email-otp' | 'fixed-otp' | 'sms-otp'): LoginType => (mfa === 'none' ? 'password' : mfa);
