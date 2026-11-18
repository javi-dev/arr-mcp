/** A URL or magnet where a name or id belongs, which can carry a tracker passkey. */
const PASTED_URL = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|magnet:)/i;

/** The value as a refusal or an audit row may repeat it. */
export const shownValue = (value: string): string => (PASTED_URL.test(value) ? '(a URL, left out)' : value);
