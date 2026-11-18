import { vi } from 'vitest';
import type * as z from 'zod/v4';
import { WriteAudit } from '../../src/core/audit.ts';
import { ConfirmTokens } from '../../src/core/confirm.ts';
import { permissionSourceFrom } from '../../src/core/permissions.ts';
import type { ServiceInstance } from '../../src/config/instances.ts';
import type { LibraryLoader } from '../../src/tools/library.ts';
import type { WriteContext, WriteToolResult } from '../../src/tools/write.ts';
import { jsonResponse, textResponse } from './serve.ts';

/**
 * A qBittorrent WebUI as far as the torrent tools reach it. Written from the
 * WebUI API source of release-5.3.0, not captured from a live server.
 */

export const HASH = 'a'.repeat(40);
export const OTHER = 'b'.repeat(40);
export const PASSKEY = 'd41d8cd98f00b204e9800998ecf8427e';

/** Bencodes a value, keeping insertion order so a test can hash the exact info bytes. */
export const bencode = (value: unknown): Buffer => {
    if (typeof value === 'number') return Buffer.from(`i${value}e`);
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
        const bytes = Buffer.from(value as string);
        return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
    }
    if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
    const entries = Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [bencode(k), bencode(v)]);
    return Buffer.concat([Buffer.from('d'), ...entries, Buffer.from('e')]);
};

export type RawTorrent = Record<string, unknown> & { hash: string };

export const torrent = (over: Partial<RawTorrent> = {}): RawTorrent => ({
    hash: HASH,
    name: 'Some.Film.2026-GROUP',
    state: 'stalledUP',
    save_path: '/data/torrents/movies',
    category: 'movies',
    auto_tmm: false,
    private: true,
    ratio: 1.5,
    seeding_time: 172_800,
    amount_left: 0,
    completed: 1000,
    size: 1000,
    progress: 1,
    ...over
});

export type FakeOptions = {
    torrents?: RawTorrent[];
    categories?: Record<string, { savePath?: string; download_path?: string | boolean | null; share_limit_action?: string }>;
    files?: unknown[];
    trackers?: unknown[];
    properties?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
    addAnswer?: string;
    /** The status of `torrents/add`: 5.3.0 answers 202 while a URL is pending and 409 on failure. */
    addStatus?: number;
    /** After a recheck, the state each read of the torrents shows in turn; the last one stays, and `null` removes them. */
    recheckStates?: (string | null)[];
    /** After a recheck, every read of the torrents fails. */
    recheckLosesSight?: boolean;
    /** Paths that answer 500. */
    failing?: string[];
};

export type Post = { path: string; form: Record<string, string>; multipart?: FormData };

export function fakeQbittorrent(opts: FakeOptions = {}) {
    const torrents = opts.torrents ?? [torrent()];
    const posts: Post[] = [];
    const seen: Headers[] = [];
    let script: (string | null)[] = [];
    let blind = false;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const path = url.pathname.replace('/api/v2', '');
        seen.push(new Headers(init?.headers));
        if (opts.failing?.includes(path) === true) return textResponse('broken', 500);
        if (init?.method === 'POST') {
            const body = init.body;
            posts.push(
                body instanceof FormData
                    ? { path, form: {}, multipart: body }
                    : { path, form: Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : '')) }
            );
            if (path === '/torrents/recheck') {
                script = [...(opts.recheckStates ?? [])];
                blind = opts.recheckLosesSight === true;
            }
            if (path === '/torrents/add') return textResponse(opts.addAnswer ?? JSON.stringify({ success_count: 1, failure_count: 0, pending_count: 0, added_torrent_ids: [HASH] }), opts.addStatus ?? 200);
            return textResponse('');
        }
        switch (path) {
            case '/torrents/info': {
                if (blind) return textResponse('broken', 500);
                const next = script.length > 1 ? script.shift() : script[0];
                if (next === null) torrents.length = 0;
                else if (next !== undefined) for (const t of torrents) t.state = next;
                const wanted = url.searchParams.get('hashes')?.split('|');
                return jsonResponse(wanted === undefined ? torrents : torrents.filter(t => wanted.includes(t.hash)));
            }
            case '/torrents/properties':
                return jsonResponse(opts.properties ?? {});
            case '/torrents/files':
                return jsonResponse(opts.files ?? [{ name: 'Some.Film/film.mkv', size: 1000, progress: 1 }]);
            case '/torrents/trackers':
                return jsonResponse(
                    opts.trackers ?? [
                        { url: '** [DHT] **', status: 2, msg: '' },
                        { url: `https://tracker.example.org:443/${PASSKEY}/announce`, status: 2, msg: `bad key ${PASSKEY}` }
                    ]
                );
            case '/torrents/categories':
                return jsonResponse(opts.categories ?? { movies: { savePath: '/data/torrents/movies' }, tv: { savePath: '' } });
            case '/app/defaultSavePath':
                return textResponse('/data/torrents');
            case '/app/preferences':
                // The defaults of a fresh qBittorrent 5.3.0 install.
                return jsonResponse(opts.preferences ?? { torrent_changed_tmm_enabled: true, category_changed_tmm_enabled: false, temp_path_enabled: false });
            default:
                return jsonResponse({ message: 'not found' }, 404);
        }
    }) as unknown as typeof fetch;
    return { impl, posts, torrents, seen };
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: WriteToolResult }>;

/** Registers tools on a stand-in server and calls them through their own input schemas. */
export function toolServer() {
    const tools = new Map<string, Handler>();
    const server = {
        registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: Handler) {
            tools.set(name, async args => handler(config.inputSchema.parse(args) as Record<string, unknown>));
        }
    };
    const call = (name: string, args: Record<string, unknown>) => {
        const tool = tools.get(name);
        if (tool === undefined) throw new Error(`${name} is not registered`);
        return tool(args);
    };
    return { server: server as never, call };
}

export function writeContext(instances: ServiceInstance[]): WriteContext & { audit: WriteAudit } {
    return {
        permissions: permissionSourceFrom(instances),
        confirm: new ConfirmTokens(),
        audit: WriteAudit.ephemeral(),
        library: { invalidate: vi.fn() } as unknown as LibraryLoader
    };
}

/** Previews, then confirms with the token the preview returned. */
export async function confirmed(call: ReturnType<typeof toolServer>['call'], name: string, args: Record<string, unknown>) {
    const preview = await call(name, args);
    return call(name, { ...args, confirm: preview.structuredContent.confirm_token });
}
