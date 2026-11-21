/**
 * Which indexers, hosts and news servers a deployment uses, scrubbed per
 * endpoint for `capture-fixtures.ts` and split out so it can be unit tested
 * (`capture-fixtures.ts` runs `loadConfig()` on import).
 *
 * Every function here maps its own placeholders to themselves, so running it
 * over a fixture it already wrote changes nothing. `test/identityCapture.test.ts`
 * holds the committed fixtures to that: each is exactly what its anonymiser
 * writes.
 */
import { isIP } from 'node:net';
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

/** Settings every Cardigann indexer has, whichever site its definition is for. */
const COMMON_SETTING = /^(?:definitionFile|baseUrl|baseSettings\.|torrentBaseSettings\.)/;

const settingValue = (f: Row, n: number): Row => {
    if (typeof f.value !== 'string' || f.value === '') return f;
    const name = typeof f.name === 'string' ? f.name : '';
    if (name === 'definitionFile') return { ...f, value: `indexer${n}` };
    if (/^info/i.test(name)) return { ...f, value: 'Information this indexer shows in Prowlarr.' };
    if (/url$/i.test(name) && !/^(?:https?:\/\/|\/)/i.test(f.value)) return { ...f, value: new URL(ANONYMOUS_URL).host };
    return { ...f, value: scrubUrls(f.value) };
};

/**
 * A Cardigann definition's own settings (a site's filters, its category list,
 * its sort orders) name it as surely as its name does. Each keeps its type,
 * value and option values, under a neutral name, label and option names. Help
 * text, a help warning and a help link go too.
 */
const neutralSetting = (f: Row, k: number): Row => ({
    ...f,
    name: `setting${k}`,
    ...(f.label === undefined ? {} : { label: replaceIfString(f.label, `Setting ${k}`) }),
    ...(f.helpText === undefined ? {} : { helpText: replaceIfString(f.helpText, 'A setting of this definition.') }),
    ...(f.helpTextWarning === undefined ? {} : { helpTextWarning: replaceIfString(f.helpTextWarning, 'A warning about this setting.') }),
    ...(f.helpLink === undefined ? {} : { helpLink: replaceIfString(f.helpLink, ANONYMOUS_URL) }),
    ...(Array.isArray(f.selectOptions)
        ? { selectOptions: (f.selectOptions as unknown[]).map((o, i) => (isRow(o) ? { ...o, name: replaceIfString(o.name, `Option ${i + 1}`), ...(o.hint === undefined ? {} : { hint: replaceIfString(o.hint, '') }) } : o)) }
        : {})
});

/**
 * A category a definition made up for its site (id 100000 and up). Its name
 * goes, and so does its id: Prowlarr derives the id from the site's own
 * category list, so the set of ids would still say which site it is. Ids are
 * renumbered from 100001 in the order they first appear, one id keeping one
 * number wherever it repeats, so a second pass changes nothing.
 */
const SITE_CATEGORY = 100_000;
const neutralCategories = (categories: unknown, renumbered = new Map<number, number>()): unknown => {
    if (!Array.isArray(categories)) return categories;
    return (categories as unknown[]).map(c => {
        if (!isRow(c)) return c;
        let site = {};
        if (typeof c.id === 'number' && c.id >= SITE_CATEGORY) {
            const id = renumbered.get(c.id) ?? SITE_CATEGORY + renumbered.size + 1;
            renumbered.set(c.id, id);
            site = { id, name: replaceIfString(c.name, `Category ${id}`) };
        }
        return { ...c, ...site, ...(c.subCategories === undefined ? {} : { subCategories: neutralCategories(c.subCategories, renumbered) }) };
    });
};

/**
 * A Prowlarr `IndexerResource`. Besides the name, the sort name, the Cardigann
 * definition file, the wiki anchor and the definition's own help texts each
 * say which site it is, and a definition can hold its API host without a
 * scheme. A Cardigann definition's own settings and site categories are made
 * neutral as well. `n` is the indexer's place in the list, as its name
 * already uses.
 */
export function anonymiseProwlarrIndexer(row: Row, index: number): Row {
    const n = index + 1;
    const cardigann = row.implementation === 'Cardigann';
    let k = 0;
    const fields = Array.isArray(row.fields)
        ? (row.fields as Row[]).map(f => {
              const valued = settingValue(f, n);
              if (!cardigann || COMMON_SETTING.test(typeof f.name === 'string' ? f.name : '')) return valued;
              k += 1;
              return neutralSetting(valued, k);
          })
        : row.fields;
    const capabilities =
        cardigann && isRow(row.capabilities) && row.capabilities.categories !== undefined
            ? { capabilities: { ...row.capabilities, categories: neutralCategories(row.capabilities.categories) } }
            : {};

    return {
        ...row,
        ...capabilities,
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

/** An IP literal, with or without a port (`192.0.2.10:9696`, `[2001:db8::1]:9696`): not a host name. */
const isAddress = (value: string): boolean => {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
    if (bracketed !== null) return isIP(bracketed[1] ?? '') !== 0;
    return isIP(value) !== 0 || isIP(value.replace(/:\d+$/, '')) !== 0;
};

const hostName = (value: unknown): unknown => (typeof value === 'string' && value !== '' && !isAddress(value) ? ANONYMOUS_HOST : value);

/**
 * Prowlarr `history`: `data.url` is the indexer's own search link, with its
 * host, its API path and any key in the query; `data.host` is the machine
 * that asked. A search row's `data.query` is what an *arr searched for, a
 * title from the library when it is not empty. A grab row adds
 * `data.infoUrl`, the release's page on the indexer, and `data.grabTitle`,
 * the release name, which carries a title as well.
 */
export function anonymiseProwlarrHistory(body: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.records)) return body;
    return {
        ...body,
        records: (body.records as Row[]).map((row, i) =>
            isRow(row.data)
                ? {
                      ...row,
                      data: {
                          ...row.data,
                          ...(row.data.url === undefined ? {} : { url: replaceIfString(row.data.url, ANONYMOUS_URL) }),
                          ...(typeof row.data.query === 'string' && row.data.query !== '' ? { query: `Title ${i + 1}` } : {}),
                          ...(row.data.infoUrl === undefined ? {} : { infoUrl: replaceIfString(row.data.infoUrl, ANONYMOUS_URL) }),
                          ...(row.data.grabTitle === undefined ? {} : { grabTitle: replaceIfString(row.data.grabTitle, `Release.${i + 1}.1080p.WEB-DL.x264-GROUP`) }),
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

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * SABnzbd `warnings`: a warning can name a news server in any wording. Each
 * server `server_stats` listed (`serverStats`, its response from the same
 * capture) becomes the `newsN` it got there, wherever it appears. A
 * connection failure, `22@<host>:563 (<host>)`, is caught by its shape as
 * well, for a server no longer in `server_stats`. The rest of the text is
 * left as it is.
 */
export function anonymiseSabnzbdWarnings(body: unknown, serverStats?: unknown): unknown {
    if (!isRow(body) || !Array.isArray(body.warnings)) return body;
    const stats = isRow(serverStats) && isRow(serverStats.servers) ? Object.keys(serverStats.servers) : [];
    const renamed = isRow(serverStats) ? anonymiseSabnzbdServerStats(serverStats) : undefined;
    const placeholders = isRow(renamed) && isRow(renamed.servers) ? Object.keys(renamed.servers) : [];
    // Longest first, so a host that is a suffix of another does not cut it in two.
    const known = stats
        .map((host, i) => [host, placeholders[i] ?? 'news1.example.test'] as const)
        .filter(([host, placeholder]) => host !== placeholder)
        .sort(([a], [b]) => b.length - a.length);
    const fallback = 'news1.example.test';
    // A whole host name only: a known server that is the tail of a longer
    // name must not turn that name into a placeholder with a label left on.
    const whole = (host: string): RegExp => new RegExp(`(?<![A-Za-z0-9.-])${escape(host)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'gi');
    const neutral = (host: string): string => (PLACEHOLDER_SERVER.test(host) ? host : fallback);
    return {
        ...body,
        warnings: (body.warnings as unknown[]).map(w => {
            const scrub = (text: string): string =>
                known
                    .reduce((out, [host, placeholder]) => out.replace(whole(host), placeholder), text)
                    .replace(
                        /(\d+@)([A-Za-z0-9.-]+)(:\d+ \()([A-Za-z0-9.-]+)(\))/g,
                        (_all: string, at: string, first: string, port: string, second: string, close: string) =>
                            `${at}${neutral(first)}${port}${neutral(second)}${close}`
                    );
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
