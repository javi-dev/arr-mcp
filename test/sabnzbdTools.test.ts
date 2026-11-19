import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { MAX_BODY_BYTES } from '../src/app.ts';
import { MAX_NZB_BASE64, registerSabnzbdTools } from '../src/tools/sabnzbdTools.ts';
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

function harness(opts: { stores?: boolean; refuses?: string; breaksOn?: string; addStatus?: boolean; addRefusal?: string; extra?: ServiceAdapter[]; over?: Record<string, unknown> } = {}) {
    const settings = { ...SETTINGS };
    const requests: URL[] = [];
    const addresses: string[] = [];
    const uploads: FormData[] = [];
    const uploadHeaders: Headers[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        addresses.push(url.href);
        if (init?.body instanceof FormData) uploadHeaders.push(new Headers(init.headers));
        if (typeof init?.body === 'string') for (const [key, value] of new URLSearchParams(init.body)) url.searchParams.set(key, value);
        requests.push(url);
        const keyword = url.searchParams.get('keyword') ?? '';
        if (keyword === opts.breaksOn && url.searchParams.get('mode') === 'set_config') return jsonResponse({ error: 'broken' }, 500);
        switch (url.searchParams.get('mode')) {
            case 'get_cats':
                return jsonResponse({ categories: ['*', 'movies', 'tv'] });
            case 'get_config':
                return jsonResponse({ config: { misc: { [keyword]: settings[keyword] } } });
            case 'set_config': {
                const value = url.searchParams.get('value') ?? '';
                if (opts.stores !== false && keyword !== opts.refuses) settings[keyword] = keyword === 'unwanted_extensions' || keyword === 'cleanup_list' ? value.split(',').filter(v => v !== '') : value;
                return jsonResponse({ config: { misc: { [keyword]: settings[keyword] } } });
            }
            case 'addurl':
                if (opts.addRefusal !== undefined) return jsonResponse([{ errorMessage: opts.addRefusal }], 400);
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
    return { call, context, requests, addresses, uploads, uploadHeaders, sent, settings };
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

    it('sends the category with an upload, and leaves the multipart boundary to fetch', async () => {
        const h = harness();
        await confirmed(h.call, 'add_nzb', { nzb_base64: b64(NZB), filename: 'film.nzb', category: 'movies' });
        expect(h.sent('addfile')[0]!.searchParams.get('cat')).toBe('movies');
        expect(h.uploadHeaders[0]!.get('content-type')).toBeNull();
    });

    it('keeps the URL out of the address it calls, where access logs would keep it', async () => {
        const h = harness();
        await confirmed(h.call, 'add_nzb', { url: `https://indexer.example/get/1.nzb?apikey=${PASSKEY}` });
        expect(h.sent('addurl')).toHaveLength(1);
        expect(h.addresses.join(' ')).not.toContain(PASSKEY);
    });

    it('accepts a gzipped NZB too large to inflate whole', async () => {
        const padding = Array.from({ length: 40_000 }, (_, i) => `<file subject="${i}"/>`).join('');
        await expect(harness().call('add_nzb', { nzb_base64: b64(gzipSync(`<nzb>${padding}</nzb>`)), filename: 'big.nzb.gz' })).resolves.toBeDefined();
    });

    it('refuses a gzip of something else, however large', async () => {
        const html = `<html>${'x'.repeat(500_000)}</html>`;
        await expect(harness().call('add_nzb', { nzb_base64: b64(gzipSync(html)), filename: 'big.nzb.gz' })).rejects.toThrow(/not an NZB/);
    });

    it('keeps an upload inside what one request can carry', () => {
        expect(MAX_NZB_BASE64 + 64 * 1024).toBeLessThan(MAX_BODY_BYTES);
    });

    it('drops upstream words that repeat the source key, from the error and the audit', async () => {
        const h = harness({ addRefusal: `could not fetch https://indexer.example/get/1.nzb?apikey=${PASSKEY}` });
        const failure = await confirmed(h.call, 'add_nzb', { url: `https://indexer.example/get/1.nzb?apikey=${PASSKEY}` }).catch((err: Error) => err);
        expect(String(failure)).toContain('did not add');
        expect(String(failure)).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('binds the token to the name of an uploaded file', async () => {
        const h = harness();
        const preview = await h.call('add_nzb', { nzb_base64: b64(NZB), filename: 'first.nzb' });
        const renamed = await h.call('add_nzb', { nzb_base64: b64(NZB), filename: 'other.nzb', confirm: preview.structuredContent.confirm_token });
        expect(renamed.structuredContent.applied).toBe(false);
        expect(h.uploads).toEqual([]);
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
        ['both sources', { url: 'https://a.example/x.nzb', nzb_base64: b64(NZB) }, /^sabnzbd invalid request: pass exactly one/],
        ['no source', {}, /^sabnzbd invalid request: pass exactly one/],
        ['a file that is not an NZB', { nzb_base64: b64('<html></html>') }, /^sabnzbd invalid request: that file is not an NZB/],
        ['a gzip that is not an NZB', { nzb_base64: b64(gzipSync('<html></html>')) }, /^sabnzbd invalid request: that file is not an NZB/],
        ['a file name with a path', { nzb_base64: b64(NZB), filename: '../../etc/x.nzb' }, /^sabnzbd invalid request: `filename` must be a plain file name/],
        ['text that is not base64', { nzb_base64: 'not base64!' }, /^sabnzbd invalid request: `nzb_base64` is not valid base64/],
        ['another scheme', { url: 'file:///etc/passwd' }, /^sabnzbd invalid request: only http and https/],
        // The one refusal here whose target really is missing.
        ['a category that does not exist', { url: 'https://a.example/x.nzb', category: 'nope' }, /^sabnzbd not found: sabnzbd has no such category/]
    ])('refuses %s, with a prefix that says why', async (_why, args, message) => {
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
        expect(preview.structuredContent.effects[0]).toBe('action_on_unwanted_extensions: pause becomes abort.');
        expect(preview.structuredContent.effects.join(' ')).not.toContain('fail_hopeless_jobs');
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

    it('fails when SABnzbd did not store a value, and names what already changed', async () => {
        const h = harness({ refuses: 'action_on_unwanted_extensions' });
        await expect(confirmed(h.call, 'update_client_settings', { fail_hopeless_jobs: false, action_on_unwanted_extensions: 'abort' })).rejects.toMatchObject({
            detail: expect.stringContaining('did not store action_on_unwanted_extensions'),
            remedy: expect.stringContaining('Already changed before this failed: fail_hopeless_jobs')
        });
    });

    it('names what already changed when a later request fails outright', async () => {
        const h = harness({ breaksOn: 'action_on_unwanted_extensions' });
        await expect(confirmed(h.call, 'update_client_settings', { fail_hopeless_jobs: false, action_on_unwanted_extensions: 'abort' })).rejects.toMatchObject({
            remedy: expect.stringMatching(/action_on_unwanted_extensions may or may not have changed.*fail_hopeless_jobs/)
        });
    });

    it('stores the retention count before the policy that counts it', async () => {
        const h = harness();
        await confirmed(h.call, 'update_client_settings', { history_retention_option: 'number-delete', history_retention_number: 50 });
        expect(h.sent('set_config').map(r => r.searchParams.get('keyword'))).toEqual(['history_retention_number', 'history_retention_option']);
    });

    it('replaces a policy already deleting before lowering the count it would apply', async () => {
        const h = harness();
        h.settings.history_retention_option = 'days-delete';
        h.settings.history_retention_number = 30;
        await confirmed(h.call, 'update_client_settings', { history_retention_option: 'number-delete', history_retention_number: 1000 });
        expect(h.sent('set_config').map(r => [r.searchParams.get('keyword'), r.searchParams.get('value')])).toEqual([
            ['history_retention_option', 'all'],
            ['history_retention_number', '1000'],
            ['history_retention_option', 'number-delete']
        ]);
    });

    it('leaves a deleting policy parked on keep-all when the count cannot be written', async () => {
        const h = harness({ breaksOn: 'history_retention_number' });
        h.settings.history_retention_option = 'days-delete';
        h.settings.history_retention_number = 7;
        await expect(confirmed(h.call, 'update_client_settings', { history_retention_option: 'number-delete', history_retention_number: 1000 })).rejects.toThrow(/did not confirm history_retention_number/);
        expect(h.settings.history_retention_option).toBe('all');
    });

    it('writes the count first when the policy in force deletes nothing', async () => {
        const h = harness();
        h.settings.history_retention_option = 'days-archive';
        await confirmed(h.call, 'update_client_settings', { history_retention_option: 'number-delete', history_retention_number: 50 });
        expect(h.sent('set_config').map(r => r.searchParams.get('keyword'))).toEqual(['history_retention_number', 'history_retention_option']);
    });

    it('turns the action off while a new list and a new action are both written', async () => {
        const h = harness();
        h.settings.action_on_unwanted_extensions = 2;
        await confirmed(h.call, 'update_client_settings', { unwanted_extensions: ['exe', 'zip'], action_on_unwanted_extensions: 'pause' });
        expect(h.sent('set_config').map(r => [r.searchParams.get('keyword'), r.searchParams.get('value')])).toEqual([
            ['action_on_unwanted_extensions', '0'],
            ['unwanted_extensions', 'exe,zip'],
            ['action_on_unwanted_extensions', '1']
        ]);
    });

    it('fails when SABnzbd did not store a list', async () => {
        const h = harness({ refuses: 'unwanted_extensions' });
        await expect(confirmed(h.call, 'update_client_settings', { unwanted_extensions: ['iso'] })).rejects.toThrow(/did not store unwanted_extensions/);
    });

    it('leaves the action alone when only the list changes', async () => {
        const h = harness();
        h.settings.action_on_unwanted_extensions = 2;
        await confirmed(h.call, 'update_client_settings', { unwanted_extensions: ['iso'] });
        expect(h.sent('set_config').map(r => r.searchParams.get('keyword'))).toEqual(['unwanted_extensions']);
    });

    it('does not repeat a tracker URL passed as a category, in the refusal or the audit', async () => {
        const h = harness();
        const category = `https://tracker.example.org/${PASSKEY}/announce`;
        const refusal = await h.call('add_nzb', { url: 'https://indexer.example/a.nzb', category }).catch((err: Error) => err.message);
        expect(String(refusal)).not.toContain(PASSKEY);
        expect(JSON.stringify(h.context.audit.recent())).not.toContain(PASSKEY);
    });

    it('does not let a token overwrite a value edited since the preview', async () => {
        const h = harness();
        h.settings.history_retention_number = 1000;
        const args = { history_retention_number: 100 };
        const preview = await h.call('update_client_settings', args);
        h.settings.history_retention_number = 500;
        const late = await h.call('update_client_settings', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.sent('set_config')).toEqual([]);
    });

    it.each([
        ['does not have', undefined],
        ['answers with a value it cannot read', 5]
    ])('refuses a setting this SABnzbd %s, without claiming which', async (_why, value) => {
        const h = harness();
        if (value === undefined) delete h.settings.cleanup_list;
        else h.settings.cleanup_list = value;
        await expect(h.call('update_client_settings', { cleanup_list: ['nfo'] })).rejects.toThrow(
            /^sabnzbd version unsupported: this SABnzbd gave no readable value for cleanup_list\. These settings need SABnzbd 4\.4 or later\. If it is newer, get_client_settings shows what it answered\.$/
        );
    });

    it('does not let a token apply once the stored retention count has changed', async () => {
        const h = harness();
        h.settings.history_retention_number = 100;
        const args = { history_retention_option: 'number-delete' };
        const preview = await h.call('update_client_settings', args);
        expect(preview.structuredContent.effects.join(' ')).toContain('number-delete, counting 100');
        h.settings.history_retention_number = 1;
        const late = await h.call('update_client_settings', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.sent('set_config')).toEqual([]);
    });

    it.each([
        [0, 'blacklist mode: these extensions count as unwanted'],
        [1, 'whitelist mode: only these extensions are allowed']
    ])('says what the extension list means in mode %i', async (mode, meaning) => {
        const h = harness();
        h.settings.unwanted_extensions_mode = mode;
        const preview = await h.call('update_client_settings', { unwanted_extensions: ['iso'] });
        expect(preview.structuredContent.effects.join(' ')).toContain(meaning);
    });

    it('does not let a token apply once the list has come to mean the opposite', async () => {
        const h = harness();
        const args = { unwanted_extensions: ['mkv'] };
        const preview = await h.call('update_client_settings', args);
        h.settings.unwanted_extensions_mode = 1;
        const late = await h.call('update_client_settings', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.sent('set_config')).toEqual([]);
    });

    it('does not let a token apply once the action on the list has changed', async () => {
        const h = harness();
        const args = { unwanted_extensions: ['mkv'] };
        const preview = await h.call('update_client_settings', args);
        expect(preview.structuredContent.effects.join(' ')).toContain('Unwanted extensions afterwards: mkv, action pause.');
        h.settings.action_on_unwanted_extensions = 2;
        const late = await h.call('update_client_settings', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.sent('set_config')).toEqual([]);
    });

    it('does not let a token for the action apply once the list has changed', async () => {
        const h = harness();
        const args = { action_on_unwanted_extensions: 'abort' };
        const preview = await h.call('update_client_settings', args);
        h.settings.unwanted_extensions = ['mkv'];
        const late = await h.call('update_client_settings', { ...args, confirm: preview.structuredContent.confirm_token });
        expect(late.structuredContent.applied).toBe(false);
        expect(h.sent('set_config')).toEqual([]);
    });

    it('refuses a keyword outside the list at the adapter too', async () => {
        const adapter = new SabnzbdAdapter(config(), (async () => jsonResponse({})) as unknown as typeof fetch);
        await expect(adapter.updateClientSettings({ api_key: 'x' } as never)).rejects.toThrow(/not a setting this server may change/);
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
        await expect(h.call('update_client_settings', { history_retention_option: 'days-delete' })).rejects.toThrow(/^sabnzbd invalid request: history retention "days-delete" needs `history_retention_number`/);
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
