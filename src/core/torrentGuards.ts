import { ServiceError } from './errors.ts';
import { shownValue } from './pastedUrl.ts';

/**
 * The path rules every torrent write goes through. Pure string checks: arr-mcp
 * cannot see qBittorrent's filesystem, so a symlink inside an allowed root is
 * outside what these can catch.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const refuse = (service: string, detail: string, remedy: string): ServiceError =>
    new ServiceError('NotFound', service, detail, { remedy });

/**
 * `path` as qBittorrent should receive it, or a refusal. Dot segments are
 * refused rather than resolved, because a path that needs resolving was not
 * written by someone who meant the place it resolves to.
 */
export function allowedPath(service: string, path: string, roots: readonly string[]): string {
    const allowed = `Allowed locations: ${roots.join(', ')}.`;
    // Before anything repeats it: a URL pasted as a path can carry a tracker passkey.
    if (shownValue(path) !== path) throw refuse(service, 'that path is a URL', allowed);
    if (path !== path.trim() || CONTROL.test(path) || path.includes('\\')) {
        throw refuse(service, 'that path has whitespace at its ends, a control character or a backslash', allowed);
    }
    if (!path.startsWith('/')) throw refuse(service, 'that path is not absolute', allowed);
    const parts = path.split('/').filter(part => part !== '');
    if (parts.some(part => part === '.' || part === '..')) throw refuse(service, 'that path contains . or .. segments', allowed);
    const normal = `/${parts.join('/')}`;
    if (!roots.some(root => normal === root || normal.startsWith(`${root}/`))) {
        throw refuse(service, `${normal} is outside the locations this instance allows`, `${allowed} Change allowed_paths in config.yaml to widen them.`);
    }
    return normal;
}

/**
 * The new name of a file inside its torrent, or a refusal. A torrent with a
 * root folder keeps every file under that folder, and one without keeps it at
 * the top level, so a rename can never leave the torrent's own directory.
 */
export function renamedPath(service: string, oldPath: string, newPath: string, existing: readonly string[]): string {
    const remedy = 'Take `old_path` from get_queue at `detail: "full"`, and give `new_path` relative to the torrent, keeping its folder.';
    if (!existing.includes(oldPath)) throw refuse(service, 'that torrent has no such file', remedy);
    const parts = newPath.split('/');
    if (CONTROL.test(newPath) || newPath.includes('\\') || parts.some(part => part === '' || part === '.' || part === '..')) {
        throw refuse(service, '`new_path` must be a relative path with no empty, . or .. segments and no backslash', remedy);
    }
    const root = oldPath.includes('/') ? oldPath.slice(0, oldPath.indexOf('/')) : undefined;
    const inside = root === undefined ? parts.length === 1 : parts.length > 1 && parts[0] === root;
    if (!inside) throw refuse(service, '`new_path` would leave the torrent\'s folder', remedy);
    if (newPath !== oldPath && existing.includes(newPath)) throw refuse(service, 'another file in that torrent already has that name', remedy);
    return newPath;
}

/** A long run of hex, or of letters and digits, is a passkey rather than a host name. */
const PASSKEY_LABEL = /^(?:[0-9a-f]{16,}|[0-9a-z]{28,})$/i;

/**
 * The host of a tracker URL, and nothing else from it: a tracker URL carries
 * the user's passkey in its path, query or userinfo. A host label that looks
 * like a passkey is masked. Undefined for qBittorrent's `** [DHT] **` rows and
 * for anything that does not parse.
 */
export function trackerHost(url: string): string | undefined {
    if (!URL.canParse(url)) return undefined;
    const host = new URL(url).hostname.toLowerCase();
    if (host === '') return undefined;
    return host.split('.').map(label => (PASSKEY_LABEL.test(label) ? '***' : label)).join('.');
}

/**
 * A URL a download client will be told to fetch: http or https, with no
 * credentials and no whitespace (qBittorrent splits `urls` on newlines and
 * fetches every part). Answers with the host alone, masked like a tracker's.
 * Refusals never repeat the value, which can hold a passkey.
 */
export function downloadHost(service: string, raw: string): string {
    const remedy = 'Give the full http or https address of the file, without a user name or password in it.';
    if (raw.length > 4096 || /\s/.test(raw) || CONTROL.test(raw) || !URL.canParse(raw)) throw refuse(service, 'that is not a usable download URL', remedy);
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse(service, 'only http and https download URLs are accepted', remedy);
    if (url.username !== '' || url.password !== '') throw refuse(service, 'a download URL with credentials in it is refused', remedy);
    return trackerHost(raw) ?? url.hostname;
}
