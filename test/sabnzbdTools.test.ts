import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { registerSabnzbdTools } from '../src/tools/sabnzbdTools.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { PASSKEY, confirmed, toolServer, writeContext } from './helpers/fakeQbittorrent.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

const API_KEY = 'sab-api-key-0123456789';

const config = (over: Record<string, unknown> = {}) =>
    ({ url: 'http://192.0.2.10:8080', api_key: API_KEY, timeout_ms: 10_000, permissions: { safe_write: true, destructive: true }, ...over }) as KeyedServiceConfig;

const SETTINGS: Record<string, unknown> = {
    fail_hopeless_jobs: 1,
    unwanted_extensions: ['exe'],
    unwanted_extensions_mode: 0,
    action_on_unwanted_extensions: 1,
    cleanup_list: ['nfo'],
    history_retention_option: 'all',
    history_retention_number: 1
};

function harness(opts: { stores?: boolean; addStatus?: boolean; extra?: ServiceAdapter[]; over?: Record<string, unknown> } = {}) {
    const settings = { ...SETTINGS };
    const requests: URL[] = [];
    const uploads: FormData[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url);
        const keyword = url.searchParams.get('keyword') ?? '';
        switch (url.searchParams.get('mode')) {
            case 'get_cats':
                return jsonResponse({ categories: ['*', 'movies', 'tv'] });
            case 'get_config':
                return jsonResponse({ config: { misc: { [keyword]: settings[keyword] } } });
            case 'set_config': {
                const value = url.searchParams.get('value') ?? '';
                if (opts.stores !== false) settings[keyword] = keyword === 'unwanted_extensions' || keyword === 'cleanup_list' ? value.split(',').filter(v => v !== '') : value;
                return jsonResponse({ config: { misc: { [keyword]: settings[keyword] } } });
            }
            case 'addurl':
                return jsonResponse({ status: opts.addStatus ?? true, nzo_ids: ['SABnzbd_nzo_1'] });
            case 'addfile':
                uploads.push(init?.body as FormData);
                return jsonResponse({ status: opts.addStatus ?? true, nzo_ids: ['SABnzbd_nzo_2'] });
            default:
                return jsonResponse({ status: false }, 404);
        }
    }) as unknown as typeof fetch;
    const cfg = config(opts.over);
    const { server, call } = toolServer();
    const context = writeContext(instancesOf({ sabnzbd: cfg }));
    registerSabnzbdTools(server, context, [new SabnzbdAdapter(cfg, impl), ...(opts.extra ?? [])]);
    const sent = (mode: string) => requests.filter(r => r.searchParams.get('mode') === mode);
    return { call, context, requests, uploads, sent, settings };
}

const NZB = '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>';
const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');

describe('add_nzb', () => {
    it('adds from a URL once confirmed, and not before', async () => {
        const h = harness();
        const args = { url: 'https://indexer.example/get/1.nzb', category: 'movies' };
        const preview = await h.call('add_nzb', args);
        expect(preview.structuredContent.applied).toBe(false);
        expect(h.sent('addurl')).toEqual([]);

        const applied = await h.call('add_nzb', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.applied).toBe(true);
        expect(h.sent('addurl')[0]!.searchParams.get('name')).toBe(args.url);
        expect(h.sent('addurl')[0]!.searchParams.get('cat')).toBe('movies');
    });

    it.each([
        ['a plain file', NZB, 'film.nzb'],
        ['a gzipped file', gzipSync(NZB), 'film.nzb.gz']
    ])('uploads %s', async (_why, file, filename) => {
        const h = harness();
        await confirmed(h.call, 'add_nzb', { nzb_base64: b64(file), filename });
        expect((h.uploads[0]!.get('name') as File).name).toBe(filename);
    });

    it('never repeats a URL that carries a key', async () => {
        const h = harness();
        const url = `https://indexer.example/get/1.nzb?apikey=${PASSKEY}`;
        const preview = await h.call('add_nzb', { url });
        const applied = await h.call('add_nzb', { url, confirm: preview.structuredContent.confirm_token });
        expect(JSON.stringify([preview, applied, h.context.audit.recent()])).not.toContain(PASSKEY);
    });

    it('binds the token to the exact source', async () => {
        const h = harness();
        const preview = await h.call('add_nzb', { url: 'https://indexer.example/a.nzb' });
        const swapped = await h.call('add_nzb', { url: 'https://indexer.example/b.nzb', confirm: preview.structuredContent.confirm_token });
        expect(swapped.structuredContent.applied).toBe(false);
        expect(h.sent('addurl')).toEqual([]);
    });

    it('warns when an *arr watches the category', async () => {
        const radarr = {
            id: 'radarr',
            type: 'radarr',
            getDownloadClients: () => Promise.resolve([{ name: 'sab', implementation: 'Sabnzbd', enabled: true, categories: ['movies'] }])
        } as unknown as ServiceAdapter;
        const preview = await harness({ extra: [radarr] }).call('add_nzb', { url: 'https://indexer.example/a.nzb', category: 'movies' });
        expect(preview.structuredContent.effects[0]).toContain('radarr watches category "movies"');
    });

    it.each([
        ['both sources', { url: 'https://a.example/x.nzb', nzb_base64: b64(NZB) }, /exactly one/],
        ['no source', {}, /exactly one/],
        ['a file that is not an NZB', { nzb_base64: b64('<html></html>') }, /not an NZB/],
        ['a gzip that is not an NZB', { nzb_base64: b64(gzipSync('<html></html>')) }, /not an NZB/],
        ['a file name with a path', { nzb_base64: b64(NZB), filename: '../../etc/x.nzb' }, /plain file name/],
        ['text that is not base64', { nzb_base64: 'not base64!' }, /not valid base64/],
        ['another scheme', { url: 'file:///etc/passwd' }, /http and https/],
        ['a category that does not exist', { url: 'https://a.example/x.nzb', category: 'nope' }, /no category named/]
    ])('refuses %s', async (_why, args, message) => {
        await expect(harness().call('add_nzb', args)).rejects.toThrow(message);
    });

    it('reports a refusal from SABnzbd as a failure', async () => {
        const h = harness({ addStatus: false });
        await expect(confirmed(h.call, 'add_nzb', { url: 'https://indexer.example/a.nzb' })).rejects.toThrow(/did not add/);
    });
});

describe('get_client_settings', () => {
    it('reads the listed settings and nothing else', async () => {
        const h = harness();
        const { structuredContent } = await h.call('get_client_settings', {});
        expect((structuredContent as unknown as { settings: unknown }).settings).toEqual({
            fail_hopeless_jobs: true,
            unwanted_extensions: ['exe'],
            unwanted_extensions_mode: 'blacklist',
            action_on_unwanted_extensions: 'pause',
            cleanup_list: ['nfo'],
            history_retention_option: 'all',
            history_retention_number: 1
        });
    });

    it('asks only for misc keywords, one at a time', async () => {
        const h = harness();
        await h.call('get_client_settings', {});
        for (const request of h.sent('get_config')) {
            expect(request.searchParams.get('section')).toBe('misc');
            expect(Object.keys(SETTINGS)).toContain(request.searchParams.get('keyword'));
        }
        expect(h.sent('get_config')).toHaveLength(Object.keys(SETTINGS).length);
    });
});

describe('update_client_settings', () => {
    it('shows each old and new value, then writes only what changes', async () => {
        const h = harness();
        const args = { action_on_unwanted_extensions: 'abort', fail_hopeless_jobs: true };
        const preview = await h.call('update_client_settings', args);
        expect(preview.structuredContent.effects).toEqual(['action_on_unwanted_extensions: pause becomes abort.']);
        expect(h.sent('set_config')).toEqual([]);

        await h.call('update_client_settings', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(h.sent('set_config').map(r => [r.searchParams.get('keyword'), r.searchParams.get('value')])).toEqual([['action_on_unwanted_extensions', '2']]);
    });

    it('needs the destructive tier', async () => {
        const h = harness({ over: { permissions: { safe_write: true, destructive: false } } });
        await expect(h.call('update_client_settings', { fail_hopeless_jobs: false })).rejects.toThrow(/destructive/);
    });

    it.each([
        ['misc', 'api_key'],
        ['misc', 'username'],
        ['servers', 'host'],
        ['misc', 'password']
    ])('has no way to reach %s.%s', async (section, keyword) => {
        const h = harness();
        await expect(h.call('update_client_settings', { section, keyword, value: 'x', fail_hopeless_jobs: false })).rejects.toThrow(/Unknown argument/);
        expect(h.requests).toEqual([]);
    });

    it('normalises list entries the way SABnzbd stores them, so the read-back agrees', async () => {
        const h = harness();
        await confirmed(h.call, 'update_client_settings', { cleanup_list: ['.NFO', '*.TMP', 'images/*'], unwanted_extensions: ['.EXE', 'bat'] });
        expect(h.settings.cleanup_list).toEqual(['nfo', '*.tmp', 'images/*']);
        expect(h.settings.unwanted_extensions).toEqual(['exe', 'bat']);
    });

    it('fails when SABnzbd did not store the value, and names what already changed', async () => {
        const h = harness({ stores: false });
        await expect(confirmed(h.call, 'update_client_settings', { fail_hopeless_jobs: false })).rejects.toThrow(/did not store fail_hopeless_jobs/);
    });

    it.each([
        ['nothing to change', {}, /at least one/],
        ['a retention count of nothing', { history_retention_option: 'number-delete' }, undefined]
    ])('handles %s', async (_why, args, message) => {
        const call = harness().call('update_client_settings', args);
        if (message === undefined) await expect(call).resolves.toBeDefined();
        else await expect(call).rejects.toThrow(message);
    });

    it('refuses a retention option that needs a count when none is stored', async () => {
        const h = harness();
        h.settings.history_retention_number = '';
        await expect(h.call('update_client_settings', { history_retention_option: 'days-delete' })).rejects.toThrow(/needs `history_retention_number`/);
    });

    it.each([
        ['an extension with a path', { unwanted_extensions: ['../x'] }],
        ['a cleanup entry with a climb', { cleanup_list: ['../secret'] }],
        ['a cleanup entry of only dots', { cleanup_list: ['...'] }],
        ['an unknown action', { action_on_unwanted_extensions: 'delete' }],
        ['an unknown retention option', { history_retention_option: 'forever' }]
    ])('refuses %s at the schema', async (_why, args) => {
        await expect(harness().call('update_client_settings', args)).rejects.toThrow();
    });

    it('never puts the API key in a preview', async () => {
        const preview = await harness().call('update_client_settings', { fail_hopeless_jobs: false });
        expect(JSON.stringify(preview)).not.toContain(API_KEY);
    });
});
