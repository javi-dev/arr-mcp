import { describe, expect, it } from 'vitest';
import { WriteAudit } from '../src/core/audit.ts';
import { scrubUrls, shownValue } from '../src/core/pastedUrl.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { selectAdapters } from '../src/tools/instanceOptions.ts';

const PASSKEY = 'd41d8cd98f00b204e9800998ecf8427e';

describe('shownValue', () => {
    it.each([
        `https://tracker.example/${PASSKEY}/announce`,
        ` https://tracker.example/${PASSKEY}/announce`,
        `<https://tracker.example/${PASSKEY}/announce>`,
        `udp://tracker.example:80/${PASSKEY}`,
        `magnet:?xt=urn:btih:abc&tr=${PASSKEY}`
    ])('leaves out %s', value => {
        expect(shownValue(value)).not.toContain(PASSKEY);
    });

    it.each(['radarr/4k', 'vpn', 'torrent-direct', 'Alien: Covenant', '42'])('repeats the ordinary value %s', value => {
        expect(shownValue(value)).toBe(value);
    });
});

describe('selectAdapters', () => {
    it('does not repeat a tracker URL passed as an instance', () => {
        const adapters = [{ id: 'radarr', type: 'radarr' }] as unknown as ServiceAdapter[];
        expect(() => selectAdapters(adapters, { instance: `https://tracker.example/${PASSKEY}/announce` })).toThrow(/left out/);
        expect(() => selectAdapters(adapters, { instance: `https://tracker.example/${PASSKEY}/announce` })).not.toThrow(PASSKEY);
    });
});

describe('scrubUrls', () => {
    it.each([
        [`no category "https://tracker.example/${PASSKEY}/announce".`, 'no category "https://tracker.example/...".'],
        [`see udp://tracker.example:6969/${PASSKEY}, then retry`, 'see udp://tracker.example:6969/..., then retry'],
        [`got https://user:${PASSKEY}@tracker.example`, 'got https://tracker.example/...'],
        [`got https://${PASSKEY}.tracker.example/announce`, 'got https://***.tracker.example/...'],
        [`magnet:?xt=urn:btih:abc&tr=${PASSKEY} was refused`, '(a magnet link, left out) was refused'],
        [`title https://tracker.example.org/owner's/${PASSKEY}/announce here`, 'title https://tracker.example.org/... here'],
        [`got https://${PASSKEY}.tracker.example`, 'got https://***.tracker.example/...'],
        [`quoted 'https://tracker.example/${PASSKEY}'`, "quoted 'https://tracker.example/...'"],
        // Paths the parser folds to `/`: judged as written, they still hold the key.
        [`got https://tracker.example/${PASSKEY}/%2e%2e`, 'got https://tracker.example/...'],
        [`got https://tracker.example/${PASSKEY}/..`, 'got https://tracker.example/...'],
        [`got http://tracker.example\\${PASSKEY}`, 'got http://tracker.example/...'],
        // Spellings a URL parser accepts for http and https without `://`.
        [`got https:\\\\tracker.example\\${PASSKEY}\\announce`, 'got https://tracker.example/...'],
        [`got https:\\tracker.example\\${PASSKEY}`, 'got https://tracker.example/...'],
        [`got https:/\\tracker.example\\${PASSKEY}`, 'got https://tracker.example/...'],
        [`got https:/tracker.example/${PASSKEY}`, 'got https://tracker.example/...'],
        [`got https:tracker.example/${PASSKEY}`, 'got https://tracker.example/...'],
        // A sentence's full stop after a cut URL is not doubled onto the placeholder.
        [`refused https://tracker.example/${PASSKEY}.`, 'refused https://tracker.example/...'],
        // A parser drops a tab inside a URL, so the key after one is still the URL's.
        [`got https://indexer.example/get\t?apikey=${PASSKEY}`, 'got https://indexer.example/...'],
        [`got https:${PASSKEY}.tracker.example`, 'got https://***.tracker.example/...'],
        // A passkey-like last label is still found when a port follows it.
        [`got https:/download.example.${PASSKEY}:8443`, 'got https://download.example.***:8443/...'],
        // Tabs and line breaks a parser drops, inside a loose spelling's host or before its key.
        [`got https:tracker.example\t/${PASSKEY}`, 'got https://tracker.example/...'],
        [`got https:tracker.example\n?passkey=${PASSKEY}`, 'got https://tracker.example/...'],
        [`got https:user:${PASSKEY}@tracker.example\t/announce`, 'got https://tracker.example/...'],
        [`got https:/tracker.example\t:8443/${PASSKEY}`, 'got https://tracker.example:8443/...'],
        [`got wss:tracker.example\t/${PASSKEY}`, 'got wss://tracker.example/...'],
        [`got https:/index\ter.example/get?apikey=${PASSKEY}`, 'got https://indexer.example/...'],
        // A mixed run of line breaks and tabs before a query is taken whole.
        [`got https://indexer.example/get\n\t?apikey=${PASSKEY}`, 'got https://indexer.example/...'],
        [`magnet:?xt=urn:btih:abc\n\t&tr=https%3A%2F%2Ftracker.example%2F${PASSKEY} was refused`, '(a magnet link, left out) was refused'],
        // A tab inside a magnet link does not leave its tracker parameter behind.
        [`magnet:?xt=urn:btih:abc\t&tr=https%3A%2F%2Ftracker.example%2F${PASSKEY} was refused`, '(a magnet link, left out) was refused']
    ])('cuts %s down', (text, expected) => {
        expect(scrubUrls(text)).toBe(expected);
    });

    it.each([
        'HTTP 500 at /api/v2/torrents/start',
        'could not reach http://192.0.2.20:8081',
        'plain words: nothing to cut',
        // Text a looser match would take for a URL, or rewrite into an address nobody sent.
        'upstream said HTTP:404 Not Found',
        'port https:443 open',
        'listening on http:8080',
        'https:strict is set',
        'ws:local',
        'FTP:Archive.mkv',
        'videos/https:poster.jpg',
        'Invalid scheme http:, use https',
        'url must start with https: or http:.',
        '(https:)',
        'Use http:// on the LAN',
        // A parser reads `1.2` as another address: the host as written must be the host parsed.
        'see https:1.2/docs',
        'upstream said HTTP:1.1/404 Not Found',
        'FTP:Archive.mkv#1'
    ])('leaves %s alone', text => {
        expect(scrubUrls(text)).toBe(text);
        // shownValue still leaves out any plain `scheme://` value whole, as it always has.
        if (!text.includes('://')) expect(shownValue(text)).toBe(text);
    });

    it('leaves the next line alone after a URL that ends one', () => {
        expect(scrubUrls(`see https://tracker.example/${PASSKEY}\n\n- Files under it`)).toBe('see https://tracker.example/...\n\n- Files under it');
    });

    it('leaves a heading on the next line alone', () => {
        expect(scrubUrls(`see https://tracker.example/${PASSKEY}\n# Heading`)).toBe('see https://tracker.example/...\n# Heading');
    });

    it.each([
        ['tabs before a space', `https:${'\t'.repeat(200_000)} x`],
        ['tabs at the end', `https:${'\t'.repeat(200_000)}`],
        ['line breaks before a space', `https:${'\n'.repeat(200_000)} x`],
        ['slashes before a space', `https:${'/'.repeat(200_000)} x`],
        ['tabs inside a URL before a space', `https://tracker.example/a${'\t'.repeat(200_000)} x`],
        ['tabs inside a magnet before a space', `magnet:?xt=a${'\t'.repeat(200_000)} x`],
        ['line breaks inside a URL before a space', `https://tracker.example/a${'\n'.repeat(200_000)} x`],
        ['mixed tabs and line breaks inside a URL before a space', `https://tracker.example/a${'\n\t'.repeat(100_000)} x`],
        ['mixed tabs and line breaks inside a magnet before a space', `magnet:?xt=a${'\t\n'.repeat(100_000)} x`]
    ])('scans %s in linear time', (_why, text) => {
        const started = Date.now();
        scrubUrls(text);
        shownValue(text);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('finds the end of a URL followed by a long run of punctuation in linear time', () => {
        const text = `https://tracker.example/${'.'.repeat(200_000)}x`;
        const started = Date.now();
        scrubUrls(text);
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it.each([`https:\\\\tracker.example\\${PASSKEY}`, `https:/tracker.example/${PASSKEY}`, `https:tracker.example/${PASSKEY}`])('treats %s as a pasted URL', value => {
        expect(shownValue(value)).toBe('(a URL, left out)');
    });
});

describe('a very long value', () => {
    it('is handled in linear time', () => {
        const long = 'a'.repeat(400_000);
        const started = Date.now();
        expect(shownValue(long)).toBe(long);
        expect(scrubUrls(long)).toBe(long);
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});

describe('the audit log', () => {
    it('keeps no passkey from a refusal, whichever field the URL was pasted into', () => {
        const audit = WriteAudit.ephemeral();
        const id = audit.begin({ tool: 't', service: 's', operation: 'o', tier: 'safe', target: 'x', args: {}, caller: 'c' });
        audit.settle(id, 'denied', `nothing named "https://tracker.example/${PASSKEY}/announce"`);
        expect(JSON.stringify(audit.recent())).not.toContain(PASSKEY);
        expect(JSON.stringify(audit.recent())).toContain('https://tracker.example/...');
    });
});
