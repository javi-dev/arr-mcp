import { fenceText } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import { TIMED_OUT, withTimeout } from '../core/timeout.ts';
import { hasDownloadClientList, type ArrDownloadClient, type ServiceAdapter } from '../services/types.ts';
import { CROSS_CHECK_BUDGET_MS } from './crossChecks.ts';

/**
 * A preview's warning that an *arr watches the category a download is going
 * into, so it may import or remove what lands there. Advice only: a slow or
 * failing *arr costs one line saying it could not be checked, never the write.
 */
export async function categoryWatchers(
    adapters: readonly ServiceAdapter[],
    implementation: 'QBittorrent' | 'Sabnzbd',
    category: string | undefined
): Promise<string[]> {
    if (category === undefined || category === '') return [];
    const lines = await Promise.all(
        adapters.filter(hasDownloadClientList).map(async arr => {
            const read = arr.getDownloadClients().catch((err: unknown) => {
                logger.warn({ service: arr.id, err }, 'could not read the download clients to check a category');
                return undefined;
            });
            const clients: ArrDownloadClient[] | undefined | typeof TIMED_OUT = await withTimeout(read, CROSS_CHECK_BUDGET_MS);
            if (clients === undefined || clients === TIMED_OUT) return [`Could not check whether ${arr.id} watches category "${category}".`];
            return clients
                .filter(c => c.enabled && c.implementation.toLowerCase() === implementation.toLowerCase() && c.categories.includes(category))
                .map(c => `Warning: ${arr.id} watches category "${category}" through its download client ${fenceText(c.name, { service: arr.id, field: 'name' })}, so it may import, rename or remove what lands there.`);
        })
    );
    return lines.flat();
}
