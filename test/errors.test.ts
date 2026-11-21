import { describe, expect, it } from 'vitest';
import { ServiceError, classifyFetchError, classifyHttpStatus } from '../src/core/errors.ts';

describe('ServiceError.message', () => {
    it('produces actionable text naming the service, cause, and target', () => {
        const err = new ServiceError('Unreachable', 'bazarr', 'connection refused at 192.168.1.20:6767');
        expect(err.message).toBe('bazarr unreachable: connection refused at 192.168.1.20:6767');
    });

    it('appends the remedy when one is known', () => {
        const err = new ServiceError('AuthFailed', 'radarr', 'HTTP 401 at /api/v3/system/status', {
            remedy: 'The API key is wrong. Radarr → Settings → General.'
        });
        expect(err.message).toBe(
            'radarr auth failed: HTTP 401 at /api/v3/system/status. The API key is wrong. Radarr → Settings → General.'
        );
    });

    it('never leaks a stack trace into model-facing text', () => {
        const err = new ServiceError('UpstreamError', 'radarr', 'boom');
        expect(err.message).not.toContain('at ');
        expect(err.message).not.toContain(import.meta.url);
    });

    it('preserves the original error as cause for logs without exposing it to the model', () => {
        const original = new Error('socket hang up');
        const err = new ServiceError('Timeout', 'sonarr', 'no response', { cause: original });
        expect(err.cause).toBe(original);
        expect(err.message).not.toContain('socket hang up');
    });

    // The MCP SDK's own catch around a tool handler reads `error.message` and
    // nothing else, so a remedy that lived anywhere else would never reach a
    // caller.
    it('includes the remedy, since .message is what a thrown error is caught as', () => {
        const err = new ServiceError('AuthFailed', 'radarr', 'HTTP 401 at /api/v3/system/status', {
            remedy: 'The API key is wrong. Radarr → Settings → General.'
        });
        expect(err.message).toBe(
            'radarr auth failed: HTTP 401 at /api/v3/system/status. The API key is wrong. Radarr → Settings → General.'
        );
    });

    it('omits the trailing dash when there is no remedy', () => {
        const err = new ServiceError('UpstreamError', 'radarr', 'boom');
        expect(err.message).toBe('radarr upstream error: boom');
    });
});

describe('classifyHttpStatus', () => {
    it.each([
        [401, 'AuthFailed'],
        [403, 'AuthFailed'],
        [404, 'NotFound'],
        [429, 'RateLimited'],
        [500, 'UpstreamError'],
        [502, 'UpstreamError']
    ])('maps HTTP %i to %s', (status, kind) => {
        expect(classifyHttpStatus(status, 'radarr', 'http://h/api')?.kind).toBe(kind);
    });

    it('returns undefined for a success status', () => {
        expect(classifyHttpStatus(200, 'radarr', 'http://h/api')).toBeUndefined();
    });

    it('returns undefined for a 3xx redirect', () => {
        expect(classifyHttpStatus(302, 'radarr', 'http://h/api')).toBeUndefined();
    });

    it('gives a 404 the wrong-base-path remedy, not a generic message', () => {
        expect(classifyHttpStatus(404, 'radarr', 'http://h/api/v3/system/status')?.remedy).toMatch(/base path/i);
    });

    it('gives a 404 on Radarr’s real get-by-id path a missing-item remedy, not the base-path one', () => {
        // The reported bug, live: GET /api/v3/movie/{id} for an id that does
        // not exist. Nothing about the base URL is wrong here. The id is the
        // *last* path segment.
        const remedy = classifyHttpStatus(404, 'radarr', 'http://h/api/v3/movie/999999')?.remedy;
        expect(remedy).not.toMatch(/base path/i);
        expect(remedy).toMatch(/id/i);
    });

    it('gives a 404 on Sonarr’s real get-by-id path the same missing-item remedy', () => {
        const remedy = classifyHttpStatus(404, 'sonarr', 'http://h/api/v3/series/42')?.remedy;
        expect(remedy).not.toMatch(/base path/i);
        expect(remedy).toMatch(/id/i);
    });

    it('gives the missing-item remedy when the id is in the middle of the path, not just the end', () => {
        // Real Jellyfin path used by get_playback (jellyfin.ts):
        // `/Users/${userId}/Items/Resume` — the id sits between two words, and
        // the trailing segment ("Resume") looks exactly like a collection.
        // Classifying on the last segment alone would blame the base URL for
        // what is far more likely a stale or wrong user id.
        const remedy = classifyHttpStatus(
            404,
            'jellyfin',
            'http://h/Users/8a1e21b1a1b04c1b8a1e21b1a1b04c1b/Items/Resume'
        )?.remedy;
        expect(remedy).not.toMatch(/base path/i);
        expect(remedy).toMatch(/id/i);
    });

    it('keeps the base-path remedy for a 404 on a collection endpoint with no id anywhere in the path', () => {
        // GET /api/v3/movie (the collection itself, no id segment at all)
        // 404ing means the base path is wrong — that route always exists.
        // Also exercises a version segment ("v3") staying endpoint-vocabulary
        // rather than being read as an opaque id-shaped token.
        expect(classifyHttpStatus(404, 'radarr', 'http://h/api/v3/movie')?.remedy).toMatch(/base path/i);
    });

    it('keeps the base-path remedy for SABnzbd’s single fixed endpoint', () => {
        // SABnzbd never puts an id in the path — ids travel as query
        // parameters (?name=...) — so a 404 here is unambiguously the base
        // path, and that must not change.
        expect(classifyHttpStatus(404, 'sabnzbd', 'http://h/api')?.remedy).toMatch(/base path/i);
    });

    it('keeps the base-path remedy for Transmission’s single fixed RPC endpoint', () => {
        expect(classifyHttpStatus(404, 'transmission', 'http://h/transmission/rpc')?.remedy).toMatch(/base path/i);
    });

    it('hedges rather than guessing when a path segment is neither an id nor endpoint vocabulary', () => {
        // A hyphenated slug is not a plain word (collection-shaped) and not a
        // number or GUID (id-shaped) — genuinely unclear from the path alone.
        const remedy = classifyHttpStatus(404, 'radarr', 'http://h/api/v3/movie/the-matrix-1999')?.remedy;
        expect(remedy).toMatch(/id/i);
        expect(remedy).toMatch(/base path|url/i);
    });

    it('names the path but not the host in the detail, so keys in query strings cannot leak', () => {
        const err = classifyHttpStatus(401, 'radarr', 'http://h:7878/api/v3/system/status?apikey=secret');
        expect(err?.detail).toContain('/api/v3/system/status');
        expect(err?.detail).not.toContain('secret');
    });
});

describe('classifyFetchError', () => {
    it('maps DNS failure to Unreachable with a DNS remedy', () => {
        const e = Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' });
        const out = classifyFetchError(e, 'radarr', 'http://nope:7878');
        expect(out.kind).toBe('Unreachable');
        expect(out.remedy).toMatch(/hostname/i);
    });

    it('maps connection refused to Unreachable', () => {
        const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Unreachable');
    });

    it('maps an AbortError to Timeout', () => {
        const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Timeout');
    });

    it('maps a TimeoutError to Timeout', () => {
        const e = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Timeout');
    });

    it('maps a firewall-blocked connection to a remedy that names the firewall', () => {
        // Windows reports this as EACCES on connect, which reads like a
        // permission problem and sends people looking in the wrong place.
        const e = Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'EACCES', message: 'connect EACCES 192.168.1.20:7878' }
        });
        const out = classifyFetchError(e, 'radarr', 'http://192.168.1.20:7878');

        expect(out.kind).toBe('Unreachable');
        expect(out.remedy).toMatch(/firewall/i);
    });

    it('maps an unroutable address to Unreachable with a routing remedy', () => {
        const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
        const out = classifyFetchError(e, 'radarr', 'http://10.9.9.9:7878');

        expect(out.kind).toBe('Unreachable');
        expect(out.remedy).toMatch(/not reachable|network/i);
    });

    it('maps a connect timeout to Unreachable, not Timeout, so reads do not retry a dead address', () => {
        const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
        expect(classifyFetchError(e, 'radarr', 'http://10.9.9.9:7878').kind).toBe('Unreachable');
    });

    it('surfaces the underlying cause rather than undici’s opaque "fetch failed"', () => {
        const e = Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ESOMETHINGNEW', message: 'connect ESOMETHINGNEW 192.168.1.20:7878' }
        });
        const out = classifyFetchError(e, 'radarr', 'http://192.168.1.20:7878');

        expect(out.detail).toContain('ESOMETHINGNEW');
        expect(out.detail).not.toBe('fetch failed at 192.168.1.20:7878');
    });

    it('maps a TLS certificate failure to Unreachable with a TLS remedy', () => {
        const e = Object.assign(new Error('self-signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        expect(classifyFetchError(e, 'radarr', 'https://h:7878').remedy).toMatch(/certificate/i);
    });

    it('reads the error code from a nested cause, as undici reports it', () => {
        const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').remedy).toMatch(/listening/i);
    });

    it('falls back to Unreachable for an unrecognised failure without throwing', () => {
        const out = classifyFetchError({ weird: true }, 'radarr', 'http://h:7878');
        expect(out.kind).toBe('Unreachable');
        expect(out.message).toContain('radarr');
    });

    it('keeps credentials and query strings out of the detail', () => {
        const e = new TypeError(
            'Request cannot be constructed from a URL that includes credentials: http://user:s3cret@host:1/api?mode=version&apikey=abc'
        );
        const text = classifyFetchError(e, 'sabnzbd', 'http://host:1').message;
        expect(text).not.toContain('s3cret');
        expect(text).not.toContain('abc');
        expect(text).toContain('includes credentials: http://host:1/...');
    });

    // #20: this scrub kept the path, so a key in it reached a read tool's error.
    it('keeps a key in the path out of the detail', () => {
        const key = 'd41d8cd98f00b204e9800998ecf8427e';
        const e = Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ESOMETHINGNEW', message: `bad response from http://host:1/${key}/api?x=1#frag` }
        });
        const out = classifyFetchError(e, 'sabnzbd', 'http://host:1');
        expect(out.message).not.toContain(key);
        expect(out.detail).toBe('bad response from http://host:1/... at host:1');
    });

    it('cuts every URL down to scheme and host', () => {
        const cases: [string, string][] = [
            ['refused http://user:pw@host:1/key/path?apikey=abc', 'refused http://host:1/...'],
            ['refused https://0123456789abcdef0123.example.org/announce', 'refused https://***.example.org/...'],
            ['refused http://host:1 and http://host:2/.', 'refused http://host:1 and http://host:2/.'],
            ["Failed to parse URL from 'http://host:1/key?apikey=abc'.", "Failed to parse URL from 'http://host:1/..."],
            // Folded to `/` by the parser, but the key is in the text as written.
            ['refused http://host:1/abc/%2e%2e', 'refused http://host:1/...'],
            // A serialiser leaves a backtick raw in a query and in a host, so neither ends the URL.
            ['refused http://host:1/?apikey=ab`cdef', 'refused http://host:1/...'],
            ['refused http://a`b.example/api?apikey=abc', 'refused http://a`b.example/...'],
            [
                'Request cannot be constructed from a URL that includes credentials: http://user:s3cret@a`b.example/api?apikey=abc',
                'Request cannot be constructed from a URL that includes credentials: http://a`b.example/...'
            ],
            ['refused http://user:s3c`ret@example.com/path?apikey=abc', 'refused http://example.com/...'],
            ['refused https://0123456789abcdef0123`x.example/', 'refused https://***`x.example/...'],
            // A long scheme is still a scheme, and digits before its first letter are the sentence's.
            [`refused a${'0'.repeat(40)}://user:pw@host:1/?apikey=abc`, `refused a${'0'.repeat(40)}://host:1/...`],
            ['version 1.5http://host:1/key', 'version 1.5http://host:1/...'],
            // A parser keeps a quote raw in a host, so a quote does not end the URL either.
            ['refused http://a"b.example/key?apikey=abc', 'refused http://a"b.example/...'],
            ['Failed to parse URL from "http://host:1/key?apikey=abc".', 'Failed to parse URL from "http://host:1/...'],
            // A passkey-like run is masked whatever sits beside it in the host.
            ["refused https://0123456789abcdef0123's.example/", "refused https://***'s.example/..."],
            ['refused https://0123456789abcdef0123)y.example/', 'refused https://***)y.example/...'],
            ['refused https://0123456789abcdef0123.', 'refused https://***/...'],
            // Punctuation after a cut URL may end its query, and nothing says where the URL stops, so it goes with it.
            ['includes credentials: http://user:pw@host:1/?password=);,:..', 'includes credentials: http://host:1/...'],
            ['see (http://host:1/?password=);,:..).', 'see (http://host:1/...'],
            ['try (http://host:1/?password=);,:.. first)', 'try (http://host:1/... first)'],
            ['[http://host:1/key]', '[http://host:1/...'],
            ['refused http://[2001:db8::1]/key', 'refused http://[2001:db8::1]/...'],
            // Only normalised, so nothing to cut.
            ['refused HTTP://Host:1/ and http://host:80/', 'refused HTTP://Host:1/ and http://host:80/'],
            ['refused http://[2001:db8::1]', 'refused http://[2001:db8::1]'],
            // Left as written only when the text as written needs nothing masked or dropped.
            ['refused http://0000000000000000000000000001/', 'refused http://0.0.0.1/...'],
            ['refused http://host:1\u001b', 'refused http://host:1/...'],
            // Nothing a URL parser refuses is left whole, and nor is a URL far longer than any address.
            ['refused http://[2001:db8::1/key?apikey=abc', 'refused (a URL, left out)'],
            [`refused http://host:1/${'a'.repeat(3000)}`, 'refused (a URL, left out)'],
            // Not addresses.
            ['a bare https:// here, and ://abc', 'a bare https:// here, and ://abc']
        ];
        for (const [message, expected] of cases) {
            expect(classifyFetchError(new Error(message), 'radarr', 'http://h:7878').detail).toBe(`${expected} at h:7878`);
        }
    });

    it('cuts the URL Node quotes when it refuses one with credentials', () => {
        const refusal = (() => {
            try {
                return new Request('http://user:pw@host.example/?password=);,:..');
            } catch (err) {
                return err;
            }
        })();
        const detail = classifyFetchError(refusal, 'radarr', 'http://h:7878').detail;
        expect(detail).toBe('Request cannot be constructed from a URL that includes credentials: http://host.example/... at h:7878');
    });

    it('reads a long message quickly', () => {
        const started = Date.now();
        for (const message of ['a'.repeat(400_000), `${'a'.repeat(400_000)}://`, 'a://'.repeat(100_000), '0://'.repeat(100_000), 'a:// '.repeat(80_000), `http://h/${"'.".repeat(200_000)}x`]) {
            classifyFetchError(new Error(message), 'radarr', 'http://h:7878');
        }
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('leaves a URL with nothing but scheme and host as it is', () => {
        const out = classifyFetchError(new Error('nothing at http://host:1/'), 'radarr', 'http://host:1');
        expect(out.detail).toBe('nothing at http://host:1/ at host:1');
    });

    it('does not throw when the url is unparseable', () => {
        const e = Object.assign(new Error('nope'), { code: 'ECONNREFUSED' });
        expect(() => classifyFetchError(e, 'radarr', 'not a url')).not.toThrow();
    });
});
