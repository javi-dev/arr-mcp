import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { fenceText, unfence } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import { scrubUrls } from '../core/pastedUrl.ts';
import { MAX_TORRENT_BYTES, readTorrentFile } from '../core/torrentFile.ts';
import { allowedPath, downloadHost, isInsideRoots, renamedPath, trackerHost } from '../core/torrentGuards.ts';
import { btihToHex } from '../services/qbittorrent.ts';
import { hasTorrentManage, type ServiceAdapter, type TorrentCategory, type TorrentCheckState, type TorrentDetails, type TorrentManageCapable, type TorrentShareRule, type TorrentSource } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { NO_OWN_SHARE_RULE, categoryIncompletePath, categorySavePath, removalAtLimit, storageDirectory } from './torrentCategoryRules.ts';
import { protectionOf } from './torrentDelete.ts';
import { categoryWatchers } from './watchedCategory.ts';
import { registerWriteTool, type AfterWrite, type WriteContext, type WritePlan } from './write.ts';

/**
 * The routine qBittorrent chores, so nobody needs a shell on the host for them.
 * Each one is a preview and a confirm through `registerWriteTool`.
 *
 * Two rules hold across all of them. A location is checked against the
 * instance's `allowed_paths` before anything is sent. And a source a torrent
 * comes from (a magnet, a URL, a file) can carry a passkey, so it is never put
 * in a preview, a target, an error or the plan's `args`, which the audit keeps:
 * the token binds a digest of it instead.
 */

type Client = ServiceAdapter & TorrentManageCapable;

const clientOf = (adapters: readonly ServiceAdapter[], instance: string | undefined): Client => {
    const adapter = resolveInstance(adapters, 'qbittorrent', instance);
    if (!hasTorrentManage(adapter)) throw new ServiceError('InvalidRequest', adapter.id, `${adapter.id} cannot manage torrents`);
    return adapter;
};

const instanceField = z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION);
/** Checked here so that nothing else, a tracker URL pasted by mistake included, reaches an error or the audit log. */
const torrentHash = z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, 'must be a torrent hash: 40 or 64 hex characters');
const hashField = torrentHash.describe('The torrent hash: `id` on its get_queue row.');
const moveFilesField = z.boolean().default(false).describe('Allow qBittorrent to physically move the data, which needs `destructive`.');
const allowRemovalField = z.boolean().default(false).describe('Accept a category whose share limits make qBittorrent remove the torrent, which needs `destructive`.');

const size = (bytes: number | undefined): string => (bytes === undefined ? 'an unknown amount of data' : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

const digestOf = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex');

/** Every category of the client, once `category` is known to be among them. */
async function categoriesWith(client: Client, category: string): Promise<ReadonlyMap<string, TorrentCategory>> {
    const categories = await client.torrentCategories();
    if (category !== '' && !categories.has(category)) {
        // Not repeated: what was passed here may be a tracker URL with its passkey.
        throw new ServiceError('NotFound', client.id, `${client.id} has no such category`, {
            remedy: `Its categories: ${[...categories.keys()].join(', ') || 'none'}. Create new ones in qBittorrent itself.`
        });
    }
    return categories;
}

/** How long `resume_if_complete` watches a recheck before leaving the rest to the caller. */
const WATCH_MS = 45_000;
/** Quick reads at first, so a small torrent is caught while it is checking; qBittorrent refreshes a torrent's state about every 1.5 seconds. */
const FAST_POLLS = 10;
const FAST_POLL_MS = 300;
const WATCH_POLL_MS = 2_000;
/** How long a complete torrent may show no checking state before the watch stops waiting for one. */
const GRACE_MS = 4_000;

/** qBittorrent's states for a torrent that is seeding, downloading, queued to, or allocating space to download: started, whoever started it. */
const STARTED_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'downloading', 'stalledDL', 'queuedDL', 'forcedDL', 'metaDL', 'forcedMetaDL', 'allocating']);

/** While these run, the amount left says nothing about where the data is, and a finished torrent can read as unfinished. */
const CHECKING_STATES = new Set(['checkingUP', 'checkingDL', 'checkingResumeData']);

/**
 * Whether qBittorrent treats this torrent as unfinished. A finished torrent whose
 * storage went missing reads as having everything left, yet still counts as finished.
 */
const isUnfinished = (d: TorrentDetails): boolean => !d.hasMetadata || ((d.remainingBytes ?? 0) > 0 && !(d.state === 'missingFiles' && d.finishedOnce));

const removalWarning = (rule: TorrentShareRule): string => {
    const limits = [
        ...(rule.ratio >= 0 ? [`ratio ${rule.ratio}`] : []),
        ...(rule.seedingMinutes >= 0 ? [`${rule.seedingMinutes} minutes seeding`] : []),
        ...(rule.inactiveMinutes >= 0 ? [`${rule.inactiveMinutes} minutes inactive`] : [])
    ];
    const reached = limits.length < 2 ? '' : rule.mode === 'MatchAll' ? 'all of: ' : rule.mode === 'MatchAny' ? 'any of: ' : '';
    return `Warning: at this category's share limits (${reached}${limits.join(', ')}) qBittorrent removes this torrent${rule.action === 'RemoveWithContent' ? ' and deletes its files' : ''}.`;
};

type TorrentToolOptions = { sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type RecheckOutcome = { rechecking: string[]; resumed?: string[]; left_stopped?: string[]; incomplete?: string[]; errored?: string[]; still_checking?: string[]; still_moving?: string[]; unconfirmed?: string[]; gone?: string[]; resume_failed?: string[]; resume_error?: string; already_running?: string[]; state_unread?: string };

/**
 * Watches a recheck that has been sent, and starts what came back whole and
 * stopped. Only a torrent seen checking counts as verified: until its check
 * begins, `complete` is still the answer from the last one. qBittorrent checks
 * one torrent at a time, so a torrent showing no check may simply be queued: an
 * incomplete one is watched to the end rather than reported as checked.
 *
 * Run outside the instance's lane, as the write's `afterWrite`: the watch only
 * reads, and the start at the end goes through `write`, back in the lane. It
 * stands down when another confirmation to the client was accepted before the
 * start got the lane, even one that found nothing to do: a pause sent then
 * leaves a checked torrent as stopped as the recheck did, and starting it would
 * undo the later request. The last read before the start is what is reported:
 * a torrent removed by then is gone, one at an error errored, one moving still
 * moving, one running already running.
 */
async function watchRecheck(client: Client, ids: readonly string[], sleep: (ms: number) => Promise<void>, write: AfterWrite['write']): Promise<RecheckOutcome> {
    const seenChecking = new Set<string>();
    const moving = new Set<string>();
    const failing = new Set<string>();
    const settled = new Map<string, TorrentCheckState | undefined>();
    let waited = 0;
    for (let poll = 0; waited < WATCH_MS && settled.size < ids.length; poll += 1) {
        const pause = poll === 0 ? 0 : poll <= FAST_POLLS ? FAST_POLL_MS : WATCH_POLL_MS;
        if (pause > 0) await sleep(pause);
        waited += pause;
        const pending = ids.filter(id => !settled.has(id));
        let states: TorrentCheckState[];
        try {
            states = await client.torrentCheckStates(pending);
        } catch (err) {
            logger.warn({ service: client.id, err }, 'lost sight of a recheck while watching it');
            break;
        }
        for (const id of pending) {
            const state = states.find(s => s.id === id);
            if (state?.state === 'moving') moving.add(id);
            else moving.delete(id);
            // Not settled on sight: a torrent can show an old error until the check reaches it.
            if (state?.state === 'error') failing.add(id);
            else failing.delete(id);
            if (state?.checking === true) seenChecking.add(id);
            // Verified data can be on its way back to the save path, and a move is not the end of the check.
            else if (state?.state === 'moving') continue;
            else if (state === undefined || seenChecking.has(id) || (state.complete && state.state !== 'error' && waited >= GRACE_MS)) settled.set(id, state);
        }
    }

    const finished = [...settled.entries()];
    const wholeAndStopped = finished.flatMap(([id, s]) => (s?.complete === true && s.stopped ? [id] : []));
    let toStart = wholeAndStopped.filter(id => seenChecking.has(id));
    // What the last read found of a torrent it will not start; one checking again or at missing files stays unconfirmed.
    const dropped = { gone: [] as string[], errored: [] as string[], moving: [] as string[], running: [] as string[] };
    // Read again at the last moment: a batch can outlast what the watch saw of its first torrent.
    const readAgain = async (): Promise<void> => {
        const fresh = await client.torrentCheckStates(toStart);
        const candidates = toStart;
        toStart = fresh.filter(s => s.complete && s.stopped && !s.checking).map(s => s.id);
        for (const id of candidates.filter(id => !toStart.includes(id))) {
            const now = fresh.find(s => s.id === id);
            if (now === undefined) dropped.gone.push(id);
            else if (now.state === 'error') dropped.errored.push(id);
            else if (now.state === 'moving') dropped.moving.push(id);
            else if (STARTED_STATES.has(now.state)) dropped.running.push(id);
        }
    };
    let resumeError: string | undefined;
    let leftStopped = false;
    // Whether the lists below come from a read taken when it was time to start.
    let readAtStart = false;
    if (toStart.length > 0) {
        try {
            // In the lane, so a confirmed write to this client cannot land between the read and the start.
            await write(async ({ overtaken, cancelled }) => {
                // Standing down needs no read, so it holds up nothing behind it.
                leftStopped = overtaken;
                if (overtaken) return;
                await readAgain();
                readAtStart = true;
                if (toStart.length === 0) return;
                // The last point to stand down: once sent, the start runs to the end, as an apply does,
                // including the older API's verb when qBittorrent does not know the new one.
                if (cancelled()) throw new Error('the request was cancelled before they were started');
                await client.startTorrents(toStart);
            });
        } catch (err) {
            logger.warn({ service: client.id, err }, 'a recheck finished but the torrents could not be started');
            resumeError = err instanceof Error ? err.message : String(err);
        }
    }
    // Not started, and not read when it was time to: read them for the report
    // only, outside the lane, since nothing will be started now.
    let stateUnread: string | undefined;
    if (toStart.length > 0 && !readAtStart && (leftStopped || resumeError !== undefined)) {
        try {
            await readAgain();
        } catch (err) {
            logger.warn({ service: client.id, err }, 'could not read the torrents again; reporting what the watch saw');
            stateUnread = err instanceof Error ? err.message : String(err);
        }
    }
    const resumeFailed = resumeError !== undefined;
    const list = (key: keyof RecheckOutcome, values: string[]) => (values.length === 0 ? {} : { [key]: values });
    return {
        rechecking: [...ids],
        ...list(resumeFailed ? 'resume_failed' : leftStopped ? 'left_stopped' : 'resumed', toStart),
        ...list('incomplete', finished.flatMap(([id, s]) => (s !== undefined && !s.complete && s.state !== 'error' ? [id] : []))),
        ...list('errored', [...finished.flatMap(([id, s]) => (s?.state === 'error' ? [id] : [])), ...ids.filter(id => !settled.has(id) && failing.has(id)), ...dropped.errored]),
        ...list('still_checking', ids.filter(id => !settled.has(id) && seenChecking.has(id) && !moving.has(id) && !failing.has(id))),
        ...list('still_moving', [...ids.filter(id => !settled.has(id) && moving.has(id)), ...dropped.moving]),
        ...list('unconfirmed', [...wholeAndStopped.filter(id => !toStart.includes(id) && !Object.values(dropped).some(group => group.includes(id))), ...ids.filter(id => !settled.has(id) && !seenChecking.has(id) && !moving.has(id) && !failing.has(id))]),
        ...list('gone', [...finished.flatMap(([id, s]) => (s === undefined ? [id] : [])), ...dropped.gone]),
        ...(resumeError === undefined || toStart.length === 0 ? {} : { resume_error: resumeError }),
        ...list('already_running', dropped.running),
        ...(stateUnread === undefined || toStart.length === 0 ? {} : { state_unread: stateUnread })
    };
}

const outcomeSentence = (o: RecheckOutcome): string | undefined => {
    if (o.resumed === undefined && o.left_stopped === undefined && o.already_running === undefined && o.incomplete === undefined && o.errored === undefined && o.still_checking === undefined && o.still_moving === undefined && o.unconfirmed === undefined && o.gone === undefined && o.resume_failed === undefined) return undefined;
    const part = (label: string, ids: string[] | undefined) => (ids === undefined ? [] : [`${label}: ${ids.join(', ')}`]);
    return `Recheck sent. ${[
        // First, since it qualifies the lists after it: they are what the watch last saw.
        ...(o.state_unread === undefined ? [] : [`what the torrents not started are doing now could not be read (${o.state_unread}), so the lists below are what was last seen; check get_queue before starting any of them`]),
        ...part('started again', o.resumed),
        ...part(`finished complete but left stopped, because another confirmation to this qBittorrent was accepted before the start (even one that found nothing to do, such as a pause of a stopped torrent); start them with pause_downloads and \`action: "resume"\` if that is still wanted${o.state_unread === undefined ? '' : ', once get_queue shows what they are doing now'}`, o.left_stopped),
        ...part('came back incomplete, and any that was not stopped is downloading what is missing', o.incomplete),
        ...part('showing an error after the recheck was sent; get_queue shows only that state, and the reason is in the qBittorrent log', o.errored),
        ...part('still checking, so start these with pause_downloads and `action: "resume"` once get_queue shows them complete', o.still_checking),
        ...part('still moving to the save path and not started, so once get_queue no longer shows them at moving and shows them complete, start them with pause_downloads and `action: "resume"`', o.still_moving),
        ...part('not started: no check was seen running, or when it was time to start them they were checking again, at missing files or no longer complete; look at them again in get_queue', o.unconfirmed),
        ...part('no longer in qBittorrent', o.gone),
        ...part('already running when they were read for the start, so not started here', o.already_running),
        ...part(
            `finished complete but could not be started${o.resume_error === undefined ? '' : ` (${o.resume_error})`}; start them with pause_downloads and \`action: "resume"\` if that is still wanted${o.state_unread === undefined ? '' : ', once get_queue shows what they are doing now'}`,
            o.resume_failed
        )
    ].join('; ')}.`;
};

/** A `.torrent` upload decoded, or a refusal that repeats none of it. */
function torrentBytes(service: string, base64: string): Buffer {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
        throw new ServiceError('InvalidRequest', service, '`torrent_base64` is not valid base64', { remedy: 'Send the whole .torrent file, base64 encoded.' });
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_TORRENT_BYTES) throw new ServiceError('InvalidRequest', service, 'that .torrent file is larger than the 3 MB limit', { remedy: 'Pass its `url` instead.' });
    return bytes;
}

/** The hosts a magnet link would have the client contact, and nothing else of it. */
const magnetHosts = (magnet: string): string[] => {
    const params = [...new URLSearchParams(magnet.slice('magnet:?'.length))];
    // libtorrent reads `tr.1` as `tr`, and any case.
    const hosts = params.filter(([key]) => ['tr', 'ws', 'xs', 'as'].includes(key.toLowerCase().replace(/\.\d+$/, ''))).flatMap(([, value]) => trackerHost(value) ?? []);
    return [...new Set(hosts)];
};

/** No whitespace at all: qBittorrent splits `urls` on newlines and fetches every part. */
const MAGNET = /^magnet:\?\S+$/;
const BTIH_TOPIC = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/;
const BTMH_TOPIC = /^urn:btmh:1220([0-9a-fA-F]{64})$/;

/**
 * The id qBittorrent will list a magnet under, read from its real `xt` fields so
 * that text inside another field cannot name a different torrent. A hybrid goes
 * by its truncated SHA-256. Undefined when the link names no torrent, or two.
 */
function magnetHash(magnet: string): string | undefined {
    const topics = [...new URLSearchParams(magnet.slice('magnet:?'.length))].filter(([key]) => /^xt(?:\.\d+)?$/i.test(key)).map(([, value]) => value);
    const v1 = [...new Set(topics.flatMap(t => BTIH_TOPIC.exec(t)?.[1] ?? []).map(btihToHex))];
    const v2 = [...new Set(topics.flatMap(t => BTMH_TOPIC.exec(t)?.[1]?.toLowerCase() ?? []))];
    if (v1.length > 1 || v2.length > 1 || v1.length + v2.length === 0) return undefined;
    return v2[0]?.slice(0, 40) ?? v1[0];
}

type AddSource = {
    request: TorrentSource;
    digest: string;
    hash?: string;
    /** `null` when the source does not say. */
    private: boolean | null;
    label: string;
    effects: string[];
};

function addSource(service: string, args: { magnet?: string | undefined; url?: string | undefined; torrent_base64?: string | undefined }): AddSource {
    const given = [args.magnet, args.url, args.torrent_base64].filter(v => v !== undefined);
    if (given.length !== 1) {
        throw new ServiceError('InvalidRequest', service, 'pass exactly one of `magnet`, `url` or `torrent_base64`', {
            remedy: 'Each is a different way to name the same thing: the torrent to add.'
        });
    }
    if (args.magnet !== undefined) {
        const hash = args.magnet.length > 8192 || !MAGNET.test(args.magnet) ? undefined : magnetHash(args.magnet);
        if (hash === undefined) {
            throw new ServiceError('InvalidRequest', service, 'that is not a magnet link', { remedy: 'A magnet starts `magnet:?` and carries `xt=urn:btih:<hash>` or `xt=urn:btmh:1220<hash>`.' });
        }
        const hosts = magnetHosts(args.magnet);
        return {
            request: { kind: 'url', url: args.magnet },
            digest: digestOf(args.magnet),
            hash,
            private: null,
            label: `torrent ${hash}`,
            effects: hosts.length === 0 ? [] : [`The client will contact: ${hosts.join(', ')}.`]
        };
    }
    if (args.url !== undefined) {
        const host = downloadHost(service, args.url);
        return {
            request: { kind: 'url', url: args.url },
            digest: digestOf(args.url),
            private: null,
            label: `the torrent file at ${host}`,
            effects: [`qBittorrent fetches the torrent file from ${host}.`]
        };
    }
    const bytes = torrentBytes(service, args.torrent_base64 ?? '');
    let facts;
    try {
        facts = readTorrentFile(bytes);
    } catch (err) {
        throw new ServiceError('InvalidRequest', service, (err as Error).message, { remedy: 'Send the whole .torrent file, base64 encoded.' });
    }
    return {
        request: { kind: 'file', bytes, filename: 'upload.torrent' },
        digest: digestOf(bytes),
        hash: facts.hash,
        private: facts.private,
        // A name can itself be a tracker URL, passkey included.
        label: fenceText(scrubUrls(facts.name), { service, field: 'name' }),
        effects: [
            `${facts.fileCount} file(s), ${size(facts.sizeBytes)}, private ${facts.private ? 'yes' : 'no'}.`,
            ...(facts.trackers.length === 0 ? [] : [`It announces to: ${facts.trackers.join(', ')}.`])
        ]
    };
}

/** 3 MB of file, base64 encoded, which leaves the request inside the server's 4 MiB limit. */
export const MAX_TORRENT_BASE64 = 4_000_000;

const AddTorrentInput = z.object({
    instance: instanceField,
    magnet: z.string().min(1).optional().describe('A magnet link.'),
    url: z.string().min(1).optional().describe('An http or https URL of a .torrent file.'),
    torrent_base64: z.string().min(1).max(MAX_TORRENT_BASE64).optional().describe('The contents of a .torrent file, base64 encoded, up to 3 MB.'),
    category: z.string().min(1).optional().describe('An existing qBittorrent category.'),
    allow_removal: allowRemovalField,
    save_path: z.string().min(1).optional().describe('Where to save it, inside the allowed paths; defaults to where the category saves.')
});

const RecheckInput = z.object({
    instance: instanceField,
    ids: z.array(torrentHash).min(1).max(50).describe('Torrent hashes: `id` on their get_queue rows.'),
    resume_if_complete: z.boolean().default(false).describe('Watch the recheck briefly and start each stopped torrent that comes back complete, unless another confirmation to this qBittorrent is accepted first, even one that changes nothing.'),
    allow_removal: allowRemovalField
});

const LocationInput = z.object({
    instance: instanceField,
    id: hashField,
    location: z.string().min(1).describe('The new save path, inside the allowed paths.'),
    move_files: moveFilesField
});

const RenameInput = z.object({
    instance: instanceField,
    id: hashField,
    old_path: z.string().min(1).describe('The file as get_queue lists it at `detail: "full"`.'),
    new_path: z.string().min(1).describe('The new path relative to the torrent, inside the same folder.')
});

const CategoryInput = z.object({
    instance: instanceField,
    id: hashField,
    category: z.string().describe('An existing qBittorrent category, or an empty string to clear it.'),
    move_files: moveFilesField,
    allow_removal: allowRemovalField
});

const ReannounceInput = z.object({ instance: instanceField, id: hashField });

/** A stopped torrent's reannounce: there is nothing to announce, so nothing to confirm. */
const stopped = (target: string, title: string): WritePlan => ({ target, summary: `${title} is stopped, so it has nothing to announce.`, effects: [], noop: true });

export function registerTorrentTools(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[], options: TorrentToolOptions = {}): void {
    const sleep = options.sleep ?? defaultSleep;

    registerWriteTool(server, context, {
        name: 'recheck_torrents',
        title: 'Recheck torrents',
        description:
            'Has qBittorrent verify torrents against the data on disk: the usual next step for a torrent at `missing files` once its data is back. `resume_if_complete` watches about 45 seconds and starts stopped ones found complete, unless a later confirmation was accepted, even a no-op (`left_stopped`); slower: still checking. Previews first. Field reference: arr://docs/recheck_torrents.',
        inputSchema: RecheckInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'recheck_torrents',
        tier: ({ allow_removal }) => (allow_removal ? 'destructive' : 'safe'),

        async plan({ instance, ids, resume_if_complete, allow_removal }): Promise<WritePlan> {
            const client = clientOf(adapters, instance);
            const wanted = [...new Set(ids.map(id => id.trim().toLowerCase()))];
            const states = await client.torrentCheckStates(wanted);
            const missing = wanted.filter(id => !states.some(s => s.id === id));
            if (missing.length > 0) {
                throw new ServiceError('NotFound', client.id, `no torrent with hash ${missing.join(', ')}`, { remedy: 'Take current ids from get_queue.' });
            }
            const skipped = states.filter(s => !s.hasMetadata);
            const inMotion = states.filter(s => s.hasMetadata && s.state === 'moving');
            const toCheck = states.filter(s => !s.checking && s.hasMetadata && s.state !== 'moving').map(s => s.id).sort();
            // A check that finds data missing sends what is left to the incomplete folder.
            const fallbacks = states.filter(s => toCheck.includes(s.id) && s.downloadPath !== undefined).sort((a, b) => a.id.localeCompare(b.id));
            for (const s of fallbacks) {
                allowedPath(client.id, s.downloadPath ?? '', client.allowedPaths);
                // And one that finds everything sends it on to the save path.
                allowedPath(client.id, s.savePath ?? '', client.allowedPaths);
            }
            // A check can write where the files are (a damaged piece renames its file), and retries a move that failed earlier.
            const checked = states.filter(s => toCheck.includes(s.id)).sort((a, b) => a.id.localeCompare(b.id));
            const stored = await Promise.all(checked.map(async s => storageDirectory(s.contentPath, await client.torrentFileNames(s.id))));
            checked.forEach((s, i) => {
                if (s.savePath !== undefined) allowedPath(client.id, s.savePath, client.allowedPaths);
                if (stored[i] !== undefined) allowedPath(client.id, stored[i], client.allowedPaths);
            });
            const strays = checked.filter((s, i) => s.downloadPath === undefined && s.savePath !== undefined && stored[i] !== s.savePath.replace(/\/+$/, ''));
            const atMissingFiles = states.filter(s => toCheck.includes(s.id) && s.state === 'missingFiles').sort((a, b) => a.id.localeCompare(b.id));
            const target = `${client.id}:${toCheck.length === 0 ? wanted.join(',') : toCheck.join(',')}`;
            if (toCheck.length === 0) return { target, summary: `None of those torrents can be checked on ${client.id}: each is already checking, being moved or still fetching its metadata.`, effects: [], noop: true };
            // A torrent the check finds whole starts counting towards its share limits, and may already be past them.
            const incomplete = states.filter(s => toCheck.includes(s.id) && !s.complete).sort((a, b) => a.id.localeCompare(b.id));
            const [categories, defaults] = incomplete.length === 0 ? [new Map<string, TorrentCategory>(), undefined] : await Promise.all([client.torrentCategories(), client.torrentClientDefaults()]);
            const removals = incomplete.flatMap(s => {
                const rule = defaults === undefined ? undefined : removalAtLimit(s.share, categories, defaults, s.category);
                return rule === undefined ? [] : [{ state: s, rule, protection: protectionOf(client, s) }];
            });
            const blocked = removals.find(r => r.protection !== undefined);
            if (blocked !== undefined && !allow_removal) {
                throw new ServiceError('PermissionDenied', client.id, `if the check finds ${blocked.state.title} complete, its share limits can remove it, and ${blocked.protection}`, {
                    remedy: 'Nothing was changed. Change its category or share limit action in qBittorrent, or pass `allow_removal: true`, which needs `destructive`.'
                });
            }
            return {
                target,
                summary: `Recheck ${toCheck.length} torrent(s) on ${client.id}.`,
                effects: [
                    ...states.filter(s => toCheck.includes(s.id)).slice(0, 10).map(s => `Checks ${s.title} (${s.id}).`),
                    ...skipped.map(s => `Skips ${s.title} (${s.id}), which has no metadata to check yet.`),
                    ...inMotion.map(s => `Skips ${s.title} (${s.id}), which is being moved. Check it once the move has ended.`),
                    ...fallbacks.map(s => `If ${s.title} comes back incomplete, qBittorrent moves what is left of it to ${s.downloadPath}; if complete, to ${s.savePath}.`),
                    ...strays.map(s => `After the check, qBittorrent moves ${s.title} to ${s.savePath}, where it is configured to be.`),
                    ...atMissingFiles.map(s => `${s.title} is at missing files: unless it is stopped, qBittorrent downloads whatever the check does not find.`),
                    ...removals.flatMap(r => [
                        ...(r.protection === undefined ? [] : [`Overrides the delete protection: ${r.protection}.`]),
                        `If ${r.state.title} comes back complete: ${removalWarning(r.rule)}`
                    ]),
                    'Reads all their data again, which can take a long time on large torrents and adds disk load while it runs.',
                    resume_if_complete
                        ? 'Starts each stopped torrent that comes back complete, unless another confirmation to this qBittorrent is accepted before the start, even one that changes nothing. A stopped one that comes back incomplete stays stopped.'
                        : 'A stopped torrent stays stopped afterwards. Pass `resume_if_complete` to start the complete ones.'
                ],
                args: {
                    ids: toCheck,
                    resume: resume_if_complete,
                    fallbacks: fallbacks.map(s => [s.id, s.downloadPath, s.savePath]),
                    strays: strays.map(s => [s.id, s.savePath]),
                    homes: checked.map((s, i) => [s.id, s.savePath ?? '', stored[i] ?? '']),
                    atMissingFiles: atMissingFiles.map(s => s.id),
                    removals: removals.map(r => [r.state.id, r.rule, r.protection !== undefined]),
                    allowRemoval: allow_removal
                }
            };
        },

        applied: (outcome: unknown) => outcomeSentence(outcome as RecheckOutcome),

        async apply(plan, { instance, resume_if_complete }) {
            const client = clientOf(adapters, instance);
            const ids = plan.args?.ids as string[];
            await client.recheckTorrents(ids);
            return { client, ids, watch: resume_if_complete };
        },

        // The recheck is the write. The watch only reads until it can start
        // what came back whole, so it runs with the instance free.
        async afterWrite(sent, then) {
            const { client, ids, watch } = sent as { client: Client; ids: string[]; watch: boolean };
            return watch ? watchRecheck(client, ids, sleep, then.write) : { rechecking: ids };
        }
    });

    registerWriteTool(server, context, {
        name: 'add_torrent',
        title: 'Add a torrent',
        description:
            'Adds a torrent to qBittorrent from a `magnet`, a `url` of a .torrent file, or the file itself as `torrent_base64`, into an existing `category` and a `save_path` inside the allowed paths. The preview names where it will land and warns when an *arr watches that category. Nothing vets the torrent, and no *arr imports it unless it watches the category. Safe tier: undo with remove_queue_item. Previews first; the confirm token is bound to that exact source. Field reference: arr://docs/add_torrent.',
        inputSchema: AddTorrentInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'add_torrent',
        tier: ({ allow_removal }) => (allow_removal ? 'destructive' : 'safe'),

        async plan(args): Promise<WritePlan> {
            const client = clientOf(adapters, args.instance);
            const source = addSource(client.id, args);
            const categories = await categoriesWith(client, args.category ?? '');
            const resolved = args.save_path ?? categorySavePath(await client.defaultSavePath(), categories, args.category ?? '');
            const savePath = allowedPath(client.id, resolved, client.allowedPaths);
            const target = `${client.id}:${source.hash ?? `url-${source.digest.slice(0, 12)}`}`;

            if (source.hash !== undefined && (await client.hasTorrent(source.hash))) {
                return { target, summary: `${client.id} already has ${source.label}.`, effects: [], noop: true };
            }
            const defaults = await client.torrentClientDefaults();
            const removal = removalAtLimit(NO_OWN_SHARE_RULE, categories, defaults, args.category ?? '');
            const protection = removal === undefined ? undefined : protectionOf(client, { private: source.private });
            if (protection !== undefined && !args.allow_removal) {
                throw new ServiceError('PermissionDenied', client.id, `that category removes torrents at its share limits, and ${protection}`, {
                    remedy: 'Nothing was changed. Pick another category, change its share limit action in qBittorrent, or pass `allow_removal: true`, which needs `destructive`.'
                });
            }
            const overrides = protection !== undefined;
            return {
                target,
                summary: `Add ${source.label} to ${client.id}, saving to ${savePath}${args.category === undefined ? '' : ` in category "${args.category}"`}.`,
                effects: [
                    ...(overrides ? [`Overrides the delete protection: ${protection}.`] : []),
                    ...(removal === undefined ? [] : [removalWarning(removal)]),
                    ...(await categoryWatchers(adapters, 'QBittorrent', args.category)),
                    `${
                        defaults.addsStopped
                            ? `Adds it stopped, as this client is set to, saving to ${savePath} once started`
                            : defaults.stopCondition === 'MetadataReceived'
                              ? `Adds it saving to ${savePath}, and this client stops it once it has its metadata`
                              : defaults.stopCondition === 'FilesChecked'
                                ? `Adds it saving to ${savePath}, and this client stops it once its files are checked`
                                : `Starts downloading into ${savePath}`
                    }. Nothing vetted this torrent.`,
                    ...source.effects,
                    'It appears in get_queue and can be removed again with remove_queue_item.'
                ],
                // A digest and never the source: this object is written to the audit log.
                args: { source_sha256: source.digest, category: args.category ?? '', savePath, addsStopped: defaults.addsStopped, stopCondition: defaults.stopCondition, removal: removal ?? '', allowRemoval: args.allow_removal, overridesProtection: overrides }
            };
        },

        applied: (outcome, plan) =>
            (outcome as { pending: boolean }).pending ? `qBittorrent accepted ${plan.target} and is still fetching it. get_queue lists it once it arrives.` : undefined,

        async apply(plan, args) {
            const client = clientOf(adapters, args.instance);
            const source = addSource(client.id, args);
            const savePath = plan.args?.savePath as string;
            const added = await client.addTorrent(source.request, { savePath, ...(args.category === undefined ? {} : { category: args.category }) });
            return { added: plan.target, pending: added.pending };
        }
    });

    registerWriteTool(server, context, {
        name: 'set_torrent_location',
        title: 'Set a torrent location',
        description:
            'Points a torrent at a new save path inside the allowed paths. qBittorrent moves what is at the old path, so without `move_files` this is only for a torrent at `missing files`, fetching metadata, or with unfinished data in the incomplete folder, and not if dropping automatic management gathers its files first. After a `missing files` repoint with metadata, run recheck_torrents. `move_files: true` moves data and needs `destructive`. Previews first; confirm to apply. Field reference: arr://docs/set_torrent_location.',
        inputSchema: LocationInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'set_torrent_location',
        tier: ({ move_files }) => (move_files ? 'destructive' : 'safe'),

        async plan({ instance, id, location, move_files }): Promise<WritePlan> {
            const client = clientOf(adapters, instance);
            const details = await client.getTorrentDetails(id);
            const path = allowedPath(client.id, location, client.allowedPaths);
            const target = `${client.id}:${details.id}`;
            if (details.savePath !== undefined && details.savePath.replace(/\/+$/, '') === path) {
                return { target, summary: `The save path of ${details.title} is already ${path}.`, effects: [], noop: true };
            }
            if (details.state === 'moving') {
                throw new ServiceError('InvalidRequest', client.id, 'that torrent is already being moved', { remedy: 'Wait for the move to finish, then look at it again in get_queue.' });
            }
            if (CHECKING_STATES.has(details.state)) {
                throw new ServiceError('InvalidRequest', client.id, 'that torrent is being checked, so where its data is cannot be told yet', { remedy: 'Wait for the check to finish, then look at it again in get_queue.' });
            }
            // The state alone decides. `completed: 0` is no proof: preallocated files count as nothing downloaded, and they move.
            const noData = details.state === 'missingFiles' || !details.hasMetadata;
            // With an incomplete folder set, `setSavePath` only records where an unfinished torrent goes when it finishes.
            const incompleteDir = details.downloadPath?.replace(/\/+$/, '');
            const keepsUnfinished = incompleteDir !== undefined && isUnfinished(details);
            // Turning automatic management off first puts the files where the torrent is configured to keep them.
            const gatherTarget = details.autoManaged && details.hasMetadata ? (keepsUnfinished ? incompleteDir : details.savePath?.replace(/\/+$/, '')) : undefined;
            const storedIn = storageDirectory(details.contentPath, details.fileNames);
            const gathersTo = gatherTarget !== undefined && storedIn !== gatherTarget ? gatherTarget : undefined;
            if (gathersTo !== undefined) allowedPath(client.id, gathersTo, client.allowedPaths);
            const moves = gathersTo !== undefined || (!noData && !keepsUnfinished);
            // A move empties where the files are now, so that has to be allowed too. Repointing a torrent at
            // missing files is the exception, since its old home is often why it is missing: whatever survives
            // there moves as well, so leaving a folder outside the roots takes an explicit `move_files`.
            const movesFrom = moves || (details.hasMetadata && !keepsUnfinished) ? storedIn : undefined;
            const leavesOutside = !moves && movesFrom !== undefined && !isInsideRoots(movesFrom, client.allowedPaths);
            if (movesFrom !== undefined && !leavesOutside) allowedPath(client.id, movesFrom, client.allowedPaths);
            if (leavesOutside && !move_files) {
                throw new ServiceError('PermissionDenied', client.id, `any file of ${details.title} still in ${movesFrom} would move too, and that folder is outside the allowed locations`, {
                    remedy: 'Nothing was changed. If that is what you want, call set_torrent_location again with `move_files: true`, which needs `destructive`.'
                });
            }
            // qBittorrent cannot find the data, so anything said to move is only whatever is left of it.
            const missing = details.state === 'missingFiles';
            if (moves && !move_files) {
                const why = missing && gathersTo !== undefined
                    ? `${details.title} is at missing files, and turning off automatic management first moves any file of it that is left to ${gathersTo}`
                    : `${details.title} has data at its current path, and qBittorrent would move it`;
                throw new ServiceError('PermissionDenied', client.id, why, {
                    remedy: 'Nothing was changed. If the data really should move, call set_torrent_location again with `move_files: true`.'
                });
            }
            // Unfinished and gathered: the files go to the incomplete folder now, and the new path only applies once finished.
            const gatheredOnly = gathersTo !== undefined && keepsUnfinished;
            // Gathered into the folder it is pointed at, so nothing moves on once it finishes.
            const gatheredHome = gatheredOnly && gathersTo === path;
            // Both hops of unfinished data: where it is (or, with no metadata, will be written) now, and `path` once the download finishes.
            // A second move is ruled out only where that first folder is known.
            const onFinish = (now: string | undefined) => (now === path ? 'keeps it there once the download finishes' : `moves it to ${path} once the download finishes`);
            const unfinishedEffect = !details.hasMetadata
                ? `It has no metadata yet, so nothing is on disk. qBittorrent downloads it into ${incompleteDir} and ${onFinish(incompleteDir)}.`
                : missing
                ? `qBittorrent reports its unfinished data missing${storedIn === undefined ? `; it is set to keep it in ${incompleteDir}` : ` from ${storedIn}`}. ${path} only becomes where it goes once the download finishes.`
                : storedIn === undefined
                ? `qBittorrent leaves its unfinished data where it is, which it is set to keep in ${incompleteDir}, and saves it ${incompleteDir === path ? 'there' : `in ${path}`} once the download finishes.`
                : `qBittorrent leaves its unfinished data where it is, in ${storedIn}, and ${onFinish(storedIn)}.`;
            // A repoint at missing files moves whatever is left at the old path, which the applied sentence must not hide.
            const repointsMissing = missing && !keepsUnfinished && details.hasMetadata;
            const savedAt = details.savePath?.replace(/\/+$/, '');
            // Only a folder the files are known to be in: with that folder unknown, the applied sentence says "the old path" instead.
            const missingFrom = storedIn;
            const anyLeft = missing ? `any file of ${details.title} that is left` : details.title;
            return {
                target,
                summary: gatheredHome
                    ? `Move ${anyLeft} to ${path} on ${client.id}, where it stays once it finishes.`
                    : gatheredOnly
                    ? `Move ${anyLeft} to ${gathersTo} now, and on to ${path} once it finishes, on ${client.id}.`
                    : keepsUnfinished
                    ? `Point ${details.title} at ${path} on ${client.id}, where its data goes once the download finishes.`
                    : repointsMissing
                    ? `Point ${details.title} at ${path} on ${client.id}, moving any file of it that is left.`
                    : `${moves ? 'Move' : 'Point'} ${details.title} ${moves ? 'to' : 'at'} ${path} on ${client.id}.`,
                effects: [
                    ...(gathersTo === undefined
                        ? []
                        : [missing ? `Turning off automatic management first moves any file of it that is left to ${gathersTo}.` : `Turning off automatic management first moves its files to ${gathersTo}.`]),
                    gatheredHome
                        ? 'qBittorrent keeps them there once the download finishes.'
                        : gatheredOnly
                        ? `qBittorrent moves them on from ${gathersTo} to ${path} once the download finishes.`
                        : keepsUnfinished
                        ? unfinishedEffect
                        : !details.hasMetadata
                        ? 'It has no metadata yet, so there is nothing on disk to move.'
                        : noData
                        ? `qBittorrent reports its data missing${storedIn !== undefined ? ` from ${storedIn}` : savedAt !== undefined ? `; its save path is ${savedAt}` : ''}. It has no call that changes the path alone, so any file of this torrent still at its old path moves too.`
                        : `Physically moves ${size(details.completedBytes)} ${(gathersTo ?? movesFrom) === undefined ? '' : `${gathersTo === undefined ? '' : 'on '}from ${gathersTo ?? movesFrom} `}to ${path}.${movesFrom === undefined && savedAt !== undefined && gathersTo === undefined ? ` Where its files are now cannot be told; it is set to keep them in ${savedAt}.` : ''} Hardlinks into the library break if ${gathersTo === undefined ? 'that crosses' : 'either move crosses'} a filesystem.`,
                    ...(details.autoManaged ? ['Switches the torrent to manual management, so its category no longer decides its path.'] : []),
                    ...(repointsMissing ? ['Run recheck_torrents afterwards so qBittorrent finds the data there.'] : [])
                ],
                // `moves`, so a token from a preview that promised no move cannot apply to data that has since come back.
                // Every folder the preview can name, so a token cannot outlive a change to one of them.
                args: {
                    id: details.id, location: path, moveFiles: move_files, moves, movesFrom: movesFrom ?? '', gathersTo: gathersTo ?? '', gatheredOnly, missing, repointsMissing,
                    missingFrom: repointsMissing ? (missingFrom ?? '') : '', storedIn: storedIn ?? '', savedAt: savedAt ?? '', incompleteDir: incompleteDir ?? ''
                }
            };
        },

        applied: (_outcome, plan) => {
            if (plan.args?.gatheredOnly === true) {
                const gathersTo = String(plan.args.gathersTo);
                const now = plan.args.missing === true ? `. Any file of it that is left may still be moving to ${gathersTo} in the background` : ` and moves the files to ${gathersTo} in the background`;
                return `qBittorrent accepted this for ${plan.target}${now}. ${gathersTo === plan.args.location ? 'They stay there' : 'They move on to the new location'} once the torrent finishes.`;
            }
            if (plan.args?.repointsMissing === true) {
                const from = String(plan.args.missingFrom);
                return `qBittorrent accepted the new location for ${plan.target}. Any file of it left ${from === '' ? 'at the old path' : `in ${from}`} may still be moving to ${String(plan.args.location)} in the background, so wait until get_queue no longer shows it at \`moving\` before running recheck_torrents.`;
            }
            return plan.args?.moves === true
                ? `qBittorrent accepted the new location for ${plan.target} and moves the data in the background. get_queue shows the torrent at \`moving\` until it is done.`
                : undefined;
        },

        async apply(plan, { instance }) {
            const { id, location } = plan.args as { id: string; location: string };
            await clientOf(adapters, instance).setTorrentLocation(id, location);
            return { location, pending: true };
        }
    });

    registerWriteTool(server, context, {
        name: 'rename_torrent_file',
        title: 'Rename a torrent file',
        description:
            'Renames one file inside a torrent, on disk and in qBittorrent. The new name stays inside the torrent\'s own folder. Take `old_path` from get_queue at `detail: "full"`. Safe tier: rename it back to undo. Previews first; confirm to apply. Field reference: arr://docs/rename_torrent_file.',
        inputSchema: RenameInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'rename_torrent_file',
        tier: 'safe',

        async plan({ instance, id, old_path, new_path }): Promise<WritePlan> {
            const client = clientOf(adapters, instance);
            const details = await client.getTorrentDetails(id);
            // The incomplete folder counts only while data is there: a finished torrent keeps its setting after leaving it.
            const unfinishedIn = details.downloadPath !== undefined && isUnfinished(details) ? [details.downloadPath] : [];
            const storedIn = storageDirectory(details.contentPath, details.fileNames);
            for (const stored of [details.savePath ?? '', ...unfinishedIn, ...(storedIn === undefined ? [] : [storedIn])]) {
                allowedPath(client.id, stored, client.allowedPaths);
            }
            const oldPath = unfence(old_path);
            const newPath = renamedPath(client.id, oldPath, unfence(new_path), details.fileNames);
            const target = `${client.id}:${details.id}`;
            const shown = (path: string) => fenceText(path, { service: client.id, field: 'file' });
            if (newPath === oldPath) return { target, summary: `${shown(oldPath)} already has that name.`, effects: [], noop: true };
            return {
                target,
                summary: `Rename ${shown(oldPath)} to ${shown(newPath)} in ${details.title}.`,
                effects: ['Renames the file on disk. An *arr still tracking this download looks for the old name until it next rescans.'],
                args: { id: details.id, oldPath, newPath }
            };
        },

        applied: (_outcome, plan) => `qBittorrent accepted the rename in ${plan.target} and finishes it in the background. get_queue lists the new name once it is done.`,

        async apply(plan, { instance }) {
            const { id, oldPath, newPath } = plan.args as { id: string; oldPath: string; newPath: string };
            await clientOf(adapters, instance).renameTorrentFile(id, oldPath, newPath);
            return { renamed: newPath, pending: true };
        }
    });

    registerWriteTool(server, context, {
        name: 'set_torrent_category',
        title: 'Set a torrent category',
        description:
            'Changes the category of a torrent, or clears it with an empty string. The category must already exist. The preview warns when an *arr watches the old or new category. If the change would relocate an automatically managed torrent it is refused unless `move_files: true`, and a category whose share limits would remove the torrent unless `allow_removal: true`; each needs `destructive`. Previews first; confirm to apply. Field reference: arr://docs/set_torrent_category.',
        inputSchema: CategoryInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'set_torrent_category',
        tier: ({ move_files, allow_removal }) => (move_files || allow_removal ? 'destructive' : 'safe'),

        async plan({ instance, id, category, move_files, allow_removal }): Promise<WritePlan> {
            const client = clientOf(adapters, instance);
            const details = await client.getTorrentDetails(id);
            const target = `${client.id}:${details.id}`;
            if (details.category === category) return { target, summary: `${details.title} is already in that category.`, effects: [], noop: true };

            const categories = await categoriesWith(client, category);
            const relocates = details.autoManaged && (await client.categoryChangeRelocates());
            const defaults = await client.torrentClientDefaults();
            let destination: string | undefined;
            let finishedAt: string | undefined;
            let writesTo: string | undefined;
            if (details.state === 'moving' || (details.autoManaged && CHECKING_STATES.has(details.state))) {
                throw new ServiceError('InvalidRequest', client.id, 'that torrent is being moved or checked, so where its data is cannot be told yet', {
                    remedy: 'Nothing was changed. Wait for that to finish, then try again.'
                });
            }
            const savedAt = details.savePath?.replace(/\/+$/, '');
            const incompleteDir = details.downloadPath?.replace(/\/+$/, '');
            // Where the files really are: a failed move or a newly wanted file leaves them away from the configured folder.
            const storedIn = storageDirectory(details.contentPath, details.fileNames);
            // A magnet reports nothing left to download, yet its data will go to the incomplete folder once it has metadata.
            const unfinished = isUnfinished(details);
            if (relocates) {
                const finalPath = categorySavePath(await client.defaultSavePath(), categories, category);
                if (finalPath !== savedAt) allowedPath(client.id, finalPath, client.allowedPaths);
                const incomplete = unfinished ? categoryIncompletePath(categories, defaults, category) : undefined;
                const target = incomplete ?? finalPath;
                if (!details.hasMetadata) {
                    // Nothing is on disk to move yet, but this is where it will be written.
                    writesTo = allowedPath(client.id, target, client.allowedPaths);
                } else if (target !== (storedIn ?? (unfinished ? (incompleteDir ?? savedAt) : savedAt))) {
                    destination = allowedPath(client.id, target, client.allowedPaths);
                }
                if (incomplete !== undefined) finishedAt = finalPath;
            } else if (details.autoManaged) {
                // Switching to manual management first puts the files where the old category keeps them.
                const target = unfinished ? (incompleteDir ?? savedAt) : savedAt;
                if (target !== undefined && !details.hasMetadata) writesTo = allowedPath(client.id, target, client.allowedPaths);
                else if (target !== undefined && storedIn !== undefined && target !== storedIn) destination = allowedPath(client.id, target, client.allowedPaths);
            }
            // A move empties where the files are now, so that has to be allowed too.
            if (destination !== undefined && storedIn !== undefined) allowedPath(client.id, storedIn, client.allowedPaths);
            // Named in the preview and the refusal. Where the files really are when that can be told, else where the torrent is set to keep them.
            const configuredIn = unfinished ? (incompleteDir ?? savedAt) : savedAt;
            const leaves = storedIn === undefined ? '' : `from ${storedIn} `;
            const unknownSource = storedIn === undefined && configuredIn !== undefined ? `where its files are now cannot be told; it is set to keep them in ${configuredIn}` : undefined;
            const removal = removalAtLimit(details.share, categories, defaults, category);
            // Only a rule this change brings in: moving between categories under the same one exposes the torrent to nothing new.
            const introduced = removal !== undefined && JSON.stringify(removal) !== JSON.stringify(removalAtLimit(details.share, categories, defaults, details.category));
            const protection = introduced ? protectionOf(client, details) : undefined;
            if (introduced && !allow_removal) {
                throw new ServiceError('PermissionDenied', client.id, `at the share limits of that category qBittorrent would remove this torrent${protection === undefined ? '' : `, and ${protection}`}`, {
                    remedy: 'Nothing was changed. Pick another category, change its share limit action in qBittorrent, or pass `allow_removal: true`, which needs `destructive`.'
                });
            }
            if (destination !== undefined && !move_files) {
                throw new ServiceError('PermissionDenied', client.id, `that category would move ${details.title} ${leaves}to ${destination}${unknownSource === undefined ? '' : `, and ${unknownSource}`}`, {
                    remedy: 'Nothing was changed. If the data really should move, call set_torrent_category again with `move_files: true`.'
                });
            }
            const watchers = [...new Set([
                ...(await categoryWatchers(adapters, 'QBittorrent', category)),
                ...(await categoryWatchers(adapters, 'QBittorrent', details.category))
            ])];
            return {
                target,
                summary: `Set the category of ${details.title} to ${category === '' ? 'none' : `"${category}"`} on ${client.id}.`,
                effects: [
                    ...(protection === undefined ? [] : [`Overrides the delete protection: ${protection}.`]),
                    ...(removal === undefined ? [] : [removalWarning(removal)]),
                    ...watchers,
                    destination === undefined
                        ? writesTo !== undefined
                            ? `It has no data yet, and will download to ${writesTo}.`
                            : finishedAt === undefined
                            ? 'The data stays where it is.'
                            : `Its unfinished data stays where it is, and goes to ${finishedAt} once finished.`
                        : `Physically moves ${size(details.completedBytes)} ${leaves}to ${destination}, because qBittorrent manages this torrent's path by category.${unknownSource === undefined ? '' : ` Where its files are now cannot be told; it is set to keep them in ${configuredIn}.`}${finishedAt === undefined ? '' : ` It goes to ${finishedAt} once finished.`}`,
                    ...(details.autoManaged && !relocates ? ['Switches the torrent to manual management, so its category no longer decides its path.'] : [])
                ],
                // The destination itself, so a token cannot outlive a change to where the category saves.
                args: { id: details.id, category, moves: destination !== undefined, movesFrom: destination === undefined ? '' : (storedIn ?? ''), configuredFrom: unknownSource === undefined || destination === undefined ? '' : (configuredIn ?? ''), destination: destination ?? '', finishedAt: finishedAt ?? '', writesTo: writesTo ?? '', removal: removal ?? '', allowRemoval: allow_removal, overridesProtection: protection !== undefined }
            };
        },

        async apply(plan, { instance }) {
            const { id, category } = plan.args as { id: string; category: string };
            await clientOf(adapters, instance).setTorrentCategory(id, category);
            return { category };
        }
    });

    registerWriteTool(server, context, {
        name: 'reannounce_torrent',
        title: 'Reannounce a torrent',
        description:
            'Has qBittorrent announce one torrent to its trackers now, for a tracker that has not caught up or a torrent short of peers. Trackers rate-limit announces, so do not repeat it in a loop. Previews first; confirm to apply. Field reference: arr://docs/reannounce_torrent.',
        inputSchema: ReannounceInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'reannounce_torrent',
        tier: 'safe',

        async plan({ instance, id }): Promise<WritePlan> {
            const client = clientOf(adapters, instance);
            // A stopped torrent has nothing to announce, so its answer must not depend on the
            // tracker list, whose read can fail on its own. When the details cannot be read,
            // the state alone is asked for; any other answer is the original failure.
            let details: TorrentDetails;
            try {
                details = await client.getTorrentDetails(id);
            } catch (err) {
                // Only for an error qBittorrent answered with, which is how a tracker read fails.
                // A refused login, or a client that is unreachable or not answering, would fail
                // the same way again, and a second failed login brings a ban closer.
                if (!(err instanceof ServiceError) || err.kind !== 'UpstreamError') throw err;
                const [state] = await client.torrentCheckStates([id]).catch(() => []);
                if (state?.stopped === true) return stopped(`${client.id}:${state.id}`, state.title);
                throw err;
            }
            const target = `${client.id}:${details.id}`;
            if (details.status === 'stopped') return stopped(target, details.title);
            if (details.trackerDigest === null) {
                throw new ServiceError('UpstreamError', client.id, 'the tracker list qBittorrent gave for this torrent could not be read, so nobody can say where a reannounce would go', {
                    remedy: 'Check that qBittorrent answers normally and that none of this torrent\'s tracker URLs is malformed (fix or remove one that is, in qBittorrent), then preview the reannounce again.'
                });
            }
            const hosts = details.trackers.map(t => `${t.host} (${t.status})`).join(', ');
            return {
                target,
                summary: `Reannounce ${details.title} on ${client.id}.`,
                effects: [hosts === '' ? 'It has no tracker to announce to, so only DHT hears about it.' : `Contacts: ${hosts}.`],
                // A digest of the trackers the preview named, so a token cannot announce to a list the caller never saw.
                args: { id: details.id, trackers_sha256: details.trackerDigest }
            };
        },

        async apply(plan, { instance }) {
            const { id } = plan.args as { id: string };
            await clientOf(adapters, instance).reannounceTorrent(id);
            return { reannounced: id };
        }
    });
}
