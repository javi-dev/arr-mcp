import { describe, expect, it, vi } from 'vitest';
import type { CredentialServiceConfig } from '../src/config/schema.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { MAX_BODY_BYTES } from '../src/app.ts';
import { fenceText } from '../src/core/fence.ts';
import { MAX_TORRENT_BASE64, registerTorrentTools } from '../src/tools/torrentTools.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { HASH, OTHER, PASSKEY, bencode, confirmed, fakeQbittorrent, toolServer, torrent, writeContext, type FakeOptions } from './helpers/fakeQbittorrent.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse, textResponse } from './helpers/serve.ts';

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
    const sleeps: number[] = [];
    registerTorrentTools(server, context, [adapter, ...extra], {
        sleep: ms => {
            sleeps.push(ms);
            return Promise.resolve();
        }
    });
    return { ...qb, call, context, sleeps };
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
        await expect(harness().call('recheck_torrents', { ids: [OTHER] })).rejects.toThrow(/^qbittorrent not found: no torrent with hash/);
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

    /** The recheck is the write; the watch after it waits on qBittorrent alone (#12). */
    it('lets another confirmed write to the client apply while it watches, then leaves the torrent stopped rather than undo it', async () => {
        const qb = fakeQbittorrent({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP'] });
        const cfg = config();
        const { server, call } = toolServer();
        let resume = (): void => undefined;
        const watching = new Promise<void>(resolve => {
            resume = resolve;
        });
        let sleeping = false;
        registerTorrentTools(server, writeContext(instancesOf({ qbittorrent: cfg })), [new QbittorrentAdapter(cfg, qb.impl)], {
            // The watch's first pause holds until the other write has gone through.
            sleep: async () => {
                if (sleeping) return;
                sleeping = true;
                await watching;
            }
        });
        try {
            const recheck = await call('recheck_torrents', { ids: [HASH], resume_if_complete: true });
            const move = await call('set_torrent_category', { id: HASH, category: 'tv' });
            const rechecking = call('recheck_torrents', { ids: [HASH], resume_if_complete: true, confirm: recheck.structuredContent.confirm_token });
            await vi.waitFor(() => expect(sleeping).toBe(true));
            const moved = await call('set_torrent_category', { id: HASH, category: 'tv', confirm: move.structuredContent.confirm_token });
            expect(moved.structuredContent.applied).toBe(true);
            resume();
            const done = await rechecking;
            expect(done.structuredContent.result).toMatchObject({ left_stopped: [HASH] });
            expect(done.content[0]?.text).toMatch(/left stopped, because another confirmation to this qBittorrent was accepted before the start/);
            expect(qb.posts.map(p => p.path)).toEqual(['/torrents/recheck', '/torrents/setCategory']);
        } finally {
            resume();
        }
    });

    it('stands down without holding the client for the read it reports from', async () => {
        const qb = fakeQbittorrent({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP'] });
        let resume = (): void => undefined;
        const watching = new Promise<void>(resolve => {
            resume = resolve;
        });
        let unblock = (): void => undefined;
        const reportRead = new Promise<void>(resolve => {
            unblock = resolve;
        });
        // After the watch resumes: its own read passes, the next one (the read it reports from) hangs.
        let readsAfterResume: number | undefined;
        let reportHeld = false;
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes('/torrents/info') && readsAfterResume !== undefined && ++readsAfterResume === 2) {
                reportHeld = true;
                await reportRead;
            }
            return qb.impl(input, init);
        }) as typeof fetch;
        const cfg = config();
        const { server, call } = toolServer();
        let sleeping = false;
        registerTorrentTools(server, writeContext(instancesOf({ qbittorrent: cfg })), [new QbittorrentAdapter(cfg, impl)], {
            sleep: async () => {
                if (sleeping) return;
                sleeping = true;
                await watching;
            }
        });
        try {
            const recheck = await call('recheck_torrents', { ids: [HASH], resume_if_complete: true });
            const move = await call('set_torrent_category', { id: HASH, category: 'tv' });
            const rechecking = call('recheck_torrents', { ids: [HASH], resume_if_complete: true, confirm: recheck.structuredContent.confirm_token });
            await vi.waitFor(() => expect(sleeping).toBe(true));
            expect((await call('set_torrent_category', { id: HASH, category: 'tv', confirm: move.structuredContent.confirm_token })).structuredContent.applied).toBe(true);
            // The fake keeps no category, so the same move previews as a change again.
            const again = await call('set_torrent_category', { id: HASH, category: 'tv' });
            readsAfterResume = 0;
            resume();
            await vi.waitFor(() => expect(reportHeld).toBe(true));
            // The recheck has stood down and is only reading: the client is free.
            const applied = await call('set_torrent_category', { id: HASH, category: 'tv', confirm: again.structuredContent.confirm_token });
            expect(applied.structuredContent.applied).toBe(true);
            unblock();
            expect((await rechecking).structuredContent.result).toMatchObject({ left_stopped: [HASH] });
        } finally {
            resume();
            unblock();
        }
    });

    /** Overtaken, it reports from a read taken after standing down: what the torrent is doing then, or that it could not tell. */
    it.each([
        ['running', { left_stopped: undefined, already_running: [HASH] }, /already running when they were read for the start/],
        ['unreadable', { left_stopped: [HASH], state_unread: expect.stringMatching(/500|broken/) as unknown }, /^Recheck sent\. what the torrents not started are doing now could not be read .*check get_queue before starting any of them; finished complete but left stopped/]
    ])('reports a torrent it stood down on from a read after it: %s', async (mode, expected, said) => {
        const t = torrent({ state: 'stoppedUP' });
        const qb = fakeQbittorrent({ torrents: [t], recheckStates: ['checkingUP', 'stoppedUP'] });
        let resume = (): void => undefined;
        const watching = new Promise<void>(resolve => {
            resume = resolve;
        });
        let readsAfterResume: number | undefined;
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            // The watch's own read passes; the next is the one it reports from.
            if (url.includes('/torrents/info') && readsAfterResume !== undefined && ++readsAfterResume === 2) {
                return mode === 'running' ? jsonResponse([{ ...t, state: 'uploading' }]) : textResponse('broken', 500);
            }
            return qb.impl(input, init);
        }) as typeof fetch;
        const cfg = config();
        const { server, call } = toolServer();
        let sleeping = false;
        registerTorrentTools(server, writeContext(instancesOf({ qbittorrent: cfg })), [new QbittorrentAdapter(cfg, impl)], {
            sleep: async () => {
                if (sleeping) return;
                sleeping = true;
                await watching;
            }
        });
        try {
            const recheck = await call('recheck_torrents', { ids: [HASH], resume_if_complete: true });
            const move = await call('set_torrent_category', { id: HASH, category: 'tv' });
            const rechecking = call('recheck_torrents', { ids: [HASH], resume_if_complete: true, confirm: recheck.structuredContent.confirm_token });
            await vi.waitFor(() => expect(sleeping).toBe(true));
            await call('set_torrent_category', { id: HASH, category: 'tv', confirm: move.structuredContent.confirm_token });
            readsAfterResume = 0;
            resume();
            const done = await rechecking;
            expect(done.structuredContent.result).toMatchObject({ rechecking: [HASH], ...Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== undefined)) });
            if (mode === 'running') expect(done.structuredContent.result).not.toHaveProperty('left_stopped');
            expect(done.content[0]?.text).toMatch(said);
            expect(qb.posts.map(p => p.path)).toEqual(['/torrents/recheck', '/torrents/setCategory']);
        } finally {
            resume();
        }
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

    it('reads the torrent again before starting it', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP', 'checkingUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
        expect(applied.structuredContent.result).toMatchObject({ unconfirmed: [HASH] });
    });

    it('says where a torrent goes if the check finds it incomplete', async () => {
        const preview = await harness({ torrents: [torrent({ download_path: '/data/torrents/incomplete' })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.effects.join(' ')).toContain('moves what is left of it to /data/torrents/incomplete');
    });

    it('keeps the token valid when qBittorrent lists the torrents in another order', async () => {
        const rows = [torrent({ download_path: '/data/torrents/incomplete' }), torrent({ hash: OTHER, download_path: '/data/torrents/incomplete' })];
        const h = harness({ torrents: rows });
        const preview = await h.call('recheck_torrents', { ids: [HASH, OTHER] });
        rows.reverse();
        const applied = await h.call('recheck_torrents', { ids: [HASH, OTHER], confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.applied).toBe(true);
    });

    it('refuses a recheck that could send a complete torrent to a save path outside the allowed roots', async () => {
        const h = harness({ torrents: [torrent({ save_path: '/mnt/legacy', download_path: '/data/torrents/incomplete' })] });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('does not let a token survive the save path changing', async () => {
        const h = harness({ torrents: [torrent({ download_path: '/data/torrents/incomplete' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        h.torrents[0]!.save_path = '/data/media/elsewhere';
        const late = await h.call('recheck_torrents', { ids: [HASH], confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    const removing = { movies: { share_limit_action: 'RemoveWithContent', ratio_limit: 1 } };

    it('refuses a recheck that could get a protected torrent removed by its share limits', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 })], categories: removing }, { protect_all_torrents: true });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/share limits can remove it/);
        expect(h.posts).toEqual([]);
    });

    it('lets allow_removal override that, at the destructive tier, and says so', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 })], categories: removing }, { protect_all_torrents: true });
        const preview = await h.call('recheck_torrents', { ids: [HASH], allow_removal: true });
        expect(preview.structuredContent.tier).toBe('destructive');
        expect(preview.structuredContent.effects.join(' ')).toContain('Overrides the delete protection');
    });

    it('warns about the same removal on an instance that protects nothing', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 })], categories: removing }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.tier).toBe('safe');
        expect(preview.structuredContent.effects.join(' ')).toContain('removes this torrent and deletes its files');
    });

    it('asks nothing of a torrent already complete, which the rule applies to anyway', async () => {
        const h = harness({ categories: removing }, { protect_all_torrents: true });
        expect((await h.call('recheck_torrents', { ids: [HASH] })).structuredContent.confirm_token).toBeDefined();
    });

    it('waits for a verified torrent that moves before it stops', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'moving', 'stoppedUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ resumed: [HASH] });
    });

    it('reports a move that outlasts the watch as still under way', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'moving'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ still_moving: [HASH] });
        expect(applied.structuredContent.result).not.toHaveProperty('still_checking');
        expect(applied.structuredContent.summary).toContain('once get_queue no longer shows them at moving');
    });

    it('refuses a check that would retry a move to a save path outside the allowed roots', async () => {
        const h = harness({ torrents: [torrent({ save_path: '/mnt/legacy/movies' })] });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('says when a check will retry a move to the save path, and binds it', async () => {
        const h = harness({ torrents: [torrent({ save_path: '/data/media/movies' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.effects.join(' ')).toContain('moves');
        expect(preview.structuredContent.effects.join(' ')).toContain('to /data/media/movies, where it is configured to be');
        h.torrents[0]!.save_path = '/data/media/other';
        const late = await h.call('recheck_torrents', { ids: [HASH], confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
    });

    it('refuses a stopped torrent stored outside the roots, where a damaged piece would rename its file', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP', save_path: '/mnt/legacy', content_path: '/mnt/legacy/Some.Film/film.mkv' })] });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('refuses files really stored outside the roots, whatever the save path says', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP', content_path: '/mnt/stray/Some.Film/film.mkv' })] });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/outside the locations/);
    });

    it('does not let a token survive the files turning up somewhere else', async () => {
        const h = harness();
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        h.torrents[0]!.content_path = '/data/media/moved/Some.Film/film.mkv';
        const late = await h.call('recheck_torrents', { ids: [HASH], confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('judges each torrent of a batch by its own files', async () => {
        const h = harness({
            torrents: [torrent(), torrent({ hash: OTHER, content_path: '/data/torrents/movies' })],
            filesByHash: { [OTHER]: [{ name: 'a.mkv', size: 1, progress: 1 }, { name: 'sub/b.mkv', size: 1, progress: 1 }] }
        });
        const preview = await h.call('recheck_torrents', { ids: [HASH, OTHER] });
        expect(preview.structuredContent.effects.join(' ')).not.toContain('where it is configured to be');
    });

    it('skips a torrent that is being moved, and says when to check it', async () => {
        const h = harness({ torrents: [torrent(), torrent({ hash: OTHER, state: 'moving' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH, OTHER] });
        expect(preview.structuredContent.effects.join(' ')).toContain('being moved. Check it once the move has ended.');
        await h.call('recheck_torrents', { ids: [HASH, OTHER], confirm: preview.structuredContent.confirm_token });
        expect(h.posts).toEqual([{ path: '/torrents/recheck', form: { hashes: HASH } }]);
    });

    it('has nothing to do when the only torrent is being moved', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'moving' })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.noop).toBe(true);
    });

    it('reports a check that ended on an error as an error, not as a download', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 })], recheckStates: ['checkingDL', 'error'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ errored: [HASH] });
        expect(applied.structuredContent.result).not.toHaveProperty('incomplete');
        expect(applied.structuredContent.summary).not.toContain('downloading what is missing');
        expect(applied.structuredContent.summary).toContain('showing an error after the recheck was sent');
    });

    it('reports an error that was there at every read as an error', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 })], recheckStates: ['error'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ errored: [HASH] });
        expect(applied.structuredContent.result).not.toHaveProperty('unconfirmed');
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
    });

    it('keeps watching a complete torrent whose old error outlasts the grace period', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: [...Array<string>(14).fill('error'), 'checkingUP', 'stoppedUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ resumed: [HASH] });
        expect(applied.structuredContent.result).not.toHaveProperty('errored');
    });

    it('calls an error that clears with no check seen unconfirmed', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['error', 'stoppedUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ unconfirmed: [HASH] });
        expect(applied.structuredContent.result).not.toHaveProperty('errored');
    });

    it('does not settle on an old error the check then clears', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['error', 'checkingUP', 'stoppedUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ resumed: [HASH] });
    });

    it('names only the stray of a batch as moving to its save path', async () => {
        const h = harness({ torrents: [torrent(), torrent({ hash: OTHER, name: 'Stray.Film', save_path: '/data/media/movies' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH, OTHER] });
        const moves = preview.structuredContent.effects.filter(e => e.includes('where it is configured to be'));
        expect(moves).toHaveLength(1);
        expect(moves[0]).toContain('Stray.Film');
    });

    it.each(['missingFiles', 'stalledUP', 'downloading'])('refuses a torrent at %s that would write to a save path outside the roots', async state => {
        const h = harness({ torrents: [torrent({ state, save_path: '/mnt/legacy', content_path: '/mnt/legacy/Some.Film/film.mkv' })] });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('sees files one folder away from a save path above them as a move', async () => {
        const files = [{ name: 'a.mkv', size: 1, progress: 1 }, { name: 'sub/b.mkv', size: 1, progress: 1 }];
        const h = harness({ files, torrents: [torrent({ state: 'stoppedUP', save_path: '/data', content_path: '/data/torrents' })] });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/outside the locations/);
    });

    it('counts files in a sibling of the save path as away from it', async () => {
        const preview = await harness({ torrents: [torrent({ save_path: '/data/torrents/movies', content_path: '/data/torrents/movies-old/Some.Film/film.mkv' })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.effects.join(' ')).toContain('where it is configured to be');
    });

    it('does not report a torrent with no root folder at its save path as moving', async () => {
        const files = [{ name: 'a.mkv', size: 1, progress: 1 }, { name: 'sub/b.mkv', size: 1, progress: 1 }];
        const preview = await harness({ files, torrents: [torrent({ content_path: '/data/torrents/movies' })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.effects.join(' ')).not.toContain('where it is configured to be');
    });

    it('promises no move to the save path for a torrent using its incomplete folder', async () => {
        const preview = await harness({ torrents: [torrent({ amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.effects.join(' ')).not.toContain('where it is configured to be');
    });

    it('does not let a token survive a torrent going missing since the preview', async () => {
        const h = harness();
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        h.torrents[0]!.state = 'missingFiles';
        const late = await h.call('recheck_torrents', { ids: [HASH], confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(late.structuredContent.effects.join(' ')).toContain('downloads whatever the check does not find');
        expect(h.posts).toEqual([]);
    });

    it('lists a torrent seen only moving once, as still moving', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['moving'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ still_moving: [HASH] });
        expect(applied.structuredContent.result).not.toHaveProperty('unconfirmed');
        expect(applied.structuredContent.summary).toContain('`action: "resume"`');
    });

    it('reports a torrent that stopped moving and went on checking as still checking', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['moving', 'checkingUP'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toMatchObject({ still_checking: [HASH] });
    });

    it('warns that a running torrent at missing files downloads what the check does not find', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'missingFiles' })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.effects.join(' ')).toContain('unless it is stopped, qBittorrent downloads whatever the check does not find');
    });

    it('keeps a passkey in a torrent name out of a refusal and its audit row', async () => {
        const name = `https://tracker.example.org/owner's/${PASSKEY}/announce`;
        const h = harness({ torrents: [torrent({ name, state: 'stoppedDL', amount_left: 500, progress: 0.5 })], categories: removing }, { protect_all_torrents: true });
        const refusal = await h.call('recheck_torrents', { ids: [HASH] }).catch((err: Error) => err.message);
        expect(String(refusal)).toContain('share limits can remove it');
        expect(String(refusal)).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('guards a private torrent under protect_private_torrents', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 })], categories: removing }, { protect_private_torrents: true });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/share limits can remove it/);
    });

    it('guards a torrent whose own share limits would remove it', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5, share_limit_action: 'Remove', ratio_limit: 1 })] }, { protect_all_torrents: true });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/share limits can remove it/);
    });

    it('does not let a token survive a removal rule changing', async () => {
        const categories = { movies: { share_limit_action: 'Remove', ratio_limit: 3 } };
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 })], categories });
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        categories.movies.ratio_limit = 1;
        const late = await h.call('recheck_torrents', { ids: [HASH], confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('keeps the token valid for two removable torrents listed in another order', async () => {
        const rows = [torrent({ state: 'stoppedDL', amount_left: 500, progress: 0.5 }), torrent({ hash: OTHER, state: 'stoppedDL', amount_left: 500, progress: 0.5 })];
        const h = harness({ torrents: rows, categories: removing });
        const preview = await h.call('recheck_torrents', { ids: [HASH, OTHER] });
        rows.reverse();
        expect((await h.call('recheck_torrents', { ids: [HASH, OTHER], confirm: preview.structuredContent.confirm_token })).structuredContent.applied).toBe(true);
    });

    it('refuses a recheck that could send data outside the allowed roots', async () => {
        const h = harness({ torrents: [torrent({ download_path: '/mnt/scratch' })] });
        await expect(h.call('recheck_torrents', { ids: [HASH] })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('does not let a token survive the incomplete folder changing', async () => {
        const h = harness({ torrents: [torrent({ download_path: '/data/torrents/incomplete' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH] });
        h.torrents[0]!.download_path = '/data/media/incomplete';
        const late = await h.call('recheck_torrents', { ids: [HASH], confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('warns about the folder only for the torrents it will check', async () => {
        const h = harness({ torrents: [torrent(), torrent({ hash: OTHER, state: 'metaDL', has_metadata: false, download_path: '/mnt/scratch' })] });
        const preview = await h.call('recheck_torrents', { ids: [HASH, OTHER] });
        expect(preview.structuredContent.effects.join(' ')).not.toContain('/mnt/scratch');
    });

    it('polls quickly at first, so a small torrent is caught while it checks', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP'] });
        await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(h.sleeps.slice(0, 10)).toEqual(Array(10).fill(300));
        expect(h.sleeps.at(-1)).toBe(2000);
    });

    it('skips a stopped magnet that has no metadata', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'stoppedDL', has_metadata: false })] }).call('recheck_torrents', { ids: [HASH] });
        expect(preview.structuredContent.noop).toBe(true);
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
        expect(applied.structuredContent.result).toMatchObject({ resume_failed: [HASH], resume_error: expect.stringMatching(/500/) as unknown });
        expect(applied.content[0]?.text).toMatch(/could not be started \(.*\); start them with pause_downloads/);
    });

    /** The read in the lane is what the reply goes by, not what the watch saw earlier. */
    it('reports a torrent removed between the watch and the start as gone, not as unconfirmed', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP', null] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toEqual({ rechecking: [HASH], gone: [HASH] });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
    });

    it.each([
        ['error', 'errored'],
        ['moving', 'still_moving'],
        ...['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'downloading', 'stalledDL', 'queuedDL', 'forcedDL', 'metaDL', 'forcedMetaDL', 'allocating'].map(state => [state, 'already_running']),
        // A state it does not know is not taken for started.
        ['someNewState', 'unconfirmed']
    ])('reports a torrent the read before the start finds at %s as %s', async (state, key) => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP', state] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toEqual({ rechecking: [HASH], [key]: [HASH] });
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
    });

    it('starts nothing for a request cancelled while it reads the torrents again in the lane', async () => {
        const abort = new AbortController();
        const qb = fakeQbittorrent({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP'] });
        let reads = 0;
        // The third read after the recheck is the one in the lane, just before the start.
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes('/torrents/info') && qb.posts.length > 0 && ++reads === 3) abort.abort();
            return qb.impl(input, init);
        }) as typeof fetch;
        const cfg = config();
        type Reply = { structuredContent: { confirm_token?: string; applied: boolean; result?: unknown } };
        const handlers = new Map<string, (args: Record<string, unknown>, ctx?: unknown) => Promise<Reply>>();
        const server = {
            registerTool(name: string, c: { inputSchema: { parse(a: unknown): unknown } }, handler: (args: Record<string, unknown>, ctx?: unknown) => Promise<Reply>) {
                handlers.set(name, (args, ctx) => handler(c.inputSchema.parse(args) as Record<string, unknown>, ctx));
            }
        };
        registerTorrentTools(server as never, writeContext(instancesOf({ qbittorrent: cfg })), [new QbittorrentAdapter(cfg, impl)], { sleep: () => Promise.resolve() });
        const recheck = handlers.get('recheck_torrents');
        if (recheck === undefined) throw new Error('not registered');
        const args = { ids: [HASH], resume_if_complete: true };
        const preview = await recheck(args);
        const done = await recheck({ ...args, confirm: preview.structuredContent.confirm_token }, { mcpReq: { signal: abort.signal } });
        expect(done.structuredContent.result).toMatchObject({ resume_failed: [HASH], resume_error: 'the request was cancelled before they were started' });
        expect(qb.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
    });

    /** Cancelled before the start: nothing is started, and the reply comes from one more read, outside the lane. */
    it.each([
        ['still stopped', 'stopped', { resume_failed: [HASH], resume_error: 'the request was cancelled before this change was sent' }],
        ['started by something else', 'running', { already_running: [HASH] }],
        ['unreadable', 'failing', { resume_failed: [HASH], state_unread: expect.stringMatching(/500|broken/) as unknown }],
        ['not a list', 'malformed', { resume_failed: [HASH], state_unread: expect.any(String) as unknown }],
        ['listed without a hash', 'hashless', { resume_failed: [HASH], state_unread: expect.stringMatching(/no hash/) as unknown }],
        ['listed with an empty hash', 'empty hash', { resume_failed: [HASH], state_unread: expect.stringMatching(/not asked for/) as unknown }],
        ['listed under another hash', 'other hash', { resume_failed: [HASH], state_unread: expect.stringMatching(/not asked for/) as unknown }]
    ])('starts nothing for a request cancelled during the watch, and reports the torrent %s', async (_label, mode, expected) => {
        const t = torrent({ state: 'stoppedUP' });
        const qb = fakeQbittorrent({ torrents: [t], recheckStates: ['checkingUP', 'stoppedUP'] });
        const cfg = config();
        const abort = new AbortController();
        // After the abort, the watch's own read passes; the next is the one the reply comes from.
        let readsAfterAbort = 0;
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes('/torrents/info') && abort.signal.aborted && ++readsAfterAbort === 2) {
                if (mode === 'running') return jsonResponse([{ ...t, state: 'uploading' }]);
                if (mode === 'failing') return textResponse('broken', 500);
                if (mode === 'malformed') return jsonResponse({ error: 'not a list' });
                if (mode === 'hashless') return jsonResponse([{ error: 'unavailable' }]);
                if (mode === 'empty hash') return jsonResponse([{ ...t, hash: '' }]);
                if (mode === 'other hash') return jsonResponse([{ ...t, hash: OTHER }]);
            }
            return qb.impl(input, init);
        }) as typeof fetch;
        type Reply = { content: { text: string }[]; structuredContent: { confirm_token?: string; applied: boolean; result?: unknown } };
        const handlers = new Map<string, (args: Record<string, unknown>, ctx?: unknown) => Promise<Reply>>();
        const server = {
            registerTool(name: string, c: { inputSchema: { parse(a: unknown): unknown } }, handler: (args: Record<string, unknown>, ctx?: unknown) => Promise<Reply>) {
                handlers.set(name, (args, ctx) => handler(c.inputSchema.parse(args) as Record<string, unknown>, ctx));
            }
        };
        registerTorrentTools(server as never, writeContext(instancesOf({ qbittorrent: cfg })), [new QbittorrentAdapter(cfg, impl)], {
            // The caller goes while the watch waits.
            sleep: () => {
                abort.abort();
                return Promise.resolve();
            }
        });
        const recheck = handlers.get('recheck_torrents');
        if (recheck === undefined) throw new Error('not registered');
        const args = { ids: [HASH], resume_if_complete: true };
        const preview = await recheck(args);
        const done = await recheck({ ...args, confirm: preview.structuredContent.confirm_token }, { mcpReq: { signal: abort.signal } });
        expect(done.structuredContent.applied).toBe(true);
        expect(done.structuredContent.result).toMatchObject(expected);
        if (mode === 'running') expect(done.structuredContent.result).not.toHaveProperty('resume_failed');
        if (mode !== 'running') expect(done.structuredContent.result).not.toHaveProperty('gone');
        expect(qb.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
    });

    it('reads once more outside the lane when the read before the start fails, and starts nothing', async () => {
        const t = torrent({ state: 'stoppedUP' });
        const qb = fakeQbittorrent({ torrents: [t], recheckStates: ['checkingUP', 'stoppedUP'] });
        // After the recheck: the watch's two reads pass, the one in the lane fails, the one after it finds the torrent seeding.
        let readsAfterRecheck = 0;
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes('/torrents/info') && qb.posts.length > 0) {
                readsAfterRecheck += 1;
                if (readsAfterRecheck === 3) return textResponse('broken', 500);
                if (readsAfterRecheck === 4) return jsonResponse([{ ...t, state: 'uploading' }]);
            }
            return qb.impl(input, init);
        }) as typeof fetch;
        const cfg = config();
        const { server, call } = toolServer();
        registerTorrentTools(server, writeContext(instancesOf({ qbittorrent: cfg })), [new QbittorrentAdapter(cfg, impl)], { sleep: () => Promise.resolve() });
        const applied = await confirmed(call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toEqual({ rechecking: [HASH], already_running: [HASH] });
        expect(readsAfterRecheck).toBe(4);
        expect(qb.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
    });

    it('reports a torrent something else started before the start as already running, not unconfirmed', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedUP' })], recheckStates: ['checkingUP', 'stoppedUP', 'uploading'] });
        const applied = await confirmed(h.call, 'recheck_torrents', { ids: [HASH], resume_if_complete: true });
        expect(applied.structuredContent.result).toEqual({ rechecking: [HASH], already_running: [HASH] });
        expect(applied.content[0]?.text).toMatch(/already running when they were read for the start/);
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/recheck']);
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

    it('does not show a passkey a .torrent carries in its own name', async () => {
        const announce = `https://tracker.example.org/${PASSKEY}/announce`;
        const file = bencode({ announce, info: { length: 5, name: announce, 'piece length': 16384, pieces: 'x'.repeat(20) } });
        const preview = await harness().call('add_torrent', { torrent_base64: file.toString('base64'), save_path: '/data/torrents' });
        expect(JSON.stringify(preview)).not.toContain(PASSKEY);
        expect(preview.structuredContent.summary).toContain('https://tracker.example.org/...');
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

    it('binds the token to the category', async () => {
        const h = harness({ torrents: [] });
        const preview = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'movies', save_path: '/data/torrents' });
        const other = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'tv', save_path: '/data/torrents', confirm: preview.structuredContent.confirm_token });
        expect(other.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
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
        ['a path outside the allowed roots', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/etc' }, /^qbittorrent permission denied: \/etc is outside the locations/],
        ['a category that does not exist', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'nope' }, /^qbittorrent not found: qbittorrent has no such category/],
        ['two sources', { magnet: `magnet:?xt=urn:btih:${OTHER}`, url: 'https://a.example/x.torrent' }, /^qbittorrent invalid request: pass exactly one/],
        ['no source', { save_path: '/data/torrents' }, /^qbittorrent invalid request: pass exactly one/],
        ['a magnet with a line break', { magnet: `magnet:?xt=urn:btih:${OTHER}\nhttp://evil.example/x` }, /^qbittorrent invalid request: that is not a magnet link/],
        ['a line break after a valid topic', { magnet: `magnet:?xt=urn:btih:${OTHER}&dn=a\nhttp://evil.example/x` }, /not a magnet/],
        ['a URL with credentials', { url: 'https://u:p@a.example/x.torrent' }, /credentials/],
        ['a file that is not a torrent', { torrent_base64: Buffer.from('<html>').toString('base64') }, /not a valid \.torrent/],
        ['text that is not base64', { torrent_base64: 'not base64!' }, /^qbittorrent invalid request: `torrent_base64` is not valid base64/]
    ])('refuses %s, with a prefix that says why', async (_why, args, message) => {
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
        const h = harness({ addStatus: 400, addAnswer: JSON.stringify([{ errorMessage: `could not fetch ${url}` }]) });
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

    it('does not claim a torrent qBittorrent has already added is still being fetched', async () => {
        const applied = await confirmed(harness().call, 'add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' });
        expect(applied.structuredContent.summary).not.toContain('still fetching');
    });

    it('reads the hash from the magnet\'s real topic, not from text inside another field', async () => {
        const h = harness();
        const preview = await h.call('add_torrent', { magnet: `magnet:?dn=xt=urn:btih:${HASH}&xt=urn:btih:${OTHER}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.noop).toBe(false);
        expect(preview.structuredContent.target).toContain(OTHER);
    });

    it('refuses a magnet naming two different torrents', async () => {
        await expect(harness().call('add_torrent', { magnet: `magnet:?xt=urn:btih:${HASH}&xt=urn:btih:${OTHER}` })).rejects.toThrow(/not a magnet/);
    });

    it('says so when the client adds torrents stopped', async () => {
        const preview = await harness({ preferences: { add_stopped_enabled: true } }).call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.effects.join(' ')).toContain('Adds it stopped');
    });

    it.each([
        ['MetadataReceived', 'stops it once it has its metadata'],
        ['FilesChecked', 'stops it once its files are checked']
    ])('says when the client stops a new torrent at %s', async (condition, text) => {
        const preview = await harness({ preferences: { torrent_stop_condition: condition } }).call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.effects.join(' ')).toContain(text);
    });

    it('does not let a token survive the client changing how it adds torrents', async () => {
        const preferences: Record<string, unknown> = { add_stopped_enabled: false };
        const h = harness({ preferences });
        const args = { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' };
        const preview = await h.call('add_torrent', args);
        preferences.add_stopped_enabled = true;
        const late = await h.call('add_torrent', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('does not let a token survive the client changing its stop condition', async () => {
        const preferences: Record<string, unknown> = { torrent_stop_condition: 'None' };
        const h = harness({ preferences });
        const args = { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' };
        const preview = await h.call('add_torrent', args);
        preferences.torrent_stop_condition = 'MetadataReceived';
        const late = await h.call('add_torrent', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('does not repeat a tracker URL passed as an instance, in the refusal or the audit', async () => {
        const h = harness();
        const instance = `https://tracker.example.org/${PASSKEY}/announce`;
        const refusal = await h.call('reannounce_torrent', { id: HASH, instance }).catch((err: Error) => err.message);
        expect(String(refusal)).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('does not repeat a tracker URL passed as a category, in the refusal or the audit', async () => {
        const h = harness();
        const category = `https://tracker.example.org/${PASSKEY}/announce`;
        const refusal = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category }).catch((err: Error) => err.message);
        expect(String(refusal)).toContain('no such category');
        expect(String(refusal)).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('does not let an override token survive a torrent ceasing to need it', async () => {
        const categories: Record<string, Record<string, unknown>> = { movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: 'Remove', ratio_limit: 1 } };
        const h = harness({ categories }, { protect_all_torrents: true });
        const args = { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'purge', allow_removal: true };
        const preview = await h.call('add_torrent', args);
        categories.purge!.share_limit_action = 'Stop';
        const late = await h.call('add_torrent', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('warns when the category it joins removes torrents at its limits', async () => {
        const categories = { movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: 'Remove', ratio_limit: 1 } };
        const preview = await harness({ categories }).call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'purge' });
        expect(preview.structuredContent.effects[0]).toContain('removes this torrent');
    });

    it('treats a magnet whose private flag is unknown as protected', async () => {
        const categories = { movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: 'Remove', ratio_limit: 1 } };
        const h = harness({ categories }, { protect_private_torrents: true });
        await expect(h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'purge' })).rejects.toThrow(/removes torrents at its share limits/);
    });

    it('does not let a token survive the category starting to remove torrents', async () => {
        const categories: Record<string, Record<string, unknown>> = { movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: 'Stop', ratio_limit: 1 } };
        const h = harness({ categories });
        const args = { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'purge' };
        const preview = await h.call('add_torrent', args);
        categories.purge!.share_limit_action = 'RemoveWithContent';
        const late = await h.call('add_torrent', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('does not let a token survive a tighter limit on the category it joins', async () => {
        const categories: Record<string, Record<string, unknown>> = { movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: 'Remove', ratio_limit: 3 } };
        const h = harness({ categories });
        const args = { magnet: `magnet:?xt=urn:btih:${OTHER}`, category: 'purge' };
        const preview = await h.call('add_torrent', args);
        categories.purge!.ratio_limit = 1;
        const late = await h.call('add_torrent', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('names the web seeds and sources a magnet makes the client contact', async () => {
        const magnet = `magnet:?xt=urn:btih:${OTHER}&ws=https%3A%2F%2Fseed.example%2Fa&xs=https%3A%2F%2Fsource.example%2Fb&as=https%3A%2F%2Falt.example%2Fc`;
        const preview = await harness().call('add_torrent', { magnet, save_path: '/data/torrents' });
        expect(preview.structuredContent.effects.join(' ')).toContain('seed.example, source.example, alt.example');
    });

    it('refuses to put a torrent the instance protects in such a category', async () => {
        const categories = { movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: 'Remove', ratio_limit: 1 } };
        const file = bencode({ info: { length: 5, name: 'Private.mkv', 'piece length': 16384, pieces: 'x'.repeat(20), private: 1 } });
        const h = harness({ categories }, { protect_private_torrents: true });
        await expect(h.call('add_torrent', { torrent_base64: file.toString('base64'), category: 'purge' })).rejects.toThrow(/removes torrents at its share limits/);
        const allowed = await h.call('add_torrent', { torrent_base64: file.toString('base64'), category: 'purge', allow_removal: true });
        expect(allowed.structuredContent.tier).toBe('destructive');
        expect(allowed.structuredContent.effects[0]).toContain('Overrides the delete protection');
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
        expect(applied.structuredContent.summary).toContain('Any file of it left in /data/torrents/movies may still be moving to /data/media/movies in the background');
        expect(applied.structuredContent.summary).toContain('before running recheck_torrents');
        expect(h.posts).toEqual([{ path: '/torrents/setLocation', form: { hashes: HASH, location: '/data/media/movies' } }]);
    });

    it('refuses to move existing data unless move_files is passed', async () => {
        const h = harness();
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(/^qbittorrent permission denied: .* would move it/);
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

    it('needs move_files for a finished torrent that kept an incomplete folder setting', async () => {
        const h = harness({ torrents: [torrent({ download_path: '/data/torrents/incomplete' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(/would move it/);
    });

    it('needs move_files for a finished torrent still sitting in that folder', async () => {
        const h = harness({ torrents: [torrent({ download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(/would move it/);
    });

    it('recognises unfinished data of a torrent with no root folder', async () => {
        const files = [{ name: 'a.mkv', size: 1, progress: 0.5 }, { name: 'sub/b.mkv', size: 1, progress: 0.5 }];
        const h = harness({ files, torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.tier).toBe('safe');
        expect(preview.structuredContent.effects[0]).toContain('leaves its unfinished data where it is');
    });

    it('names both folders for a magnet using the incomplete folder, and does not ask for a recheck', async () => {
        const h = harness({ torrents: [torrent({ state: 'metaDL', has_metadata: false, amount_left: 0, download_path: '/data/torrents/incomplete', content_path: '' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.effects).toContain(
            'It has no metadata yet, so nothing is on disk. qBittorrent downloads it into /data/torrents/incomplete and moves it to /data/media/movies once the download finishes.'
        );
        expect(preview.structuredContent.effects.join(' ')).not.toContain('recheck_torrents');
    });

    it('says where unfinished data is set to be kept when its folder cannot be told', async () => {
        const h = harness({ files: [], torrents: [torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.effects[0]).toBe(
            'qBittorrent leaves its unfinished data where it is, which it is set to keep in /data/torrents/incomplete, and saves it in /data/media/movies once the download finishes.'
        );
    });

    it('promises no stay when the new path is the configured folder but where the files are cannot be told', async () => {
        const h = harness({ files: [], torrents: [torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/torrents/incomplete' });
        expect(preview.structuredContent.effects[0]).toBe(
            'qBittorrent leaves its unfinished data where it is, which it is set to keep in /data/torrents/incomplete, and saves it there once the download finishes.'
        );
    });

    it('promises no second move for a gathered torrent pointed at the folder it is gathered into', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete' })] });
        const args = { id: HASH, location: '/data/torrents/incomplete', move_files: true };
        const preview = await h.call('set_torrent_location', args);
        expect(preview.structuredContent.summary).toMatch(/^Move \S+ to \/data\/torrents\/incomplete on qbittorrent, where it stays once it finishes\.$/);
        expect(preview.structuredContent.effects[1]).toBe('qBittorrent keeps them there once the download finishes.');
        const applied = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.summary).toContain('moves the files to /data/torrents/incomplete in the background. They stay there once the torrent finishes.');
    });

    it('promises no second move when the new path is where the unfinished data already is', async () => {
        const h = harness({ torrents: [torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/torrents/incomplete' });
        expect(preview.structuredContent.effects[0]).toBe('qBittorrent leaves its unfinished data where it is, in /data/torrents/incomplete, and keeps it there once the download finishes.');
    });

    it('moves nothing for a manual torrent that is unfinished, wherever its files are', async () => {
        const h = harness({ torrents: [torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.tier).toBe('safe');
        expect(preview.structuredContent.effects[0]).toContain('leaves its unfinished data where it is');
    });

    it('needs move_files when dropping automatic management would gather stray files into the folder', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(/would move it/);
        const args = { id: HASH, location: '/data/media/movies', move_files: true };
        const preview = await h.call('set_torrent_location', args);
        expect(preview.structuredContent.summary).toContain('to /data/torrents/incomplete now, and on to /data/media/movies once it finishes');
        expect(preview.structuredContent.effects[0]).toContain('first moves its files to /data/torrents/incomplete');
        expect(preview.structuredContent.effects[1]).toBe('qBittorrent moves them on from /data/torrents/incomplete to /data/media/movies once the download finishes.');
        expect(preview.structuredContent.effects.join(' ')).not.toContain('leaves its unfinished data');
        const applied = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.summary).toContain('moves the files to /data/torrents/incomplete in the background. They move on to the new location once the torrent finishes.');
    });

    it('treats a finished torrent whose storage went missing as finished', async () => {
        const h = harness({ torrents: [torrent({ state: 'missingFiles', amount_left: 1000, completion_on: 1_700_000_000, download_path: '/data/torrents/incomplete' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.effects[0]).toContain('any file of this torrent still at its old path moves too');
        expect(preview.structuredContent.effects.join(' ')).toContain('recheck_torrents');
    });

    it('treats a torrent at missing files that never finished as unfinished', async () => {
        const h = harness({ torrents: [torrent({ state: 'missingFiles', amount_left: 500, completion_on: -1, download_path: '/data/torrents/incomplete' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        // Not "leaves it where it is, in ...": qBittorrent reports it missing from there.
        expect(preview.structuredContent.effects[0]).toBe(
            'qBittorrent reports its unfinished data missing from /data/torrents/movies. /data/media/movies only becomes where it goes once the download finishes.'
        );
    });

    it('does not name the incomplete folder as where unfinished data went missing when its folder cannot be told', async () => {
        const h = harness({ files: [], torrents: [torrent({ state: 'missingFiles', amount_left: 500, completion_on: -1, download_path: '/data/torrents/incomplete', content_path: '' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.effects[0]).toBe(
            'qBittorrent reports its unfinished data missing; it is set to keep it in /data/torrents/incomplete. /data/media/movies only becomes where it goes once the download finishes.'
        );
    });

    it('promises no definite move when an unfinished torrent at missing files is gathered first', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'missingFiles', amount_left: 500, completion_on: -1, download_path: '/data/torrents/incomplete' })] });
        const args = { id: HASH, location: '/data/media/movies', move_files: true };
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(/is at missing files, and turning off automatic management first moves any file of it that is left/);
        const preview = await h.call('set_torrent_location', args);
        expect(preview.structuredContent.summary).toMatch(/^Move any file of .* that is left to \/data\/torrents\/incomplete now, and on to \/data\/media\/movies once it finishes/);
        expect(preview.structuredContent.effects[0]).toBe('Turning off automatic management first moves any file of it that is left to /data/torrents/incomplete.');
        expect(preview.structuredContent.effects[1]).toBe('qBittorrent moves them on from /data/torrents/incomplete to /data/media/movies once the download finishes.');
        const applied = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.summary).toBe(
            `qBittorrent accepted this for qbittorrent:${HASH}. Any file of it that is left may still be moving to /data/torrents/incomplete in the background. They move on to the new location once the torrent finishes.`
        );
    });

    it('names a magnet\'s incomplete folder once when it is also the new path', async () => {
        const h = harness({ torrents: [torrent({ state: 'metaDL', has_metadata: false, amount_left: 0, download_path: '/data/torrents/incomplete', content_path: '' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/torrents/incomplete' });
        expect(preview.structuredContent.effects).toContain('It has no metadata yet, so nothing is on disk. qBittorrent downloads it into /data/torrents/incomplete and keeps it there once the download finishes.');
    });

    it('keeps a torrent unfinished when it finished once and a later check found it incomplete', async () => {
        const h = harness({ torrents: [torrent({ state: 'stoppedDL', amount_left: 500, completion_on: 1_700_000_000, download_path: '/data/torrents/incomplete' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.effects[0]).toContain('leaves its unfinished data where it is');
    });

    it('repoints an automatic magnet with no metadata without move_files', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'metaDL', has_metadata: false, amount_left: 0, download_path: '/data/torrents/incomplete', content_path: '' })] });
        expect((await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).structuredContent.tier).toBe('safe');
    });

    it('checks the save path a finished torrent is gathered into before it moves on', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, save_path: '/mnt/archive/tv', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/tv', move_files: true })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('names and binds the save path a finished torrent is gathered into', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, save_path: '/data/torrents/tv', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        const args = { id: HASH, location: '/data/media/tv', move_files: true };
        const preview = await h.call('set_torrent_location', args);
        expect(preview.structuredContent.effects[0]).toContain('first moves its files to /data/torrents/tv');
        // The second hop starts where the gather left the files.
        expect(preview.structuredContent.effects[1]).toMatch(
            /^Physically moves \S+ GB on from \/data\/torrents\/tv to \/data\/media\/tv\. Hardlinks into the library break if either move crosses a filesystem\.$/
        );
        h.torrents[0]!.save_path = '/data/media/other';
        const late = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('refuses to gather stray files into a folder outside the allowed roots', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500, download_path: '/mnt/scratch' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true })).rejects.toThrow(/outside the locations/);
    });

    it('says a magnet with no metadata has nothing on disk, and does not suggest a recheck', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'metaDL', has_metadata: false, content_path: '' })] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.effects[0]).toContain('nothing on disk to move');
        expect(preview.structuredContent.effects.join(' ')).not.toContain('recheck_torrents');
    });

    it.each(['checkingUP', 'checkingDL', 'checkingResumeData'])('refuses a torrent at %s, whose data cannot be located yet', async state => {
        const h = harness({ torrents: [torrent({ state, amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true })).rejects.toThrow(/being checked/);
    });

    it('treats a stopped magnet with no metadata as having nothing to move', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'stoppedDL', has_metadata: false, completed: 0 })] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('leaves unfinished data in the incomplete-downloads folder, and says so', async () => {
        const h = harness({ torrents: [torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.summary).toContain('where its data goes once the download finishes');
        expect(preview.structuredContent.effects[0]).toBe(
            'qBittorrent leaves its unfinished data where it is, in /data/torrents/incomplete, and moves it to /data/media/movies once the download finishes.'
        );
        const applied = await confirmed(h.call, 'set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(applied.structuredContent.effects[0]).toContain('leaves its unfinished data where it is');
        expect(applied.structuredContent.summary).not.toContain('moving');
    });

    it('refuses while the torrent is already moving', async () => {
        const h = harness({ torrents: [torrent({ state: 'moving' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true })).rejects.toThrow(/^qbittorrent invalid request: that torrent is already being moved/);
    });

    it('says that a file still at the old path moves too', async () => {
        const preview = await harness({ torrents: [missing] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.summary).toMatch(/^Point \S+ at \/data\/media\/movies on qbittorrent, moving any file of it that is left\.$/);
        expect(preview.structuredContent.effects[0]).toContain('any file of this torrent still at its old path moves too');
    });

    it('promises no move or recheck for a torrent at missing files that has no metadata', async () => {
        const h = harness({ files: [], torrents: [torrent({ state: 'missingFiles', has_metadata: false, content_path: '' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' });
        expect(preview.structuredContent.summary).toMatch(/^Point \S+ at \/data\/media\/movies on qbittorrent\.$/);
        expect(preview.structuredContent.effects).toContain('It has no metadata yet, so there is nothing on disk to move.');
        expect(preview.structuredContent.effects.join(' ')).not.toContain('recheck_torrents');
        const applied = await h.call('set_torrent_location', { id: HASH, location: '/data/media/movies', confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.summary).not.toContain('may still be moving');
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

    it('needs move_files to repoint a missing torrent whose old folder is outside the roots', async () => {
        const h = harness({ torrents: [torrent({ state: 'missingFiles', save_path: '/downloads', content_path: '/downloads/Some.Film/film.mkv' })] });
        const args = { id: HASH, location: '/data/media/movies' };
        await expect(h.call('set_torrent_location', args)).rejects.toThrow(/^qbittorrent permission denied: any file of .* still in \/downloads would move too/);
        expect(h.posts).toEqual([]);
        const applied = await confirmed(h.call, 'set_torrent_location', { ...args, move_files: true });
        expect(applied.structuredContent.tier).toBe('destructive');
        expect(applied.structuredContent.summary).toContain('Any file of it left in /downloads may still be moving to /data/media/movies');
        expect(applied.structuredContent.effects[0]).toContain('missing from /downloads');
        expect(h.posts.map(p => p.path)).toEqual(['/torrents/setLocation']);
    });

    it('warns after confirm that files left at the old path may still be moving, also when they are gathered first', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'missingFiles', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies' })).rejects.toThrow(
            /^qbittorrent permission denied: .* is at missing files, and turning off automatic management first moves any file of it that is left to \/data\/torrents\/movies/
        );
        const applied = await confirmed(h.call, 'set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true });
        expect(applied.structuredContent.effects[0]).toBe('Turning off automatic management first moves any file of it that is left to /data/torrents/movies.');
        expect(h.posts).toHaveLength(1);
        expect(applied.structuredContent.summary).toContain(
            'Any file of it left in /data/torrents/incomplete may still be moving to /data/media/movies in the background, so wait until get_queue no longer shows it at `moving` before running recheck_torrents.'
        );
    });

    it('says "the old path" rather than the gather folder when a gathered missing torrent\'s folder cannot be told', async () => {
        const h = harness({ files: [], torrents: [torrent({ auto_tmm: true, state: 'missingFiles', content_path: '' })] });
        const applied = await confirmed(h.call, 'set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true });
        expect(applied.structuredContent.effects[0]).toContain('first moves any file of it that is left to /data/torrents/movies');
        expect(applied.structuredContent.summary).toContain('Any file of it left at the old path may still be moving to /data/media/movies');
    });

    it('binds the save path a missing torrent is repointed from when its folder cannot be told', async () => {
        const h = harness({ files: [], torrents: [torrent({ state: 'missingFiles', content_path: '' })] });
        const args = { id: HASH, location: '/data/media/movies' };
        const preview = await h.call('set_torrent_location', args);
        // Its save path, not a folder qBittorrent reported the data missing from.
        expect(preview.structuredContent.effects[0]).toContain('reports its data missing; its save path is /data/torrents/movies.');
        h.torrents[0]!.save_path = '/data/torrents/other';
        const late = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(late.structuredContent.effects[0]).toContain('its save path is /data/torrents/other');
        expect(h.posts).toEqual([]);
        const applied = await h.call('set_torrent_location', { ...args, confirm: late.structuredContent.confirm_token });
        expect(applied.structuredContent.summary).toContain('Any file of it left at the old path may still be moving to /data/media/movies');
        expect(applied.structuredContent.summary).not.toContain('/data/torrents/other');
    });

    it.each([
        ['the incomplete folder a magnet will download into', torrent({ state: 'metaDL', has_metadata: false, amount_left: 0, download_path: '/data/torrents/incomplete', content_path: '' }), false, (t: Record<string, unknown>) => (t.download_path = '/data/torrents/incomplete2')],
        ['the configured folder a move names when the real one cannot be told', torrent({ content_path: '' }), true, (t: Record<string, unknown>) => (t.save_path = '/data/torrents/other')],
        ['the folder unfinished data is in', torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' }), false, (t: Record<string, unknown>) => (t.content_path = '/data/torrents/elsewhere/Some.Film/film.mkv')]
    ])('binds %s in the token', async (_what, t, move_files, change) => {
        const h = harness({ ...(t.content_path === '' ? { files: [] } : {}), torrents: [t] });
        const args = { id: HASH, location: '/data/media/movies', move_files };
        const preview = await h.call('set_torrent_location', args);
        change(h.torrents[0] as unknown as Record<string, unknown>);
        const late = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('binds the folder a missing torrent is repointed from', async () => {
        const h = harness({ torrents: [torrent({ state: 'missingFiles' })] });
        const args = { id: HASH, location: '/data/media/movies' };
        const preview = await h.call('set_torrent_location', args);
        h.torrents[0]!.content_path = '/data/media/other/Some.Film/film.mkv';
        const late = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('names the folder the files really leave', async () => {
        const preview = await harness({ torrents: [torrent({ content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true });
        expect(preview.structuredContent.effects.join(' ')).toContain('from /data/torrents/incomplete to /data/media/movies');
    });

    it('refuses to move files out of a folder outside the allowed roots', async () => {
        const h = harness({ torrents: [torrent({ save_path: '/downloads', content_path: '/downloads/Some.Film/film.mkv' })] });
        await expect(h.call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('does not let a token survive the files turning up somewhere else before a move', async () => {
        const h = harness();
        const args = { id: HASH, location: '/data/media/movies', move_files: true };
        const preview = await h.call('set_torrent_location', args);
        h.torrents[0]!.content_path = '/data/media/other/Some.Film/film.mkv';
        const late = await h.call('set_torrent_location', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
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
        await expect(h.call('set_torrent_location', { id: HASH, location: '/etc/x', move_files: true })).rejects.toThrow(/^qbittorrent permission denied: \/etc\/x is outside the locations/);
        await expect(h.call('set_torrent_location', { id: HASH, location: 'data/media', move_files: true })).rejects.toThrow(/^qbittorrent invalid request: that path is not absolute/);
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

    it('says it is the save path that is already set, not where the files are', async () => {
        const h = harness({ torrents: [torrent({ state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })] });
        const preview = await h.call('set_torrent_location', { id: HASH, location: '/data/torrents/movies' });
        expect(preview.structuredContent.noop).toBe(true);
        expect(preview.structuredContent.summary).toMatch(/^The save path of .* is already \/data\/torrents\/movies\.$/);
    });

    it('does not repeat the save path after gathering files whose folder cannot be told', async () => {
        const preview = await harness({ files: [], torrents: [torrent({ auto_tmm: true, content_path: '' })] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true });
        const effects = preview.structuredContent.effects.join(' ');
        expect(effects).toContain('Turning off automatic management first moves its files to /data/torrents/movies.');
        expect(effects).toContain('on from /data/torrents/movies to /data/media/movies');
        expect(effects).not.toContain('Where its files are now cannot be told');
    });

    it('does not call the save path the source when where the files are cannot be told', async () => {
        const preview = await harness({ files: [], torrents: [torrent({ content_path: '', save_path: '/data/torrents/movies/' })] }).call('set_torrent_location', { id: HASH, location: '/data/media/movies', move_files: true });
        const effects = preview.structuredContent.effects.join(' ');
        expect(effects).toContain('to /data/media/movies. Where its files are now cannot be told; it is set to keep them in /data/torrents/movies.');
        expect(effects).not.toContain('from /data/torrents/movies');
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
        ['still downloading', { download_path: '/incomplete', amount_left: 100 }]
    ])('refuses a torrent %s outside the allowed roots', async (_why, over) => {
        const h = harness({ torrents: [torrent(over)] });
        await expect(h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Some.Film/renamed.mkv' })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('refuses a torrent whose files really sit outside the allowed roots', async () => {
        const h = harness({ torrents: [torrent({ content_path: '/incomplete/Some.Film/film.mkv' })] });
        await expect(h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Some.Film/renamed.mkv' })).rejects.toThrow(/outside the locations/);
    });

    it('ignores a stale incomplete folder of a finished torrent whose data went missing', async () => {
        const h = harness({ torrents: [torrent({ state: 'missingFiles', amount_left: 1000, completion_on: 1_700_000_000, download_path: '/incomplete' })] });
        const preview = await h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Some.Film/renamed.mkv' });
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('refuses a magnet pasted as the new name without repeating it', async () => {
        const h = harness({ files: [{ name: 'film.mkv', size: 1, progress: 1 }], torrents: [torrent({ content_path: '/data/torrents/movies/film.mkv' })] });
        const new_path = `magnet:?xt=urn:btih:${OTHER}&tr=https%3A%2F%2Ftracker.example%2F${PASSKEY}%2Fannounce`;
        const refusal = await h.call('rename_torrent_file', { id: HASH, old_path: 'film.mkv', new_path }).catch((err: Error) => err.message);
        expect(String(refusal)).toContain('is a URL');
        expect(String(refusal)).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('accepts the fenced name get_queue lists, and sends the plain one', async () => {
        const h = harness();
        const fenced = fenceText('Some.Film/film.mkv', { service: 'qbittorrent', field: 'file' });
        await confirmed(h.call, 'rename_torrent_file', { id: HASH, old_path: fenced, new_path: fenceText('Some.Film/renamed.mkv', { service: 'qbittorrent', field: 'file' }) });
        expect(h.posts[0]!.form).toMatchObject({ oldPath: 'Some.Film/film.mkv', newPath: 'Some.Film/renamed.mkv' });
    });

    it('ignores the incomplete folder of a torrent that has finished', async () => {
        const h = harness({ torrents: [torrent({ download_path: '/incomplete' })] });
        const preview = await h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Some.Film/renamed.mkv' });
        expect(preview.structuredContent.confirm_token).toBeDefined();
    });

    it('says not found only for a file the torrent really lacks', async () => {
        const h = harness();
        await expect(h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/gone.mkv', new_path: 'Some.Film/x.mkv' })).rejects.toThrow(/^qbittorrent not found: that torrent has no such file/);
        await expect(h.call('rename_torrent_file', { id: HASH, old_path: 'Some.Film/film.mkv', new_path: 'Other/film.mkv' })).rejects.toThrow(/^qbittorrent invalid request: `new_path` would leave/);
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
        // A policy refusal, not a missing instance, and it names both ends of the move.
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(
            /^qbittorrent permission denied: that category would move .* from \/data\/torrents\/movies to \/data\/torrents\/tv/
        );
        const moved = await confirmed(h.call, 'set_torrent_category', { id: HASH, category: 'tv', move_files: true });
        expect(moved.structuredContent.effects.join(' ')).toContain('from /data/torrents/movies to /data/torrents/tv');
    });

    it('does not call the configured folder the source when where the files are cannot be told', async () => {
        const h = harness({ files: [], torrents: [torrent({ auto_tmm: true, content_path: '' })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(
            /^qbittorrent permission denied: that category would move \S+ to \/data\/torrents\/tv, and where its files are now cannot be told; it is set to keep them in \/data\/torrents\/movies/
        );
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true });
        expect(preview.structuredContent.effects.join(' ')).toContain(
            "to /data/torrents/tv, because qBittorrent manages this torrent's path by category. Where its files are now cannot be told; it is set to keep them in /data/torrents/movies."
        );
        expect(preview.structuredContent.effects.join(' ')).not.toContain('from /data/torrents/movies');
    });

    it('does not call the configured incomplete folder the source of unfinished data whose folder cannot be told', async () => {
        const h = harness({
            files: [],
            torrents: [torrent({ auto_tmm: true, state: 'downloading', amount_left: 500, download_path: '/data/torrents/incomplete', content_path: '' })],
            preferences: { torrent_changed_tmm_enabled: true, temp_path_enabled: false, max_ratio_act: 0 },
            categories: { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: '/data/torrents/incomplete/tv' } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/^qbittorrent permission denied: that category would move \S+ to \/data\/torrents\/incomplete\/tv, and where its files are now cannot be told; it is set to keep them in \/data\/torrents\/incomplete\. Nothing was changed/);
        // The token binds the folder the preview names, so a change to it asks for a new preview.
        const args = { id: HASH, category: 'tv', move_files: true };
        const preview = await h.call('set_torrent_category', args);
        expect(preview.structuredContent.effects.join(' ')).toContain('it is set to keep them in /data/torrents/incomplete.');
        expect(preview.structuredContent.effects.join(' ')).not.toContain('from /data/torrents/incomplete');
        h.torrents[0]!.download_path = '/data/torrents/incomplete2';
        const late = await h.call('set_torrent_category', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(late.structuredContent.effects.join(' ')).toContain('it is set to keep them in /data/torrents/incomplete2.');
        expect(h.posts).toEqual([]);
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

    const downloading = (over = {}) => torrent({ auto_tmm: true, state: 'downloading', amount_left: 500, ...over });
    const prefs = (over = {}) => ({ torrent_changed_tmm_enabled: true, temp_path_enabled: false, temp_path: '/data/torrents/incomplete', max_ratio_act: 0, ...over });

    it('needs move_files when unfinished data would go to the global incomplete folder', async () => {
        const h = harness({ torrents: [downloading()], preferences: prefs({ temp_path_enabled: true }) });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/would move/);
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true });
        expect(preview.structuredContent.effects.join(' ')).toContain('/data/torrents/incomplete/tv');
    });

    it('refuses unfinished data going to a category folder outside the allowed roots', async () => {
        const h = harness({ torrents: [downloading()], preferences: prefs(), categories: { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: '/mnt/scratch/incomplete' } } });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('follows a folder a subcategory inherits from its parent', async () => {
        const h = harness({
            torrents: [downloading()],
            preferences: prefs(),
            categories: { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: '/mnt/scratch/incomplete' }, 'tv/hd': { savePath: '/data/torrents/movies', download_path: null } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv/hd', move_files: true })).rejects.toThrow(/outside the locations/);
    });

    it('leaves unfinished data alone when both categories use the same folder, and says where it goes later', async () => {
        const h = harness({
            torrents: [downloading({ download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })],
            preferences: prefs(),
            categories: { movies: { savePath: '/data/torrents/movies', download_path: '/data/torrents/incomplete' }, tv: { savePath: '/data/torrents/tv', download_path: '/data/torrents/incomplete' } }
        });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv' });
        expect(preview.structuredContent.tier).toBe('safe');
        expect(preview.structuredContent.effects.join(' ')).toContain('goes to /data/torrents/tv once finished');
    });

    it('needs move_files when the files are not in the folder the torrent is set to use', async () => {
        const h = harness({
            torrents: [downloading({ download_path: '/data/torrents/incomplete' })],
            preferences: prefs(),
            categories: { movies: { savePath: '/data/torrents/movies', download_path: '/data/torrents/incomplete' }, tv: { savePath: '/data/torrents/tv', download_path: '/data/torrents/incomplete' } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/would move/);
    });

    it('needs move_files for a torrent with no root folder going up to a parent directory', async () => {
        const files = [{ name: 'a.mkv', size: 1, progress: 1 }, { name: 'sub/b.mkv', size: 1, progress: 1 }];
        const h = harness({ files, torrents: [torrent({ auto_tmm: true, content_path: '/data/torrents/movies' })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: '' })).rejects.toThrow(/would move/);
    });

    it('sees a single file in a folder as already in place', async () => {
        const h = harness({
            torrents: [downloading({ download_path: '/data/torrents/incomplete', content_path: '/data/torrents/incomplete/Some.Film/film.mkv' })],
            preferences: prefs(),
            categories: { movies: { download_path: '/data/torrents/incomplete' }, tv: { savePath: '/data/torrents/tv', download_path: '/data/torrents/incomplete' } }
        });
        expect((await h.call('set_torrent_category', { id: HASH, category: 'tv' })).structuredContent.tier).toBe('safe');
    });

    it('lets a manual torrent stored outside the roots change category, since nothing moves', async () => {
        const h = harness({ torrents: [torrent({ save_path: '/downloads', content_path: '/downloads/Some.Film/film.mkv' })] });
        expect((await h.call('set_torrent_category', { id: HASH, category: 'tv' })).structuredContent.tier).toBe('safe');
    });

    it('does not let a category token survive where the files are becoming unknown', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true })] });
        const args = { id: HASH, category: 'tv', move_files: true };
        const preview = await h.call('set_torrent_category', args);
        expect(preview.structuredContent.effects.join(' ')).toContain('from /data/torrents/movies to /data/torrents/tv');
        h.torrents[0]!.content_path = '';
        const late = await h.call('set_torrent_category', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(late.structuredContent.effects.join(' ')).toContain('Where its files are now cannot be told');
        expect(h.posts).toEqual([]);
    });

    it('does not let a category token survive the files turning up somewhere else', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true })] });
        const args = { id: HASH, category: 'tv', move_files: true };
        const preview = await h.call('set_torrent_category', args);
        h.torrents[0]!.content_path = '/data/media/other/Some.Film/film.mkv';
        const late = await h.call('set_torrent_category', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('refuses a category move that would empty a folder outside the allowed roots', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, save_path: '/downloads', content_path: '/downloads/Some.Film/film.mkv' })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/outside the locations/);
        expect(h.posts).toEqual([]);
    });

    it('refuses while an automatically managed torrent is being moved', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'moving' })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/^qbittorrent invalid request: that torrent is being moved or checked/);
    });

    it('needs move_files when switching to manual would gather stray files first', async () => {
        const h = harness({
            torrents: [downloading({ download_path: '/data/torrents/incomplete' })],
            preferences: prefs({ torrent_changed_tmm_enabled: false })
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/would move/);
    });

    it('asks no move_files of a magnet, which has nothing to move, and names where it will download', async () => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true, state: 'metaDL', has_metadata: false, amount_left: 0, content_path: '' })],
            preferences: prefs(),
            categories: { movies: {}, tv: { savePath: '/data/torrents/tv' } }
        });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv' });
        expect(preview.structuredContent.tier).toBe('safe');
        expect(preview.structuredContent.effects.join(' ')).toContain('will download to /data/torrents/tv');
    });

    it('checks the incomplete folder of a magnet that has no metadata yet', async () => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true, state: 'metaDL', has_metadata: false, amount_left: 0, content_path: '' })],
            preferences: prefs(),
            categories: { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: '/mnt/scratch/odd' } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/outside the locations/);
    });

    it('binds where the data goes once finished, also when it moves now', async () => {
        const categories = { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: '/data/torrents/incomplete/tv' } };
        const h = harness({ torrents: [downloading()], preferences: prefs(), categories });
        const args = { id: HASH, category: 'tv', move_files: true };
        const preview = await h.call('set_torrent_category', args);
        expect(preview.structuredContent.effects.join(' ')).toContain('It goes to /data/torrents/tv once finished.');
        categories.tv.savePath = '/data/media/tv';
        const late = await h.call('set_torrent_category', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('takes unfinished data to the save path when the category is cleared and no folder applies', async () => {
        const h = harness({ torrents: [downloading()], preferences: prefs() });
        const preview = await h.call('set_torrent_category', { id: HASH, category: '', move_files: true });
        expect(preview.structuredContent.effects.join(' ')).toContain('to /data/torrents,');
    });

    it('still checks the save path of a category that keeps unfinished data where it is', async () => {
        const h = harness({
            torrents: [downloading({ download_path: '/data/torrents/incomplete' })],
            preferences: prefs(),
            categories: { movies: {}, tv: { savePath: '/mnt/elsewhere', download_path: '/data/torrents/incomplete' } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/outside the locations/);
    });

    it('lets a category that opts out of the folder take the data to its save path', async () => {
        const h = harness({
            torrents: [downloading()],
            preferences: prefs({ temp_path_enabled: true }),
            categories: { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: false } }
        });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true });
        expect(preview.structuredContent.effects.join(' ')).toContain('to /data/torrents/tv');
        expect(preview.structuredContent.effects.join(' ')).not.toContain('once finished');
    });

    it('names where a magnet will download when the change only switches it to manual', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'metaDL', has_metadata: false, amount_left: 0, content_path: '' })], preferences: prefs({ torrent_changed_tmm_enabled: false }) });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv' });
        expect(preview.structuredContent.effects.join(' ')).toContain('will download to /data/torrents/movies');
    });

    it('refuses a manual torrent that is being moved', async () => {
        const h = harness({ torrents: [torrent({ state: 'moving' })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/being moved or checked/);
    });

    it('fails closed when the incomplete folder cannot be read', async () => {
        const h = harness({ torrents: [downloading()], preferences: { torrent_changed_tmm_enabled: true } });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/outside the locations/);
    });

    it('refuses to relocate a torrent while it is being checked', async () => {
        const h = harness({ torrents: [torrent({ auto_tmm: true, state: 'checkingUP', amount_left: 500 })] });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true })).rejects.toThrow(/being moved or checked/);
    });

    const purge = (action: string) => ({ movies: {}, purge: { savePath: '/data/torrents/purge', share_limit_action: action, ratio_limit: 1 } });

    it('needs allow_removal, and the destructive tier, for a category that would remove the torrent', async () => {
        const h = harness({ categories: purge('RemoveWithContent') });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'purge' })).rejects.toThrow(/would remove this torrent/);
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true });
        expect(preview.structuredContent.tier).toBe('destructive');
        expect(preview.structuredContent.effects[0]).toContain('removes this torrent and deletes its files');
    });

    it('refuses allow_removal without the destructive permission', async () => {
        const h = harness({ categories: purge('Remove') }, { permissions: { safe_write: true, destructive: false } });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true })).rejects.toThrow(/destructive/);
    });

    it('says when allow_removal overrides the protection of an instance', async () => {
        const h = harness({ categories: purge('Remove') }, { protect_all_torrents: true });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true });
        expect(preview.structuredContent.confirm_token).toBeDefined();
        expect(preview.structuredContent.effects[0]).toContain('Overrides the delete protection');
    });

    it('previews the final path for a finished torrent whose data went missing', async () => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true, state: 'missingFiles', amount_left: 1000, completion_on: 1_700_000_000 })],
            preferences: prefs(),
            categories: { movies: {}, tv: { savePath: '/data/torrents/tv', download_path: '/data/torrents/incomplete/tv' } }
        });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv', move_files: true });
        expect(preview.structuredContent.effects.join(' ')).toContain('to /data/torrents/tv,');
        expect(preview.structuredContent.effects.join(' ')).not.toContain('/data/torrents/incomplete/tv');
    });

    it('does not let an override token survive the torrent ceasing to be protected', async () => {
        const h = harness({ categories: purge('Remove') }, { protect_private_torrents: true });
        const args = { id: HASH, category: 'purge', allow_removal: true };
        const preview = await h.call('set_torrent_category', args);
        h.torrents[0]!.private = false;
        const late = await h.call('set_torrent_category', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('lets a manual torrent change category while it is being checked', async () => {
        const h = harness({ torrents: [torrent({ state: 'checkingUP' })] });
        expect((await h.call('set_torrent_category', { id: HASH, category: 'tv' })).structuredContent.confirm_token).toBeDefined();
    });

    it('refuses a magnet that would download outside the allowed roots', async () => {
        const h = harness({
            torrents: [torrent({ auto_tmm: true, state: 'metaDL', has_metadata: false, amount_left: 0, content_path: '' })],
            preferences: prefs(),
            categories: { movies: {}, tv: { savePath: '/mnt/elsewhere' } }
        });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'tv' })).rejects.toThrow(/outside the locations/);
    });

    it('asks nothing extra when both categories already resolve to the same removal', async () => {
        const preferences = prefs({ max_ratio_act: 1, max_ratio_enabled: true, max_ratio: 2 });
        const h = harness({ preferences }, { protect_all_torrents: true });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'tv' });
        expect(preview.structuredContent.tier).toBe('safe');
        expect(preview.structuredContent.effects[0]).toContain('removes this torrent');
    });

    it.each(['Remove', 'RemoveWithContent'])('refuses a protected torrent a category would %s at its limits', async action => {
        const h = harness({ categories: purge(action) }, { protect_private_torrents: true });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'purge' })).rejects.toThrow(/would remove this torrent/);
        expect(h.posts).toEqual([]);
    });

    it('refuses a removal a subcategory inherits from its parent', async () => {
        const categories = { ...purge('Remove'), 'purge/old': { share_limit_action: 'Default', ratio_limit: -2 } };
        const h = harness({ categories }, { protect_all_torrents: true });
        await expect(h.call('set_torrent_category', { id: HASH, category: 'purge/old' })).rejects.toThrow(/would remove this torrent/);
    });

    it('refuses a removal inherited from the client when the category is cleared', async () => {
        const categories = { movies: { share_limit_action: 'Stop', ratio_limit: 5 } };
        const h = harness({ categories, preferences: prefs({ max_ratio_act: 3, max_ratio_enabled: true, max_ratio: 2 }) }, { protect_all_torrents: true });
        await expect(h.call('set_torrent_category', { id: HASH, category: '' })).rejects.toThrow(/would remove this torrent/);
    });

    it('lets the action a torrent sets for itself win over the category', async () => {
        const h = harness({ torrents: [torrent({ share_limit_action: 'Stop' })], categories: purge('Remove') }, { protect_all_torrents: true });
        expect((await h.call('set_torrent_category', { id: HASH, category: 'purge' })).structuredContent.confirm_token).toBeDefined();
    });

    it('does not count a removing action that has no limit to reach', async () => {
        const categories = { movies: {}, purge: { share_limit_action: 'Remove', ratio_limit: -1, seeding_time_limit: -1, inactive_seeding_time_limit: -1 } };
        const h = harness({ categories }, { protect_all_torrents: true });
        expect((await h.call('set_torrent_category', { id: HASH, category: 'purge' })).structuredContent.confirm_token).toBeDefined();
    });

    it('lets a protected torrent into a category that only stops at its limits', async () => {
        const h = harness({ categories: { movies: {}, hold: { share_limit_action: 'Stop', ratio_limit: 1 } } }, { protect_all_torrents: true });
        expect((await h.call('set_torrent_category', { id: HASH, category: 'hold' })).structuredContent.confirm_token).toBeDefined();
    });

    it('does not let a token survive a tighter limit on the category', async () => {
        const categories = purge('RemoveWithContent');
        const h = harness({ categories });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true });
        expect(preview.structuredContent.effects[0]).toContain('ratio 1');
        categories.purge.ratio_limit = 0.5;
        const late = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('says whether any or all of the limits trigger the removal, and binds it', async () => {
        const preferences: Record<string, unknown> = prefs({ max_ratio_act: 3, max_ratio_enabled: true, max_ratio: 2, max_seeding_time_enabled: true, max_seeding_time: 60, share_limits_mode: 'MatchAll' });
        const h = harness({ preferences });
        const preview = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents' });
        expect(preview.structuredContent.effects[0]).toContain('all of: ratio 2, 60 minutes seeding');
        preferences.share_limits_mode = 'MatchAny';
        const late = await h.call('add_torrent', { magnet: `magnet:?xt=urn:btih:${OTHER}`, save_path: '/data/torrents', confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
    });

    it('does not let a token survive the match mode of the category changing', async () => {
        const categories: Record<string, Record<string, unknown>> = { movies: {}, purge: { share_limit_action: 'Remove', ratio_limit: 1, seeding_time_limit: 60, share_limits_mode: 'MatchAll' } };
        const h = harness({ categories });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true });
        categories.purge!.share_limits_mode = 'MatchAny';
        const late = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
    });

    it('counts a client whose action cannot be read as removing', async () => {
        const categories = { movies: { share_limit_action: 'Stop', ratio_limit: 5 } };
        const h = harness({ categories, preferences: { torrent_changed_tmm_enabled: true, temp_path_enabled: false, max_ratio_enabled: true, max_ratio: 1 } }, { protect_all_torrents: true });
        await expect(h.call('set_torrent_category', { id: HASH, category: '' })).rejects.toThrow(/would remove this torrent/);
    });

    it('does not let a token survive the action of the category changing', async () => {
        const categories = purge('Remove');
        const h = harness({ categories });
        const preview = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true });
        categories.purge.share_limit_action = 'RemoveWithContent';
        const late = await h.call('set_torrent_category', { id: HASH, category: 'purge', allow_removal: true, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.posts).toEqual([]);
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
        await expect(harness().call('set_torrent_category', { id: HASH, category: 'nope' })).rejects.toThrow(/has no such category/);
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

    it.each([
        ['a tracker added', (list: Record<string, unknown>[]) => list.push({ url: 'https://other.example.net/announce', status: 2, msg: '' })],
        ['a passkey swapped on the same host', (list: Record<string, unknown>[]) => (list[1] = { ...list[1], url: 'https://tracker.example.org:443/0123456789abcdef0123456789abcdef/announce' })]
    ])('refuses a token once the tracker list changed: %s', async (_why, change) => {
        const trackers: Record<string, unknown>[] = [
            { url: '** [DHT] **', status: 2, msg: '' },
            { url: `https://tracker.example.org:443/${PASSKEY}/announce`, status: 2, msg: '' }
        ];
        const h = harness({ trackers });
        const preview = await h.call('reannounce_torrent', { id: HASH });
        change(trackers);
        const late = await h.call('reannounce_torrent', { id: HASH, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(late.structuredContent.confirm_error).toBeDefined();
        expect(h.posts).toEqual([]);
        // The digest binds the list; neither the preview nor the audit row may carry a URL from it.
        expect(JSON.stringify([preview, late, h.context.audit.recent()])).not.toContain(PASSKEY);
        expect(JSON.stringify([preview, late, h.context.audit.recent()])).not.toContain('0123456789abcdef0123456789abcdef');
        // The fresh token from the refusal binds the list as it is now, and announces once.
        const applied = await h.call('reannounce_torrent', { id: HASH, confirm: late.structuredContent.confirm_token });
        expect(applied.structuredContent.applied).toBe(true);
        expect(h.posts).toEqual([{ path: '/torrents/reannounce', form: { hashes: HASH } }]);
    });

    it.each([
        ['an object', { error: 'busy' }],
        ['a null row', [null]],
        ['bare strings', ['https://tracker.example.org/announce']],
        ['a row with no url', [{ url: '** [DHT] **', status: 2 }, { status: 2 }]],
        ['a url that does not parse', [{ url: 'not a tracker', status: 2 }]]
    ])('refuses to preview when the tracker answer is %s', async (_why, answer) => {
        const h = harness({ trackers: answer as unknown as unknown[] });
        await expect(h.call('reannounce_torrent', { id: HASH })).rejects.toThrow(/tracker list qBittorrent gave for this torrent could not be read/);
        expect(h.posts).toEqual([]);
    });

    it('refuses a token, without announcing, once a tracker row stops reading', async () => {
        const opts: FakeOptions = { trackers: [{ url: '** [DHT] **', status: 2 }] };
        const h = harness(opts);
        const preview = await h.call('reannounce_torrent', { id: HASH });
        expect(preview.structuredContent.effects).toEqual(['It has no tracker to announce to, so only DHT hears about it.']);
        opts.trackers = [{ url: '** [DHT] **', status: 2 }, { status: 2 }];
        await expect(h.call('reannounce_torrent', { id: HASH, confirm: preview.structuredContent.confirm_token })).rejects.toThrow(/could not be read/);
        expect(h.posts).toEqual([]);
    });

    it('still lists the trackers it can read beside rows it cannot, and refuses to reannounce from that list', async () => {
        const trackers = [null, { url: { toString: 0 }, status: 2 }, { url: `https://tracker.example.org/${PASSKEY}/announce`, status: 2 }];
        const details = await new QbittorrentAdapter(config(), fakeQbittorrent({ trackers }).impl).getTorrentDetails(HASH);
        expect(details.trackers).toEqual([{ host: 'tracker.example.org', status: 'working' }]);
        expect(details.trackerDigest).toBeNull();
        await expect(harness({ trackers }).call('reannounce_torrent', { id: HASH })).rejects.toThrow(/could not be read/);
    });

    it('still applies when only a tracker status or the order changed', async () => {
        const trackers: Record<string, unknown>[] = [
            { url: 'https://one.example.org/announce', status: 2, msg: '' },
            { url: 'https://two.example.org/announce', status: 2, msg: '' }
        ];
        const h = harness({ trackers });
        const preview = await h.call('reannounce_torrent', { id: HASH });
        trackers.reverse();
        trackers[0] = { ...trackers[0], status: 4 };
        const applied = await h.call('reannounce_torrent', { id: HASH, confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.applied).toBe(true);
    });

    it('has nothing to do for a stopped torrent', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'stoppedUP' })] }).call('reannounce_torrent', { id: HASH });
        expect(preview.structuredContent.noop).toBe(true);
    });

    /** A qBittorrent whose answer to each path can be replaced, counting the paths it was asked for. */
    function answering(opts: FakeOptions, answer: (path: string) => Response | undefined) {
        const qb = fakeQbittorrent(opts);
        const paths: string[] = [];
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname.replace('/api/v2', '');
            paths.push(path);
            return answer(path) ?? qb.impl(input, init);
        }) as typeof fetch;
        const cfg = config({ username: 'admin', password: 'secret' });
        const { server, call } = toolServer();
        registerTorrentTools(server, writeContext(instancesOf({ qbittorrent: cfg })), [new QbittorrentAdapter(cfg, impl)]);
        return { call, posts: qb.posts, reads: (wanted: string) => paths.filter(p => p === wanted).length };
    }

    const TRACKER_FAILURES: [string, () => Response, RegExp][] = [
        ['an error', () => new Response('broken', { status: 500 }), /^qbittorrent upstream error: HTTP 500/],
        ['a rate limit', () => new Response('slow down', { status: 429 }), /^qbittorrent rate limited/],
        ['a 404', () => new Response('not found', { status: 404 }), /^qbittorrent upstream error: qBittorrent could not be asked about this torrent/],
        ['a dropped connection', () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
        }, /^qbittorrent unreachable: socket hang up/],
        ['no answer', () => {
            throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        }, /^qbittorrent timed out/]
    ];

    it.each(['stoppedUP', 'pausedDL'])('has nothing to do for a torrent at %s, and never asks for its trackers', async state => {
        const h = answering({ torrents: [torrent({ state })] }, path => {
            if (path === '/torrents/trackers') throw new Error('the trackers of a stopped torrent were asked for');
            return undefined;
        });
        const preview = await h.call('reannounce_torrent', { id: HASH.toUpperCase() });
        expect(preview.structuredContent.noop).toBe(true);
        expect(preview.structuredContent.summary).toContain('is stopped, so it has nothing to announce');
        expect(preview.structuredContent.target).toBe(`qbittorrent:${HASH}`);
        expect(preview.structuredContent.confirm_token).toBeUndefined();
        expect(h.reads('/torrents/info')).toBe(1);
        expect(h.reads('/torrents/trackers')).toBe(0);
        expect(h.posts).toEqual([]);
    });

    it('reads only the torrent list and the trackers for a running torrent, even with an incomplete row', async () => {
        const row = torrent();
        delete row.save_path;
        const h = answering({ torrents: [row] }, () => undefined);
        const preview = await h.call('reannounce_torrent', { id: HASH });
        expect(preview.structuredContent.confirm_token).toBeDefined();
        expect([h.reads('/torrents/info'), h.reads('/torrents/trackers'), h.reads('/torrents/files'), h.reads('/torrents/properties')]).toEqual([1, 1, 0, 0]);
    });

    it.each(TRACKER_FAILURES)('still refuses a running torrent when the tracker request meets %s, with that failure', async (_why, fail, message) => {
        const h = answering({}, path => (path === '/torrents/trackers' ? fail() : undefined));
        await expect(h.call('reannounce_torrent', { id: HASH })).rejects.toThrow(message);
        expect(h.reads('/torrents/info')).toBe(1);
        // Nothing else about the torrent is read for a reannounce.
        expect(h.reads('/torrents/files')).toBe(0);
        expect(h.posts).toEqual([]);
    });

    it('refuses at confirm, without announcing, when the tracker request fails after the preview', async () => {
        let failing = false;
        const h = answering({}, path => (failing && path === '/torrents/trackers' ? new Response('broken', { status: 500 }) : undefined));
        const preview = await h.call('reannounce_torrent', { id: HASH });
        expect(preview.structuredContent.confirm_token).toBeDefined();
        failing = true;
        await expect(h.call('reannounce_torrent', { id: HASH, confirm: preview.structuredContent.confirm_token })).rejects.toThrow(/^qbittorrent upstream error: HTTP 500/);
        expect(h.posts).toEqual([]);
    });

    it('refuses a hash the client does not have', async () => {
        await expect(harness().call('reannounce_torrent', { id: OTHER })).rejects.toThrow(/^qbittorrent not found: no torrent with hash/);
    });

    it.each([
        ['a 404 on the torrent list', 1, 0, /^qbittorrent upstream error: qBittorrent could not be asked about this torrent/, (path: string) => (path === '/torrents/info' ? new Response('not found', { status: 404 }) : undefined)],
        ['a refused login', 1, 1, /auth failed/, (path: string) => (path === '/auth/login' ? new Response('Fails.') : new Response('Forbidden', { status: 403 }))],
        ['an unreachable client', 1, 0, /unreachable/, () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }],
        // A read that times out is retried once, by the HTTP client, before it fails.
        ['a client that does not answer', 2, 0, /timed out/, () => {
            throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        }]
    ])('fails after %s as it did before, reading the torrent list no more often', async (_why, reads, logins, message, answer) => {
        const h = answering({}, answer);
        await expect(h.call('reannounce_torrent', { id: HASH })).rejects.toThrow(message);
        expect(h.reads('/torrents/info')).toBe(reads);
        expect(h.reads('/auth/login')).toBe(logins);
        expect(h.posts).toEqual([]);
    });

    it('names a stopped torrent by its hash in lower case', async () => {
        const preview = await harness({ torrents: [torrent({ state: 'stoppedUP' })] }).call('reannounce_torrent', { id: HASH.toUpperCase() });
        expect(preview.structuredContent.target).toBe(`qbittorrent:${HASH}`);
    });
});
