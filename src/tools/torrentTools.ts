import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { fenceText, unfence } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import { MAX_TORRENT_BYTES, readTorrentFile } from '../core/torrentFile.ts';
import { allowedPath, downloadHost, renamedPath, trackerHost } from '../core/torrentGuards.ts';
import { btihToHex } from '../services/qbittorrent.ts';
import { hasTorrentManage, type ServiceAdapter, type TorrentCategory, type TorrentCheckState, type TorrentManageCapable, type TorrentShareRule, type TorrentSource } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { NO_OWN_SHARE_RULE, categoryIncompletePath, categorySavePath, isStoredIn, removalAtLimit } from './torrentCategoryRules.ts';
import { protectionOf } from './torrentDelete.ts';
import { categoryWatchers } from './watchedCategory.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

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
    if (!hasTorrentManage(adapter)) throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot manage torrents`);
    return adapter;
};

const instanceField = z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION);
/** Checked here so that nothing else, a tracker URL pasted by mistake included, reaches an error or the audit log. */
const torrentHash = z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, 'must be a torrent hash: 40 or 64 hex characters');
const hashField = torrentHash.describe('The torrent hash: `id` on its get_queue row.');
const moveFilesField = z.boolean().default(false).describe('Allow qBittorrent to physically move the data, which needs `destructive`.');

const size = (bytes: number | undefined): string => (bytes === undefined ? 'an unknown amount of data' : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

const digestOf = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex');

/** Every category of the client, once `category` is known to be among them. */
async function categoriesWith(client: Client, category: string): Promise<ReadonlyMap<string, TorrentCategory>> {
    const categories = await client.torrentCategories();
    if (category !== '' && !categories.has(category)) {
        throw new ServiceError('NotFound', client.id, `${client.id} has no category named "${category}"`, {
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

/** While these run, the amount left says nothing about where the data is, and a finished torrent can read as unfinished. */
const CHECKING_STATES = new Set(['checkingUP', 'checkingDL', 'checkingResumeData']);

const removalWarning = (rule: TorrentShareRule): string => {
    const limits = [
        ...(rule.ratio >= 0 ? [`ratio ${rule.ratio}`] : []),
        ...(rule.seedingMinutes >= 0 ? [`${rule.seedingMinutes} minutes seeding`] : []),
        ...(rule.inactiveMinutes >= 0 ? [`${rule.inactiveMinutes} minutes inactive`] : [])
    ];
    return `Warning: at this category's share limits (${limits.join(', ')}) qBittorrent removes this torrent${rule.action === 'RemoveWithContent' ? ' and deletes its files' : ''}.`;
};

type TorrentToolOptions = { sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type RecheckOutcome = { rechecking: string[]; resumed?: string[]; incomplete?: string[]; still_checking?: string[]; unconfirmed?: string[]; gone?: string[]; resume_failed?: string[] };

/**
 * Watches a recheck that has been sent, and starts what came back whole and
 * stopped. Only a torrent seen checking counts as verified: until its check
 * begins, `complete` is still the answer from the last one. qBittorrent checks
 * one torrent at a time, so a torrent showing no check may simply be queued: an
 * incomplete one is watched to the end rather than reported as checked.
 */
async function watchRecheck(client: Client, ids: readonly string[], sleep: (ms: number) => Promise<void>): Promise<RecheckOutcome> {
    const seenChecking = new Set<string>();
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
            if (state?.checking === true) seenChecking.add(id);
            else if (state === undefined || seenChecking.has(id) || (state.complete && waited >= GRACE_MS)) settled.set(id, state);
        }
    }

    const finished = [...settled.entries()];
    const wholeAndStopped = finished.flatMap(([id, s]) => (s?.complete === true && s.stopped ? [id] : []));
    let toStart = wholeAndStopped.filter(id => seenChecking.has(id));
    let resumeFailed = false;
    if (toStart.length > 0) {
        try {
            // Read again at the last moment: a batch can outlast what the watch saw of its first torrent.
            const fresh = await client.torrentCheckStates(toStart);
            toStart = fresh.filter(s => s.complete && s.stopped && !s.checking).map(s => s.id);
            if (toStart.length > 0) await client.startTorrents(toStart);
        } catch (err) {
            logger.warn({ service: client.id, err }, 'a recheck finished but the torrents could not be started');
            resumeFailed = true;
        }
    }
    const list = (key: keyof RecheckOutcome, values: string[]) => (values.length === 0 ? {} : { [key]: values });
    return {
        rechecking: [...ids],
        ...list(resumeFailed ? 'resume_failed' : 'resumed', toStart),
        ...list('incomplete', finished.flatMap(([id, s]) => (s !== undefined && !s.complete ? [id] : []))),
        ...list('still_checking', ids.filter(id => !settled.has(id) && seenChecking.has(id))),
        ...list('unconfirmed', [...wholeAndStopped.filter(id => !toStart.includes(id)), ...ids.filter(id => !settled.has(id) && !seenChecking.has(id))]),
        ...list('gone', finished.flatMap(([id, s]) => (s === undefined ? [id] : [])))
    };
}

const outcomeSentence = (o: RecheckOutcome): string | undefined => {
    if (o.resumed === undefined && o.incomplete === undefined && o.still_checking === undefined && o.unconfirmed === undefined && o.gone === undefined && o.resume_failed === undefined) return undefined;
    const part = (label: string, ids: string[] | undefined) => (ids === undefined ? [] : [`${label}: ${ids.join(', ')}`]);
    return `Recheck sent. ${[
        ...part('started again', o.resumed),
        ...part('came back incomplete', o.incomplete),
        ...part('still checking, so start these with pause_downloads once get_queue shows them complete', o.still_checking),
        ...part('no check was seen running yet, so these were not started; look at them again in get_queue', o.unconfirmed),
        ...part('removed while checking', o.gone),
        ...part('finished complete but could not be started', o.resume_failed)
    ].join('; ')}.`;
};

/** A `.torrent` upload decoded, or a refusal that repeats none of it. */
function torrentBytes(service: string, base64: string): Buffer {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
        throw new ServiceError('NotFound', service, '`torrent_base64` is not valid base64', { remedy: 'Send the whole .torrent file, base64 encoded.' });
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_TORRENT_BYTES) throw new ServiceError('NotFound', service, 'that .torrent file is larger than the 3 MB limit', { remedy: 'Pass its `url` instead.' });
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
        throw new ServiceError('NotFound', service, 'pass exactly one of `magnet`, `url` or `torrent_base64`', {
            remedy: 'Each is a different way to name the same thing: the torrent to add.'
        });
    }
    if (args.magnet !== undefined) {
        const hash = args.magnet.length > 8192 || !MAGNET.test(args.magnet) ? undefined : magnetHash(args.magnet);
        if (hash === undefined) {
            throw new ServiceError('NotFound', service, 'that is not a magnet link', { remedy: 'A magnet starts `magnet:?` and carries `xt=urn:btih:<hash>` or `xt=urn:btmh:1220<hash>`.' });
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
        throw new ServiceError('NotFound', service, (err as Error).message, { remedy: 'Send the whole .torrent file, base64 encoded.' });
    }
    return {
        request: { kind: 'file', bytes, filename: 'upload.torrent' },
        digest: digestOf(bytes),
        hash: facts.hash,
        private: facts.private,
        label: fenceText(facts.name, { service, field: 'name' }),
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
    save_path: z.string().min(1).optional().describe('Where to save it, inside the allowed paths; defaults to where the category saves.')
});

const RecheckInput = z.object({
    instance: instanceField,
    ids: z.array(torrentHash).min(1).max(50).describe('Torrent hashes: `id` on their get_queue rows.'),
    resume_if_complete: z.boolean().default(false).describe('Watch the recheck briefly and start each stopped torrent that comes back complete.')
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
    move_files: moveFilesField
});

const ReannounceInput = z.object({ instance: instanceField, id: hashField });

export function registerTorrentTools(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[], options: TorrentToolOptions = {}): void {
    const sleep = options.sleep ?? defaultSleep;

    registerWriteTool(server, context, {
        name: 'recheck_torrents',
        title: 'Recheck torrents',
        description:
            'Has qBittorrent verify torrents against the data on disk: the usual next step for a torrent at `missing files` once its data is back. `resume_if_complete` watches for about 45 seconds and starts each stopped torrent that comes back complete; slower ones are reported as still checking. Previews first; confirm to start the recheck. Field reference: arr://docs/recheck_torrents.',
        inputSchema: RecheckInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'recheck_torrents',
        tier: 'safe',

        async plan({ instance, ids, resume_if_complete }): Promise<WritePlan> {
            const client = clientOf(adapters, instance);
            const wanted = [...new Set(ids.map(id => id.trim().toLowerCase()))];
            const states = await client.torrentCheckStates(wanted);
            const missing = wanted.filter(id => !states.some(s => s.id === id));
            if (missing.length > 0) {
                throw new ServiceError('NotFound', client.id, `no torrent with hash ${missing.join(', ')}`, { remedy: 'Take current ids from get_queue.' });
            }
            const skipped = states.filter(s => !s.hasMetadata);
            const toCheck = states.filter(s => !s.checking && s.hasMetadata).map(s => s.id).sort();
            const target = `${client.id}:${toCheck.length === 0 ? wanted.join(',') : toCheck.join(',')}`;
            if (toCheck.length === 0) return { target, summary: `None of those torrents can be checked on ${client.id}: each is already checking or still fetching its metadata.`, effects: [], noop: true };
            return {
                target,
                summary: `Recheck ${toCheck.length} torrent(s) on ${client.id}.`,
                effects: [
                    ...states.filter(s => toCheck.includes(s.id)).slice(0, 10).map(s => `Checks ${s.title} (${s.id}).`),
                    ...skipped.map(s => `Skips ${s.title} (${s.id}), which has no metadata to check yet.`),
                    'Reads all their data again, which can take a long time on large torrents and adds disk load while it runs.',
                    resume_if_complete
                        ? 'Starts each stopped torrent that comes back complete. An incomplete one stays stopped.'
                        : 'A stopped torrent stays stopped afterwards. Pass `resume_if_complete` to start the complete ones.'
                ],
                args: { ids: toCheck, resume: resume_if_complete }
            };
        },

        applied: (outcome: unknown) => outcomeSentence(outcome as RecheckOutcome),

        async apply(plan, { instance, resume_if_complete }) {
            const client = clientOf(adapters, instance);
            const ids = plan.args?.ids as string[];
            await client.recheckTorrents(ids);
            return resume_if_complete ? watchRecheck(client, ids, sleep) : { rechecking: ids };
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
        tier: 'safe',

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
            const removal = removalAtLimit(NO_OWN_SHARE_RULE, categories, await client.torrentClientDefaults(), args.category ?? '');
            const protection = removal === undefined ? undefined : protectionOf(client, { private: source.private });
            if (protection !== undefined) {
                throw new ServiceError('PermissionDenied', client.id, `that category removes torrents at its share limits, and ${protection}`, {
                    remedy: 'Nothing was changed. Pick another category, or change its share limit action in qBittorrent.'
                });
            }
            return {
                target,
                summary: `Add ${source.label} to ${client.id}, saving to ${savePath}${args.category === undefined ? '' : ` in category "${args.category}"`}.`,
                effects: [
                    ...(removal === undefined ? [] : [removalWarning(removal)]),
                    ...(await categoryWatchers(adapters, 'QBittorrent', args.category)),
                    `Starts downloading into ${savePath}. Nothing vetted this torrent.`,
                    ...source.effects,
                    'It appears in get_queue and can be removed again with remove_queue_item.'
                ],
                // A digest and never the source: this object is written to the audit log.
                args: { source_sha256: source.digest, category: args.category ?? '', savePath, removal: removal ?? '' }
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
            'Points a torrent at a new save path inside the allowed paths. qBittorrent cannot change a path without moving what it finds there, so by default this is only for a torrent at `missing files`, still fetching metadata, or with its unfinished data in the incomplete-downloads folder. Follow it with recheck_torrents. `move_files: true` has qBittorrent physically move existing data, and needs `destructive`. Previews first; confirm to apply. Field reference: arr://docs/set_torrent_location.',
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
                return { target, summary: `${details.title} is already at ${path}.`, effects: [], noop: true };
            }
            if (details.state === 'moving') {
                throw new ServiceError('NotFound', client.id, 'that torrent is already being moved', { remedy: 'Wait for the move to finish, then look at it again in get_queue.' });
            }
            if (CHECKING_STATES.has(details.state)) {
                throw new ServiceError('NotFound', client.id, 'that torrent is being checked, so where its data is cannot be told yet', { remedy: 'Wait for the check to finish, then look at it again in get_queue.' });
            }
            // The state alone decides. `completed: 0` is no proof: preallocated files count as nothing downloaded, and they move.
            const noData = details.state === 'missingFiles' || !details.hasMetadata;
            // Unfinished data in the incomplete-downloads folder stays there: qBittorrent only records where it goes when finished.
            const heldElsewhere =
                details.downloadPath !== undefined &&
                (!details.hasMetadata || ((details.remainingBytes ?? 0) > 0 && details.contentPath !== undefined && isStoredIn(details.contentPath, details.downloadPath)));
            const moves = !noData && !heldElsewhere;
            if (moves && !move_files) {
                throw new ServiceError('NotFound', client.id, `${details.title} has data at its current path, and qBittorrent would move it`, {
                    remedy: 'Nothing was changed. If the data really should move, call set_torrent_location again with `move_files: true`.'
                });
            }
            return {
                target,
                summary: `${moves ? 'Move' : 'Point'} ${details.title} ${moves ? 'to' : 'at'} ${path} on ${client.id}.`,
                effects: [
                    heldElsewhere
                        ? `Its unfinished data stays in ${details.downloadPath}. Only where it goes once finished changes.`
                        : noData
                        ? `qBittorrent reports its data missing from ${details.savePath ?? 'its current path'}. It has no call that changes the path alone, so any file of this torrent still there moves too.`
                        : `Physically moves ${size(details.completedBytes)} from ${details.savePath ?? 'its current path'} to ${path}. Hardlinks into the library break if that crosses a filesystem.`,
                    ...(details.autoManaged ? ['Switches the torrent to manual management, so its category no longer decides its path.'] : []),
                    ...(noData && !heldElsewhere ? ['Run recheck_torrents afterwards so qBittorrent finds the data there.'] : [])
                ],
                // `moves`, so a token from a preview that promised no move cannot apply to data that has since come back.
                args: { id: details.id, location: path, moveFiles: move_files, moves }
            };
        },

        applied: (_outcome, plan) =>
            plan.args?.moves === true
                ? `qBittorrent accepted the new location for ${plan.target} and moves the data in the background. get_queue shows the torrent at \`moving\` until it is done.`
                : undefined,

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
            const unfinishedIn = details.downloadPath !== undefined && (details.remainingBytes ?? 0) > 0 ? [details.downloadPath] : [];
            for (const stored of [details.savePath ?? '', ...unfinishedIn]) {
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
            'Changes the category of a torrent, or clears it with an empty string. The category must already exist. The preview warns when an *arr watches the old or new category. If the change would relocate an automatically managed torrent it is refused unless `move_files: true`, which needs `destructive`. Previews first; confirm to apply. Field reference: arr://docs/set_torrent_category.',
        inputSchema: CategoryInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'set_torrent_category',
        tier: ({ move_files }) => (move_files ? 'destructive' : 'safe'),

        async plan({ instance, id, category, move_files }): Promise<WritePlan> {
            const client = clientOf(adapters, instance);
            const details = await client.getTorrentDetails(id);
            const target = `${client.id}:${details.id}`;
            if (details.category === category) return { target, summary: `${details.title} is already in that category.`, effects: [], noop: true };

            const categories = await categoriesWith(client, category);
            const relocates = details.autoManaged && (await client.categoryChangeRelocates());
            const defaults = await client.torrentClientDefaults();
            let destination: string | undefined;
            let finishedAt: string | undefined;
            if (relocates) {
                if (CHECKING_STATES.has(details.state)) {
                    throw new ServiceError('NotFound', client.id, 'that torrent is being checked, so where its data is cannot be told yet', {
                        remedy: 'Nothing was changed. Wait for the check to finish, then try again.'
                    });
                }
                const savedAt = details.savePath?.replace(/\/+$/, '');
                const finalPath = categorySavePath(await client.defaultSavePath(), categories, category);
                if (finalPath !== savedAt) allowedPath(client.id, finalPath, client.allowedPaths);
                // A magnet reports nothing left to download, yet its data will go to the incomplete folder once it has metadata.
                const unfinished = (details.remainingBytes ?? 0) > 0 || !details.hasMetadata;
                const incomplete = unfinished ? categoryIncompletePath(categories, defaults, category) : undefined;
                const target = incomplete ?? finalPath;
                // Where the files really are: a failed move or a newly wanted file leaves them away from the configured folder.
                const inPlace =
                    details.contentPath === undefined
                        ? target === (unfinished ? (details.downloadPath?.replace(/\/+$/, '') ?? savedAt) : savedAt)
                        : isStoredIn(details.contentPath, target);
                if (!inPlace) destination = allowedPath(client.id, target, client.allowedPaths);
                if (incomplete !== undefined) finishedAt = finalPath;
            }
            const removal = removalAtLimit(details.share, categories, defaults, category);
            const protection = removal === undefined ? undefined : protectionOf(client, details);
            if (protection !== undefined) {
                throw new ServiceError('PermissionDenied', client.id, `at the share limits of that category qBittorrent would remove this torrent, and ${protection}`, {
                    remedy: 'Nothing was changed. Pick another category, or change its share limit action in qBittorrent.'
                });
            }
            if (destination !== undefined && !move_files) {
                throw new ServiceError('NotFound', client.id, `that category would move ${details.title} to ${destination}`, {
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
                    ...(removal === undefined ? [] : [removalWarning(removal)]),
                    ...watchers,
                    destination === undefined
                        ? finishedAt === undefined
                            ? 'The data stays where it is.'
                            : `Its unfinished data stays where it is, and goes to ${finishedAt} once finished.`
                        : `Physically moves ${size(details.completedBytes)} to ${destination}, because qBittorrent manages this torrent's path by category.${finishedAt === undefined ? '' : ` It goes to ${finishedAt} once finished.`}`,
                    ...(details.autoManaged && !relocates ? ['Switches the torrent to manual management, so its category no longer decides its path.'] : [])
                ],
                // The destination itself, so a token cannot outlive a change to where the category saves.
                args: { id: details.id, category, moves: destination !== undefined, destination: destination ?? '', finishedAt: finishedAt ?? '', removal: removal ?? '' }
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
            const details = await client.getTorrentDetails(id);
            const target = `${client.id}:${details.id}`;
            if (details.status === 'stopped') return { target, summary: `${details.title} is stopped, so it has nothing to announce.`, effects: [], noop: true };
            const hosts = details.trackers.map(t => `${t.host} (${t.status})`).join(', ');
            return {
                target,
                summary: `Reannounce ${details.title} on ${client.id}.`,
                effects: [hosts === '' ? 'It has no tracker to announce to, so only DHT hears about it.' : `Contacts: ${hosts}.`],
                args: { id: details.id }
            };
        },

        async apply(plan, { instance }) {
            const { id } = plan.args as { id: string };
            await clientOf(adapters, instance).reannounceTorrent(id);
            return { reannounced: id };
        }
    });
}
