/**
 * Which indexers, hosts and news servers a deployment uses, scrubbed per
 * endpoint for `capture-fixtures.ts` and split out so it can be unit tested
 * (`capture-fixtures.ts` runs `loadConfig()` on import).
 *
 * Every function here maps its own placeholders to themselves, so running it
 * over a fixture it already wrote changes nothing. `test/scriptsRedact.test.ts`
 * holds the committed fixtures to that: each is exactly what its anonymiser
 * writes.
 */
import { ANONYMOUS_HOST, ANONYMOUS_URL, isRow, replaceIfString, type Row } from './redact.ts';

/** The name an indexer gets in a fixture, and the suffix an *arr adds to one it syncs from Prowlarr. */
const PLACEHOLDER_INDEXER = /^Indexer (\d+)$/;
const SYNCED = ' (Prowlarr)';

/**
 * Real indexer name to `Indexer N`, numbered by first appearance within one
 * response, so rows from one indexer still share a name. An *arr's ` (Prowlarr)`
 * suffix is kept: it says the indexer is synced, which the seeding checks read.
 * A placeholder keeps its number, and a new name never takes a number one
 * already holds anywhere in `names`, every name the response carries.
 */
export function indexerAliases(names: readonly unknown[] = []): (name: unknown) => unknown {
    const given = new Map<string, string>();
    const base = (name: string): string => (name.endsWith(SYNCED) ? name.slice(0, -SYNCED.length) : name);
    const taken = new Set<number>(
        names.flatMap(name => {
            const kept = typeof name === 'string' ? PLACEHOLDER_INDEXER.exec(base(name)) : null;
            return kept === null ? [] : [Number(kept[1])];
        })
    );
    let next = 1;
    const alias = (base: string): string => {
        const kept = PLACEHOLDER_INDEXER.exec(base);
        if (kept !== null) {
            taken.add(Number(kept[1]));
            return base;
        }
        const known = given.get(base);
        if (known !== undefined) return known;
        while (taken.has(next)) next++;
        taken.add(next);
        const placeholder = `Indexer ${next}`;
        given.set(base, placeholder);
        return placeholder;
    };
    return name => {
        if (typeof name !== 'string' || name === '') return name;
        return name.endsWith(SYNCED) ? `${alias(base(name))}${SYNCED}` : alias(name);
    };
}

const scrubUrls = (value: string): string => value.replace(/https?:\/\/[^\s"',\]]+/gi, ANONYMOUS_URL);

/**
 * A Prowlarr `IndexerResource`. Besides the name, the sort name, the Cardigann
 * definition file, the wiki anchor and the definition's own help texts each
 * say which site it is, and a definition can hold its API host without a
 * scheme. `n` is the indexer's place in the list, as its name already uses.
 */
export function anonymiseProwlarrIndexer(row: Row, index: number): Row {
    const n = index + 1;
    const fields = Array.isArray(row.fields)
        ? (row.fields as Row[]).map(f => {
              if (typeof f.value !== 'string' || f.value === '') return f;
              const name = typeof f.name === 'string' ? f.name : '';
              if (name === 'definitionFile') return { ...f, value: `indexer${n}` };
              if (/^info/i.test(name)) return { ...f, value: 'Information this indexer shows in Prowlarr.' };
              if (/url$/i.test(name) && !/^(?:https?:\/\/|\/)/i.test(f.value)) return { ...f, value: new URL(ANONYMOUS_URL).host };
              return { ...f, value: scrubUrls(f.value) };
          })
        : row.fields;

    return {
        ...row,
        name: replaceIfString(row.name, `Indexer ${n}`),
        ...(row.sortName === undefined ? {} : { sortName: replaceIfString(row.sortName, `indexer ${n}`) }),
        description: replaceIfString(row.description, 'An indexer.'),
        definitionName: replaceIfString(row.definitionName, 'Definition'),
        ...(row.infoLink === undefined ? {} : { infoLink: replaceIfString(row.infoLink, ANONYMOUS_URL) }),
        indexerUrls: Array.isArray(row.indexerUrls) ? [ANONYMOUS_URL] : row.indexerUrls,
        legacyUrls: Array.isArray(row.legacyUrls) ? [] : row.legacyUrls,
        fields
    };
}

/** An address the redaction already wrote, or any IP literal: not a host name. */
const isAddress = (value: string): boolean => /^[\d.]+$/.test(value) || value.includes(':');

const hostName = (value: unknown): unknown => (typeof value === 'string' && value !== '' && !isAddress(value) ? ANONYMOUS_HOST : value);

/**
 * Prowlarr `history`: `data.url` is the indexer's own search link, with its
 * host, its API path and any key in the query; `data.host` is the machine
 * that asked.
 */
export function anonymiseProwlarrHistory(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.records)) return body;
    return {
        ...body,
        records: (body.records as Row[]).map(row =>
            isRow(row.data)
                ? {
                      ...row,
                      data: {
                          ...row.data,
                          ...(row.data.url === undefined ? {} : { url: replaceIfString(row.data.url, ANONYMOUS_URL) }),
                          ...(row.data.host === undefined ? {} : { host: hostName(row.data.host) })
                      }
                  }
                : row
        )
    };
}

/** Prowlarr `indexerstats`: each indexer by name, and each host that queried it. */
export function anonymiseProwlarrIndexerStats(body: unknown): unknown {
    if (!isRow(body)) return body;
    const alias = indexerAliases(Array.isArray(body.indexers) ? (body.indexers as Row[]).map(row => row.indexerName) : []);
    return {
        ...body,
        ...(Array.isArray(body.indexers)
            ? { indexers: (body.indexers as Row[]).map(row => ({ ...row, indexerName: alias(row.indexerName) })) }
            : {}),
        ...(Array.isArray(body.hosts) ? { hosts: (body.hosts as Row[]).map(row => ({ ...row, host: hostName(row.host) })) } : {})
    };
}

/** A Radarr or Sonarr `blocklist` page: which indexer each release came from. */
export function anonymiseArrBlocklist(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.records)) return body;
    const alias = indexerAliases((body.records as Row[]).map(row => row.indexer));
    return {
        ...body,
        records: (body.records as Row[]).map(row => (row.indexer === undefined ? row : { ...row, indexer: alias(row.indexer) }))
    };
}

/** What a news server becomes: `news1.example.test`, `news2.example.test`. */
const PLACEHOLDER_SERVER = /^news\d+\.example\.test$/;

/** SABnzbd `server_stats`: the `servers` object is keyed by the news server's host. */
export function anonymiseSabnzbdServerStats(body: unknown): unknown {
    if (!isRow(body) || !isRow(body.servers)) return body;
    const entries = Object.entries(body.servers);
    const taken = new Set(entries.map(([host]) => host).filter(host => PLACEHOLDER_SERVER.test(host)));
    let next = 1;
    const renamed = entries.map(([host, stats]): [string, unknown] => {
        if (PLACEHOLDER_SERVER.test(host)) return [host, stats];
        while (taken.has(`news${next}.example.test`)) next++;
        const placeholder = `news${next}.example.test`;
        taken.add(placeholder);
        return [placeholder, stats];
    });
    return { ...body, servers: Object.fromEntries(renamed) };
}

/**
 * SABnzbd `warnings`: a connection failure names the news server twice,
 * `22@<host>:563 (<host>)`. The rest of the text is left as it is.
 */
export function anonymiseSabnzbdWarnings(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.warnings)) return body;
    const server = 'news1.example.test';
    return {
        ...body,
        warnings: (body.warnings as unknown[]).map(w => {
            const scrub = (text: string): string =>
                text.replace(/(\d+@)[A-Za-z0-9.-]+(:\d+ \()[A-Za-z0-9.-]+(\))/g, `$1${server}$2${server}$3`);
            if (typeof w === 'string') return scrub(w);
            return isRow(w) && typeof w.text === 'string' ? { ...w, text: scrub(w.text) } : w;
        })
    };
}

/**
 * Cleanuparr's seeker configuration names each *arr instance as the operator
 * did. It becomes the instance's type, numbered only when one type repeats.
 */
export function anonymiseCleanuparrSeeker(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.instances)) return body;
    const rows = body.instances as Row[];
    const typeOf = (row: Row): string => (typeof row.instanceType === 'string' ? row.instanceType : 'Instance');
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(typeOf(row), (counts.get(typeOf(row)) ?? 0) + 1);
    const seen = new Map<string, number>();
    return {
        ...body,
        instances: rows.map(row => {
            if (row.instanceName === undefined) return row;
            const type = typeOf(row);
            const k = (seen.get(type) ?? 0) + 1;
            seen.set(type, k);
            return { ...row, instanceName: replaceIfString(row.instanceName, (counts.get(type) ?? 0) > 1 ? `${type} ${k}` : type) };
        })
    };
}

/** Jellyfin `System/Info`: `ServerName` is the name the operator gave the server, by default its host name. */
export function anonymiseJellyfinSystemInfo(body: unknown): unknown {
    return isRow(body) && body.ServerName !== undefined ? { ...body, ServerName: replaceIfString(body.ServerName, ANONYMOUS_HOST) } : body;
}
