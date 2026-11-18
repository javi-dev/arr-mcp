import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { gather } from '../core/gather.ts';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, listText, toolInput, type DetailLevel, unreachableTail } from '../core/shape.ts';
import { annotateCleanuparr, dueWithin, type CleanuparrDue } from './cleanuparrQueue.ts';
import type { LibraryKind } from '../core/resolver.ts';
import { hasQueue, hasTorrentManage, TORRENT_FILES_SHOWN, type QueueItem, type ServiceAdapter, type TorrentDetails } from '../services/types.ts';
import { MediaKindSchema, holds } from './mediaKind.ts';
import { importFailing, importStepFor, orphanImportStepFor, retriedImportStepFor } from './importStep.ts';
import { nextStepLine, stepsField, type NextStep } from '../core/nextStep.ts';
import { DOWNLOAD_CLIENTS, serviceOf, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { INSTANCE_PARAM_DESCRIPTION } from './resolveInstance.ts';
import { readTargets, serviceTarget } from './serviceTarget.ts';

type GetQueueResult = {
    items: QueueItem[];
    /** Torrents on this page that were not given their files, trackers and save path, because the page is too long. */
    torrentDetailsOmitted?: number;
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /**
     * Keyed by **adapter id**, not by service type: a named instance reports
     * under `radarr/4k`. Widened from `ServiceId` for the reason
     * `library.ts` already was (`gather` has always keyed this by the id it
     * fanned out over), so the narrower type described something this never
     * held. Every existing key is unchanged.
     */
    counts: Record<string, number>;
    /** With `by_tracker`: seed time per tracker hostname, over the matching rows that are seeding now. */
    byTracker?: TrackerSeeding[];
    /** At `detail: "full"`: what Cleanuparr's rules fall due on in the next week, across the whole queue, not just this page. */
    cleanuparrDue?: CleanuparrDue;
    /** An import_download per download the *arr will not import, over every matching row, not just this page, capped. */
    next_steps?: NextStep[];
    /** How many more steps the cap on `next_steps` left out. */
    next_steps_more?: number;
};

/**
 * One tracker's seeding torrents (#531). `tracker` is the hostname only:
 * the announce URL carries the user's passkey and is never returned.
 * `atRisk` counts torrents a Cleanuparr rule stops or deletes before they
 * reach `min_seed_days`, the hit-and-run case; only with `min_seed_days`.
 */
type TrackerSeeding = {
    tracker: string;
    seeding: number;
    sizeBytes: number;
    seedingSeconds: { total: number; median: number; min: number };
    noPeers?: number;
    atRisk?: number;
};

/** A torrent no working tracker announced for: qBittorrent leaves `tracker` empty then. */
const UNKNOWN_TRACKER = 'unknown';

export function seedingByTracker(items: readonly QueueItem[], now: number, minSeedDays?: number): TrackerSeeding[] {
    const groups = new Map<string, QueueItem[]>();
    for (const item of items) {
        if (item.torrent === undefined || !item.status.startsWith('seeding')) continue;
        const tracker = item.torrent.trackerDomains[0] ?? UNKNOWN_TRACKER;
        groups.set(tracker, [...(groups.get(tracker) ?? []), item]);
    }
    return [...groups]
        .map(([tracker, rows]) => {
            const secs = rows.map(r => r.seeding?.seedingSeconds ?? 0).sort((a, b) => a - b);
            const mid = Math.floor(secs.length / 2);
            const median = secs.length % 2 === 1 ? secs[mid]! : Math.round((secs[mid - 1]! + secs[mid]!) / 2);
            const noPeers = rows.filter(r => r.status === 'seeding (no peers)').length;
            const atRisk =
                minSeedDays === undefined
                    ? 0
                    : rows.filter(r => {
                          const c = r.seeding?.cleanuparr;
                          const dueAt = c !== undefined && 'rule' in c ? c.dueAt : undefined;
                          if (dueAt === undefined) return false;
                          const seededThen = (r.seeding?.seedingSeconds ?? 0) + Math.max(0, Date.parse(dueAt) - now) / 1000;
                          return seededThen < minSeedDays * 86_400;
                      }).length;
            return {
                tracker,
                seeding: rows.length,
                sizeBytes: rows.reduce((n, r) => n + (r.sizeBytes ?? 0), 0),
                seedingSeconds: { total: secs.reduce((a, b) => a + b, 0), median, min: secs[0]! },
                ...(noPeers === 0 ? {} : { noPeers }),
                ...(atRisk === 0 ? {} : { atRisk })
            };
        })
        .sort((a, b) => b.seeding - a.seeding || a.tracker.localeCompare(b.tracker));
}

const days = (seconds: number): string => `${(seconds / 86_400).toFixed(1)}d`;

/** One line per tracker for the text answer. */
export const trackerLine = (t: TrackerSeeding): string =>
    `${t.tracker}: ${t.seeding} seeding (${size(t.sizeBytes)}), ${days(t.seedingSeconds.total)} total, median ${days(t.seedingSeconds.median)}, min ${days(t.seedingSeconds.min)}` +
    (t.noPeers === undefined ? '' : `, ${t.noPeers} without peers`) +
    (t.atRisk === undefined ? '' : `, ${t.atRisk} removed before the minimum`);

const GIB = 1024 ** 3;
const size = (bytes: number): string => (bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** One sentence: "Cleanuparr is due to delete 3 (12.4 GB) and stop 1 (700 MB) in the next 7 days." */
export function dueText(due: CleanuparrDue): string {
    const parts = (['delete', 'stop'] as const).flatMap(a => {
        const t = due[a];
        return t === undefined ? [] : [`${a} ${t.count} (${size(t.sizeBytes)})`];
    });
    return `Cleanuparr is due to ${parts.join(' and ')} in the next ${due.days} days${due.dryRun === true ? ' (dry run, so it only logs)' : ''}.`;
}

/**
 * Below `full`, a download client's row is dropped when an *arr row of the
 * same grab is in the list, and the *arr row names the client in `client`.
 * Without a `kind` every download was listed twice, once by the *arr and once
 * by the client, which doubled the answer for no new fact at `standard`: what
 * the client row adds (seed state, its own error) is `full` detail. Matched
 * on the client's download id, which is the *arr's `downloadId` (a SABnzbd
 * nzo_id, an NZBGet drone id, a torrent hash) up to case.
 */
function foldClientRows(rows: readonly QueueItem[], clients: ReadonlySet<string>): QueueItem[] {
    const keyOf = (q: QueueItem): string => (q.downloadId ?? q.id).toLowerCase();
    const arrRows = new Map<string, QueueItem[]>();
    for (const q of rows) {
        if (clients.has(q.service) || q.downloadId === undefined) continue;
        const key = q.downloadId.toLowerCase();
        arrRows.set(key, [...(arrRows.get(key) ?? []), q]);
    }
    const owner = new Map<QueueItem, string>();
    const kept = rows.filter(q => {
        if (!clients.has(q.service)) return true;
        const mine = arrRows.get(keyOf(q));
        if (mine === undefined) return true;
        for (const a of mine) owner.set(a, q.service);
        return false;
    });
    return kept.map(q => (owner.has(q) ? { ...q, client: owner.get(q)! } : q));
}

const project = (q: QueueItem, detail: DetailLevel): QueueItem => {
    const { torrent, noAlbum: _n, heldBy: _h, ...visible } = q;
    if (detail === 'full') {
        if (torrent === undefined) return visible;
        // The save path only where it helps explain why no Cleanuparr rule matched: 500 of them blow the budget.
        const unmatched = q.seeding?.cleanuparr !== undefined && 'unmatched' in q.seeding.cleanuparr;
        return {
            ...visible,
            ...(torrent.category === '' ? {} : { category: torrent.category }),
            ...(torrent.tags.length === 0 ? {} : { tags: torrent.tags }),
            ...(unmatched && torrent.savePath !== undefined ? { savePath: torrent.savePath } : {})
        };
    }
    if (detail === 'minimal') return { service: q.service, id: q.id, title: q.title, status: q.status };
    const { errorMessage: _e, private: _p, seeding: _s, strikes: _k, markedForRemoval: _m, ...rest } = visible;
    return rest;
};

/**
 * One queue row as a line. `service:id` leads the facts because it is what
 * `remove_queue_item` takes, and a stuck download is the
 * usual reason anyone reads this list at all, so the blocking state and the
 * error come before the size and the ETA, which say only how long to wait.
 */
export function queueLine(item: QueueItem): string {
    const facts = [`${item.service}:${item.id}`, item.status];
    if (item.importState !== undefined && item.importState !== '') facts.push(item.importState);
    if (item.orphaned === true) facts.push('orphaned');
    if (item.addedAt !== undefined) facts.push(`waiting since ${item.addedAt.slice(0, 10)}`);
    if (item.errorMessage !== undefined && item.errorMessage !== '') facts.push(item.errorMessage);
    if (item.statusMessages !== undefined) facts.push(...item.statusMessages);
    for (const s of item.strikes ?? []) {
        facts.push(`${s.count} Cleanuparr strike${s.count === 1 ? '' : 's'} (${s.reason}${s.dryRun === true ? ', dry run' : ''})`);
    }
    if (item.markedForRemoval === true) facts.push('marked for removal on Cleanuparr\'s next run');
    const c = item.seeding?.cleanuparr !== undefined && 'rule' in item.seeding.cleanuparr ? item.seeding.cleanuparr : undefined;
    if (item.seeding?.overLimit === true && item.status.startsWith('seeding')) {
        const marks = [...(c?.dryRun === true ? ['dry run'] : []), ...(c?.notEnforced === true ? ['not scheduled'] : [])];
        facts.push(
            item.seeding.forced === true
                ? 'past its seed limit (force-started, so exempt)'
                : c !== undefined && item.seeding.limitSource === 'cleanuparr'
                  ? `past Cleanuparr rule "${c.rule}"${marks.length === 0 ? '' : ` (${marks.join(', ')})`}`
                  : 'past its seed limit'
        );
    }
    if (c?.dueAt !== undefined) facts.push(`Cleanuparr ${c.action} due ${c.dueAt}${c.dryRun === true ? ' (dry run)' : ''}`);

    return `${item.title}: ${facts.join(', ')}`;
}

/** Server-side filters (#530), all optional and combined with AND. */
export type QueueFilter = {
    category?: string[];
    status?: string;
    over_limit?: boolean;
    struck?: boolean;
    due_within_days?: number;
    unmatched?: boolean;
    hash?: string;
};

/** The services with a queue, for the `service` filter. */
const QUEUE_TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'lidarr', 'sabnzbd', 'nzbget', 'transmission', 'qbittorrent', 'shelfmark', 'grimmory'],
    can: hasQueue,
    cannot: 'has no download queue'
});

/** The adapters a `service` and `instance` filter leave, refused rather than answered empty when they name nothing. */
function queueAdapters(adapters: readonly ServiceAdapter[], service: ServiceId | undefined, instance: string | undefined): readonly ServiceAdapter[] {
    if (service !== undefined) return readTargets(adapters, QUEUE_TARGET, service, instance);
    if (instance === undefined || instance === '') return adapters;
    const wanted = instance.toLowerCase();
    const found = adapters.filter(a => hasQueue(a) && a.instance?.toLowerCase() === wanted);
    if (found.length === 0) {
        throw new ServiceError('NotFound', 'get_queue', `no queue belongs to an instance named "${instance}"`, {
            remedy: `Named instances with a queue: ${adapters.filter(hasQueue).flatMap(a => a.instance ?? []).join(', ') || 'none'}.`
        });
    }
    return found;
}

/** How many torrents are read at once for `detail: "full"`: up to four requests each, against one client's WebUI. */
const DETAIL_READS_AT_ONCE = 4;

/** A longer page carries no per-torrent details: 500 rows would be 2,000 requests to the client and an answer no session can hold. */
const DETAIL_ROWS_MAX = 100;

/** Files listed across one page, handed out in row order, so a page of season packs stays readable. */
const DETAIL_FILES_PER_PAGE = 500;

/**
 * The per-torrent facts `torrents/info` does not carry. Only the rows on this
 * page are read. A failed read names the instance in `degraded` and leaves its
 * row as the list had it; the rest of the page still answers.
 */
async function withTorrentDetails(rows: QueueItem[], adapters: readonly ServiceAdapter[], degraded: string[]): Promise<{ items: QueueItem[]; omitted: number }> {
    const clients = new Map(adapters.filter(hasTorrentManage).map(a => [a.id, a]));
    const wanted = rows.flatMap((row, i) => (clients.has(row.service) ? [i] : []));
    if (wanted.length > DETAIL_ROWS_MAX) return { items: rows, omitted: wanted.length };

    const details = new Map<number, TorrentDetails>();
    let next = 0;
    const worker = async (): Promise<void> => {
        for (let at = next++; at < wanted.length; at = next++) {
            const i = wanted[at]!;
            const row = rows[i]!;
            try {
                details.set(i, await clients.get(row.service)!.getTorrentDetails(row.id));
            } catch (err) {
                // Removed since the list was read: there is nothing to describe.
                if (err instanceof ServiceError && err.kind === 'NotFound') continue;
                const source = `${row.service}:torrent details`;
                if (!degraded.includes(source)) degraded.push(source);
            }
        }
    };
    await Promise.all(Array.from({ length: DETAIL_READS_AT_ONCE }, worker));

    let filesLeft = DETAIL_FILES_PER_PAGE;
    const items = rows.map((row, i) => {
        const d = details.get(i);
        if (d === undefined) return row;
        // Asked about one torrent, the whole page's allowance is its own.
        const shown = Math.min(d.files.length, wanted.length === 1 ? DETAIL_FILES_PER_PAGE : TORRENT_FILES_SHOWN, filesLeft);
        filesLeft -= shown;
        return {
            ...row,
            ...(d.savePath === undefined ? {} : { savePath: d.savePath }),
            private: d.private,
            ...(d.ratio === undefined ? {} : { ratio: d.ratio }),
            ...(d.seedingSeconds === undefined ? {} : { seedingSeconds: d.seedingSeconds }),
            files: d.files.slice(0, shown),
            ...(d.files.length > shown ? { filesOmitted: d.files.length - shown } : {}),
            trackers: d.trackers
        };
    });
    return { items, omitted: 0 };
}

const DAY_MS = 86_400_000;

/** The filters that read what Cleanuparr adds, so the rows need annotating even below `detail: "full"`. */
const needsCleanuparr = (f: QueueFilter): boolean =>
    f.over_limit !== undefined || f.struck !== undefined || f.due_within_days !== undefined || f.unmatched !== undefined;

function matchesFilter(item: QueueItem, f: QueueFilter, now: number): boolean {
    if (f.hash !== undefined) {
        const wanted = f.hash.trim().toLowerCase();
        if (![item.id, item.downloadId, item.torrent?.hash].some(v => v?.toLowerCase() === wanted)) return false;
    }
    if (f.category !== undefined && (item.torrent === undefined || !f.category.includes(item.torrent.category))) return false;
    if (f.status !== undefined && !item.status.toLowerCase().startsWith(f.status.toLowerCase())) return false;
    if (f.over_limit !== undefined && (item.seeding?.overLimit === true) !== f.over_limit) return false;
    if (f.struck !== undefined && ((item.strikes?.length ?? 0) > 0) !== f.struck) return false;
    const c = item.seeding?.cleanuparr;
    if (f.unmatched !== undefined && (c !== undefined && 'unmatched' in c) !== f.unmatched) return false;
    if (f.due_within_days !== undefined) {
        const dueAt = c !== undefined && 'rule' in c ? c.dueAt : undefined;
        if (dueAt === undefined || Date.parse(dueAt) > now + f.due_within_days * DAY_MS) return false;
    }
    return true;
}

export async function buildGetQueue(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number; offset?: number; kind?: LibraryKind; filter?: QueueFilter; byTracker?: { minSeedDays?: number }; service?: ServiceId; instance?: string }
): Promise<GetQueueResult> {
    const filter = opts.filter ?? {};
    const { items, degraded, counts } = await gather(
        queueAdapters(adapters, opts.service, opts.instance)
            .filter(hasQueue)
            .filter(a => holds(a, opts.kind))
            .map(a => ({ id: a.id, fetch: () => a.getQueue() }))
    );
    if (opts.detail === 'full' || needsCleanuparr(filter) || opts.byTracker?.minSeedDays !== undefined) {
        await annotateCleanuparr(items, adapters, id => {
            if (!degraded.includes(id)) degraded.push(id);
        });
    }

    // Sorted before limiting. Concatenation order is adapter order, which is
    // alphabetical, so an unsorted limit would drop Transmission first, every
    // time, and a 60-item Radarr queue would report an empty Transmission.
    // Soonest-finishing first is also the order someone asking "what is
    // downloading" wants; unknown ETAs sort last rather than first.
    items.sort((a, b) => (a.etaSeconds ?? Infinity) - (b.etaSeconds ?? Infinity) || a.title.localeCompare(b.title));

    const now = Date.now();
    // Due totals stay whole-queue: they answer "what goes this week", not "of these rows".
    const due = opts.detail === 'full' ? dueWithin(items, now) : undefined;
    const matching = Object.keys(filter).length === 0 ? items : items.filter(i => matchesFilter(i, filter, now));
    // Folded after filtering, so a filter only a client row meets (a seed
    // limit, a category) still finds it.
    const clients = new Set(adapters.filter(a => DOWNLOAD_CLIENTS.includes(a.type)).map(a => a.id));
    const listed = opts.detail === 'full' ? matching : foldClientRows(matching, clients);
    const shaped = applyLimit(listed, opts.limit, opts.offset);
    // Per service, what is listed: raw rows would count a folded client row
    // twice and add up to more than `total`. A service that answered stays at 0.
    const listedCounts = Object.fromEntries(Object.keys(counts).map(id => [id, listed.filter(q => q.service === id).length]));
    const byTracker = opts.byTracker === undefined ? undefined : seedingByTracker(matching, now, opts.byTracker.minSeedDays);
    const projected = shaped.items.map(i => project(i, opts.detail));
    const detailed = opts.detail === 'full' ? await withTorrentDetails(projected, adapters, degraded) : { items: projected, omitted: 0 };
    return {
        ...shaped,
        items: detailed.items,
        ...(detailed.omitted === 0 ? {} : { torrentDetailsOmitted: detailed.omitted }),
        degraded,
        counts: listedCounts,
        ...(due === undefined ? {} : { cleanuparrDue: due }),
        ...(byTracker === undefined ? {} : { byTracker }),
        ...stepsField(importSteps(matching), 3, true)
    };
}

/**
 * The imports to offer: a download the *arr finished and then would not
 * import (`importBlocked`), or keeps failing to (`importPending` with reasons).
 * A completed row it is still importing on its own, with no reasons, gets
 * none. An orphan, matched to nothing in the library, may be a release the
 * *arr never matched rather than deleted media, so it gets one that asks for a
 * `mapping`.
 */
const importSteps = (rows: readonly QueueItem[]): NextStep[] =>
    rows.flatMap(row => {
        if (!importFailing(row)) return [];
        const step =
            row.orphaned === true ? orphanImportStepFor(row) : row.importState === 'importBlocked' ? importStepFor(row) : retriedImportStepFor(row);
        return step === undefined ? [] : [step];
    });

const GetQueueInput = toolInput({
    service: serviceOf(QUEUE_TARGET.services).optional().describe('Only this service\'s queue.'),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    hash: z.string().min(1).optional().describe('Only the row with this queue id, download id or torrent hash.'),
    kind: MediaKindSchema.describe(
        'Only one service\'s queue. [[radarr: `movie`: Radarr.]] [[sonarr|whisparr: `series`: {{and: sonarr=Sonarr; whisparr=Whisparr}}.]] [[lidarr: `artist`: Lidarr.]] [[shelfmark|grimmory: `book`: {{and: shelfmark=Shelfmark; grimmory=Grimmory\'s Bookdrop}}.]] Pass it when the request names one of those services. Download clients are left out, since their rows are the same downloads. Omit for everything.'
    ),
    category: z.array(z.string()).min(1).optional().describe('Only torrents in these client categories.'),
    status: z.string().min(1).optional().describe('Only rows whose status starts with this, e.g. `seeding`, `stalled`.'),
    over_limit: z.boolean().optional().describe('Only rows past (true) or within (false) their seed limit.'),
    struck: z.boolean().optional().describe('[[cleanuparr: Only rows with (true) or without (false) Cleanuparr strikes.]]'),
    due_within_days: z.number().int().min(0).max(365).optional().describe('[[cleanuparr: Only rows Cleanuparr acts on within this many days.]]'),
    unmatched: z.boolean().optional().describe('[[cleanuparr: Only rows no Cleanuparr rule covers (true), or that one does (false).]]'),
    by_tracker: z.boolean().optional().describe('Add `byTracker`: seed time per tracker hostname over the matching seeding torrents.'),
    min_seed_days: z.number().min(0).max(365).optional().describe('[[cleanuparr: With by_tracker: count per tracker what Cleanuparr removes before this seed time.]]'),
    detail: DetailSchema,
    limit: LimitSchema,
    offset: OffsetSchema
});

export function registerGetQueue(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_queue',
        {
            title: 'Download queue',
            annotations: READ_ONLY,
            description:
                'Everything downloading or stalled, merged across every *arr queue and download client[[grimmory: , plus files waiting in Grimmory\'s Bookdrop]]. Sizes are bytes, ETAs seconds; release names are fenced as untrusted data. An *arr row carries `downloadId` and `statusMessages`: a finished download stuck at `importBlocked`, or `importPending` with messages, comes back as an import_download step in `next_steps`; a title mismatch or unknown episode fails on every retry until fixed in the service. [[transmission|qbittorrent: At `detail: "full"` a torrent carries `seeding` (ratio, time seeded, the limit that applies, `overLimit`) and, with Cleanuparr, the rule that governs it, its `strikes` and `dueAt`; `cleanuparrDue` totals what falls due within 7 days.]] [[qbittorrent: A qBittorrent row at `detail: "full"` also has `savePath`, `private`, `ratio`, `seedingSeconds`, `files` and `trackers` (hostnames only).]] Filter on the server rather than reading the whole queue. Remove a row with remove_queue_item. Field reference: arr://docs/get_queue.',
            outputSchema: PagedOutputSchema,
            inputSchema: GetQueueInput
        },
        async ({ service, instance, kind, detail, limit, offset, by_tracker, min_seed_days, ...rest }) => {
            const filter = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as QueueFilter;
            const filtered = Object.keys(filter).length > 0;
            const tracked = by_tracker === true || min_seed_days !== undefined;
            const result = await buildGetQueue(adapters, {
                detail,
                limit,
                offset,
                filter,
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                ...(kind === undefined ? {} : { kind }),
                ...(tracked ? { byTracker: min_seed_days === undefined ? {} : { minSeedDays: min_seed_days } } : {})
            });
            const summary =
                `${result.returned} of ${result.total} item(s) in the queue${filtered ? ' match' : ''}` +
                unreachableTail(result.degraded) +
                (result.cleanuparrDue === undefined ? '' : ` ${dueText(result.cleanuparrDue)}`) +
                (result.torrentDetailsOmitted === undefined ? '' : ` Files, trackers and save paths are left out of a page of ${result.torrentDetailsOmitted} torrents: ask for ${DETAIL_ROWS_MAX} or fewer, or one \`hash\`.`);

            const trackers =
                result.byTracker === undefined ? '' : ['', 'Per tracker:', ...(result.byTracker.length === 0 ? ['(nothing seeding)'] : result.byTracker.map(trackerLine)), ''].join('\n');
            const steps =
                (result.next_steps ?? []).map(step => `
${nextStepLine(step)}`).join('') +
                (result.next_steps_more === undefined ? '' : `
${result.next_steps_more} more blocked download(s) not offered here.`);
            return { content: [{ type: 'text', text: listText(summary + trackers, result.items, queueLine) + steps }], structuredContent: result };
        }
    );
}
