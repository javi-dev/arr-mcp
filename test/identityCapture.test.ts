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

    it('replace a history row search link whole, key and all, and the host that asked', () => {
        const body = anonymiseProwlarrHistory({
            page: 1,
            records: [
                { id: 1, data: { url: 'https://some-real-site.example/api?t=search&apikey=0123abcd', host: 'my-server', query: 'x' } },
                { id: 2, data: { host: '192.0.2.10' } },
                { id: 3 }
            ]
        });
        expect(body).toEqual({
            page: 1,
            records: [
                { id: 1, data: { url: 'https://indexer.example.test/', host: 'service.example.test', query: 'x' } },
                { id: 2, data: { host: '192.0.2.10' } },
                { id: 3 }
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
        ['sabnzbd/warnings.json', anonymiseSabnzbdWarnings],
        ['cleanuparr/2.10.12/configuration-seeker.json', anonymiseCleanuparrSeeker],
        ['jellyfin/system-info.json', anonymiseJellyfinSystemInfo]
    ] as const)('%s is what the capture writes', (path, anonymise) => {
        const body = fixture(path);
        expect(anonymise(body)).toEqual(body);
    });
});
