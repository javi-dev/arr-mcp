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
        [`got https:${PASSKEY}.tracker.example`, 'got https://***.tracker.example/...']
    ])('cuts %s down', (text, expected) => {
        expect(scrubUrls(text)).toBe(expected);
    });

    it.each([
        'HTTP 500 at /api/v2/torrents/start',
        'could not reach http://192.168.1.20:8081',
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
        '(https:)'
    ])('leaves %s alone', text => {
        expect(scrubUrls(text)).toBe(text);
        // shownValue still leaves out any plain `scheme://` value whole, as it always has.
        if (!text.includes('://')) expect(shownValue(text)).toBe(text);
    });

    it('leaves the next line alone after a URL that ends one', () => {
        expect(scrubUrls(`see https://tracker.example/${PASSKEY}\n\n- Files under it`)).toBe('see https://tracker.example/...\n\n- Files under it');
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
