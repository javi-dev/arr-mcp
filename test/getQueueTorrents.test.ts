import { describe, expect, it } from 'vitest';
import type { CredentialServiceConfig } from '../src/config/schema.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { buildGetQueue } from '../src/tools/getQueue.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { HASH, OTHER, PASSKEY, fakeQbittorrent, torrent, type FakeOptions } from './helpers/fakeQbittorrent.ts';
import { expectWithinBudget } from './helpers/budget.ts';

const adapter = (name: string | undefined, opts: FakeOptions = {}) =>
    new QbittorrentAdapter(
        { ...(name === undefined ? {} : { name }), url: 'http://192.0.2.10:8081', timeout_ms: 10_000, permissions: { safe_write: false, destructive: false } } as CredentialServiceConfig,
        fakeQbittorrent(opts).impl
    );

const full = { detail: 'full', limit: 50 } as const;

describe('get_queue on qBittorrent at detail "full"', () => {
    it('returns the save path, private flag, ratio, seed time, files and trackers', async () => {
        const [row] = (await buildGetQueue([adapter(undefined)], full)).items;
        expect(row).toMatchObject({
            savePath: '/data/torrents/movies',
            private: true,
            ratio: 1.5,
            seedingSeconds: 172_800,
            trackers: [{ host: 'tracker.example.org', status: 'working' }]
        });
        expect(row!.files).toEqual([{ name: expect.stringContaining('Some.Film/film.mkv'), sizeBytes: 1000, progress: 1 }]);
    });

    it('fills a torrent at missing files from torrents/properties', async () => {
        const bare = { hash: HASH, name: 'Gone', state: 'missingFiles' };
        const [row] = (await buildGetQueue([adapter(undefined, { torrents: [bare], properties: { save_path: '/data/media/gone', is_private: true, share_ratio: 2.25, seeding_time: 600 } })], full)).items;
        expect(row).toMatchObject({ status: 'missing files', savePath: '/data/media/gone', private: true, ratio: 2.25, seedingSeconds: 600 });
    });

    it('says `null` when nobody can know the private flag yet', async () => {
        const [row] = (await buildGetQueue([adapter(undefined, { torrents: [{ hash: HASH, name: 'New', state: 'metaDL' }], properties: { private: null } })], full)).items;
        expect(row!.private).toBeNull();
    });

    it('carries no tracker URL, passkey or tracker message', async () => {
        const result = await buildGetQueue([adapter(undefined, { torrents: [torrent({ tracker: `https://tracker.example.org/${PASSKEY}/announce` })] })], full);
        expect(JSON.stringify(result)).not.toContain(PASSKEY);
        expect(JSON.stringify(result)).not.toContain('bad key');
    });

    it('drops the DHT, PeX and LSD rows', async () => {
        const [row] = (await buildGetQueue([adapter(undefined, { trackers: [{ url: '** [DHT] **', status: 2 }, { url: '** [PeX] **', status: 2 }, { url: '** [LSD] **', status: 2 }] })], full)).items;
        expect(row!.trackers).toEqual([]);
    });

    it('reports a tracker that is being contacted as updating', async () => {
        const [row] = (await buildGetQueue([adapter(undefined, { trackers: [{ url: 'https://t.example/announce', status: 2, updating: true }] })], full)).items;
        expect(row!.trackers).toEqual([{ host: 't.example', status: 'updating' }]);
    });

    it('caps the files of one torrent and says how many are left out', async () => {
        const files = Array.from({ length: 250 }, (_, i) => ({ name: `Pack/${i}.mkv`, size: 1, progress: 1 }));
        const [row] = (await buildGetQueue([adapter(undefined, { torrents: [torrent(), torrent({ hash: OTHER })], files })], full)).items;
        expect(row!.files).toHaveLength(200);
        expect(row!.filesOmitted).toBe(50);
    });

    it('lets a single torrent use the whole page allowance', async () => {
        const files = Array.from({ length: 250 }, (_, i) => ({ name: `Pack/${i}.mkv`, size: 1, progress: 1 }));
        const { items } = await buildGetQueue([adapter(undefined, { torrents: [torrent()], files })], { detail: 'full', limit: 50, filter: { hash: HASH } });
        expect(items[0]!.files).toHaveLength(250);
        expect(items[0]!.filesOmitted).toBeUndefined();
    });

    it('reports a ratio past the ceiling, which qBittorrent answers with -1, as the ceiling', async () => {
        const [row] = (await buildGetQueue([adapter(undefined, { torrents: [torrent({ ratio: -1 })] })], full)).items;
        expect(row!.ratio).toBe(9999);
    });

    it('shares a file budget across the page', async () => {
        const files = Array.from({ length: 200 }, (_, i) => ({ name: `Pack/${i}.mkv`, size: 1, progress: 1 }));
        const torrents = ['1', '2', '3'].map(c => torrent({ hash: c.repeat(40) }));
        const { items } = await buildGetQueue([adapter(undefined, { torrents, files })], full);
        expect(items.map(i => i.files?.length)).toEqual([200, 200, 100]);
        expect(items[2]!.filesOmitted).toBe(100);
    });

    it('skips the per-torrent reads on a page too long to read them for', async () => {
        const torrents = Array.from({ length: 101 }, (_, i) => torrent({ hash: i.toString(16).padStart(40, '0') }));
        const result = await buildGetQueue([adapter(undefined, { torrents })], { detail: 'full', limit: 500 });
        expect(result.torrentDetailsOmitted).toBe(101);
        expect(result.items[0]!.trackers).toBeUndefined();
    });

    it('stays within the response budget at the longest page that is read in detail', async () => {
        const files = Array.from({ length: 200 }, (_, i) => ({ name: `Some.Long.Release.Name.2026/episode.${i}.mkv`, size: 1, progress: 1 }));
        const torrents = Array.from({ length: 100 }, (_, i) => torrent({ hash: i.toString(16).padStart(40, '0') }));
        expectWithinBudget(await buildGetQueue([adapter(undefined, { torrents, files })], { detail: 'full', limit: 100 }), 40_000);
    });

    it('keeps the page when one read fails, and names the instance', async () => {
        const result = await buildGetQueue([adapter(undefined, { failing: ['/torrents/files'] })], full);
        expect(result.items).toHaveLength(1);
        expect(result.degraded).toContain('qbittorrent:torrent details');
    });

    it('does not mark the page degraded for a torrent removed while it was read', async () => {
        const qb = fakeQbittorrent({ torrents: [torrent()] });
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes('hashes=')) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
            return qb.impl(input, init);
        }) as typeof fetch;
        const client = new QbittorrentAdapter({ url: 'http://192.0.2.10:8081', timeout_ms: 10_000, permissions: { safe_write: false, destructive: false } } as CredentialServiceConfig, impl);
        const result = await buildGetQueue([client], full);
        expect(result.items).toHaveLength(1);
        expect(result.degraded).toEqual([]);
    });

    it('does not read details below detail "full"', async () => {
        const [row] = (await buildGetQueue([adapter(undefined)], { detail: 'standard', limit: 50 })).items;
        expect(row!.files).toBeUndefined();
    });
});

describe('get_queue filters', () => {
    const stack = () => [adapter('vpn', { torrents: [torrent()] }), adapter('novpn', { torrents: [torrent({ hash: OTHER })] })];

    it('narrows to one instance', async () => {
        const { items } = await buildGetQueue(stack(), { detail: 'standard', limit: 50, instance: 'novpn' });
        expect(items.map(i => i.service)).toEqual(['qbittorrent/novpn']);
    });

    it('narrows to one service', async () => {
        const { items } = await buildGetQueue(stack(), { detail: 'standard', limit: 50, service: 'qbittorrent' });
        expect(items).toHaveLength(2);
    });

    it('narrows to one hash, whatever its case', async () => {
        const { items } = await buildGetQueue(stack(), { detail: 'standard', limit: 50, filter: { hash: OTHER.toUpperCase() } });
        expect(items.map(i => i.id)).toEqual([OTHER]);
    });

    it('finds an *arr row by its download id', async () => {
        const radarr = { id: 'radarr', type: 'radarr', getQueue: () => Promise.resolve([{ service: 'radarr', id: '7', title: 'Film', status: 'downloading', protocol: 'torrent', downloadId: OTHER.toUpperCase() }]) } as unknown as ServiceAdapter;
        const { items } = await buildGetQueue([radarr], { detail: 'standard', limit: 50, filter: { hash: OTHER } });
        expect(items.map(i => i.id)).toEqual(['7']);
    });

    it('refuses an instance that does not exist rather than answering empty', async () => {
        await expect(buildGetQueue(stack(), { detail: 'standard', limit: 50, instance: 'nope' })).rejects.toThrow(/no queue belongs/);
    });

    it('refuses a service that is not configured', async () => {
        await expect(buildGetQueue(stack(), { detail: 'standard', limit: 50, service: 'sonarr' })).rejects.toThrow();
    });
});
