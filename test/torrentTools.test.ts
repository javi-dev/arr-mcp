import { describe, expect, it, vi } from 'vitest';
import type { CredentialServiceConfig } from '../src/config/schema.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { MAX_BODY_BYTES } from '../src/app.ts';
import { MAX_TORRENT_BASE64, registerTorrentTools } from '../src/tools/torrentTools.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { HASH, OTHER, PASSKEY, bencode, confirmed, fakeQbittorrent, toolServer, torrent, writeContext, type FakeOptions } from './helpers/fakeQbittorrent.ts';
import { instancesOf } from './helpers/instances.ts';

const config = (over: Record<string, unknown> = {}) =>
    ({
        url: 'http://192.0.2.10:8081',
        timeout_ms: 10_000,
        permissions: { safe_write: true, destructive: true },
        ...over
    }) as CredentialServiceConfig;

function harness(opts: FakeOptions = {}, over: Record<string, unknown> = {}, extra: ServiceAdapter[] = []) {
    const qb = fakeQbittorrent(opts);
    const cfg = config(over);
    const adapter = new QbittorrentAdapter(cfg, qb.impl);
    const { server, call } = toolServer();
    const context = writeContext(instancesOf({ qbittorrent: cfg }));
    registerTorrentTools(server, context, [adapter, ...extra], { sleep: () => Promise.resolve() });
    return { ...qb, call, context };
}

const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=x&tr=${encodeURIComponent(`https://tracker.example.org/${PASSKEY}/announce`)}`;

describe('every torrent write', () => {
    it.each([
        ['recheck_torrents', { ids: [HASH] }],
        ['add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'movies' }],
        ['set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true }],
        ['rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Some.Film/renamed.mkv' }],
        ['set_torrent_category', { id: HASH, category: 'tv' }],
        ['reannounce_torrent', { id: HASH }]
    ])('%s previews first, and dry_run issues no token', async (tool, args) => {
        const h = harness();
        const preview = await h.call(tool, args);
        expect(preview.structuredContent.applied).toBe(false);
        expect(preview.structuredContent.confirm_token).toBeDefined();
        expect(h.posts).toEqual([]);

        const dry = await h.call(tool, { ...args, dry_run: true });
        expect(dry.structuredContent.confirm_token).toBeUndefined();
        expect(h.posts).toEqual([]);
    });

    it.each([
        ['reannounce_torrent', { id: `https://tracker.example.org/announce?passkey=${PASSKEY}` }],
        ['recheck_torrents', { ids: [`https://tracker.example.org/announce?passkey=${PASSKEY}`] }]
    ])('%s refuses something that is not a hash without repeating it', async (tool, args) => {
        const h = harness();
        const refusal = await h.call(tool, args).catch((err: Error) => err.message);
        expect(refusal).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('refuses a token from a different request', async () => {
        const h = harness();
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/a', move_files: true });
        const other = await h.call('set_torrent_location', { id: HASH, location: '/data/media/b', move_files: true, confirm: preview.structuredContent.confirm_token });
        expect(other.structuredContent.applied).toBe(false);
        expect(other.structuredContent.confirm_error).toBeDefined();
        expect(h.posts).toEqual([]);
    });
});

describe('recheck_torrents', () => {
    it('rechecks what is not already being checked', async () => {
        const h = harness({ torrents: [torrent(), torrent({ hash: OTHER, state: 'checkingUP' })] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH, OTHER.toUpperCase()] });
        expect(applied.structuredContent.applied).toBe(true);
        expect(h.posts).toEqual([{ path: '/torrents/recheck', form: { hashes: HASH } }]);
    });

    it('has nothing to do when every torrent is already checking', async () => {
        const h = harness({ torrents: [torrent({ state: 'checkingDL' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it('refuses a hash the client does not have', async () => {
        await expect(harness().call('recheck_torrents', { ids: [OTHER] })).rejects.toThrow(/no torrent with hash/);
    });

    it('refuses the `all` keyword, so one call cannot reach every torrent', async () => {
        await expect(harness().call('recheck_torrents', { ids: ['all'] })).rejects.toThrow();
    });

    it('starts a stopped torrent it saw checking that comes back complete', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingResumeData', 'checkingUP', 'stoppedUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck', '/torrents/start']);
        expect(applied.structuredContent.result).toMatchObject({ resumed: [HASH] });
    });

    it('sees a check that only shows on the second read, as qBittorrent refreshes its state late', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['stoppedUP', 'checkingUP', 'stoppedUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ resumed: [HASH] });
    });

    it('does not call a torrent queued behind another check incomplete', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 10, progress: 0.9 })] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ unconfirmed: [HASH] });
        expect(applied.structuredContent.result).not.toHaveProperty('incomplete');
    });

    it('skips a torrent that has no metadata to check', async () => {
        const h = harness({ torrents: [torrent(), torrent({ hash: OTHER, state: 'metaDL' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH, OTHER] });
        expect(preview.structuredContent.effects.join(' ')).toContain('no metadata to check yet');
        await h.call('recheck_torrents', { ids: [HASH, OTHER], confirm: preview.structuredContent.confirm_token });
        expect(h.posts).toEqual([{ path: '/torrents/recheck', form: { hashes: HASH } }]);
    });

    it('has nothing to do when no torrent has metadata yet', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'forcedMetaDL' })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it('binds the token to whether it resumes', async () => {
        const h = harness();
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        const resumed = await h.call('recheck_torrents', { ids: [HASH], resume_if_complete: true, confirm: preview.structuredContent.confirm_token });
        expect(resumed.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('does not start a torrent on the verdict of an earlier check', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
        expect(applied.structuredContent.result).toMatchObject({ unconfirmed: [HASH] });
    });

    it('leaves an incomplete torrent stopped', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 10, progress: 0.9 })], recheckStates: ['checkingDL', 'stoppedDL'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
        expect(applied.structuredContent.result).toMatchObject({ incomplete: [HASH] });
    });

    it('reports a torrent still checking when the watch ends, and starts nothing', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
        expect(applied.structuredContent.result).toMatchObject({ still_checking: [HASH] });
        expect(applied.structuredContent.summary).toContain('still checking');
    });

    it('reports a torrent removed while it was being checked', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', null] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ gone: [HASH] });
    });

    it('still reports the recheck when the watch loses sight of the client', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckLosesSight: true });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.applied).toBe(true);
        expect(applied.structuredContent.result).toMatchObject({ unconfirmed: [HASH] });
    });

    it('says when a finished torrent could not be started', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP'], failing: ['/torrents/start'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ resume_failed: [HASH] });
    });
});

describe('add_torrent', () => {
    it('adds a magnet with a resolved path and automatic management off', async () => {
        const h = harness();
        const magnet = `magnet:?xt=urn:btih:${OTHER}`;
        const applied = await confirmed(h.call, 'add_torrent', { magnet, category: 'movies' });
        expect(applied.structuredContent.applied).toBe(true);
        expect(h.posts).toEqual([{ path: '/torrents/add', form: { savepath: '/data/torrents/movies', autoTMM: 'false', useDownloadPath: 'false', category: 'movies', urls: magnet } }]);
    });

    it('uploads a .torrent file and shows what it holds', async () => {
        const h = harness();
        const file = bencode({ announce: `https://tracker.example.org/${PASSKEY}/announce`, info: { length: 5, name: 'Upload.mkv', 'piece length': 16384, pieces: 'x'.repeat(20), private: 1 } });
        const args = { torrent_base64: file.toString('base64'), save_path: '/data/media/new' };
        const preview = await h.call('add_torrent', args);
        expect(preview.structuredContent.summary).toContain('Upload.mkv');
        expect(preview.structuredContent.effects.join(' ')).toContain('private yes');
        expect(preview.structuredContent.effects.join(' ')).toContain('tracker.example.org');

        await h.call('add_torrent', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(h.posts[0]!.multipart?.get('savepath')).toBe('/data/media/new');
        expect(h.posts[0]!.multipart?.get('useDownloadPath')).toBe('false');
        expect(h.posts[0]!.multipart?.get('torrents')).toBeInstanceOf(Blob);
    });

    it('never repeats a source that carries a passkey', async () => {
        const h = harness({ torrents: [] });
        const url = `https://indexer.example/dl/${PASSKEY}/film.torrent?passkey=${PASSKEY}`;
        for (const args of [{ magnet: MAGNET, save_path: '/data/torrents' }, { url, save_path: '/data/torrents' }]) {
            const preview = await h.call('add_torrent', args);
            const applied = await h.call('add_torrent', { ...args, confirm: preview.structuredContent.confirm_token });
            expect(JSON.stringify([preview, applied])).not.toContain(PASSKEY);
        }
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('binds the token to the exact source', async () => {
        const h = harness({ torrents: [] });
        const preview = await h.call('add_torrent', { url: 'https://indexer.example/a.torrent', save_path: '/data/torrents' });
        const swapped = await h.call('add_torrent', { url: 'https://indexer.example/b.torrent', save_path: '/data/torrents', confirm: preview.structuredContent.confirm_token });
        expect(swapped.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('warns when an *arr watches the category', async () => {
        const radarr = {
            id: 'radarr',
            type: 'radarr',
            getDownloadClients: () => Promise.resolve([{ name: 'qb', implementation: 'QBittorrent', enabled: true, categories: ['movies'] }])
        } as unknown as ServiceAdapter;
        const h = harness({}, {}, [radarr]);
        const preview = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'movies' });
        expect(preview.structuredContent.effects[0]).toContain('radarr watches category "movies"');
    });

    it('still previews when an *arr cannot be asked', async () => {
        const radarr = { id: 'radarr', type: 'radarr', getDownloadClients: vi.fn(() => Promise.reject(new Error('down'))) } as unknown as ServiceAdapter;
        const h = harness({}, {}, [radarr]);
        const preview = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'movies' });
        expect(preview.structuredContent.effects[0]).toContain('Could not check whether radarr watches');
    });

    it.each([
        ['a path outside the allowed roots', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/etc' }, /outside the locations/],
        ['a category that does not exist', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'nope' }, /no category named/],
        ['two sources', { magnet: `magnet:?xt=urn:btih:${OTHER}`, url: 'https://a.example/x.torrent' }, /exactly one/],
        ['no source', { save_path: '/data/torrents' }, /exactly one/],
        ['a magnet with a line break', { magnet: `magnet:?xt=urn:btih:${OTHER}\nhttp://evil.example/x` }, /not a magnet/],
        ['a URL with credentials', { url: 'https://u:p@a.example/x.torrent' }, /credentials/],
        ['a file that is not a torrent', { torrent_base64: Buffer.from('<html>').toString('base64') }, /not a valid \.torrent/],
        ['text that is not base64', { torrent_base64: 'not base64!' }, /not valid base64/]
    ])('refuses %s', async (_why, args, message) => {
        await expect(harness().call('add_torrent', args)).rejects.toThrow(message);
    });

    it('refuses a category whose own path is outside the allowed roots', async () => {
        const h = harness({ categories: { odd: { savePath: '/mnt/elsewhere' } } });
        await expect(h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'odd' })).rejects.toThrow(/outside the locations/);
    });

    it('recognises a base32 magnet of a torrent the client already holds', async () => {
        const preview = await harness().call('add_torrent', { magnet: `magnet:?xt=urn:btih:${'VK'.repeat(16)}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it('goes by the truncated SHA-256 of a hybrid magnet', async () => {
        const v2 = 'c'.repeat(64);
        const h = harness({ torrents: [torrent({ hash: v2.slice(0, 40) })] });
        const preview = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}&xt=urn:btmh:1220${v2}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it('keeps an upload inside what one request can carry', async () => {
        expect(MAX_TORRENT_BASE64 + 64 * 1024).toBeLessThan(MAX_BODY_BYTES);
        const tooBig = Buffer.alloc(3_000_001).toString('base64');
        await expect(harness().call('add_torrent', { torrent_base64: tooBig })).rejects.toThrow();
    });

    it('honours configured allowed_paths in place of the defaults', async () => {
        const h = harness({}, { allowed_paths: ['/srv/dl'] });
        await expect(h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' })).rejects.toThrow(/outside the locations/);
        const preview = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/srv/dl/x' });
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('has nothing to do for a torrent the client already holds', async () => {
        const preview = await harness().call('add_torrent', { magnet: `magnet:?xt=urn:btih:${HASH}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it.each([
        ['an older build', { addAnswer: 'Fails.' }],
        ['5.3.0 counting a failure', { addAnswer: JSON.stringify({ success_count: 0, failure_count: 1, pending_count: 0 }) }],
        ['5.3.0 answering 409', { addAnswer: '', addStatus: 409 }]
    ])('reports a refusal from %s as a failure', async (_why, opts) => {
        const h = harness(opts);
        await expect(confirmed(h.call, 'add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' })).rejects.toThrow(/did not add/);
    });

    it('drops upstream words that repeat the source key, from the error and the audit', async () => {
        const url = `https://indexer.example/get/${PASSKEY}.torrent`;
        const h = harness({ addStatus: 400, addAnswer: JSON.stringify({ errorMessage: `could not fetch ${url}` }) });
        const failure = await confirmed(h.call, 'add_torrent', { url, save_path: '/data/torrents' }).catch((err: Error) => err);
        expect(String(failure)).toContain('did not add');
        expect(String(failure)).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('says a source still being fetched is not finished', async () => {
        const h = harness({ addStatus: 202, addAnswer: JSON.stringify({ success_count: 0, failure_count: 0, pending_count: 1 }) });
        const applied = await confirmed(h.call, 'add_torrent', { url: 'https://indexer.example/a.torrent', save_path: '/data/torrents' });
        expect(applied.structuredContent.summary).toContain('still fetching');
    });

    it('accepts a v2 magnet, and goes by its truncated hash', async () => {
        const v2 = 'd'.repeat(64);
        const h = harness({ torrents: [torrent({ hash: v2.slice(0, 40) })] });
        const preview = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btmh:1220${v2}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it('names every tracker a magnet makes the client contact, however it is spelled', async () => {
        const magnet = `magnet:?xt=urn:btih:${OTHER}&tr.1=https%3A%2F%2Fone.example%2Fa&TR=https%3A%2F%2Ftwo.example%2Fb`;
        const preview = await harness().call('add_torrent', { magnet, save_path: '/data/torrents' });
        expect(preview.structuredContent.effects.join(' ')).toContain('The client will contact: one.example, two.example.');
    });

    it('binds the token to the trackers of a magnet, not only its hash', async () => {
        const h = harness();
        const first = `magnet:?xt=urn:btih:${OTHER}&tr=https%3A%2F%2Fone.example%2Fa`;
        const preview = await h.call('add_torrent', { magnet: first, save_path: '/data/torrents' });
        const other = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}&tr=https%3A%2F%2Fevil.example%2Fa`, save_path: '/data/torrents', confirm: preview.structuredContent.confirm_token });
        expect(other.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });
});

describe('set_torrent_location', () => {
    const missing = torrent({ state: 'missingFiles', completed: 0 });

    it('repoints a torrent at missing files without move_files', async () => {
        const h = harness({ torrents: [missing] });
        const applied = await confirmed(h.call, 'set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(applied.structuredContent.applied).toBe(true);
        expect(applied.structuredContent.tier).toBe('safe');
        expect(h.posts).toEqual([{ path: '/torrents/setLocation', form: { hashes: HASH, location: '/data/media/movies' } }]);
    });

    it('refuses to move existing data unless move_files is passed', async () => {
        const h = harness();
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(/would move it/);
        expect(h.posts).toEqual([]);
    });

    it.each(['downloading', 'stalledDL', 'stoppedDL', 'queuedDL', 'allocating'])('refuses a torrent at %s with nothing downloaded, whose files could still move', async state => {
        const h = harness({ torrents: [torrent({ state, completed: 0 })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(/would move it/);
    });

    it.each(['metaDL', 'forcedMetaDL'])('points a torrent at %s without move_files, having nothing to move', async state => {
        const preview = await harness({ torrents: [torrent({ state, completed: 0 })] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.tier).toBe('safe');
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('leaves unfinished data in the incomplete-downloads folder, and says so', async () => {
        const h = harness({ torrents: [torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete' })] });
        const applied = await confirmed(h.call, 'set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(applied.structuredContent.effects[0]).toContain('stays in /data/torrents/incomplete');
        expect(applied.structuredContent.summary).not.toContain('moving');
    });

    it('refuses while the torrent is already moving', async () => {
        const h = harness({ torrents: [torrent({ state: 'moving' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true })).rejects.toThrow(/already being moved/);
    });

    it('says that a file still at the old path moves too', async () => {
        const preview = await harness({ torrents: [missing] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.effects[0]).toContain('any file of this torrent still there moves too');
    });

    it('does not let a token that promised no move apply once the data is back', async () => {
        const h = harness({ torrents: [torrent({ state: 'missingFiles', completed: 0 })] });
        const args = { id: HASH, location: '/data/media/movies', move_files: true };
        const preview = await h.call('set_torrent_location', args);
        h.torrents[0]!.state = 'stalledUP';
        const late = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(late.structuredContent.effects.join(' ')).toContain('Physically moves');
        expect(h.posts).toEqual([]);
    });

    it('reports a move as accepted rather than finished', async () => {
        const applied = await confirmed(harness().call, 'set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true });
        expect(applied.structuredContent.summary).toContain('in the background');
        expect(applied.structuredContent.result).toMatchObject({ pending: true });
    });

    it('needs the destructive tier to move data', async () => {
        const h = harness({}, { permissions: { safe_write: true, destructive: false } });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true })).rejects.toThrow(/destructive/);
        expect(h.posts).toEqual([]);
    });

    it('moves data once move_files is confirmed, and says what it will cost', async () => {
        const h = harness();
        const args = { id: HASH, location: '/data/media/movies', move_files: true };
        const preview = await h.call('set_torrent_location', args);
        expect(preview.structuredContent.tier).toBe('destructive');
        expect(preview.structuredContent.effects.join(' ')).toContain('Physically moves');
        await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/setLocation']);
    });

    it('refuses a location outside the allowed roots, even with move_files', async () => {
        const h = harness();
        await expect(h.call('set_torrent_location', { id: HASH, location: '/etc/x', move_files: true })).rejects.toThrow(/outside the locations/);
    });

    it('re-checks at confirm: data that appeared since the preview is not moved', async () => {
        const h = harness({ torrents: [torrent({ state: 'missingFiles', completed: 0 })] });
        const args = { id: HASH, location: '/data/media/movies' };
        const preview = await h.call('set_torrent_location', args);
        h.torrents[0]!.state = 'stalledUP';
        h.torrents[0]!.completed = 1000;
        await expect(h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token })).rejects.toThrow(/would move it/);
        expect(h.posts).toEqual([]);
    });

    it('has nothing to do at the current path', async () => {
        const preview = await harness().call('set_torrent_location', { id: HASH, location: '/data/torrents/movies/' });
        expect(preview.structuredContent.noop).toBe(true);
    });
});

describe('rename_torrent_file', () => {
    it('renames inside the torrent folder', async () => {
        const h = harness();
        await confirmed(h.call, 'rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Some.Film/renamed.mkv' });
        expect(h.posts).toEqual([{ path: '/torrents/renameFile', form: { hash: HASH, oldPath: 'Some.Film/film.mkv', newPath: 'Some.Film/renamed.mkv' } }]);
    });

    it.each([
        ['saved', { save_path: '/downloads' }],
        ['still downloading', { download_path: '/incomplete' }]
    ])('refuses a torrent %s outside the allowed roots', async (_why, over) => {
        const h = harness({ torrents: [torrent(over)] });
        await expect(h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Some.Film/renamed.mkv' })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it.each(['../film.mkv', 'Other/film.mkv', '/etc/passwd', 'Some.Film/../../x'])('refuses to leave the folder with %s', async new_path => {
        const h = harness();
        await expect(h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path })).rejects.toThrow();
        expect(h.posts).toEqual([]);
    });
});

describe('set_torrent_category', () => {
    it('changes the category of a manually managed torrent without moving it', async () => {
        const h = harness();
        const applied = await confirmed(h.call, 'set_torrent_category', { id: HASH, category: 'tv' });
        expect(applied.structuredContent.effects).toContain('The data stays where it is.');
        expect(h.posts).toEqual([{ path: '/torrents/setCategory', form: { hashes: HASH, category: 'tv' } }]);
    });

    it('clears a category with an empty string', async () => {
        const h = harness();
        await confirmed(h.call, 'set_torrent_category', { id: HASH, category: '' });
        expect(h.posts[0]!.form).toEqual({ hashes: HASH, category: '' });
    });

    it('refuses a change that would relocate a managed torrent unless move_files is passed', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/would move/);
        const moved = await confirmed(h.call, 'set_torrent_category', { id: HASH, category: 'tv', move_files: true });
        expect(moved.structuredContent.effects.join(' ')).toContain('/data/torrents/tv');
    });

    it('treats an unreadable relocation preference as moving', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true })], preferences: {} });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/would move/);
    });

    it('reads the preference that governs a category change, not the one for a category path', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true })], preferences: { torrent_changed_tmm_enabled: true, category_changed_tmm_enabled: false } });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/would move/);
    });

    it('does not ask for move_files when the client only switches the torrent to manual, and says so', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true })], preferences: { torrent_changed_tmm_enabled: false, category_changed_tmm_enabled: true } });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv' });
        expect(preview.structuredContent.confirm_token).toBeDefined();
        expect(preview.structuredContent.effects).toContain('Switches the torrent to manual management, so its category no longer decides its path.');
    });

    it('puts a subcategory with no path under its parent, as qBittorrent does', async () => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true })],
            categories: { movies: { savePath: '/data/torrents/movies' }, tv: { savePath: '/data/media/tv' }, 'tv/Show': { savePath: '' } }
        });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv/Show', move_files: true });
        expect(preview.structuredContent.effects.join(' ')).toContain('/data/media/tv/Show');
    });

    it('refuses a subcategory whose parent saves outside the allowed roots', async () => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true, save_path: '/data/torrents/tv/Show' })],
            categories: { movies: {}, tv: { savePath: '/mnt/cold/tv' }, 'tv/Show': { savePath: '' } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv/Show', move_files: true })).rejects.toThrow(/outside the locations/);
    });

    it('does not let a token apply once the category saves somewhere else', async () => {
        const categories = { movies: { savePath: '/data/torrents/movies' }, tv: { savePath: '/data/media/tv' } };
        const h = harness({ torrents: [torrent({ auto_tmm: true })], categories });
        const args = { id: HASH, category: 'tv', move_files: true };
        const preview = await h.call('set_torrent_category', args);
        categories.tv.savePath = '/data/media/archive';
        const late = await h.call('set_torrent_category', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it.each([
        ['the instance keeps unfinished data in a folder', { temp_path_enabled: true }, {}],
        ['the category names its own folder', { temp_path_enabled: false }, { download_path: '/mnt/scratch/incomplete' }]
    ])('refuses to relocate an unfinished torrent when %s', async (_why, prefs, tv) => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500 })],
            preferences: { torrent_changed_tmm_enabled: true, ...prefs },
            categories: { movies: { savePath: '/data/torrents/movies' }, tv: { savePath: '/data/torrents/tv', ...tv } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/incomplete-downloads/);
        expect(h.posts).toEqual([]);
    });

    it('refuses to relocate an unfinished torrent already in such a folder', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete/movies' })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/incomplete-downloads/);
    });

    it('lets a category that opts out of the folder relocate an unfinished torrent', async () => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500 })],
            preferences: { torrent_changed_tmm_enabled: true, temp_path_enabled: true },
            categories: { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: false } }
        });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true });
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('warns when the new category removes torrents at its share limits', async () => {
        const h = harness({ categories: { movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: 'RemoveWithContent' } } as never });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'purge' });
        expect(preview.structuredContent.effects[0]).toContain('removes a torrent once it reaches');
    });

    it.each(['Remove', 'RemoveWithContent'])('refuses a protected torrent a category would %s at its limits', async action => {
        const h = harness({ categories: { movies: {}, purge: { share_limit_action: action } } as never }, { protect_private_torrents: true });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'purge' })).rejects.toThrow(/removes torrents at its share limits/);
        expect(h.posts).toEqual([]);
    });

    it('lets a protected torrent into a category that only stops at its limits', async () => {
        const h = harness({ categories: { movies: {}, hold: { share_limit_action: 'Stop' } } as never }, { protect_all_torrents: true });
        expect((await h.call('set_torrent_category', { id: HASH, category: 'hold' })).structuredContent.confirm_token).toBeDefined();
    });

    it('warns about an *arr watching the category the torrent leaves', async () => {
        const radarr = {
            id: 'radarr',
            type: 'radarr',
            getDownloadClients: () => Promise.resolve([{ name: 'qb', implementation: 'QBittorrent', enabled: true, categories: ['movies'] }])
        } as unknown as ServiceAdapter;
        const preview = await harness({}, {}, [radarr]).call('set_torrent_category', { id: HASH, category: 'tv' });
        expect(preview.structuredContent.effects[0]).toContain('radarr watches category "movies"');
    });

    it('refuses a relocation outside the allowed roots, even with move_files', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true })], categories: { odd: { savePath: '/mnt/elsewhere' } } });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'odd', move_files: true })).rejects.toThrow(/outside the locations/);
    });

    it('refuses a category that does not exist', async () => {
        await expect(harness().call('set_torrent_category', { id: HASH, category: 'nope' })).rejects.toThrow(/no category named/);
    });
});

describe('reannounce_torrent', () => {
    it('names the tracker by host only', async () => {
        const h = harness();
        const preview = await h.call('reannounce_torrent', { id: HASH });
        expect(preview.structuredContent.effects).toEqual(['Contacts: tracker.example.org (working).']);
        expect(JSON.stringify(preview)).not.toContain(PASSKEY);
        await h.call('reannounce_torrent', { id: HASH, confirm: preview.structuredContent.confirm_token });
        expect(h.posts).toEqual([{ path: '/torrents/reannounce', form: { hashes: HASH } }]);
    });

    it('has nothing to do for a stopped torrent', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'stoppedUP' })] }).call('reannounce_torrent', { id: HASH });
        expect(preview.structuredContent.noop).toBe(true);
    });
});
