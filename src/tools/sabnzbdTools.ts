import { createHash } from 'node:crypto';
import { constants, gunzipSync } from 'node:zlib';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { READ_ONLY, toolInput } from '../core/shape.ts';
import { downloadHost } from '../core/torrentGuards.ts';
import { hasNzbAdd, type NzbAddCapable, type NzbSource, type SabClientSettings, type SabClientSettingsRead, type SabSettingChange, type ServiceAdapter } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import { categoryWatchers } from './watchedCategory.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * SABnzbd's routine chores. `update_client_settings` reaches a fixed list of
 * `misc` keywords and nothing else: servers, credentials and API keys are not
 * representable in its input, and no response it reads can contain them.
 */

type Client = ServiceAdapter & NzbAddCapable;

const clientOf = (adapters: readonly ServiceAdapter[], instance: string | undefined): Client => {
    const adapter = resolveInstance(adapters, 'sabnzbd', instance);
    if (!hasNzbAdd(adapter)) throw new ServiceError('InvalidRequest', adapter.id, `${adapter.id} cannot take an NZB`);
    return adapter;
};

const instanceField = z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION);

/** What still fits the server's 4 MiB request limit once base64 encoded. */
const MAX_NZB_BYTES = 3_000_000;

/** 3 MB of file, base64 encoded, which leaves the request inside that limit. */
export const MAX_NZB_BASE64 = 4_000_000;

/** Enough of a file to find the root element. */
const NZB_SNIFF_BYTES = 64 * 1024;

/** Only the start of a gzip is inflated, and its output is capped, so a gzip bomb stops here. */
const GZIP_SNIFF_INPUT = 16 * 1024;
const GZIP_SNIFF_OUTPUT = 32 * 1024 * 1024;

const looksLikeNzb = (bytes: Buffer): boolean => {
    let head = bytes.subarray(0, NZB_SNIFF_BYTES);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        try {
            head = gunzipSync(bytes.subarray(0, GZIP_SNIFF_INPUT), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: GZIP_SNIFF_OUTPUT }).subarray(0, NZB_SNIFF_BYTES);
        } catch {
            return false;
        }
    }
    return /<nzb[\s>]/i.test(head.toString('utf8'));
};

type AddSource = { request: NzbSource; digest: string; label: string };

function nzbSource(service: string, args: { url?: string | undefined; nzb_base64?: string | undefined; filename?: string | undefined }): AddSource {
    if ((args.url === undefined) === (args.nzb_base64 === undefined)) {
        throw new ServiceError('InvalidRequest', service, 'pass exactly one of `url` or `nzb_base64`', { remedy: 'Each is a different way to name the NZB to add.' });
    }
    if (args.url !== undefined) {
        const host = downloadHost(service, args.url);
        return { request: { kind: 'url', url: args.url }, digest: createHash('sha256').update(args.url).digest('hex'), label: `the NZB at ${host}` };
    }
    const encoded = args.nzb_base64 ?? '';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new ServiceError('InvalidRequest', service, '`nzb_base64` is not valid base64', { remedy: 'Send the whole .nzb file, base64 encoded.' });
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_NZB_BYTES) throw new ServiceError('InvalidRequest', service, 'that NZB is larger than the 3 MB limit', { remedy: 'Pass its `url` instead.' });
    if (!looksLikeNzb(bytes)) throw new ServiceError('InvalidRequest', service, 'that file is not an NZB', { remedy: 'Send a .nzb or .nzb.gz file, base64 encoded.' });
    const filename = args.filename ?? 'upload.nzb';
    if (!/^[\w .()[\]-]{1,200}\.nzb(?:\.gz)?$/i.test(filename)) {
        throw new ServiceError('InvalidRequest', service, '`filename` must be a plain file name ending in .nzb or .nzb.gz');
    }
    return {
        request: { kind: 'file', bytes, filename },
        digest: createHash('sha256').update(bytes).digest('hex'),
        label: `the uploaded NZB ${fenceText(filename, { service, field: 'filename' })}`
    };
}

const AddNzbInput = z.object({
    instance: instanceField,
    url: z.string().min(1).optional().describe('An http or https URL of an NZB.'),
    nzb_base64: z.string().min(1).max(MAX_NZB_BASE64).optional().describe('The contents of a .nzb or .nzb.gz file, base64 encoded, up to 3 MB.'),
    filename: z.string().min(1).optional().describe('The name of the uploaded file, ending in .nzb or .nzb.gz.'),
    category: z.string().min(1).optional().describe('An existing SABnzbd category.')
});

const RETENTION_OPTIONS = ['all', 'number-archive', 'number-delete', 'days-archive', 'days-delete', 'all-archive', 'all-delete'] as const;

const extensionList = z
    .array(z.string().regex(/^\.?[A-Za-z0-9]{1,16}$/, 'must be a file extension such as exe'))
    .max(200)
    .transform(list => [...new Set(list.map(e => e.replace(/^\./, '').toLowerCase()))]);

/** What SABnzbd stores for a cleanup entry: lower case, and an entry with no folder loses its outer dots. */
const storedCleanupEntry = (entry: string): string => {
    const lower = entry.toLowerCase();
    return lower.includes('/') ? lower : lower.replace(/^\.+|\.+$/g, '');
};

const cleanupList = z
    .array(
        z
            .string()
            .regex(/^[A-Za-z0-9._*?/-]{1,128}$/, 'must be an extension, file name or pattern such as nfo or *.tmp')
            .refine(entry => !entry.split('/').includes('..'), { message: 'must not contain ..' })
            .refine(entry => storedCleanupEntry(entry) !== '', { message: 'must name an extension, file name or pattern' })
    )
    .max(200)
    .transform(list => [...new Set(list.map(storedCleanupEntry))]);

const SettingsShape = {
    fail_hopeless_jobs: z.boolean().optional().describe('Abort a job once too much of it is missing to complete.'),
    unwanted_extensions: extensionList.optional().describe('The file extensions SABnzbd treats as unwanted.'),
    action_on_unwanted_extensions: z.enum(['off', 'pause', 'abort']).optional().describe('What SABnzbd does with a job holding an unwanted extension.'),
    cleanup_list: cleanupList.optional().describe('Extensions, file names or patterns deleted after a download completes.'),
    history_retention_option: z.enum(RETENTION_OPTIONS).optional().describe('How completed and failed jobs leave the history.'),
    history_retention_number: z.number().int().min(1).max(36_500).optional().describe('The job count or days the retention option counts.')
};

const UpdateSettingsInput = z.object({ instance: instanceField, ...SettingsShape });

const SETTING_NAMES = Object.keys(SettingsShape) as (keyof SabClientSettings)[];

const shown = (value: unknown): string => (Array.isArray(value) ? (value.length === 0 ? '(empty)' : value.join(', ')) : value === null ? 'unset' : String(value));

const same = (a: unknown, b: unknown): boolean => shown(a) === shown(b);

/** What the list means, which the mode decides and this tool cannot change. */
const unwantedMeaning = (mode: SabClientSettingsRead['unwanted_extensions_mode']): string => {
    if (mode === 'whitelist') return 'SABnzbd is in whitelist mode: only these extensions are allowed, and everything else counts as unwanted.';
    if (mode === 'blacklist') return 'SABnzbd is in blacklist mode: these extensions count as unwanted.';
    return 'SABnzbd did not say whether this list blocks these extensions or allows only these.';
};

const SettingsOutput = z.looseObject({ service: z.string(), settings: z.looseObject({}) });

export function registerSabnzbdTools(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'add_nzb',
        title: 'Add an NZB',
        description:
            'Adds an NZB to SABnzbd from a `url` or the file itself as `nzb_base64`, into an existing `category`. The preview warns when an *arr watches that category. Safe tier: undo with remove_queue_item. Previews first; the confirm token is bound to that exact source. Field reference: arr://docs/add_nzb.',
        inputSchema: AddNzbInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'add_nzb',
        tier: 'safe',

        async plan(args): Promise<WritePlan> {
            const client = clientOf(adapters, args.instance);
            const source = nzbSource(client.id, args);
            if (args.category !== undefined) {
                const categories = await client.nzbCategories();
                if (!categories.includes(args.category)) {
                    // Not repeated: what was passed here may be a tracker URL with its passkey.
                    throw new ServiceError('NotFound', client.id, `${client.id} has no such category`, {
                        remedy: `Its categories: ${categories.join(', ') || 'none'}.`
                    });
                }
            }
            return {
                target: `${client.id}:nzb-${source.digest.slice(0, 12)}`,
                summary: `Add ${source.label} to ${client.id}${args.category === undefined ? '' : ` in category "${args.category}"`}.`,
                effects: [
                    ...(await categoryWatchers(adapters, 'Sabnzbd', args.category)),
                    'Starts downloading it. Nothing vetted this NZB.',
                    'It appears in get_queue and can be removed again with remove_queue_item.'
                ],
                // A digest and never the source: this object is written to the audit log.
                args: { source_sha256: source.digest, category: args.category ?? '', filename: source.request.kind === 'file' ? source.request.filename : '' }
            };
        },

        async apply(plan, args) {
            const client = clientOf(adapters, args.instance);
            const added = await client.addNzb(nzbSource(client.id, args).request, args.category === undefined ? {} : { category: args.category });
            return { added: added.ids, target: plan.target };
        }
    });

    server.registerTool(
        'get_client_settings',
        {
            title: 'Download client settings',
            annotations: READ_ONLY,
            description:
                'The SABnzbd settings update_client_settings can change: aborting hopeless jobs, unwanted extensions and what happens to them, the cleanup list and history retention. Servers and credentials are never read. Field reference: arr://docs/get_client_settings.',
            inputSchema: toolInput({ instance: instanceField }),
            outputSchema: SettingsOutput
        },
        async ({ instance }) => {
            const client = clientOf(adapters, instance);
            const settings = await client.getClientSettings();
            const lines = Object.entries(settings).map(([key, value]) => `${key}: ${shown(value)}`);
            return {
                content: [{ type: 'text', text: `${client.id} settings:\n${lines.join('\n')}` }],
                structuredContent: { service: client.id, settings }
            };
        }
    );

    registerWriteTool(server, context, {
        name: 'update_client_settings',
        title: 'Update download client settings',
        description:
            'Changes the SABnzbd settings get_client_settings lists, and only those: aborting hopeless jobs, unwanted extensions and the action on them, the cleanup list, and history retention. Destructive tier, because these decide which files and jobs SABnzbd deletes. The preview lists each old and new value. Previews first; confirm to apply. Field reference: arr://docs/update_client_settings.',
        inputSchema: UpdateSettingsInput,
        service: ({ instance }) => clientOf(adapters, instance).id,
        operation: 'update_client_settings',
        tier: 'destructive',

        async plan(args): Promise<WritePlan> {
            const client = clientOf(adapters, args.instance);
            const requested = Object.fromEntries(SETTING_NAMES.flatMap(name => (args[name] === undefined ? [] : [[name, args[name]]]))) as SabSettingChange;
            if (Object.keys(requested).length === 0) {
                throw new ServiceError('InvalidRequest', client.id, 'pass at least one setting to change', { remedy: 'get_client_settings lists them.' });
            }
            const current = await client.getClientSettings();
            const unsupported = Object.keys(requested).filter(name => current[name as keyof SabClientSettings] === null && name !== 'history_retention_number');
            if (unsupported.length > 0) {
                throw new ServiceError('VersionUnsupported', client.id, `this SABnzbd gave no readable value for ${unsupported.join(', ')}`, { remedy: 'These settings need SABnzbd 4.4 or later. If it is newer, get_client_settings shows what it answered.' });
            }

            const option = requested.history_retention_option ?? current.history_retention_option;
            const number = requested.history_retention_number ?? current.history_retention_number;
            if (option !== null && /^(?:number|days)-/.test(option) && (number === null || number < 1)) {
                throw new ServiceError('InvalidRequest', client.id, `history retention "${option}" needs \`history_retention_number\``);
            }

            const changes = Object.fromEntries(Object.entries(requested).filter(([name, value]) => !same(value, current[name as keyof SabClientSettings])));
            const target = `${client.id}:settings`;
            if (Object.keys(changes).length === 0) return { target, summary: `${client.id} already has those settings.`, effects: [], noop: true };
            const retentionChanges = 'history_retention_option' in changes || 'history_retention_number' in changes;
            const unwantedChanges = 'unwanted_extensions' in changes || 'action_on_unwanted_extensions' in changes;
            const unwanted = {
                extensions: requested.unwanted_extensions ?? current.unwanted_extensions,
                mode: current.unwanted_extensions_mode,
                action: requested.action_on_unwanted_extensions ?? current.action_on_unwanted_extensions
            };
            return {
                target,
                summary: `Change ${Object.keys(changes).length} setting(s) on ${client.id}.`,
                effects: [
                    ...Object.entries(changes).map(([name, value]) => `${name}: ${shown(current[name as keyof SabClientSettings])} becomes ${shown(value)}.`),
                    ...(unwantedChanges ? [unwantedMeaning(unwanted.mode), `Unwanted extensions afterwards: ${shown(unwanted.extensions)}, action ${shown(unwanted.action)}.`] : []),
                    ...(retentionChanges ? [`History retention afterwards: ${shown(option)}, counting ${shown(number)}.`] : [])
                ],
                // The retention in force, so a token cannot outlive a change to the half of it this call leaves alone.
                args: {
                    changes,
                    // What this replaces, so a token cannot overwrite an edit made since the preview.
                    replaces: Object.fromEntries(Object.keys(changes).map(name => [name, current[name as keyof SabClientSettings]])),
                    ...(retentionChanges ? { retention: { option, number } } : {}),
                    // All three, because each changes what the other two do.
                    ...(unwantedChanges ? { unwanted } : {})
                }
            };
        },

        async apply(plan, { instance }) {
            const changes = plan.args?.changes as SabSettingChange;
            await clientOf(adapters, instance).updateClientSettings(changes);
            return { changed: Object.keys(changes) };
        }
    });
}
