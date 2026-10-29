import type { Clock } from '../engine/auth/mail.js';

/** The real clock, for the waits of a login (the mail that is coming, the next authenticator window). The engine itself has no timer (UI-09). */
export const systemClock: Clock = {
  now: () => Date.now(),
  waitUntil: (at) => new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now()))),
};
