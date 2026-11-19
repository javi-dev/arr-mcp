import { ServiceError } from '../core/errors.ts';
import { hasTorrentManage, type QueueItem, type ServiceAdapter, type TorrentDetails, type TorrentManageCapable } from '../services/types.ts';

type Client = ServiceAdapter & TorrentManageCapable;

const TORRENT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const yesNo = (flag: boolean | null | undefined): string => (flag === true ? 'yes' : flag === false ? 'no' : 'unknown');

/** The line a person weighs before deleting a torrent. */
function factsLine(d: TorrentDetails): string {
    const trackers = d.trackers.map(t => `${t.host} (${t.status})`).join(', ');
    return (
        `Torrent facts: private ${yesNo(d.private)}, ratio ${d.ratio === undefined ? 'unknown' : d.ratio.toFixed(2)}, ` +
        `seeded ${d.seedingSeconds === undefined ? 'unknown' : `${(d.seedingSeconds / 86_400).toFixed(1)} days`}, ` +
        `tracker ${trackers === '' ? 'unknown' : trackers}.`
    );
}

/** Why `client` guards this torrent. An unknown private flag counts as private: the guard fails closed. */
export function protectionOf(client: Client, d: Pick<TorrentDetails, 'private'>): string | undefined {
    if (client.deleteProtection.all) return `${client.id} protects all of its torrents`;
    if (!client.deleteProtection.private) return undefined;
    if (d.private === true) return `${client.id} protects private torrents, and this one is private`;
    if (d.private === null) return `${client.id} protects private torrents, and this one's private flag is not known yet`;
    return undefined;
}

const isProtecting = (client: Client): boolean => client.deleteProtection.all || client.deleteProtection.private;

type TorrentDeleteCheck = {
    /** For the preview. */
    facts?: string;
    /** Why this delete needs `allow_protected`. */
    blockedBy?: string;
};

/**
 * What removing `item` would do to a torrent in qBittorrent. Removing an *arr's
 * row can delete the torrent as well, so an *arr row is traced to the instance
 * holding its download id: otherwise the guard would stop only the direct route.
 *
 * `deletes` is whether this removal reaches the torrent at all. A protected
 * instance that cannot be read blocks the delete, because a guard that opens
 * when its service is down protects nothing.
 */
export async function checkTorrentDelete(
    adapters: readonly ServiceAdapter[],
    adapter: ServiceAdapter,
    item: QueueItem,
    deletes: boolean
): Promise<TorrentDeleteCheck> {
    const direct = hasTorrentManage(adapter);
    const hash = direct ? item.id : item.downloadId;
    if (hash === undefined || !TORRENT_HASH.test(hash)) return {};

    // Every instance is asked, not the first that answers: a cross-seeded torrent
    // has one hash on two instances, and an *arr row does not say which it means.
    const clients = direct ? [adapter] : adapters.filter(hasTorrentManage);
    const guarded = direct || deletes;
    let facts: string | undefined;
    let blockedBy: string | undefined;
    for (const client of clients) {
        let details: TorrentDetails;
        try {
            details = await client.getTorrentDetails(hash);
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'NotFound') continue;
            facts ??= 'Torrent facts could not be read.';
            if (guarded && isProtecting(client)) blockedBy ??= `${client.id} protects torrents and could not be read to check this one`;
            continue;
        }
        if (facts === undefined || facts === 'Torrent facts could not be read.') facts = factsLine(details);
        if (guarded) blockedBy ??= protectionOf(client, details);
    }
    return { ...(facts === undefined ? {} : { facts }), ...(blockedBy === undefined ? {} : { blockedBy }) };
}
