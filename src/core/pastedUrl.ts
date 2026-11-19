/** A URL or magnet where a name or id belongs, which can carry a tracker passkey. */
// The scheme is bounded so a long run of letters cannot make the match quadratic.
const PASTED_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/|magnet:\?/i;

/** The value as a refusal or an audit row may repeat it. */
export const shownValue = (value: string): string => (PASTED_URL.test(value) ? '(a URL, left out)' : value);

/** A long run of hex, or of letters and digits, is a passkey rather than a host name. */
const PASSKEY_LABEL = /^(?:[0-9a-f]{16,}|[0-9a-z]{28,})$/i;

/** A hostname with any label that looks like a passkey masked. */
export const maskedHost = (hostname: string): string =>
    hostname
        .toLowerCase()
        .split('.')
        .map(label => (PASSKEY_LABEL.test(label) ? '***' : label))
        .join('.');

// An apostrophe is a legal part of a URL path, so it does not end one.
const MAGNET_IN_TEXT = /magnet:\?[^\s"<>`]+/gi;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"<>`]+/gi;

/**
 * Free text with every URL cut down to its scheme and host, and every magnet
 * link removed. A tracker URL keeps its passkey in the path, the query or the
 * userinfo, so those never reach the audit log, whichever field of whichever
 * tool the URL was pasted into.
 */
export function scrubUrls(text: string): string {
    return text.replace(MAGNET_IN_TEXT, '(a magnet link, left out)').replace(URL_IN_TEXT, match => {
        const tail = /[.,;:)\]']+$/.exec(match)?.[0] ?? '';
        const raw = match.slice(0, match.length - tail.length);
        if (!URL.canParse(raw)) return `(a URL, left out)${tail}`;
        const url = new URL(raw);
        const bare = (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
        if (bare && maskedHost(url.hostname) === url.hostname) return match;
        return `${url.protocol}//${maskedHost(url.hostname)}${url.port === '' ? '' : `:${url.port}`}/...${tail}`;
    });
}
