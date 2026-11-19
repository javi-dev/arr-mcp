import { instanceId } from '../config/instances.ts';
import { DEFAULT_TORRENT_PATHS, type ConfigByService, type ServiceId } from '../config/schema.ts';
import { qbittorrentSession } from '../core/auth.ts';
import { SHORT_READ_TTL_MS, cached } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { hostPort } from '../core/hostPort.ts';
import { logger } from '../core/logger.ts';
import { scrubUrls } from '../core/pastedUrl.ts';
import { trackerHost } from '../core/torrentGuards.ts';
import type { TorrentFacts } from '../core/cleanuparrRules.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ClientSeedLimits,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type PauseCapable,
    type PauseState,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type MagnetAdded,
    type MagnetAddCapable,
    type RemoveQueueOptions,
    type SeedingState,
    type SeedLimitsCapable,
    type ServiceAdapter,
    type SpeedLimit,
    type SpeedLimitCapable,
    type TorrentAdded,
    type TorrentCategory,
    type TorrentCheckState,
    type TorrentClientDefaults,
    type TorrentDetails,
    type TorrentEndpoint,
    type TorrentManageCapable,
    type TorrentShareRule,
    type TorrentSource,
    type TorrentTrackerRow,
    PAUSE_MARK
} from './types.ts';

const API = '/api/v2';

/** Both spellings, for the same reason `TORRENT_STATE` keeps both: 5.0 renamed
 *  the paused states to stopped. */
const PAUSED_STATES = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);

const CHECKING_STATES = new Set(['checkingUP', 'checkingDL', 'checkingResumeData']);

/**
 * Hand-written: qBittorrent publishes no OpenAPI document. Its WebUI API mixes
 * JSON responses with bare-string ones, and takes form fields rather than JSON
 * on writes.
 */
type RawTorrent = {
    hash?: string;
    name?: string;
    state?: string;
    size?: number;
    amount_left?: number;
    eta?: number;
    /** -1 when infinite. */
    ratio?: number;
    seeding_time?: number;
    /** -2 follows the default, -1 is no limit. */
    ratio_limit?: number;
    seeding_time_limit?: number;
    /** Effective limits after torrent, category and global; -1 is none.
     *  `max_seeding_time` is minutes. */
    max_ratio?: number;
    max_seeding_time?: number;
    /** 5.x only, and null until metadata arrives. */
    private?: boolean | null;
    category?: string;
    tags?: string;
    tracker?: string;
    save_path?: string;
    auto_tmm?: boolean;
    download_path?: string;
    content_path?: string;
    has_metadata?: boolean;
    completion_on?: number;
    share_limit_action?: string;
    share_limits_mode?: string;
    inactive_seeding_time_limit?: number;
    progress?: number;
    completed?: number;
};

/** `torrents/properties`: what `torrents/info` can lack on a torrent in trouble. 5.0 and 5.1 spell `private` as `is_private`. */
type RawProperties = {
    save_path?: string;
    private?: boolean | null;
    is_private?: boolean | null;
    share_ratio?: number;
    seeding_time?: number;
};

type RawFile = { name?: string; size?: number; progress?: number };

/** `url` is read for its host and dropped. `msg` is never read: a tracker can echo the passkey in it. */
type RawTracker = { url?: string; status?: number; updating?: boolean };

/** `download_path` is a folder, `false` for none, or `null` to follow the global setting. */
type RawCategories = Record<
    string,
    { savePath?: string; download_path?: string | boolean | null; share_limit_action?: string; share_limits_mode?: string; ratio_limit?: number; seeding_time_limit?: number; inactive_seeding_time_limit?: number }
>;

type RawMainData = { server_state?: { free_space_on_disk?: number } };
type RawPreferences = {
    save_path?: string;
    /** "When Torrent Category changed": true relocates the torrent, false switches it to manual mode. */
    torrent_changed_tmm_enabled?: boolean;
    /** "Keep incomplete torrents in". */
    temp_path_enabled?: boolean;
    temp_path?: string;
    /** "Do not start the download automatically". */
    add_stopped_enabled?: boolean;
    torrent_stop_condition?: string;
    share_limits_mode?: string;
    max_inactive_seeding_time_enabled?: boolean;
    max_inactive_seeding_time?: number;
    max_ratio_enabled?: boolean;
    max_ratio?: number;
    max_seeding_time_enabled?: boolean;
    /** Minutes. */
    max_seeding_time?: number;
    max_ratio_act?: number;
};

/** `ShareLimitAction` in 5.x, `MaxRatioAction` in 4.x: same numbers. */
const SHARE_LIMIT_ACTION: Record<number, ClientSeedLimits['action']> = {
    0: 'stop',
    1: 'remove',
    2: 'super seeding',
    3: 'remove with content'
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * A magnet's `btih` is 40 hex characters or, per BEP 9, 32 base32 ones.
 * `torrents/info?hashes=` takes hex only, so a base32 hash never matches and
 * the duplicate check silently passes. A 32-character value with a character
 * outside the base32 alphabet is left as given.
 */
export function btihToHex(btih: string): string {
    const lower = btih.toLowerCase();
    if (lower.length !== 32 || [...lower].some(c => !BASE32.includes(c))) return lower;
    const bits = [...lower].map(c => BASE32.indexOf(c).toString(2).padStart(5, '0')).join('');
    return Array.from({ length: 40 }, (_, i) => parseInt(bits.slice(i * 4, i * 4 + 4), 2).toString(16)).join('');
}

/** qBittorrent's own state vocabulary, mapped onto readable words. 5.0 renamed
 *  the paused states to stopped; both spellings are kept so one adapter serves
 *  4.x and 5.x. */
const TORRENT_STATE: Record<string, string> = {
    error: 'error',
    missingFiles: 'missing files',
    uploading: 'seeding',
    forcedUP: 'seeding',
    stalledUP: 'seeding (no peers)',
    pausedUP: 'stopped',
    stoppedUP: 'stopped',
    queuedUP: 'queued to seed',
    checkingUP: 'verifying',
    downloading: 'downloading',
    forcedDL: 'downloading',
    metaDL: 'fetching metadata',
    forcedMetaDL: 'fetching metadata',
    stalledDL: 'stalled',
    pausedDL: 'stopped',
    stoppedDL: 'stopped',
    queuedDL: 'queued',
    checkingDL: 'verifying',
    checkingResumeData: 'verifying',
    allocating: 'allocating',
    moving: 'moving'
};

/** qBittorrent reports this (100 days) rather than a null when it cannot
 *  estimate, so passing it through would promise a finish date it never made. */
const ETA_UNKNOWN = 8_640_000;

const DEFAULT_LIMIT = -2;

/** Mirrors `SessionImpl::processTorrentShareLimits`: ratio first, then
 *  seeding time in whole minutes. */
function seedingOf(t: RawTorrent): { seeding?: SeedingState } {
    if (t.amount_left !== 0) return {};

    const ratio = t.ratio === -1 ? Infinity : t.ratio;
    const ratioLimit = t.max_ratio !== undefined && t.max_ratio >= 0 ? t.max_ratio : undefined;
    const minutesLimit = t.max_seeding_time !== undefined && t.max_seeding_time >= 0 ? t.max_seeding_time : undefined;
    const overridden =
        (t.ratio_limit ?? DEFAULT_LIMIT) !== DEFAULT_LIMIT || (t.seeding_time_limit ?? DEFAULT_LIMIT) !== DEFAULT_LIMIT;

    const overRatio = ratioLimit !== undefined && ratio !== undefined && ratio >= ratioLimit;
    const overTime =
        minutesLimit !== undefined && t.seeding_time !== undefined && Math.floor(t.seeding_time / 60) >= minutesLimit;

    return {
        seeding: {
            ...(ratio === undefined || ratio === Infinity ? {} : { ratio }),
            ...(t.seeding_time === undefined ? {} : { seedingSeconds: t.seeding_time }),
            ...(ratioLimit === undefined ? {} : { ratioLimit }),
            ...(minutesLimit === undefined ? {} : { seedingLimitSeconds: minutesLimit * 60 }),
            ...(overridden ? { ownLimit: true as const } : {}),
            ...(overRatio || overTime ? { overLimit: true as const } : {}),
            ...(t.state === 'forcedUP' ? { forced: true as const } : {})
        }
    };
}

const STOPPED = new Set(['pausedUP', 'stoppedUP', 'pausedDL', 'stoppedDL']);

/** qBittorrent sends tags as one comma-separated string. */
const tagsOf = (t: RawTorrent): string[] => (t.tags ?? '').split(',').map(s => s.trim()).filter(s => s !== '');

const isMarked = (t: RawTorrent): boolean => tagsOf(t).includes(PAUSE_MARK);

/** `TrackerEndpointState` in 5.3. 3 is the "updating" of older builds, which 5.3 reports as its own flag. */
const TRACKER_STATUS: Record<number, string> = {
    0: 'disabled',
    1: 'not contacted',
    2: 'working',
    3: 'updating',
    4: 'not working',
    5: 'tracker error',
    6: 'unreachable'
};

/**
 * A stopped magnet has no metadata either, which only `has_metadata` says. A
 * build too old to send it (4.x) still has the states, and reports no size for
 * a torrent whose metadata never arrived.
 */
const hasMetadataOf = (t: RawTorrent): boolean => {
    if (t.state === 'metaDL' || t.state === 'forcedMetaDL') return false;
    if (t.has_metadata !== undefined) return t.has_metadata;
    return t.size === undefined || t.size > 0;
};

/** `max_ratio_act` as the action names categories and torrents use. Unknown counts as removing: the guard fails closed. */
const SHARE_ACTION_NAME: Record<number, string> = { 0: 'Stop', 1: 'Remove', 2: 'EnableSuperSeeding', 3: 'RemoveWithContent' };

const shareRuleOf = (raw: { share_limit_action?: string; share_limits_mode?: string; ratio_limit?: number; seeding_time_limit?: number; inactive_seeding_time_limit?: number }): TorrentShareRule => ({
    action: raw.share_limit_action ?? 'Default',
    mode: raw.share_limits_mode ?? 'Default',
    ratio: raw.ratio_limit ?? -2,
    seedingMinutes: raw.seeding_time_limit ?? -2,
    inactiveMinutes: raw.inactive_seeding_time_limit ?? -2
});

/** qBittorrent's ceiling, which it reports as -1 once a ratio reaches it. */
const MAX_RATIO = 9999;

const shownRatio = (ratio: number | undefined): number | undefined => (ratio === undefined ? undefined : ratio < 0 ? MAX_RATIO : ratio);

/**
 * `null` until a torrent has metadata. `is_private` is the deprecated spelling
 * and reads false while nobody can know yet, so it answers only where `private`
 * is absent altogether, on a build too old to have it.
 */
const privateOf = (info: RawTorrent, props: RawProperties | undefined): boolean | null => {
    if (!hasMetadataOf(info)) return null;
    if (typeof info.private === 'boolean' || info.private === null) return info.private;
    if (props === undefined) return null;
    return props.private !== undefined ? props.private : (props.is_private ?? null);
};

const trackerRows = (rows: readonly RawTracker[]): TorrentTrackerRow[] =>
    rows.flatMap(row => {
        const host = trackerHost(row.url ?? '');
        if (host === undefined) return [];
        return [{ host, status: row.updating === true ? 'updating' : (TRACKER_STATUS[row.status ?? -1] ?? 'unknown') }];
    });

/** Only the active tracker: torrents/info carries one. Cleanuparr checks every tracker. */
function torrentOf(t: RawTorrent & { hash: string }): { torrent: TorrentFacts } {
    const host = t.tracker ? trackerHost(t.tracker) : undefined;
    const trackerDomains = host === undefined ? [] : [host];
    return {
        torrent: {
            hash: t.hash.toLowerCase(),
            category: t.category ?? '',
            // The pause mark is this server's bookkeeping; the status already says stopped.
            tags: tagsOf(t).filter(tag => tag !== PAUSE_MARK),
            trackerDomains,
            ...(t.save_path ? { savePath: t.save_path } : {}),
            ...(typeof t.private === 'boolean' ? { private: t.private } : {}),
            stopped: STOPPED.has(t.state ?? ''),
            seeding: t.amount_left === 0
        }
    };
}

/**
 * Whether `torrents/add` took the torrent. Up to 5.1 it answers 200 with
 * `Ok.` or `Fails.`, so the status line says nothing; later builds answer
 * empty or with JSON counts.
 */
function addAccepted(body: string): boolean {
    if (body === '' || body === 'Ok.') return true;
    try {
        const counts = JSON.parse(body) as { success_count?: unknown; pending_count?: unknown; failure_count?: unknown };
        if (typeof counts !== 'object' || counts === null) return false;
        const n = (v: unknown) => (typeof v === 'number' ? v : 0);
        return n(counts.success_count) + n(counts.pending_count) > 0 || n(counts.failure_count) === 0;
    } catch {
        return false;
    }
}

/** Only 5.2 and later say; an older build's `Ok.` promises nothing either way. */
function stillPending(body: string): boolean {
    try {
        const counts = JSON.parse(body) as { pending_count?: unknown };
        return typeof counts.pending_count === 'number' && counts.pending_count > 0;
    } catch {
        return false;
    }
}

export class QbittorrentAdapter
    implements
        ServiceAdapter,
        DiskSpaceCapable,
        QueueCapable,
        QueueRemoveCapable,
        PauseCapable,
        SpeedLimitCapable,
        MagnetAddCapable,
        SeedLimitsCapable,
        TorrentEndpoint,
        TorrentManageCapable
{
    readonly type: ServiceId = 'qbittorrent';
    readonly endpoint: string;
    readonly instance: string | undefined;
    readonly id: string;
    readonly allowedPaths: readonly string[];
    readonly deleteProtection: { readonly private: boolean; readonly all: boolean };
    readonly #http: ServiceHttp;
    /** Shared by the disk check and the seed limits of one get_stack_health pass; this adapter never writes preferences. */
    readonly #preferences = cached(SHORT_READ_TTL_MS, () => this.#http.get<RawPreferences>(`${API}/app/preferences`));

    constructor(config: ConfigByService['qbittorrent'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.endpoint = hostPort(config.url) ?? config.url;
        this.id = instanceId('qbittorrent', config.name);
        this.allowedPaths = config.allowed_paths ?? DEFAULT_TORRENT_PATHS;
        this.deleteProtection = { private: config.protect_private_torrents === true, all: config.protect_all_torrents === true };
        this.#http = new ServiceHttp(
            this.id,
            config,
            qbittorrentSession({
                id: this.id,
                url: config.url,
                timeoutMs: config.timeout_ms,
                ...(config.username === undefined ? {} : { username: config.username }),
                ...(config.password === undefined ? {} : { password: config.password }),
                ...(config.webui_api_key === undefined ? {} : { apiKey: config.webui_api_key }),
                ...(fetchImpl === fetch ? {} : { fetchImpl })
            }),
            fetchImpl
        );
    }

    /** Answered as a bare `v5.0.4`, not JSON. */
    async getVersion(): Promise<string> {
        const version = await this.#http.getText(`${API}/app/version`);
        if (version === '') {
            throw new ServiceError('UpstreamError', this.id, 'app/version returned an empty body');
        }
        return version;
    }

    /**
     * Free space lives only in `sync/maindata`; the path it refers to lives only
     * in `app/preferences`. Reporting free bytes without saying which disk is
     * what makes a two-disk stack unreadable, so this pays for both.
     */
    async getDiskSpace(): Promise<DiskSpace[]> {
        const [main, prefs] = await Promise.all([
            this.#http.get<RawMainData>(`${API}/sync/maindata`),
            this.#preferences()
        ]);

        const free = main.server_state?.free_space_on_disk;
        if (typeof free !== 'number') return [];

        return [
            {
                service: this.id,
                path: prefs.save_path ?? 'save_path',
                label: 'qBittorrent save path',
                freeSpace: free
                // No totalSpace: qBittorrent reports free space only.
            }
        ];
    }

    async getQueue(): Promise<QueueItem[]> {
        const torrents = await this.#http.get<RawTorrent[]>(`${API}/torrents/info`);

        return (Array.isArray(torrents) ? torrents : [])
            .filter((t): t is RawTorrent & { hash: string } => typeof t.hash === 'string' && t.hash !== '')
            .map(t => ({
                service: this.id,
                id: t.hash,
                title: fenceText(scrubUrls(t.name ?? ''), { service: this.id, field: 'name' }),
                status: TORRENT_STATE[t.state ?? ''] ?? 'unknown',
                protocol: 'torrent',
                ...(t.size === undefined ? {} : { sizeBytes: t.size }),
                ...(t.amount_left === undefined ? {} : { remainingBytes: t.amount_left }),
                ...(t.eta === undefined || t.eta <= 0 || t.eta >= ETA_UNKNOWN ? {} : { etaSeconds: t.eta }),
                ...(typeof t.private === 'boolean' ? { private: t.private } : {}),
                ...seedingOf(t),
                ...torrentOf(t)
            }));
    }

    /** Global defaults only. Per-category limits (5.2+) show up per torrent
     *  in `getQueue`, as its effective limit. */
    async getSeedLimits(): Promise<ClientSeedLimits> {
        const prefs = await this.#preferences();
        const ratio = prefs.max_ratio_enabled === true ? prefs.max_ratio : undefined;
        const minutes = prefs.max_seeding_time_enabled === true ? prefs.max_seeding_time : undefined;

        return {
            service: this.id,
            ...(ratio === undefined || ratio < 0 ? {} : { ratioLimit: ratio }),
            ...(minutes === undefined || minutes < 0 ? {} : { seedingLimitSeconds: minutes * 60 }),
            action: SHARE_LIMIT_ACTION[prefs.max_ratio_act ?? -1] ?? 'unknown'
        };
    }

    /** No blocklist of grabbed releases: that is an *arr concept. */
    readonly supportsBlocklist = false;

    /**
     * `deleteFiles` is the destructive half and maps to `removeFromClient`.
     *
     * The existence check is not redundant: `torrents/delete` answers 200 for a
     * hash it has never seen, so without it a typo'd id reports a successful
     * removal of nothing.
     */
    async removeQueueItem(id: string, opts: RemoveQueueOptions): Promise<void> {
        const hash = this.#hash(id);
        const existing = await this.#http.get<RawTorrent[]>(
            `${API}/torrents/info?hashes=${encodeURIComponent(hash)}`
        );
        if (!Array.isArray(existing) || existing.length === 0) {
            throw new ServiceError('NotFound', this.id, `no torrent with hash "${id}"`, {
                remedy: 'qBittorrent torrent ids are info hashes. Take one from get_queue.'
            });
        }

        await this.#http.postForm(
            `${API}/torrents/delete`,
            { hashes: hash, deleteFiles: String(opts.removeFromClient) },
            true
        );
    }

    /**
     * qBittorrent has no client-wide paused flag. A whole-client pause stops
     * the running torrents and tags them, and the client reads as paused while
     * any torrent carries the tag; stopped torrents without it were stopped by
     * something else and resume leaves them be. Both spellings of stopped
     * count, because 5.0 renamed the paused states and this adapter serves 4.x
     * and 5.x alike, exactly as `TORRENT_STATE` already does.
     *
     * **Spec-derived, like every pause path here.** There is no qBittorrent on
     * the stack these adapters were probed against, so nothing below was
     * confirmed against a live instance.
     */
    async readPauseState(id?: string): Promise<PauseState> {
        if (id !== undefined) {
            const [torrent] = await this.#torrents(id);
            if (torrent === undefined) throw this.#notFound(id);
            return { paused: PAUSED_STATES.has(torrent.state ?? ''), scope: `torrent ${id}` };
        }

        const torrents = await this.#tagged();
        const runningIds = torrents.filter(t => !PAUSED_STATES.has(t.state ?? '')).map(t => t.hash.toLowerCase());
        const markedIds = torrents.filter(isMarked).map(t => t.hash.toLowerCase());
        return {
            paused: markedIds.length > 0,
            scope: torrents.length === 1 ? '1 torrent' : `${torrents.length} torrents`,
            torrents: {
                running: runningIds.length,
                stopped: torrents.length - runningIds.length,
                marked: markedIds.length,
                mark: `tag ${PAUSE_MARK}`,
                runningIds,
                markedIds
            }
        };
    }

    async setPaused(paused: boolean, id?: string, only?: readonly string[]): Promise<string | void> {
        if (id !== undefined) {
            const [torrent] = await this.#torrents(id);
            if (torrent === undefined) throw this.#notFound(id);
            const hash = this.#hash(id);
            await this.#verb(paused, hash);
            // Started by hand, so a later whole-client resume has nothing to do for it.
            if (!paused && isMarked(torrent)) return this.#unmark(hash, 1);
            return;
        }

        const bound = only === undefined ? undefined : new Set(only);
        const torrents = (await this.#tagged()).filter(t => bound === undefined || bound.has(t.hash.toLowerCase()));
        if (paused) {
            const running = torrents.filter(t => !PAUSED_STATES.has(t.state ?? '')).map(t => t.hash);
            if (running.length === 0) return;
            // Tagged before they stop: a stop that fails half-way then leaves
            // running torrents tagged, which resume starts harmlessly, rather
            // than stopped ones resume does not know about.
            await this.#tag(true, running.join('|'));
            await this.#verb(true, running.join('|'));
            return;
        }

        const held = torrents.filter(isMarked).map(t => t.hash);
        if (held.length === 0) return;
        await this.#verb(false, held.join('|'));
        return this.#unmark(held.join('|'), held.length);
    }

    /** After a resume that landed: a tag left behind is reported, not thrown,
     *  since thrown it would read as nothing resumed. A later whole-client
     *  resume starts those torrents again, which are running anyway. */
    async #unmark(hashes: string, count: number): Promise<string | void> {
        try {
            await this.#tag(false, hashes);
        } catch (err) {
            logger.warn({ service: this.id, err }, `resumed, but could not remove the ${PAUSE_MARK} tag`);
            return `${count === 1 ? 'It keeps' : `${count} keep`} the tag ${PAUSE_MARK}, which could not be removed: ${err instanceof Error ? err.message : String(err)}`;
        }
        await this.#dropEmptyTag();
    }

    /**
     * `removeTags` leaves the tag itself in qBittorrent's tag list, where the
     * user sees it in the sidebar. Deleted only once no torrent carries it:
     * a pause running alongside may have tagged one since. Best effort, since
     * the resume it follows has already happened.
     */
    async #dropEmptyTag(): Promise<void> {
        try {
            // Rows filtered here too: a qBittorrent older than the `tag` filter ignores it.
            const still = await this.#http.get<RawTorrent[]>(`${API}/torrents/info?tag=${encodeURIComponent(PAUSE_MARK)}`);
            if (Array.isArray(still) && still.some(isMarked)) return;
            await this.#http.postForm(`${API}/torrents/deleteTags`, { tags: PAUSE_MARK }, true);
        } catch (err) {
            logger.warn({ service: this.id, err }, `could not delete the empty ${PAUSE_MARK} tag`);
        }
    }

    /**
     * v5 renamed `pause`/`resume` to `stop`/`start`. Both are attempted: the
     * new verb first, the old one only if that 404s, because this adapter has
     * no version gate and guessing wrong would silently do nothing. `hashes`
     * is never `all`: that would start torrents no pause stopped.
     */
    async #verb(paused: boolean, hashes: string): Promise<void> {
        const [modern, legacy] = paused ? ['stop', 'pause'] : ['start', 'resume'];
        try {
            await this.#http.postForm(`${API}/torrents/${modern}`, { hashes }, true);
        } catch (err) {
            if (!(err instanceof ServiceError) || err.kind !== 'NotFound') throw err;
            await this.#http.postForm(`${API}/torrents/${legacy}`, { hashes }, true);
        }
    }

    /** `addTags` creates the tag if it does not exist yet. */
    async #tag(mark: boolean, hashes: string): Promise<void> {
        try {
            await this.#http.postForm(`${API}/torrents/${mark ? 'addTags' : 'removeTags'}`, { hashes, tags: PAUSE_MARK }, true);
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'NotFound') throw this.#noTags();
            throw err;
        }
    }

    /** Every torrent, refused on a qBittorrent without tags (before 4.2, whose
     *  rows carry no `tags` field): a whole-client pause with nowhere to record
     *  what it stopped could not be undone exactly. */
    async #tagged(): Promise<(RawTorrent & { hash: string })[]> {
        const torrents = (await this.#torrents()).filter(
            (t): t is RawTorrent & { hash: string } => typeof t.hash === 'string' && t.hash !== ''
        );
        if (torrents.some(t => t.tags === undefined)) throw this.#noTags();
        return torrents;
    }

    #noTags(): ServiceError {
        return new ServiceError(
            'VersionUnsupported',
            this.id,
            'this qBittorrent has no torrent tags, so a whole-client pause could not record which torrents it stopped',
            { remedy: 'Pause or resume torrents one at a time with `id`, or upgrade to qBittorrent 4.2 or later.' }
        );
    }

    #notFound(id: string): ServiceError {
        return new ServiceError('NotFound', this.id, `no torrent with hash "${id}"`, {
            remedy: 'qBittorrent torrent ids are info hashes. Take one from get_queue.'
        });
    }

    /**
     * qBittorrent speaks **bytes per second** here, where this boundary
     * speaks KiB/s. `0` means unlimited, both ways.
     *
     * Spec-derived, like the pause paths above: there is no qBittorrent on
     * the stack these adapters were probed against.
     */
    async readSpeedLimit(): Promise<SpeedLimit> {
        const raw = await this.#http.getText(`${API}/transfer/downloadLimit`);
        const bytes = Number(raw.trim());
        if (!Number.isFinite(bytes) || bytes <= 0) return { service: this.id };
        return { service: this.id, kbps: Math.round(bytes / 1024) };
    }

    async setSpeedLimit(kbps: number | undefined): Promise<void> {
        const bytes = kbps === undefined || kbps <= 0 ? 0 : Math.round(kbps) * 1024;
        await this.#http.postForm(`${API}/transfer/setDownloadLimit`, { limit: String(bytes) }, true);
    }

    /**
     * qBittorrent takes the link as a form field and answers a bare `Ok.`
     * whether or not it already had the torrent, so a duplicate is checked
     * for beforehand rather than inferred from the response.
     *
     * Spec-derived, like the pause paths above.
     */
    async addMagnet(uri: string): Promise<MagnetAdded> {
        const btih = /xt=urn:btih:([0-9a-zA-Z]+)/.exec(uri)?.[1];
        const hash = btih === undefined ? undefined : btihToHex(btih);
        const existing =
            hash === undefined
                ? []
                : await this.#http.get<RawTorrent[]>(`${API}/torrents/info?hashes=${encodeURIComponent(hash)}`);

        const duplicate = Array.isArray(existing) && existing.length > 0;
        const answer = await this.#http.postFormText(`${API}/torrents/add`, { urls: uri });
        // A duplicate is already known, and older builds answer one with
        // `Fails.` too, so the body only decides a new torrent.
        if (!duplicate && !addAccepted(answer)) {
            throw new ServiceError(
                'UpstreamError',
                this.id,
                `qBittorrent did not add the torrent: it answered ${fenceText(answer, { service: this.id, field: 'add' })}`,
                { remedy: 'Check the magnet link, and that qBittorrent has finished starting up, then try again.' }
            );
        }

        return {
            ...(hash === undefined ? {} : { id: hash }),
            duplicate
        };
    }

    /**
     * One torrent as the write previews and `get_queue` show it. `torrents/info`
     * answers first and `torrents/properties` fills what it lacks, which on a
     * torrent at missingFiles can be the save path, the ratio and the seed time.
     */
    async getTorrentDetails(id: string): Promise<TorrentDetails> {
        const hash = this.#hash(id);
        // Only an empty list means no such torrent. The delete guard reads
        // NotFound as permission to go ahead, so a 404 from a proxy must not become one.
        const listed = (err: unknown): never => {
            if (err instanceof ServiceError && err.kind === 'NotFound') {
                throw new ServiceError('UpstreamError', this.id, 'qBittorrent could not be asked about this torrent');
            }
            throw err;
        };
        // `getArray`, because only a real empty list proves the torrent is absent.
        const [info] = await this.#http.getArray<RawTorrent>(`${API}/torrents/info?hashes=${hash}`).catch(listed);
        if (info === undefined) throw this.#notFound(id);

        const incomplete = info.save_path === undefined || typeof info.private !== 'boolean' || info.ratio === undefined || info.seeding_time === undefined;
        const props = incomplete
            ? await this.#http.get<RawProperties>(`${API}/torrents/properties?hash=${hash}`).catch((err: unknown) => {
                  logger.warn({ service: this.id, err }, 'could not read the torrent properties');
                  return undefined;
              })
            : undefined;
        const [files, trackers] = await Promise.all([
            this.#http.get<RawFile[]>(`${API}/torrents/files?hash=${hash}`),
            this.#http.get<RawTracker[]>(`${API}/torrents/trackers?hash=${hash}`)
        ]).catch(listed);

        const ratio = shownRatio(info.ratio ?? props?.share_ratio);
        const seedingSeconds = info.seeding_time ?? props?.seeding_time;
        const savePath = info.save_path ?? props?.save_path;
        const named = (Array.isArray(files) ? files : []).filter((f): f is RawFile & { name: string } => typeof f.name === 'string');
        return {
            id: hash,
            title: fenceText(scrubUrls(info.name ?? ''), { service: this.id, field: 'name' }),
            status: TORRENT_STATE[info.state ?? ''] ?? 'unknown',
            state: info.state ?? '',
            ...(savePath === undefined ? {} : { savePath }),
            ...(info.download_path === undefined || info.download_path === '' ? {} : { downloadPath: info.download_path }),
            ...(info.content_path === undefined || info.content_path === '' ? {} : { contentPath: info.content_path }),
            hasMetadata: hasMetadataOf(info),
            finishedOnce: (info.completion_on ?? 0) > 0,
            share: shareRuleOf(info),
            private: privateOf(info, props),
            ...(ratio === undefined ? {} : { ratio }),
            ...(seedingSeconds === undefined || seedingSeconds < 0 ? {} : { seedingSeconds }),
            category: info.category ?? '',
            autoManaged: info.auto_tmm === true,
            ...(info.amount_left === undefined ? {} : { remainingBytes: info.amount_left }),
            ...(info.completed === undefined ? {} : { completedBytes: info.completed }),
            ...(info.size === undefined ? {} : { sizeBytes: info.size }),
            ...(info.progress === undefined ? {} : { progress: info.progress }),
            fileNames: named.map(f => f.name),
            files: named.map(f => ({
                name: fenceText(f.name, { service: this.id, field: 'file' }),
                sizeBytes: f.size ?? 0,
                progress: f.progress ?? 0
            })),
            trackers: trackerRows(Array.isArray(trackers) ? trackers : [])
        };
    }

    async torrentCheckStates(ids: readonly string[]): Promise<TorrentCheckState[]> {
        const hashes = ids.map(id => this.#hash(id)).join('|');
        const rows = await this.#http.get<RawTorrent[]>(`${API}/torrents/info?hashes=${encodeURIComponent(hashes)}`);
        return (Array.isArray(rows) ? rows : []).flatMap(t => {
            if (typeof t.hash !== 'string') return [];
            const state = t.state ?? '';
            return [{
                id: t.hash.toLowerCase(),
                title: fenceText(scrubUrls(t.name ?? ''), { service: this.id, field: 'name' }),
                state,
                checking: CHECKING_STATES.has(state),
                complete: t.amount_left === 0 && t.progress === 1,
                stopped: PAUSED_STATES.has(state),
                hasMetadata: hasMetadataOf(t),
                ...(t.download_path === undefined || t.download_path === '' ? {} : { downloadPath: t.download_path }),
                ...(t.save_path === undefined || t.save_path === '' ? {} : { savePath: t.save_path }),
                ...(t.content_path === undefined || t.content_path === '' ? {} : { contentPath: t.content_path }),
                category: t.category ?? '',
                private: privateOf(t, undefined),
                share: shareRuleOf(t)
            }];
        });
    }

    async torrentFileNames(id: string): Promise<string[]> {
        const files = await this.#http.getArray<RawFile>(`${API}/torrents/files?hash=${this.#hash(id)}`);
        return files.flatMap(f => (typeof f.name === 'string' ? [f.name] : []));
    }

    async recheckTorrents(ids: readonly string[]): Promise<void> {
        await this.#http.postForm(`${API}/torrents/recheck`, { hashes: ids.map(id => this.#hash(id)).join('|') }, true);
    }

    async startTorrents(ids: readonly string[]): Promise<void> {
        await this.#verb(false, ids.map(id => this.#hash(id)).join('|'));
    }

    async torrentCategories(): Promise<Map<string, TorrentCategory>> {
        const raw = await this.#http.get<RawCategories>(`${API}/torrents/categories`);
        return new Map(
            Object.entries(raw ?? {}).map(([name, c]) => [
                name,
                {
                    savePath: c.savePath ?? '',
                    downloadPath: typeof c.download_path === 'string' ? c.download_path : c.download_path === false ? false : null,
                    share: shareRuleOf(c)
                }
            ])
        );
    }

    /** Read fresh, and what is missing counts against the write: these decide where data may move and whether it may be deleted. */
    async torrentClientDefaults(): Promise<TorrentClientDefaults> {
        const prefs = await this.#http.get<RawPreferences>(`${API}/app/preferences`);
        const limit = (enabled: boolean | undefined, value: number | undefined): number => (enabled === true ? (value ?? -1) : -1);
        return {
            incompleteEnabled: prefs.temp_path_enabled !== false,
            incompletePath: prefs.temp_path ?? '',
            addsStopped: prefs.add_stopped_enabled === true,
            stopCondition: prefs.torrent_stop_condition ?? 'None',
            share: {
                action: SHARE_ACTION_NAME[prefs.max_ratio_act ?? -1] ?? 'Remove',
                mode: prefs.share_limits_mode ?? 'Default',
                ratio: limit(prefs.max_ratio_enabled, prefs.max_ratio),
                seedingMinutes: limit(prefs.max_seeding_time_enabled, prefs.max_seeding_time),
                inactiveMinutes: limit(prefs.max_inactive_seeding_time_enabled, prefs.max_inactive_seeding_time)
            }
        };
    }

    async defaultSavePath(): Promise<string> {
        return this.#http.getText(`${API}/app/defaultSavePath`);
    }

    /** Read fresh: this decides whether a category change may move files. Unknown counts as moving. */
    async categoryChangeRelocates(): Promise<boolean> {
        const prefs = await this.#http.get<RawPreferences>(`${API}/app/preferences`);
        return prefs.torrent_changed_tmm_enabled !== false;
    }

    async hasTorrent(hash: string): Promise<boolean> {
        return (await this.#torrents(hash)).length > 0;
    }

    /**
     * Always sends a resolved save path with automatic management and the
     * incomplete-downloads folder off, so the torrent lands where the preview
     * said whatever the category's settings say. Never sends `urls` and a file
     * together. A refusal keeps its status and drops qBittorrent's words, which
     * can repeat the URL it was given, passkey included.
     */
    async addTorrent(source: TorrentSource, opts: { category?: string; savePath: string }): Promise<TorrentAdded> {
        const fields = { savepath: opts.savePath, autoTMM: 'false', useDownloadPath: 'false', ...(opts.category === undefined ? {} : { category: opts.category }) };
        const remedy = 'Check the source is a valid torrent and that qBittorrent can reach it, then try again.';
        let answer: string;
        try {
            if (source.kind === 'url') {
                answer = await this.#http.postFormText(`${API}/torrents/add`, { ...fields, urls: source.url });
            } else {
                const form = new FormData();
                for (const [key, value] of Object.entries(fields)) form.set(key, value);
                form.set('torrents', new Blob([new Uint8Array(source.bytes)], { type: 'application/x-bittorrent' }), source.filename);
                answer = await this.#http.postMultipartText(`${API}/torrents/add`, form);
            }
        } catch (err) {
            if (!(err instanceof ServiceError)) throw err;
            throw new ServiceError(err.kind, this.id, `qBittorrent did not add the torrent (HTTP ${err.status ?? 'error'})`, {
                remedy: err.kind === 'AuthFailed' && err.remedy !== undefined ? err.remedy : remedy,
                ...(err.status === undefined ? {} : { status: err.status })
            });
        }
        if (!addAccepted(answer)) throw new ServiceError('UpstreamError', this.id, 'qBittorrent did not add the torrent', { remedy });
        return { accepted: true, pending: stillPending(answer) };
    }

    async setTorrentLocation(id: string, location: string): Promise<void> {
        await this.#http.postForm(`${API}/torrents/setLocation`, { hashes: this.#hash(id), location }, true);
    }

    async renameTorrentFile(id: string, oldPath: string, newPath: string): Promise<void> {
        await this.#http.postForm(`${API}/torrents/renameFile`, { hash: this.#hash(id), oldPath, newPath }, true);
    }

    async setTorrentCategory(id: string, category: string): Promise<void> {
        await this.#http.postForm(`${API}/torrents/setCategory`, { hashes: this.#hash(id), category }, true);
    }

    async reannounceTorrent(id: string): Promise<void> {
        await this.#http.postForm(`${API}/torrents/reannounce`, { hashes: this.#hash(id) }, true);
    }

    /** `hashes` is `|`-separated with `all` as a keyword, so only one bare hash may reach it. */
    #hash(id: string): string {
        const hash = id.trim().toLowerCase();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
            // Not repeated: whatever was passed here may be a tracker URL with its passkey.
            throw new ServiceError('NotFound', this.id, 'that is not a torrent info hash', {
                remedy: 'qBittorrent torrent ids are 40 or 64 hex characters. Take one from get_queue.'
            });
        }
        return hash;
    }

    async #torrents(id?: string): Promise<RawTorrent[]> {
        const path =
            id === undefined
                ? `${API}/torrents/info`
                : `${API}/torrents/info?hashes=${encodeURIComponent(this.#hash(id))}`;
        const torrents = await this.#http.get<RawTorrent[]>(path);
        return Array.isArray(torrents) ? torrents : [];
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
