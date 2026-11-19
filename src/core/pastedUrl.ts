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
/** Characters a sentence can end on that a URL rarely does. */
const TRAILING = new Set(['.', ',', ';', ':', ')', ']', "'"]);
/** A scheme and an authority with nothing after them but one slash. */
const BARE_URL = /^[a-z][a-z0-9+.-]{0,31}:\/\/[^/?#\\]*\/?$/i;

/**
 * Free text with every URL cut down to its scheme and host, and every magnet
 * link removed. A tracker URL keeps its passkey in the path, the query or the
 * userinfo, so those never reach the audit log, whichever field of whichever
 * tool the URL was pasted into.
 */
export function scrubUrls(text: string): string {
    return text.replace(MAGNET_IN_TEXT, '(a magnet link, left out)').replace(URL_IN_TEXT, match => {
        // Walked back from the end: a regex for the tail retries from every point
        // of a long run of punctuation, and this runs on whatever a caller sends.
        let cut = match.length;
        while (cut > 0 && TRAILING.has(match[cut - 1] ?? '')) cut -= 1;
        const tail = match.slice(cut);
        const raw = match.slice(0, cut);
        if (!URL.canParse(raw)) return `(a URL, left out)${tail}`;
        const url = new URL(raw);
        // Judged on the text as written, not the parsed URL: the parser folds a
        // path such as `/key/%2e%2e` down to `/`, which would pass a key through.
        const bare = BARE_URL.test(raw) && url.username === '' && url.password === '';
        if (bare && maskedHost(url.hostname) === url.hostname) return match;
        // The placeholder already ends in dots, so a sentence's own are not added to them.
        return `${url.protocol}//${maskedHost(url.hostname)}${url.port === '' ? '' : `:${url.port}`}/...${tail.replace(/^\.+/, '')}`;
    });
}
