import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { categoryWatchers } from '../src/tools/watchedCategory.ts';
import { serving } from './helpers/serve.ts';

const SECRET = 'download-client-password';

/** Shaped like Radarr's `/api/v3/downloadclient`, which carries each client's credentials among its fields. */
const client = (over: Record<string, unknown> = {}) => ({
    name: 'qBittorrent',
    implementation: 'QBittorrent',
    enable: true,
    fields: [
        { name: 'host', value: 'qbittorrent' },
        { name: 'password', value: SECRET },
        { name: 'movieCategory', value: 'movies' },
        { name: 'movieImportedCategory', value: 'movies-done' }
    ],
    ...over
});

const radarr = (rows: unknown[]) =>
    new RadarrAdapter(
        { url: 'http://192.0.2.10:7878', api_key: 'k', timeout_ms: 1000, permissions: { safe_write: false, destructive: false } } as KeyedServiceConfig,
        serving({ '/api/v3/downloadclient': rows })
    );

describe('getDownloadClients', () => {
    it('reads the categories and copies out no credential', async () => {
        const [row] = await radarr([client()]).getDownloadClients();
        expect(row).toEqual({ name: 'qBittorrent', implementation: 'QBittorrent', enabled: true, categories: ['movies', 'movies-done'] });
        expect(JSON.stringify(row)).not.toContain(SECRET);
    });
});

describe('categoryWatchers', () => {
    const warned = (rows: unknown[], category = 'movies') => categoryWatchers([radarr(rows) as ServiceAdapter], 'QBittorrent', category);

    it('warns about a client watching the category', async () => {
        expect((await warned([client()]))[0]).toContain('radarr watches category "movies"');
    });

    it('also counts the category an *arr moves imported downloads to', async () => {
        expect(await warned([client()], 'movies-done')).toHaveLength(1);
    });

    it('ignores a disabled client', async () => {
        expect(await warned([client({ enable: false })])).toEqual([]);
    });

    it('ignores a client of another kind', async () => {
        expect(await warned([client({ implementation: 'Transmission' })])).toEqual([]);
    });

    it('says nothing without a category', async () => {
        expect(await categoryWatchers([radarr([client()]) as ServiceAdapter], 'QBittorrent', undefined)).toEqual([]);
    });
});
