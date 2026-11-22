import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    captureProwlarrIndexerStats,
    captureSabnzbdWarnings,
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
                    { name: 'mirrorUrl', value: 'https://[2001:db8:5::9]:8443/some-site/path?key=x' },
                    { name: 'cdnUrl', value: '//cdn.some-real-site.example/x' },
                    { name: 'notice', type: 'info', value: 'Some Real Site asks for an invite.' },
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
            { name: 'mirrorUrl', value: 'https://indexer.example.test/' },
            { name: 'cdnUrl', value: 'https://indexer.example.test/' },
            { name: 'notice', type: 'info', value: 'Information this indexer shows in Prowlarr.' },
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
            { name: 'setting2', label: 'Setting 2', helpText: 'A setting of this definition.', value: 'Value 2' },
            { name: 'setting3', label: 'Setting 3', helpTextWarning: 'A warning about this setting.', helpLink: 'https://indexer.example.test/', value: 1 }
        ]);
    });

    it('leave a Newznab indexer settings and standard categories as they are, and its own categories neutral', () => {
        const fields = [{ name: 'apiPath', label: 'API Path', value: '/api' }, { name: 'categories', label: 'Categories', value: [2000] }];
        const row = anonymiseProwlarrIndexer(
            {
                implementation: 'Newznab',
                name: 'x',
                fields,
                capabilities: { categories: [{ id: 2000, name: 'Movies', subCategories: [{ id: 2040, name: 'Movies/HD' }] }, { id: 102040, name: 'Site HD Movies' }] }
            },
            0
        );
        expect(row.fields).toEqual(fields);
        expect(row.capabilities).toEqual({
            categories: [{ id: 2000, name: 'Movies', subCategories: [{ id: 2040, name: 'Movies/HD' }] }, { id: 100001, name: 'Category 100001' }]
        });
    });

    it('replace a host name with a port, and keep an IP address with or without one', () => {
        const hosts = ['my-server:9696', '192.0.2.10:9696', '[2001:db8::1]:9696', '2001:db8::1', '192.0.2.10', '10.0.0.4'];
        const body = anonymiseProwlarrIndexerStats({ hosts: hosts.map(host => ({ host })) }) as { hosts: { host: string }[] };
        expect(body.hosts.map(h => h.host)).toEqual(['service.example.test', '192.0.2.10:9696', '[2001:db8::1]:9696', '2001:db8::1', '192.0.2.10', '10.0.0.4']);
    });

    // A public address is a real machine: the capture's redaction only rewrites private ones.
    it('replace a public address in either Prowlarr host field with a documentation one, port kept', () => {
        const stats = anonymiseProwlarrIndexerStats({ hosts: [{ host: '8.8.4.4' }, { host: '8.8.4.4:9696' }, { host: '[2606:4700::1111]:9696' }] }) as { hosts: { host: string }[] };
        expect(stats.hosts.map(h => h.host)).toEqual(['203.0.113.10', '203.0.113.10:9696', '[2001:db8::10]:9696']);
        const history = anonymiseProwlarrHistory({ records: [{ data: { host: '2606:4700::1111' } }] });
        expect(history).toEqual({ records: [{ data: { host: '2001:db8::10' } }] });
    });

    it('replace every IPv6 host outside the documentation range whole, zone and embedded IPv4 included', () => {
        const hosts = ['fe80::1%eth0', '[fe80::1%25eth0]:9696', '::ffff:192.168.1.5', 'fd00::5', '::1', '2001:db8::7', '2001:db8::7%eth0', '2001:db8::198.51.100.9'];
        const stats = anonymiseProwlarrIndexerStats({ hosts: hosts.map(host => ({ host })) }) as { hosts: { host: string }[] };
        expect(stats.hosts.map(h => h.host)).toEqual(['2001:db8::10', '[2001:db8::10]:9696', '2001:db8::10', '2001:db8::10', '2001:db8::10', '2001:db8::7', '2001:db8::10', '2001:db8::10']);
    });

    it('neutralise what was typed into a definition own settings, credentials as the redaction placeholder, and keep it on a second pass', () => {
        const once = anonymiseProwlarrIndexer(
            {
                implementation: 'Cardigann',
                name: 'x',
                fields: [
                    { name: 'cookie', type: 'textbox', value: 'session=abc123' },
                    { name: 'siteKey', type: 'password', privacy: 'password', value: 'k' },
                    { name: 'apiHost', type: 'textbox', value: 'api.some-real-site.example' },
                    { name: 'freeleech', type: 'checkbox', value: true },
                    { name: 'notice', type: 'info', value: 'Some Real Site help' },
                    { name: 'empty', type: 'textbox', value: '' }
                ]
            },
            0
        );
        const values = ['__REDACTED__', '__REDACTED__', 'Value 3', true, 'Information this indexer shows in Prowlarr.', ''];
        expect((once.fields as { value: unknown }[]).map(f => f.value)).toEqual(values);
        // A recapture checked against its own output: the names that told these apart are gone by now.
        expect(anonymiseProwlarrIndexer(once, 0)).toEqual(once);
        const named = anonymiseProwlarrIndexer({ implementation: 'Cardigann', name: 'x', fields: [{ name: 'info_extra', type: 'textbox', value: 'Some Real Site help' }] }, 0);
        expect(anonymiseProwlarrIndexer(named, 0)).toEqual(named);
    });

    it('redact a credential in a Newznab indexer extra query parameters and keep the rest', () => {
        const row = anonymiseProwlarrIndexer(
            { implementation: 'Newznab', name: 'x', fields: [{ name: 'additionalParameters', value: '&extended=1&apikey=0123abcd&passkey=zz' }] },
            0
        );
        expect(row.fields).toEqual([{ name: 'additionalParameters', value: '&extended=1&apikey=__REDACTED__&passkey=__REDACTED__' }]);
        expect(anonymiseProwlarrIndexer(row, 0)).toEqual(row);
    });

    it('name a built-in indexer implementation generically, and leave the generic ones', () => {
        const row = anonymiseProwlarrIndexer({ implementation: 'SomeRealSite', implementationName: 'Some Real Site', configContract: 'SomeRealSiteSettings', name: 'x', fields: [] }, 0);
        expect(row).toMatchObject({ implementation: 'Indexer', implementationName: 'Indexer', configContract: 'IndexerSettings' });
        expect(anonymiseProwlarrIndexer(row, 0)).toEqual(row);
        for (const implementation of ['Newznab', 'Torznab', 'Cardigann']) {
            const generic = { implementation, implementationName: implementation, configContract: `${implementation}Settings`, name: 'x', fields: [] };
            expect(anonymiseProwlarrIndexer(generic, 0)).toMatchObject({ implementation, implementationName: implementation, configContract: `${implementation}Settings` });
        }
    });

    it('give an indexer in the stats the name the indexer list gave it, by id, and number the rest after them', () => {
        const list = [{ id: 21 }, { id: 8 }];
        const body = captureProwlarrIndexerStats(
            { indexers: [{ indexerId: 8, indexerName: 'Some Real Site' }, { indexerId: 99, indexerName: 'Gone Site' }, { indexerId: 21, indexerName: 'Other Site' }] },
            new Map<string, unknown>([['indexer', list]])
        );
        expect(body).toEqual({
            indexers: [{ indexerId: 8, indexerName: 'Indexer 2' }, { indexerId: 99, indexerName: 'Indexer 3' }, { indexerId: 21, indexerName: 'Indexer 1' }]
        });
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

    it('rename an IP literal in a connection failure for a server server_stats does not list', () => {
        const body = anonymiseSabnzbdWarnings(
            { warnings: [{ text: 'Connection refused 22@2001:db8:77::5:563 (2001:db8:77::5)' }, { text: 'Connection refused 23@198.51.100.9:119 (198.51.100.9)' }, { text: 'Connection refused 24@fe80::1%eth0:563 (fe80::1%eth0)' }, { text: 'Connection refused 25@fe80::1%my_nic:563 (fe80::1%my_nic)' }] },
            { servers: {} }
        );
        expect(body).toEqual({
            warnings: [{ text: 'Connection refused 22@news1.example.test:563 (news1.example.test)' }, { text: 'Connection refused 23@news1.example.test:119 (news1.example.test)' }, { text: 'Connection refused 24@news1.example.test:563 (news1.example.test)' }, { text: 'Connection refused 25@news1.example.test:563 (news1.example.test)' }]
        });
    });

    it('give the warnings the aliases server_stats got, as the capture runs them', () => {
        const rawStats = { servers: { 'news.first-provider.example': {}, 'eu.news.second-provider.example': {} } };
        const stats = anonymiseSabnzbdServerStats(rawStats) as { servers: Record<string, unknown> };
        const warnings = captureSabnzbdWarnings(
            { warnings: [{ text: 'Login failed for eu.news.second-provider.example' }] },
            new Map<string, unknown>([['server-stats', rawStats]])
        );
        expect(Object.keys(stats.servers)).toEqual(['news1.example.test', 'news2.example.test']);
        expect(warnings).toEqual({ warnings: [{ text: 'Login failed for news2.example.test' }] });
    });

    // capture-fixtures.ts cannot be imported (it loads the config), so this reads it:
    // each endpoint these anonymisers exist for is registered with its anonymiser.
    it('register every endpoint with its anonymiser in the capture script', () => {
        const source = readFileSync(join(import.meta.dirname, '..', 'scripts', 'capture-fixtures.ts'), 'utf8');
        const registered = (line: string): number => source.split(line).length - 1;
        expect(registered("{ name: 'blocklist', path: '/api/v3/blocklist?page=1&pageSize=10', anonymise: anonymiseArrBlocklist },")).toBe(2);
        expect(registered("{ name: 'indexerstats', path: '/api/v1/indexerstats', anonymise: captureProwlarrIndexerStats },")).toBe(1);
        expect(registered("{ name: 'history', path: '/api/v1/history?pageSize=20', anonymise: anonymiseProwlarrHistory },")).toBe(1);
        expect(registered("            path: '/api/v1/indexer',\n            anonymise: body => (Array.isArray(body) ? (body as Row[]).map(anonymiseProwlarrIndexer) : body)")).toBe(1);
        expect(registered("{ name: 'system-info', path: '/System/Info', anonymise: anonymiseJellyfinSystemInfo },")).toBe(1);
        expect(registered("{ name: 'configuration-seeker', path: '/api/configuration/seeker', anonymise: anonymiseCleanuparrSeeker },")).toBe(1);
        // No other capture of these endpoints goes around them.
        expect(source.match(/\{ name: '(?:indexerstats|system-info|configuration-seeker|server-stats|warnings)'/g)).toHaveLength(5);
        expect(source.match(/path: '\/api\/v1\/history/g)).toHaveLength(1);
    });

    // capture-fixtures.ts cannot be imported (it loads the config), so this reads it:
    // the warnings must go through the wiring above, after server_stats is captured.
    it('wire the SABnzbd warnings to the server_stats captured before them', () => {
        const source = readFileSync(join(import.meta.dirname, '..', 'scripts', 'capture-fixtures.ts'), 'utf8');
        const stats = source.indexOf("{ name: 'server-stats', path: '/api?mode=server_stats&output=json', anonymise: anonymiseSabnzbdServerStats }");
        const warnings = source.indexOf("{ name: 'warnings', path: '/api?mode=warnings&output=json', anonymise: captureSabnzbdWarnings }");
        expect(stats).toBeGreaterThan(-1);
        expect(warnings).toBeGreaterThan(stats);
        // The loop keeps each raw response before it anonymises the next, and hands them on.
        const kept = source.indexOf('soFar.set(endpoint.name, raw);');
        const handed = source.indexOf('endpoint.anonymise(raw, soFar)');
        expect(kept).toBeGreaterThan(-1);
        expect(handed).toBeGreaterThan(kept);
        expect(source.match(/endpoint\.anonymise\(/g)).toHaveLength(1);
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

// One placeholder is one indexer: the stats and the list agree by id.
describe('the committed Prowlarr fixtures', () => {
    it('name each indexer the same in the list and the stats', () => {
        const list = fixture('prowlarr/indexer.json') as { id: number; name: string }[];
        const stats = fixture('prowlarr/indexerstats.json') as { indexers: { indexerId: number; indexerName: string }[] };
        const byId = new Map(list.map(row => [row.id, row.name]));
        for (const row of stats.indexers) {
            if (byId.has(row.indexerId)) expect(row.indexerName, String(row.indexerId)).toBe(byId.get(row.indexerId));
        }
        expect(stats.indexers.some(row => byId.has(row.indexerId))).toBe(true);
    });
});

/**
 * Each committed fixture is exactly what its anonymiser writes: running it
 * again changes nothing. A value the capture would have replaced fails here.
 */
describe('the committed fixtures', () => {
    it.each([
        ['prowlarr/indexer.json', (b: unknown) => (Array.isArray(b) ? b.map(anonymiseProwlarrIndexer) : b)],
        ['prowlarr/indexerstats.json', (b: unknown) => anonymiseProwlarrIndexerStats(b, fixture('prowlarr/indexer.json'))],
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
