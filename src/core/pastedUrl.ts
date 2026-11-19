/**
 * The start of a URL: any scheme followed by `://`, and, for the schemes a URL
 * parser treats specially (http, https, ws, wss, ftp), any run of slashes and
 * backslashes it reads the same way, or none, so `https:\\host\\key`,
 * `https:/host/key` and `https:host/key` all parse as `https://host/key`.
 * `scrubUrls` then asks one of those spellings for more before it counts it,
 * since `HTTP:404` or a file named `FTP:Archive.mkv` is text.
 *
 * The run of separators is taken whole (`(?=(...))\1` cannot give any back), so
 * a long run that leads nowhere is one pass rather than a split tried at every
 * point. It is the first capture group of every pattern built from this.
 */
// The scheme is bounded so a long run of letters cannot make the match quadratic.
const URL_START = String.raw`(?:\b(?:https?|wss?|ftp):(?=([\\/]*))\1|[a-z][a-z0-9+.-]{0,31}:\/\/)`;

/** The plain `scheme://` form, which always counts as a URL where a name belongs. */
const PASTED_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/|magnet:\?/i;

/**
 * The value as a refusal or an audit row may repeat it: left out whole when it
 * is a URL, in the plain form or in one the scrub would cut down.
 */
export const shownValue = (value: string): string => (PASTED_URL.test(value) || scrubUrls(value) !== value ? '(a URL, left out)' : value);

/** A long run of hex, or of letters and digits, is a passkey rather than a host name. */
const PASSKEY_LABEL = /^(?:[0-9a-f]{16,}|[0-9a-z]{28,})$/i;

/** A hostname with any label that looks like a passkey masked. */
export const maskedHost = (hostname: string): string =>
    hostname
        .toLowerCase()
        .split('.')
        .map(label => (PASSKEY_LABEL.test(label) ? '***' : label))
        .join('.');

/**
 * What carries a URL or magnet on. A parser drops tabs and line breaks inside
 * one, so they do not end it when it plainly goes on: a tab before more of it,
 * or a line break before a character that continues a query. A line break
 * before anything else ends a line of text, and the next line is left alone.
 * Each run of tabs or line breaks is tried once from where it starts, so a long
 * run that leads nowhere costs one pass.
 */
// An apostrophe is a legal part of a URL path, so it does not end one.
const URL_BODY = String.raw`(?:[^\s"<>\x60]|\t+(?=[^\s"<>\x60])|[\r\n]+(?=[?&=%]))+`;
const MAGNET_IN_TEXT = new RegExp(String.raw`magnet:\?${URL_BODY}`, 'gi');
const URL_IN_TEXT = new RegExp(`${URL_START}${URL_BODY}`, 'gi');
/** The plain `scheme://` spelling, as opposed to one only a special scheme allows. */
const PLAIN_START = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;
/** Characters a sentence can end on that a URL rarely does. */
const TRAILING = new Set(['.', ',', ';', ':', ')', ']', "'"]);
/** A scheme and an authority with nothing after them but one slash. */
const BARE_URL = /^[a-z][a-z0-9+.-]{0,31}:\/\/[^/?#\\]*\/?$/i;

/**
 * Whether a spelling only a special scheme allows is a URL worth cutting down.
 * It counts when a parser reads it as one with the very host it was written
 * with (so `https:1.2/docs` is not read as the address 1.0.0.2), that host has
 * a dot, and a path, a query or a user name goes with it, or the host has a
 * passkey-like label. Text such as `HTTP:404`, `https:strict` or a file named
 * `FTP:Archive.mkv#1` has none of that and stays as it is.
 */
function looseUrl(raw: string): boolean {
    if (!URL.canParse(raw)) return false;
    const after = raw.slice(raw.indexOf(':') + 1).replace(/^[\\/]+/, '');
    const authority = after.split(/[\\/?#]/)[0] ?? '';
    const written = authority
        .slice(authority.lastIndexOf('@') + 1)
        .replace(/:\d*$/, '')
        .replace(/\.$/, '')
        .toLowerCase();
    const { hostname } = new URL(raw);
    if (hostname.replace(/\.$/, '') !== written || !written.includes('.')) return false;
    return /[\\/?@]/.test(after) || maskedHost(hostname) !== hostname;
}

/**
 * Free text with every URL cut down to its scheme and host, and every magnet
 * link removed. A tracker URL keeps its passkey in the path, the query or the
 * userinfo, so those never reach the audit log, whichever field of whichever
 * tool the URL was pasted into.
 */
export function scrubUrls(text: string): string {
    return text.replace(MAGNET_IN_TEXT, '(a magnet link, left out)').replace(URL_IN_TEXT, match => {
        // Walked back from the end, so a long run of punctuation costs one pass.
        let cut = match.length;
        while (cut > 0 && TRAILING.has(match[cut - 1] ?? '')) cut -= 1;
        const tail = match.slice(cut);
        const raw = match.slice(0, cut);
        if (!PLAIN_START.test(raw) && !looseUrl(raw)) return match;
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
