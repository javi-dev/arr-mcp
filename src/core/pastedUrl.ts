/**
 * The start of a URL: any scheme followed by `://`, and, for the schemes a URL
 * parser treats specially (http, https, ws, wss, ftp), any run of slashes and
 * backslashes it reads the same way, or none, so `https:\\host\\key`,
 * `https:/host/key` and `https:host/key` all parse as `https://host/key`. A
 * parser drops tabs and line breaks, so they may sit among those separators
 * too. `scrubUrls` then asks one of those spellings for more before it counts
 * it, since `HTTP:404` or a file named `FTP:Archive.mkv` is text.
 */
// The scheme is bounded so a long run of letters cannot make the match quadratic.
const URL_START = String.raw`(?:\b(?:https?|wss?|ftp):[\\/\t\r\n]*|[a-z][a-z0-9+.-]{0,31}:\/\/)`;

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

// An apostrophe is a legal part of a URL path, so it does not end one.
const MAGNET_IN_TEXT = /magnet:\?[^\s"<>`]+/gi;
// A parser drops tabs and line breaks inside a URL, so they do not end one when
// the URL plainly goes on: a tab before more of it, or a line break before a
// character that continues a path or query. A line break before a word is the
// end of a line of text, and the next line is left alone.
const URL_IN_TEXT = new RegExp(String.raw`${URL_START}(?:[^\s"<>\x60]|\t+(?=[^\s"<>\x60])|[\r\n]+(?=[\/?#&=%\\]))+`, 'gi');
/** The plain `scheme://` spelling, as opposed to one only a special scheme allows. */
const PLAIN_START = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;
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
        // Walked back from the end, so a long run of punctuation costs one pass.
        let cut = match.length;
        while (cut > 0 && TRAILING.has(match[cut - 1] ?? '')) cut -= 1;
        const tail = match.slice(cut);
        const raw = match.slice(0, cut);
        if (!PLAIN_START.test(raw)) {
            // A spelling only a special scheme allows counts when a parser reads
            // it as a URL, its host as written has a dot, and something follows
            // the host or precedes it (a path, a query, a fragment or userinfo).
            // Text such as `HTTP:404`, `https:strict` or `FTP:Archive.mkv` has
            // none of that and stays as it is.
            const rest = raw.slice(raw.indexOf(':') + 1);
            const host = rest.replace(/^[\\/\t\r\n]+/, '').split(/[\\/?#]/)[0] ?? '';
            const more = /[\\/?#@]/.test(rest.replace(/^[\\/\t\r\n]+/, '')) || maskedHost(host) !== host.toLowerCase();
            if (!URL.canParse(raw) || !host.includes('.') || !more) return match;
        }
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
