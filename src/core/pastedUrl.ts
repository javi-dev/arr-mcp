/** A URL or magnet where a name or id belongs, which can carry a tracker passkey. */
// The scheme is bounded so a long run of letters cannot make the match quadratic.
const PASTED_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/|magnet:\?/i;

/** The value as a refusal or an audit row may repeat it. */
export const shownValue = (value: string): string => (PASTED_URL.test(value) ? '(a URL, left out)' : value);

/** A long run of hex, or of letters and digits, is a passkey rather than a host name. */
const PASSKEY_LABEL = /^(?:[0-9a-f]{16,}|[0-9a-z]{28,})$/i;

/** A hostname with any label that looks like a passkey masked. A parser keeps a
 *  backtick in a host, so each side of one is judged as a label of its own. */
export const maskedHost = (hostname: string): string =>
    hostname
        .toLowerCase()
        .split('.')
        .map(label => label.split('`').map(piece => (PASSKEY_LABEL.test(piece) ? '***' : piece)).join('`'))
        .join('.');

/**
 * Where a link starts: a magnet link, or a scheme and `://`. The scheme may
 * start with a digit here, so a scheme longer than the bound is still caught by
 * its last characters; the part before its first letter is kept as text.
 */
const LINK_START = /magnet:\?|[a-z0-9+.-]{1,32}:\/\//gi;
// An apostrophe is a legal part of a URL, so it does not end one, and nor does
// a backtick: a URL serialiser leaves one raw in a host and in a query, so
// stopping there would keep the rest. The exception is a link that opens a code
// span, which ends where the span closes, so the next span is not swallowed.
const LINK_BODY = /[^\s"<>]*/y;
const SPAN_BODY = /[^\s"<>`]*/y;
/** Characters a sentence or a code span can end on that a URL rarely does. */
const TRAILING = new Set(['.', ',', ';', ':', ')', ']', "'", '`']);
/** A scheme and an authority with nothing after them but one slash. */
const BARE_URL = /^[a-z][a-z0-9+.-]{0,31}:\/\/[^/?#\\]*\/?$/i;

/**
 * A match split into the link and the punctuation after it that belongs to the
 * sentence. Walked back from the end: a regex for the tail retries from every
 * point of a long run of punctuation, and this runs on whatever a caller sends.
 * A `]` that closes an IPv6 host (`http://[2001:db8::1]`) is the URL's own, so
 * one is taken off only while there are more of them than `[`.
 */
function splitTail(match: string): { raw: string; tail: string } {
    let opens = 0;
    let closes = 0;
    for (const char of match) {
        if (char === '[') opens += 1;
        else if (char === ']') closes += 1;
    }
    let cut = match.length;
    while (cut > 0 && TRAILING.has(match[cut - 1] ?? '')) {
        if (match[cut - 1] === ']') {
            if (closes <= opens) break;
            closes -= 1;
        }
        cut -= 1;
    }
    return { raw: match.slice(0, cut), tail: match.slice(cut) };
}

/**
 * Free text with every URL cut down to its scheme and host, and every magnet
 * link removed. A tracker URL keeps its passkey in the path, the query or the
 * userinfo, so those never reach the audit log, whichever field of whichever
 * tool the URL was pasted into.
 */
export function scrubUrls(text: string): string {
    let out = '';
    let copied = 0;
    LINK_START.lastIndex = 0;
    // One pass, each character read a bounded number of times: this runs on whatever a caller sends.
    for (let start = LINK_START.exec(text); start !== null; start = LINK_START.exec(text)) {
        const inSpan = text[start.index - 1] === '`';
        const body = inSpan ? SPAN_BODY : LINK_BODY;
        body.lastIndex = LINK_START.lastIndex;
        let end = body.lastIndex + (body.exec(text)?.[0].length ?? 0);
        // A scheme with nothing after it names no address.
        if (end === LINK_START.lastIndex) continue;
        // The closing backtick goes with the link, so it is kept as the link's tail.
        if (inSpan && text[end] === '`') end += 1;
        const match = text.slice(start.index, end);
        out += text.slice(copied, start.index) + (/^magnet/i.test(match) ? `(a magnet link, left out)${splitTail(match).tail}` : cutUrl(match));
        copied = end;
        LINK_START.lastIndex = end;
    }
    return out + text.slice(copied);
}

/** One URL as found in text, cut down to its scheme and host. */
function cutUrl(match: string): string {
    const { raw: whole, tail } = splitTail(match);
    // Scheme characters before its first letter: the end of a longer word, or of a scheme past the bound.
    const lead = /^[0-9+.-]*/.exec(whole)?.[0] ?? '';
    const raw = whole.slice(lead.length);
    if (raw.endsWith('://')) return match;
    if (!URL.canParse(raw)) return `${lead}(a URL, left out)${tail}`;
    const url = new URL(raw);
    // Judged on the text as written, not the parsed URL: the parser folds a
    // path such as `/key/%2e%2e` down to `/`, which would pass a key through.
    const bare = BARE_URL.test(raw) && url.username === '' && url.password === '';
    // maskedHost lowercases, and a parser keeps the case of a host for a scheme it does not know (`smb://NAS`).
    if (bare && maskedHost(url.hostname) === url.hostname.toLowerCase()) return match;
    // The placeholder already ends in dots, so a sentence's own are not added to them.
    return `${lead}${url.protocol}//${maskedHost(url.hostname)}${url.port === '' ? '' : `:${url.port}`}/...${tail.replace(/^\.+/, '')}`;
}
