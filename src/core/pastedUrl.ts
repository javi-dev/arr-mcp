/**
 * The start of a URL. Any scheme followed by `://`, and for the schemes a URL
 * parser treats specially, any spelling it accepts: one slash, backslashes in
 * place of slashes, or none at all (`https:\\host\\key` and `https:host/key`
 * both parse as `https://host/...`).
 */
// The scheme is bounded so a long run of letters cannot make the match quadratic.
const URL_START = String.raw`(?:\b(?:https?|wss?|ftp):|[a-z][a-z0-9+.-]{0,31}:\/\/)`;

/** A URL or magnet where a name or id belongs, which can carry a tracker passkey. */
const PASTED_URL = new RegExp(String.raw`${URL_START}[^\s"<>\x60]|magnet:\?`, 'i');

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
const URL_IN_TEXT = new RegExp(String.raw`${URL_START}[^\s"<>\x60]+`, 'gi');
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
        const tail = /[.,;:)\]']+$/.exec(match)?.[0] ?? '';
        const raw = match.slice(0, match.length - tail.length);
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
