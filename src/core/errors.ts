
export type ServiceErrorKind =
    | 'Unreachable'
    | 'AuthFailed'
    | 'NotFound'
    | 'RateLimited'
    | 'Timeout'
    | 'VersionUnsupported'
    | 'PermissionDenied'
    | 'InvalidRequest'
    | 'UpstreamError';

const PROSE: Record<ServiceErrorKind, string> = {
    Unreachable: 'unreachable',
    AuthFailed: 'auth failed',
    NotFound: 'not found',
    RateLimited: 'rate limited',
    Timeout: 'timed out',
    VersionUnsupported: 'version unsupported',
    // The only kind that is not a fault of the service. It reads as
    // "radarr permission denied: destructive writes are disabled for radarr",
    // which is repetitive but keeps every error one shape, and the service
    // name is what tells the model *whose* config to change.
    PermissionDenied: 'permission denied',
    // Arguments arr-mcp refused before asking the service anything, or a request
    // the target's current state rules out. Not `NotFound`, which would read as
    // if the instance itself were missing.
    InvalidRequest: 'invalid request',
    UpstreamError: 'upstream error'
};

function formatServiceError(kind: ServiceErrorKind, service: string, detail: string, remedy?: string): string {
    const base = `${service} ${PROSE[kind]}: ${detail}`;
    return remedy ? `${base.replace(/\.$/, '')}. ${remedy}` : base;
}

/**
 * A model told *why* something failed reports it; a model handed an opaque
 * error invents an explanation. The remedy therefore lives
 * in `.message` itself: every path that throws
 * this error is caught somewhere as a plain `Error`, and the only field a
 * generic catcher reads is `.message`, including the MCP SDK's own tool
 * dispatch loop, which builds its error result from `error.message` alone.
 * `.message` never includes a stack trace, and never the underlying cause,
 * which stays available for logs via `.cause`.
 */
export class ServiceError extends Error {
    readonly kind: ServiceErrorKind;
    readonly service: string;
    readonly detail: string;
    readonly remedy: string | undefined;
    /** Set by IdentityResolver when no configured or named user exists, so
     *  that refusal is not mistaken for an HTTP 404 from the user listing. */
    readonly reason: 'unknown_user' | undefined;
    /** The HTTP status the service answered with, when that is what failed. */
    readonly status: number | undefined;

    constructor(
        kind: ServiceErrorKind,
        service: string,
        detail: string,
        opts?: { remedy?: string; cause?: unknown; reason?: 'unknown_user'; status?: number }
    ) {
        super(
            formatServiceError(kind, service, detail, opts?.remedy),
            opts?.cause !== undefined ? { cause: opts.cause } : undefined
        );
        this.name = 'ServiceError';
        this.kind = kind;
        this.service = service;
        this.detail = detail;
        this.remedy = opts?.remedy;
        this.reason = opts?.reason;
        this.status = opts?.status;
    }
}

const OUTAGE_KINDS: ReadonlySet<ServiceErrorKind> = new Set(['Unreachable', 'Timeout', 'RateLimited', 'UpstreamError']);

/**
 * A service that did not answer, as opposed to one that refused or a config
 * that names nobody. A read degrades on the first; the second reaches the
 * caller as an error, since retrying a refusal changes nothing.
 */
export const isOutage = (err: unknown): boolean => err instanceof ServiceError && OUTAGE_KINDS.has(err.kind);

/** Origin only: a redirect target's path or query can carry anything. */
export function redirectedElsewhere(service: string, origin: string): ServiceError {
    return new ServiceError('UpstreamError', service, `redirected to another host (${origin})`, {
        remedy: 'Set its url in the config to the address it redirects to.'
    });
}

/** Extracts the path alone, so an api key in a query string cannot leak. */
function safePath(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

function safeHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

const SCHEME_CHAR = /[a-z0-9+.-]/i;
/** What ends a URL in a message: whitespace, `<` and `>`, which a parser takes
 *  nowhere raw. Not a quote or a backtick: a URL serialiser leaves those raw in a
 *  host or a query, and stopping there would keep the rest. */
const URL_END = /[\s<>]/;
/** Punctuation that can close a sentence or a quotation around a URL. */
const URL_TRAILING = new Set(['.', ',', ';', ':', ')', ']', "'", '"', '`']);
/** The closer each character before a URL pairs with, when the URL is quoted or bracketed. */
const CLOSER: Readonly<Record<string, string>> = { "'": "'", '"': '"', '`': '`', '(': ')', '[': ']' };
/** A scheme and an authority with nothing after them but one slash, judged as written. */
const BARE_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\@]*\/?$/i;
/** A run of hex, or of letters and digits, long enough to be a passkey rather than a name. */
const PASSKEY_RUN = /^(?:[0-9a-f]{16,}|[0-9a-z]{28,})$/;
/** Far past any address a service is configured with. A parser's time grows faster than its input. */
const MAX_URL_LENGTH = 2048;

/**
 * Cuts every URL in a transport error's message down to its scheme and host.
 * Node quotes the full URL when it refuses one, and a key can sit in its
 * userinfo, its path or its query. One pass from each `://`: back over the
 * scheme, forward to the end of the URL. Each character is read a bounded
 * number of times, however the message is built.
 */
function scrubUrls(text: string): string {
    let out = '';
    let copied = 0;
    const separator = /:\/\//g;
    for (let found = separator.exec(text); found !== null; found = separator.exec(text)) {
        let start = found.index;
        while (start > copied && SCHEME_CHAR.test(text[start - 1] ?? '')) start -= 1;
        // A scheme starts with a letter; digits before the first one belong to the sentence.
        while (start < found.index && !/[a-z]/i.test(text[start] ?? '')) start += 1;
        if (start === found.index) continue;
        let end = found.index + 3;
        let opens = 0;
        let closes = 0;
        for (; end < text.length && !URL_END.test(text[end] ?? ''); end += 1) {
            if (text[end] === '[') opens += 1;
            else if (text[end] === ']') closes += 1;
        }
        // Walked back off the end. A `]` that closes an IPv6 host is the URL's own,
        // so one is taken off only while there are more of them than `[`.
        let cut = end;
        while (cut > found.index + 3 && URL_TRAILING.has(text[cut - 1] ?? '')) {
            if (text[cut - 1] === ']') {
                if (closes <= opens) break;
                closes -= 1;
            }
            cut -= 1;
        }
        // A scheme with nothing after it names no address.
        if (cut === found.index + 3) continue;
        const kept = hostOnly(text.slice(start, cut));
        out += text.slice(copied, start);
        if (kept === undefined) {
            out += text.slice(start, end);
        } else {
            // Punctuation after a cut URL may be the end of its query. Only the closer
            // of a quotation or bracket opened before the URL, and what follows it,
            // is the sentence's; the placeholder's dots stand in for a full stop.
            const closer = CLOSER[text[start - 1] ?? ''];
            const tail = text.slice(cut, end);
            const at = closer === undefined ? -1 : tail.lastIndexOf(closer);
            out += kept + (at === -1 ? '' : tail.slice(at));
        }
        copied = end;
        separator.lastIndex = end;
    }
    return out + text.slice(copied);
}

/**
 * One URL as its scheme and host, with any run in the host that looks like a
 * passkey masked, or `undefined` when it is already no more than that.
 */
function hostOnly(raw: string): string | undefined {
    const url = raw.length > MAX_URL_LENGTH ? null : URL.parse(raw);
    if (url === null) return '(a URL, left out)';
    // Runs, not labels: a parser keeps a quote, a bracket or a backtick in a host, so a passkey can sit beside one.
    const host = url.hostname.toLowerCase().replace(/[0-9a-z]+/g, run => (PASSKEY_RUN.test(run) ? '***' : run));
    // Judged on the text as written: the parser folds a path such as `/key/%2e%2e` down to `/`.
    if (BARE_URL.test(raw) && host === url.hostname.toLowerCase()) return undefined;
    return `${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}/...`;
}

/** A plain endpoint-vocabulary word, or a REST version segment such as `v3`. */
const WORD_SEGMENT = /^([A-Za-z]+|v\d+)$/i;

/**
 * An integer id, or a GUID; hyphenated or not (Jellyfin's are 32 raw hex
 * characters, no hyphens). Requiring a digit alongside the hex letters keeps
 * an incidental all-letter word that happens to be hex-shaped (`face`,
 * `cafe`, `dead`) from being misread as an id.
 */
const ID_SEGMENT = /^(\d+|(?=[0-9a-f-]*\d)[0-9a-f]{4,}(-[0-9a-f]{4,})*)$/i;

/**
 * The only signal a 404 carries about *why* is the path it was for. Every
 * real by-id endpoint in this codebase (Radarr `/api/v3/movie/{id}`, Sonarr
 * `/api/v3/series/{id}`, and, critically, Jellyfin's
 * `/Users/{userId}/Items/Resume`, where the id sits mid-path, not last) has
 * an id-shaped segment *somewhere*; a collection or status endpoint
 * (`/api/v3/movie`, `/api/v3/system/status`) is made entirely of
 * endpoint-vocabulary words. Position must not matter (classifying only the
 * last segment is exactly what missed the Jellyfin case) so every segment is
 * inspected, and an id anywhere outweighs the rest of the path being
 * word-shaped. A segment that is neither a recognisable word nor a
 * recognisable id (a hash, a slug) makes the path genuinely ambiguous, so it
 * gets a remedy that says so instead of confidently guessing one cause.
 */
function classifyNotFoundPath(pathname: string): 'item' | 'collection' | 'ambiguous' {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return 'collection';
    if (segments.some(s => ID_SEGMENT.test(s))) return 'item';
    if (segments.every(s => WORD_SEGMENT.test(s))) return 'collection';
    return 'ambiguous';
}

const NOT_FOUND_REMEDY: Record<ReturnType<typeof classifyNotFoundPath>, string> = {
    item: 'This id does not exist at that service. Verify it (e.g. via search) rather than guessing, before assuming the base URL is wrong.',
    collection: 'Wrong base path. Check the URL does not include a trailing path or reverse-proxy prefix.',
    ambiguous:
        'Could not tell from the URL alone whether this is a missing id or a wrong base path. Verify the id is correct, and separately that the URL has no trailing path or reverse-proxy prefix.'
};

export const API_KEY_REMEDY = 'The API key is wrong. Check the service’s Settings → General page.';

/** `authRemedy` is what to say about a 401 or 403: the API key text fits only a service that takes one. */
export function classifyHttpStatus(
    status: number,
    service: string,
    url: string,
    authRemedy: string = API_KEY_REMEDY
): ServiceError | undefined {
    if (status < 400) return undefined;
    const pathname = safePath(url);
    const at = `HTTP ${status} at ${pathname}`;

    if (status === 401 || status === 403) {
        return new ServiceError('AuthFailed', service, at, { remedy: authRemedy, status });
    }
    if (status === 404) {
        return new ServiceError('NotFound', service, at, {
            remedy: NOT_FOUND_REMEDY[classifyNotFoundPath(pathname)],
            status
        });
    }
    if (status === 429) {
        return new ServiceError('RateLimited', service, at, { status });
    }
    return new ServiceError('UpstreamError', service, at, { status });
}

const TLS_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export function classifyFetchError(err: unknown, service: string, url: string): ServiceError {
    const e = (err ?? {}) as {
        name?: string;
        code?: string;
        message?: string;
        cause?: { code?: string; message?: string };
    };
    // undici wraps the OS-level failure one level down as `cause`.
    const code = e.code ?? e.cause?.code;
    const host = safeHost(url);

    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        return new ServiceError('Timeout', service, `no response from ${host} within the configured timeout`, {
            cause: err
        });
    }
    if (code !== undefined && TLS_CODES.has(code)) {
        return new ServiceError('Unreachable', service, `TLS error (${code}) at ${host}`, {
            remedy:
                'The TLS certificate could not be verified. Use http:// on the LAN, or install a trusted certificate.',
            cause: err
        });
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new ServiceError('Unreachable', service, `DNS lookup failed for ${host}`, {
            remedy: 'The hostname does not resolve. Use an IP address, or check your DNS.',
            cause: err
        });
    }
    if (code === 'ECONNREFUSED') {
        return new ServiceError('Unreachable', service, `connection refused at ${host}`, {
            remedy: 'Nothing is listening on that port. Check the service is running and the port is right.',
            cause: err
        });
    }
    // Windows reports a firewall-blocked outbound connection as EACCES on
    // connect, which reads nothing like a permission problem to the user.
    if (code === 'EACCES' || code === 'EPERM') {
        return new ServiceError('Unreachable', service, `connection blocked at ${host}`, {
            remedy: 'Something refused to let the connection out, usually a local firewall. Check the host can reach that address and port.',
            cause: err
        });
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        return new ServiceError('Unreachable', service, `no route to ${host}`, {
            remedy: 'That address is not reachable from this machine. Check the IP is right and on a network this host can see.',
            cause: err
        });
    }
    if (code === 'ETIMEDOUT') {
        // Deliberately Unreachable rather than Timeout: Timeout makes reads
        // retry once, and a connect that timed out against a dead address will
        // simply time out again, doubling the wait for no new information.
        return new ServiceError('Unreachable', service, `connection to ${host} timed out`, {
            remedy: 'Nothing answered at that address. Check the IP and port, and that a firewall is not dropping the packets.',
            cause: err
        });
    }

    // undici's own message is always the useless "fetch failed"; the cause
    // carries the one that says what actually happened. Node quotes the full URL
    // when it refuses one with userinfo, and a key can sit in its userinfo, path
    // or query, so every URL is cut to scheme and host, as write tools cut theirs.
    const detail = scrubUrls(e.cause?.message ?? e.message ?? 'unknown error');
    return new ServiceError('Unreachable', service, `${detail} at ${host}`, { cause: err });
}
