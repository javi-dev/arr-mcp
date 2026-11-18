import { describe, expect, it } from 'vitest';
import { addInstance, updateInstance } from '../src/config/mutate.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { resolveSecrets } from '../src/config/secretSources.ts';
import { qbittorrentSession } from '../src/core/auth.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { textResponse } from './helpers/serve.ts';

const AUTH = { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [], allow_token_in_url: false };

const parse = (entry: Record<string, unknown>) =>
    ConfigSchema.safeParse({ auth: AUTH, services: { qbittorrent: { url: 'http://192.0.2.10:8081', ...entry } } });

describe('qBittorrent config keys', () => {
    it('accepts a block written before they existed', () => {
        expect(parse({ username: 'u', password: 'p' }).success).toBe(true);
    });

    it('accepts all of them together', () => {
        expect(parse({ allowed_paths: ['/data/torrents'], protect_private_torrents: true, protect_all_torrents: false, webui_api_key: 'k' }).success).toBe(true);
    });

    it.each([
        ['the filesystem root', { allowed_paths: ['/'] }],
        ['a relative path', { allowed_paths: ['data/torrents'] }],
        ['a trailing slash', { allowed_paths: ['/data/torrents/'] }],
        ['a climb', { allowed_paths: ['/data/../etc'] }],
        ['an empty list', { allowed_paths: [] }],
        ['the key both inline and from a file', { webui_api_key: 'k', webui_api_key_file: '/run/secrets/k' }]
    ])('refuses %s', (_why, entry) => {
        expect(parse(entry).success).toBe(false);
    });

    it('does not offer the keys to another service', () => {
        expect(ConfigSchema.safeParse({ auth: AUTH, services: { transmission: { url: 'http://192.0.2.10:9091', allowed_paths: ['/data'] } } }).success).toBe(false);
    });

    it('reads the API key from a file', () => {
        const parsed = parse({ webui_api_key_file: '/run/secrets/qb' });
        expect(parsed.success).toBe(true);
        const resolved = resolveSecrets(parsed.data!, { readFile: () => 'from-file\n' });
        const entry = resolved.services.qbittorrent as unknown as { webui_api_key?: string; webui_api_key_file?: string };
        expect(entry.webui_api_key).toBe('from-file');
        expect(entry.webui_api_key_file).toBeUndefined();
    });

    it('defaults the allowed paths and leaves the guards off', () => {
        const adapter = new QbittorrentAdapter({ url: 'http://192.0.2.10:8081', timeout_ms: 1000, permissions: { safe_write: false, destructive: false } } as never);
        expect(adapter.allowedPaths).toEqual(['/data/torrents', '/data/media']);
        expect(adapter.deleteProtection).toEqual({ private: false, all: false });
    });
});

describe('editing a qBittorrent instance on the config page', () => {
    const config = () =>
        ConfigSchema.parse({
            auth: AUTH,
            services: { qbittorrent: { url: 'http://192.0.2.10:8081', username: 'u', password: 'p', webui_api_key: 'the-key', allowed_paths: ['/srv/dl'], protect_all_torrents: true } }
        });
    const entry = (c: ReturnType<typeof config>) => c.services.qbittorrent as unknown as Record<string, unknown>;

    it('keeps the guardrails and the key through an edit on the same host', () => {
        const next = entry(updateInstance(config(), 'qbittorrent', { url: 'http://192.0.2.10:8081', timeout_ms: 5000 }));
        expect(next).toMatchObject({ webui_api_key: 'the-key', allowed_paths: ['/srv/dl'], protect_all_torrents: true });
    });

    it('drops the key when the instance moves to another host, and keeps the guardrails', () => {
        const next = entry(updateInstance(config(), 'qbittorrent', { url: 'http://192.0.2.99:8081', password: 'retyped' }));
        expect(next.webui_api_key).toBeUndefined();
        expect(next).toMatchObject({ allowed_paths: ['/srv/dl'], protect_all_torrents: true });
    });

    it('adds a new instance with no stored address to compare against', () => {
        const empty = ConfigSchema.parse({ auth: AUTH, services: {} });
        expect(() => addInstance(empty, { type: 'qbittorrent', fields: { url: 'http://192.0.2.10:8081' } })).not.toThrow();
    });
});

describe('qBittorrent API key auth', () => {
    const BASE = 'http://192.0.2.10:8081';
    const ctx = () => ({ url: new URL(`${BASE}/api/v2/app/version`), headers: new Headers() });

    it('sends the key as a bearer token and no cookie', () => {
        const c = ctx();
        qbittorrentSession({ id: 'qb', url: BASE, timeoutMs: 1000, apiKey: 'the-key' }).apply(c as never);
        expect(c.headers.get('Authorization')).toBe('Bearer the-key');
        expect(c.headers.get('Cookie')).toBeNull();
    });

    it('falls back to the cookie login when the key is refused', async () => {
        const impl = (async () => new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc; path=/' } })) as unknown as typeof fetch;
        const auth = qbittorrentSession({ id: 'qb', url: BASE, timeoutMs: 1000, apiKey: 'old-key', username: 'u', password: 'p', fetchImpl: impl });
        expect(await auth.recover!(textResponse('Forbidden', 403), new AbortController().signal)).toBe(true);
        const c = ctx();
        auth.apply(c as never);
        expect(c.headers.get('Authorization')).toBeNull();
        expect(c.headers.get('Cookie')).toBe('SID=abc');
    });

    it('lets the 403 stand when there is no login to fall back on', async () => {
        const auth = qbittorrentSession({ id: 'qb', url: BASE, timeoutMs: 1000, apiKey: 'old-key' });
        expect(await auth.recover!(textResponse('Forbidden', 403), new AbortController().signal)).toBe(false);
        const c = ctx();
        auth.apply(c as never);
        expect(c.headers.get('Authorization')).toBe('Bearer old-key');
    });

    it('names the key in the remedy only when one is configured', () => {
        expect(qbittorrentSession({ id: 'qb', url: BASE, timeoutMs: 1000, apiKey: 'k' }).remedy).toContain('webui_api_key');
        expect(qbittorrentSession({ id: 'qb', url: BASE, timeoutMs: 1000 }).remedy).not.toContain('webui_api_key');
    });
});
