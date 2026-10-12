import { z } from 'zod';

/**
 * Layers 20 and 21, the application and page knowledge bases (AK-01, PK-01). What the engine knows about one
 * application, written down by people and learned from runs: its pages and routes, the forms, fields, buttons and
 * messages on each, the names people use for them, its business rules, how to get from one page to another, how to log
 * in, and its own words (an Employee, a Supervisor: PD-3). It is data, not code: it is stored as a file, edited, and
 * versioned, so a result can always be traced to the knowledge it was made with.
 */

export const MESSAGE_KINDS = ['error', 'validation', 'success', 'info', 'warning'] as const;

/** One thing on a page: a field, a button, a link, a table. Its names are the ones people use; the page is where it is. */
export const ComponentSchema = z.object({
  /** The name the application itself shows: the one every other name resolves to. */
  name: z.string().min(1),
  /** Other names people write for it: "login name", "user id", "username field". */
  aliases: z.array(z.string()).default([]),
  /** The class of the QA ontology (ON-01), or an application class from \`vocabulary\`. */
  ontology: z.string().default('Element'),
  testId: z.string().optional(),
  role: z.string().optional(),
  /** Where to find it when nothing else can (LC-01, XPath level). */
  xpath: z.string().optional(),
  /** The form it belongs to. */
  form: z.string().optional(),
  /** Seen on the page when the page is the right one: it identifies the page (PK-01). */
  key: z.boolean().default(false),
  notes: z.string().optional(),
});
export type Component = z.infer<typeof ComponentSchema>;

export const MessageSchema = z.object({
  name: z.string().min(1),
  /** The words of the message, or the part that never changes. */
  text: z.string().min(1),
  kind: z.enum(MESSAGE_KINDS),
});
export type KnownMessage = z.infer<typeof MessageSchema>;

export const PageSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  /** The path of the page, from the base URL: `/pim/addEmployee`. */
  route: z.string().optional(),
  sections: z.array(z.string()).default([]),
  forms: z.array(z.string()).default([]),
  components: z.array(ComponentSchema).default([]),
  /** Filters that change what the page shows ("status", "date range"). */
  filters: z.array(z.string()).default([]),
  messages: z.array(MessageSchema).default([]),
  /** The lifecycle states the page can be in (ST-01): `LOGIN_PAGE`, `DASHBOARD`. */
  expectedStates: z.array(z.string()).default([]),
});
export type Page = z.infer<typeof PageSchema>;

export const ApplicationSchema = z.object({
  /** Written by the store: 1 for the first save, one more for each save after it. */
  version: z.number().int().positive().default(1),
  name: z.string().min(1),
  baseUrl: z.string().optional(),
  pages: z.array(PageSchema).default([]),
  roles: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
  rules: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).default([]),
  /** How to get from one page to the next, and by what. */
  navigation: z.array(z.object({ from: z.string(), to: z.string(), via: z.string() })).default([]),
  authentication: z
    .object({
      loginPage: z.string().optional(),
      usernameField: z.string().optional(),
      passwordField: z.string().optional(),
      loginButton: z.string().optional(),
      successPage: z.string().optional(),
      mfa: z.enum(['none', 'totp', 'email-otp']).default('none'),
    })
    .default({ mfa: 'none' }),
  /**
   * The application's own words (PD-3). "Employee" and "Supervisor" belong to one application; they are not in the core
   * ontology, and they mean nothing to another application's knowledge.
   */
  vocabulary: z.array(z.object({ term: z.string().min(1), ontology: z.string().min(1), aliases: z.array(z.string()).default([]) })).default([]),
});
export type Application = z.infer<typeof ApplicationSchema>;
