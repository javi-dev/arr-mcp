import { describe, expect, it } from 'vitest';
import type { CredentialServiceConfig } from '../src/config/schema.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { registerRemoveQueueItem } from '../src/tools/removeQueueItem.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { HASH, PASSKEY, confirmed, fakeQbittorrent, toolServer, torrent, writeContext, type FakeOptions } from './helpers/fakeQbittorrent.ts';
import { namedInstances } from './helpers/instances.ts';

const config = (name: string, over: Record<string, unknown> = {}) =>
    ({ name, url: `http://192.0.2.10:${name === 'vpn' ? 8081 : 8082}`, timeout_ms: 10_000, permissions: { safe_write: true, destructive: true }, ...over }) as CredentialServiceConfig;

function harness(over: Record<string, unknown> = {}, opts: FakeOptions = {}) {
    const qb = fakeQbittorrent(opts);
    const cfg = config('vpn', over);
    const { server, call } = toolServer();
    registerRemoveQueueItem(server, writeContext(namedInstances('qbittorrent', [cfg])), [new QbittorrentAdapter(cfg, qb.impl)]);
    return { ...qb, call };
}

const ARGS = { service: 'qbittorrent', instance: 'vpn', id: HASH };

describe('remove_queue_item on qBittorrent', () => {
    it('shows private, ratio, seed time and tracker host in the preview', async () => {
        const preview = await harness().call('remove_queue_item', ARGS);
        expect(preview.structuredContent.effects.join(' ')).toContain('Torrent facts: private yes, ratio 1.50, seeded 2.0 days, tracker tracker.example.org (working).');
    });

    it('never shows a passkey from a tracker URL or message', async () => {
        const preview = await harness().call('remove_queue_item', ARGS);
        expect(JSON.stringify(preview)).not.toContain(PASSKEY);
    });

    it('removes an unprotected torrent as before', async () => {
        const h = harness();
        const applied = await confirmed(h.call, 'remove_queue_item', ARGS);
        expect(applied.structuredContent.applied).toBe(true);
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/delete']);
    });

    it.each([
        ['protect_all_torrents', { protect_all_torrents: true }, torrent({ private: false })],
        ['protect_private_torrents', { protect_private_torrents: true }, torrent({ private: true })]
    ])('refuses a torrent %s guards', async (_key, over, row) => {
        const h = harness(over, { torrents: [row] });
        await expect(h.call('remove_queue_item', ARGS)).rejects.toThrow(/protected from deletion/);
        expect(h.posts).toEqual([]);
    });

    it('leaves a public torrent alone under protect_private_torrents', async () => {
        const h = harness({ protect_private_torrents: true }, { torrents: [torrent({ private: false })] });
        expect((await h.call('remove_queue_item', ARGS)).structuredContent.confirm_token).toBeDefined();
    });

    it('counts an unknown private flag as private', async () => {
        const h = harness({ protect_private_torrents: true }, { torrents: [torrent({ private: undefined })], properties: { private: null, is_private: false } });
        await expect(h.call('remove_queue_item', ARGS)).rejects.toThrow(/not known yet/);
    });

    it('does not believe the deprecated flag while a magnet is still fetching metadata', async () => {
        const h = harness({ protect_private_torrents: true }, { torrents: [torrent({ state: 'metaDL', private: null })], properties: { private: null, is_private: false } });
        await expect(h.call('remove_queue_item', ARGS)).rejects.toThrow(/not known yet/);
    });

    it('guards a removal that keeps the files, since the torrent still leaves the client', async () => {
        const h = harness({ protect_all_torrents: true });
        await expect(h.call('remove_queue_item', { ...ARGS, remove_from_client: false })).rejects.toThrow(/protected from deletion/);
    });

    it.each([
        ['a tracker URL', `https://tracker.example.org/announce?passkey=${PASSKEY}`],
        ['a tracker URL after a space', ` https://tracker.example.org/announce?passkey=${PASSKEY}`],
        ['a magnet', `magnet:?xt=urn:btih:${HASH}&tr=https%3A%2F%2Ftracker.example.org%2F${PASSKEY}%2Fannounce`]
    ])('does not repeat %s passed as an id, in the refusal or the audit', async (_why, id) => {
        const qb = fakeQbittorrent();
        const cfg = config('vpn');
        const { server, call } = toolServer();
        const context = writeContext(namedInstances('qbittorrent', [cfg]));
        registerRemoveQueueItem(server, context, [new QbittorrentAdapter(cfg, qb.impl)]);
        const refusal = await call('remove_queue_item', { ...ARGS, id }).catch((err: Error) => err.message);
        expect(String(refusal)).not.toContain(PASSKEY);
        expect(JSON.stringify(context.audit.recent())).not.toContain(PASSKEY);
    });

    it('counts a torrent as private-unknown when its properties cannot be read', async () => {
        const h = harness({ protect_private_torrents: true }, { torrents: [torrent({ private: undefined, ratio: undefined })], failing: ['/torrents/properties'] });
        await expect(h.call('remove_queue_item', ARGS)).rejects.toThrow(/not known yet/);
    });

    it('trusts no private flag while a torrent has no metadata', async () => {
        const h = harness({ protect_private_torrents: true }, { torrents: [torrent({ state: 'forcedMetaDL', private: false })] });
        await expect(h.call('remove_queue_item', ARGS)).rejects.toThrow(/not known yet/);
    });

    it('does not let a token survive a torrent becoming protected, even with allow_protected', async () => {
        const h = harness({ protect_private_torrents: true }, { torrents: [torrent({ private: false })] });
        const args = { ...ARGS, allow_protected: true };
        const preview = await h.call('remove_queue_item', args);
        h.torrents[0]!.private = true;
        const late = await h.call('remove_queue_item', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(late.structuredContent.effects[0]).toContain('Overrides the delete protection');
        expect(h.posts).toEqual([]);
    });

    it('does not trust the legacy flag of a paused magnet on a build that sends no has_metadata', async () => {
        // qBittorrent 4.x: no `has_metadata`, no `private` in the list, and `is_private: false` whenever metadata is missing.
        const paused = torrent({ state: 'pausedDL', size: 0, amount_left: 0, private: undefined, has_metadata: undefined });
        const h = harness({ protect_private_torrents: true }, { torrents: [paused], properties: { is_private: false } });
        await expect(h.call('remove_queue_item', ARGS)).rejects.toThrow(/not known yet/);
        expect(h.posts).toEqual([]);
    });

    it('still reads the legacy flag of a torrent that has its metadata on such a build', async () => {
        const seeding = torrent({ private: undefined, has_metadata: undefined });
        const h = harness({ protect_private_torrents: true }, { torrents: [seeding], properties: { is_private: false } });
        expect((await h.call('remove_queue_item', ARGS)).structuredContent.confirm_token).toBeDefined();
    });

    it('fails closed when a proxy answers 404 for a torrent qBittorrent has just listed', async () => {
        const qb = fakeQbittorrent();
        const impl = ((input: string | URL | Request, init?: RequestInit) =>
            String(input).includes('/torrents/files') ? Promise.resolve(new Response('', { status: 404 })) : qb.impl(input, init)) as typeof fetch;
        const cfg = config('vpn', { protect_all_torrents: true });
        const { server, call } = toolServer();
        registerRemoveQueueItem(server, writeContext(namedInstances('qbittorrent', [cfg])), [new QbittorrentAdapter(cfg, impl)]);
        await expect(call('remove_queue_item', ARGS)).rejects.toThrow(/could not be read/);
    });

    it('fails closed when a protecting instance cannot be read', async () => {
        const h = harness({ protect_private_torrents: true }, { failing: ['/torrents/trackers'] });
        await expect(h.call('remove_queue_item', ARGS)).rejects.toThrow(/could not be read/);
        expect(h.posts).toEqual([]);
    });

    it('removes a protected torrent only with allow_protected, and says it is overriding', async () => {
        const h = harness({ protect_all_torrents: true });
        const args = { ...ARGS, allow_protected: true };
        const preview = await h.call('remove_queue_item', args);
        expect(preview.structuredContent.effects[0]).toContain('Overrides the delete protection');
        await h.call('remove_queue_item', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/delete']);
    });

    it('does not let a token from an unprotected preview apply once protection applies', async () => {
        const h = harness({ protect_private_torrents: true }, { torrents: [torrent({ private: false })] });
        const preview = await h.call('remove_queue_item', ARGS);
        h.torrents[0]!.private = true;
        await expect(h.call('remove_queue_item', { ...ARGS, confirm: preview.structuredContent.confirm_token })).rejects.toThrow(/protected from deletion/);
        expect(h.posts).toEqual([]);
    });
});

describe('remove_queue_item on an *arr row', () => {
    const arrRow = { service: 'radarr', id: '7', title: 'Film', status: 'downloading', protocol: 'torrent', downloadId: HASH.toUpperCase() };

    function arrHarness(instances: { name: string; over?: Record<string, unknown>; opts?: FakeOptions }[]) {
        const removed: unknown[] = [];
        const radarr = {
            id: 'radarr',
            type: 'radarr',
            supportsBlocklist: true,
            grabRecorded: () => Promise.resolve(true),
            getQueue: () => Promise.resolve([arrRow]),
            removeQueueItem: (_id: string, opts: unknown) => {
                removed.push(opts);
                return Promise.resolve();
            }
        } as unknown as ServiceAdapter;
        const clients = instances.map(i => new QbittorrentAdapter(config(i.name, i.over), fakeQbittorrent(i.opts).impl));
        const { server, call } = toolServer();
        const radarrInstance = { id: 'radarr', type: 'radarr', config: { url: 'http://192.0.2.10:7878', api_key: 'k', timeout_ms: 1000, permissions: { safe_write: true, destructive: true } } };
        registerRemoveQueueItem(server, writeContext([radarrInstance as never]), [radarr, ...clients]);
        return { call, removed };
    }

    it('traces the row to the torrent and guards it', async () => {
        const h = arrHarness([{ name: 'vpn', over: { protect_all_torrents: true } }]);
        await expect(h.call('remove_queue_item', { service: 'radarr', id: '7' })).rejects.toThrow(/protected from deletion/);
        expect(h.removed).toEqual([]);
    });

    it('guards a cross-seeded torrent when only the second instance protects it', async () => {
        const h = arrHarness([{ name: 'vpn' }, { name: 'novpn', over: { protect_all_torrents: true } }]);
        await expect(h.call('remove_queue_item', { service: 'radarr', id: '7' })).rejects.toThrow(/qbittorrent\/novpn protects/);
        expect(h.removed).toEqual([]);
    });

    it('fails closed when the protecting instance answers 404 to the lookup itself', async () => {
        const removed: unknown[] = [];
        const radarr = {
            id: 'radarr',
            type: 'radarr',
            supportsBlocklist: true,
            getQueue: () => Promise.resolve([arrRow]),
            removeQueueItem: (_id: string, opts: unknown) => {
                removed.push(opts);
                return Promise.resolve();
            }
        } as unknown as ServiceAdapter;
        const proxyDown = (() => Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch;
        const { server, call } = toolServer();
        const radarrInstance = { id: 'radarr', type: 'radarr', config: { url: 'http://192.0.2.10:7878', api_key: 'k', timeout_ms: 1000, permissions: { safe_write: true, destructive: true } } };
        registerRemoveQueueItem(server, writeContext([radarrInstance as never]), [radarr, new QbittorrentAdapter(config('vpn', { protect_all_torrents: true }), proxyDown)]);
        await expect(call('remove_queue_item', { service: 'radarr', id: '7' })).rejects.toThrow(/could not be read/);
        expect(removed).toEqual([]);
    });

    it('fails closed when a proxy answers the lookup with something that is not a list', async () => {
        const removed: unknown[] = [];
        const radarr = {
            id: 'radarr',
            type: 'radarr',
            supportsBlocklist: true,
            getQueue: () => Promise.resolve([arrRow]),
            removeQueueItem: (_id: string, opts: unknown) => {
                removed.push(opts);
                return Promise.resolve();
            }
        } as unknown as ServiceAdapter;
        const proxy = (() => Promise.resolve(Response.json({ error: 'upstream down' }))) as unknown as typeof fetch;
        const { server, call } = toolServer();
        const radarrInstance = { id: 'radarr', type: 'radarr', config: { url: 'http://192.0.2.10:7878', api_key: 'k', timeout_ms: 1000, permissions: { safe_write: true, destructive: true } } };
        registerRemoveQueueItem(server, writeContext([radarrInstance as never]), [radarr, new QbittorrentAdapter(config('vpn', { protect_all_torrents: true }), proxy)]);
        await expect(call('remove_queue_item', { service: 'radarr', id: '7' })).rejects.toThrow(/could not be read/);
        expect(removed).toEqual([]);
    });

    it('is not blocked by a protecting instance that does not hold the torrent', async () => {
        const h = arrHarness([{ name: 'vpn', over: { protect_all_torrents: true }, opts: { torrents: [] } }]);
        expect((await h.call('remove_queue_item', { service: 'radarr', id: '7' })).structuredContent.confirm_token).toBeDefined();
    });

    it('guards a blocklist-only removal, since the *arr can still delete the download', async () => {
        const h = arrHarness([{ name: 'vpn', over: { protect_all_torrents: true } }]);
        await expect(h.call('remove_queue_item', { service: 'radarr', id: '7', remove_from_client: false, blocklist: true })).rejects.toThrow(/protected from deletion/);
    });

    it('fails closed when a protecting instance cannot be read', async () => {
        const h = arrHarness([{ name: 'vpn', over: { protect_all_torrents: true }, opts: { failing: ['/torrents/info'] } }]);
        await expect(h.call('remove_queue_item', { service: 'radarr', id: '7' })).rejects.toThrow(/could not be read/);
        expect(h.removed).toEqual([]);
    });

    it('lets a removal through that leaves the download in the client', async () => {
        const h = arrHarness([{ name: 'vpn', over: { protect_all_torrents: true } }]);
        const preview = await h.call('remove_queue_item', { service: 'radarr', id: '7', remove_from_client: false });
        expect(preview.structuredContent.confirm_token).toBeDefined();
        expect(preview.structuredContent.effects.join(' ')).toContain('Torrent facts');
    });
});
