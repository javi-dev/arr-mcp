import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    anonymiseArrBlocklist,
    anonymiseCleanuparrSeeker,
    anonymiseJellyfinSystemInfo,
    anonymiseProwlarrHistory,
    anonymiseProwlarrIndexer,
    anonymiseProwlarrIndexerStats,
    anonymiseSabnzbdServerStats,
    anonymiseSabnzbdWarnings,
    indexerAliases
} from '../scripts/lib/identityCapture.ts';

/**
 * #31 and #35: which indexers, hosts and news servers a deployment uses,
 * scrubbed by the capture script per endpoint. The inputs below are made up;
 * "Some Real Site" stands for a real indexer name.
 */

const fixture = (path: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'));

describe('indexerAliases', () => {
    it('numbers names by first appearance and gives one name one number', () => {
        const alias = indexerAliases();
        expect(['Some Real Site', 'Other Site', 'Some Real Site'].map(alias)).toEqual(['Indexer 1', 'Indexer 2', 'Indexer 1']);
    });

    it('keeps the suffix an *arr adds to an indexer synced from Prowlarr, under the same number', () => {
        const alias = indexerAliases();
        expect(alias('Some Real Site (Prowlarr)')).toBe('Indexer 1 (Prowlarr)');
        expect(alias('Some Real Site')).toBe('Indexer 1');
    });

    it('leaves a placeholder as it is and never gives its number to a new name', () => {
        const names = ['Indexer 1 (Prowlarr)', 'Some Real Site', 'Indexer 2'];
        expect(names.map(indexerAliases(names))).toEqual(['Indexer 1 (Prowlarr)', 'Indexer 3', 'Indexer 2']);
    });

    it('passes through what is not a name', () => {
        const alias = indexerAliases();
        expect([undefined, null, '', 7].map(alias)).toEqual([undefined, null, '', 7]);
    });
});

describe('the Prowlarr anonymisers', () => {
    it('replace every field of an indexer that names the site', () => {
        const row = anonymiseProwlarrIndexer(
            {
                id: 21,
                name: 'Some Real Site',
                sortName: 'some real site',
                infoLink: 'https://wiki.example.org/indexers#somerealsite',
                fields: [
                    { name: 'definitionFile', value: 'somerealsite' },
                    { name: 'apiurl', value: 'api.some-real-site.example' },
                    { name: 'baseUrl', value: 'https://some-real-site.example/' },
                    { name: 'apiPath', value: '/api' },
                    { name: 'info_uploader', value: 'Some Real Site lists uploaders by name.' },
                    { name: 'sort', value: 2 }
                ]
            },
            2
        );
        expect(row).toMatchObject({ id: 21, name: 'Indexer 3', sortName: 'indexer 3', infoLink: 'https://indexer.example.test/' });
        expect(row.fields).toEqual([
            { name: 'definitionFile', value: 'indexer3' },
            { name: 'apiurl', value: 'indexer.example.test' },
            { name: 'baseUrl', value: 'https://indexer.example.test/' },
            { name: 'apiPath', value: '/api' },
            { name: 'info_uploader', value: 'Information this indexer shows in Prowlarr.' },
            { name: 'sort', value: 2 }
        ]);
    });

    it('make a Cardigann definition own settings and site categories neutral, keeping the common ones', () => {
        const row = anonymiseProwlarrIndexer(
            {
                implementation: 'Cardigann',
                name: 'Some Real Site',
                capabilities: { categories: [{ id: 5000, name: 'TV', subCategories: [{ id: 123456, name: 'Some Real Site Anime' }] }, { id: 100100, name: 'Site Movies' }, { id: 2000, name: 'Movies', subCategories: [{ id: 123456, name: 'Some Real Site Anime' }] }] },
                fields: [
                    { name: 'baseSettings.queryLimit', label: 'Query Limit', helpText: 'The number of queries' },
                    { name: 'site-filter', label: 'Filter on the site', value: 0, selectOptions: [{ value: 0, name: 'trusted only', order: 0, hint: 'site words' }] },
                    { name: 'uploader', label: 'Uploader on the site', helpText: 'Some help', value: 'someone' },
                    { name: 'site-sort', label: 'Sort', helpTextWarning: 'Some Real Site sorts by age', helpLink: 'https://some-real-site.example/help', value: 1 }
                ]
            },
            0
        );
        expect(row.capabilities).toEqual({
            categories: [{ id: 5000, name: 'TV', subCategories: [{ id: 100001, name: 'Category 100001' }] }, { id: 100002, name: 'Category 100002' }, { id: 2000, name: 'Movies', subCategories: [{ id: 100001, name: 'Category 100001' }] }]
        });
        expect(row.fields).toEqual([
            { name: 'baseSettings.queryLimit', label: 'Query Limit', helpText: 'The number of queries' },
            { name: 'setting1', label: 'Setting 1', value: 0, selectOptions: [{ value: 0, name: 'Option 1', order: 0, hint: '' }] },
            { name: 'setting2', label: 'Setting 2', helpText: 'A setting of this definition.', value: 'someone' },
            { name: 'setting3', label: 'Setting 3', helpTextWarning: 'A warning about this setting.', helpLink: 'https://indexer.example.test/', value: 1 }
        ]);
    });

    it('leave a Newznab indexer settings as they are', () => {
        const fields = [{ name: 'apiPath', label: 'API Path', value: '/api' }, { name: 'categories', label: 'Categories', value: [2000] }];
        expect(anonymiseProwlarrIndexer({ implementation: 'Newznab', name: 'x', fields }, 0).fields).toEqual(fields);
    });

    it('replace a host name with a port, and keep an IP address with or without one', () => {
        const hosts = ['my-server:9696', '192.0.2.10:9696', '[2001:db8::1]:9696', '2001:db8::1', '192.0.2.10'];
        const body = anonymiseProwlarrIndexerStats({ hosts: hosts.map(host => ({ host })) }) as { hosts: { host: string }[] };
        expect(body.hosts.map(h => h.host)).toEqual(['service.example.test', '192.0.2.10:9696', '[2001:db8::1]:9696', '2001:db8::1', '192.0.2.10']);
    });

    it('replace a history row search link whole, key and all, and the host that asked', () => {
        const body = anonymiseProwlarrHistory({
            page: 1,
            records: [
                { id: 1, data: { url: 'https://some-real-site.example/api?t=search&apikey=0123abcd', host: 'my-server', query: 'Some Library Title 2024' } },
                { id: 2, data: { host: '192.0.2.10' } },
                { id: 3 },
                { id: 4, eventType: 'releaseGrabbed', data: { grabTitle: 'Some.Library.Title.2024.1080p-GRP', infoUrl: 'https://some-real-site.example/details/1' } }
            ]
        });
        expect(body).toEqual({
            page: 1,
            records: [
                { id: 1, data: { url: 'https://indexer.example.test/', host: 'service.example.test', query: 'Title 1' } },
                { id: 2, data: { host: '192.0.2.10' } },
                { id: 3 },
                { id: 4, eventType: 'releaseGrabbed', data: { grabTitle: 'Release.4.1080p.WEB-DL.x264-GROUP', infoUrl: 'https://indexer.example.test/' } }
            ]
        });
    });

    it('replace the indexer names and host names in indexer stats', () => {
        expect(
            anonymiseProwlarrIndexerStats({
                indexers: [{ indexerId: 20, indexerName: 'Some Real Site' }, { indexerId: 8, indexerName: 'Other Site' }],
                userAgents: [{ userAgent: 'Radarr' }],
                hosts: [{ host: 'my-server' }, { host: '192.0.2.10' }]
            })
        ).toEqual({
            indexers: [{ indexerId: 20, indexerName: 'Indexer 1' }, { indexerId: 8, indexerName: 'Indexer 2' }],
            userAgents: [{ userAgent: 'Radarr' }],
            hosts: [{ host: 'service.example.test' }, { host: '192.0.2.10' }]
        });
    });
});

describe('the other anonymisers', () => {
    it('name a blocklist row indexer by placeholder, rows from one indexer alike', () => {
        const body = anonymiseArrBlocklist({
            records: [{ indexer: 'Some Real Site (Prowlarr)' }, { indexer: 'Other Site (Prowlarr)' }, { indexer: 'Some Real Site (Prowlarr)' }, { id: 4 }]
        });
        expect(body).toEqual({
            records: [{ indexer: 'Indexer 1 (Prowlarr)' }, { indexer: 'Indexer 2 (Prowlarr)' }, { indexer: 'Indexer 1 (Prowlarr)' }, { id: 4 }]
        });
    });

    it('rename each SABnzbd news server and the host a connection warning quotes', () => {
        expect(anonymiseSabnzbdServerStats({ total: 1, servers: { 'news.some-provider.example': { total: 1 }, 'news2.example.test': { total: 2 } } })).toEqual({
            total: 1,
            servers: { 'news1.example.test': { total: 1 }, 'news2.example.test': { total: 2 } }
        });
        expect(
            anonymiseSabnzbdWarnings({
                warnings: [{ text: 'Connection refused 22@news.some-provider.example:563 (news.some-provider.example)' }, { text: 'Import of Some.Release.mkv failed' }]
            })
        ).toEqual({
            warnings: [{ text: 'Connection refused 22@news1.example.test:563 (news1.example.test)' }, { text: 'Import of Some.Release.mkv failed' }]
        });
    });

    it('rename a news server in any wording a warning uses, as server_stats numbered it', () => {
        const stats = { servers: { 'news.first-provider.example': {}, 'eu.news.second-provider.example': {} } };
        expect(
            anonymiseSabnzbdWarnings(
                {
                    warnings: [
                        { text: 'Login failed for eu.news.second-provider.example' },
                        { text: 'Server news.first-provider.example will be ignored for 10 minutes' },
                        { text: 'Cannot connect to server news.first-provider.example [Failed to resolve news.first-provider.example]' },
                        { text: 'Connection refused 3@news.gone-provider.example:563 (news.gone-provider.example)' },
                        { text: 'Connection refused 4@old.news.first-provider.example:563 (old.news.first-provider.example)' },
                        { text: 'Connection refused 5@news.first-provider.example:563 (news.gone-provider.example)' },
                        { text: 'Login failed for old.news.first-provider.example' }
                    ]
                },
                stats
            )
        ).toEqual({
            warnings: [
                { text: 'Login failed for news2.example.test' },
                { text: 'Server news1.example.test will be ignored for 10 minutes' },
                { text: 'Cannot connect to server news1.example.test [Failed to resolve news1.example.test]' },
                { text: 'Connection refused 3@news1.example.test:563 (news1.example.test)' },
                { text: 'Connection refused 4@news1.example.test:563 (news1.example.test)' },
                { text: 'Connection refused 5@news1.example.test:563 (news1.example.test)' },
                // A server no longer in server_stats is unknown outside the connection-failure
                // wording, and is left whole rather than cut down to a placeholder with a label on.
                { text: 'Login failed for old.news.first-provider.example' }
            ]
        });
    });

    it('name a Cleanuparr instance by its type, numbered only when a type repeats', () => {
        expect(
            anonymiseCleanuparrSeeker({
                instances: [
                    { instanceName: '[my-prefix] Sonarr', instanceType: 'Sonarr' },
                    { instanceName: 'Movies HD', instanceType: 'Radarr' },
                    { instanceName: 'Movies 4K', instanceType: 'Radarr' }
                ]
            })
        ).toEqual({
            instances: [
                { instanceName: 'Sonarr', instanceType: 'Sonarr' },
                { instanceName: 'Radarr 1', instanceType: 'Radarr' },
                { instanceName: 'Radarr 2', instanceType: 'Radarr' }
            ]
        });
    });

    it('replace the Jellyfin server name', () => {
        expect(anonymiseJellyfinSystemInfo({ ServerName: 'my-server', Version: '10.10.0' })).toEqual({ ServerName: 'service.example.test', Version: '10.10.0' });
    });
});

/**
 * Each committed fixture is exactly what its anonymiser writes: running it
 * again changes nothing. A value the capture would have replaced fails here.
 */
describe('the committed fixtures', () => {
    it.each([
        ['prowlarr/indexer.json', (b: unknown) => (Array.isArray(b) ? b.map(anonymiseProwlarrIndexer) : b)],
        ['prowlarr/indexerstats.json', anonymiseProwlarrIndexerStats],
        ['prowlarr/history.json', anonymiseProwlarrHistory],
        ['radarr/blocklist.json', anonymiseArrBlocklist],
        ['sonarr/blocklist.json', anonymiseArrBlocklist],
        ['sabnzbd/server-stats.json', anonymiseSabnzbdServerStats],
        ['sabnzbd/warnings.json', (b: unknown) => anonymiseSabnzbdWarnings(b, fixture('sabnzbd/server-stats.json'))],
        ['cleanuparr/2.10.12/configuration-seeker.json', anonymiseCleanuparrSeeker],
        ['jellyfin/system-info.json', anonymiseJellyfinSystemInfo]
    ] as const)('%s is what the capture writes', (path, anonymise) => {
        const body = fixture(path);
        expect(anonymise(body)).toEqual(body);
    });
});
