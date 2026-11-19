import { instancesOf } from './helpers/instances.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, ServiceId } from '../src/config/schema.ts';
import { BEARER_CALLER, WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom, type WriteTier } from '../src/core/permissions.ts';
import { cappedTo } from '../src/mcp/scopes.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { CrossChecker, CrossCheckProfile } from '../src/tools/crossChecks.ts';
import { rawTarget, registerWriteTool, type WritePlan, type WriteToolResult } from '../src/tools/write.ts';

/**
 * A stand-in for McpServer that keeps the one behaviour the harness depends on:
 * arguments are parsed against the declared schema — including its defaults —
 * before the handler sees them. A fake that skipped the parse would hide the
 * fact that `dry_run` gets its `false` from the schema.
 */
type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function fakeServer() {
    const tools = new Map<string, { schema: z.ZodObject; handler: Handler }>();
    const server = {
        registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: Handler) {
            tools.set(name, { schema: config.inputSchema, handler });
        }
    };

    const call = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
        const tool = tools.get(name);
        if (tool === undefined) throw new Error(`no such tool: ${name}`);
        return tool.handler(tool.schema.parse(args) as Record<string, unknown>, signal === undefined ? undefined : { mcpReq: { signal } });
    };

    return { server: server as never, call, tools };
}

const service = (safe_write: boolean, destructive: boolean): AnyServiceConfig =>
    ({
        url: 'http://192.0.2.10:7878',
        api_key: 'k',
        timeout_ms: 10_000,
        permissions: { safe_write, destructive }
    }) as AnyServiceConfig;

const PLAN: WritePlan = {
    target: '5',
    summary: 'Delete Alien (1979) from Radarr, deleting files from disk.',
    effects: ['Deletes 1 file totalling 24.1 GB from disk.', 'Removes the film from Radarr.'],
    args: { deleteFiles: true }
};

type Harness = ReturnType<typeof buildHarness>;

function buildHarness(
    opts: {
        permissions?: Partial<Record<ServiceId, AnyServiceConfig>>;
        plan?: WritePlan | ((args: { id: string }) => Promise<WritePlan>);
        route?: (args: { id: string }) => string;
        apply?: (plan: WritePlan, args: { id: string }) => Promise<unknown>;
        applied?: (outcome: unknown, plan: WritePlan) => string | undefined;
        tier?: 'safe' | 'destructive';
        caller?: string;
        crossChecks?: CrossChecker;
        crossCheck?: CrossCheckProfile;
        /** The tiers the presenting credential allows, as `/mcp` caps them. */
        ceiling?: WriteTier[];
    } = {}
) {
    const audit = WriteAudit.ephemeral();
    const confirm = new ConfirmTokens();
    const invalidate = vi.fn();
    const apply = vi.fn(opts.apply ?? (() => Promise.resolve({ ok: true })));
    const planned = opts.plan;
    const plan = vi.fn(typeof planned === 'function' ? planned : () => Promise.resolve(planned ?? PLAN));

    const { server, call } = fakeServer();
    registerWriteTool(
        server,
        {
            permissions: (() => {
                const source = permissionSourceFrom(instancesOf(opts.permissions ?? { radarr: service(false, true) }));
                return opts.ceiling === undefined
                    ? source
                    : cappedTo(source, new Set(opts.ceiling), () => ({ reason: 'this token is read-only', remedy: 'Use a write token.' }));
            })(),
            confirm,
            audit,
            library: { invalidate } as unknown as LibraryLoader,
            ...(opts.caller === undefined ? {} : { caller: opts.caller }),
            ...(opts.crossChecks === undefined ? {} : { crossChecks: opts.crossChecks })
        },
        {
            name: 'delete_media',
            title: 'Delete a film or series',
            description: 'Deletes a film.',
            inputSchema: z.object({ id: z.string() }),
            service: opts.route ?? 'radarr',
            operation: 'delete_movie',
            tier: opts.tier ?? 'destructive',
            plan,
            apply,
            ...(opts.applied === undefined ? {} : { applied: opts.applied }),
            ...(opts.crossCheck === undefined ? {} : { crossCheck: opts.crossCheck })
        }
    );

    return { audit, call, apply, plan, invalidate };
}

const outcomes = (h: Harness): string[] =>
    (h.audit.recent() as { outcome: string }[]).map(r => r.outcome).reverse();

let harness: Harness;
beforeEach(() => {
    harness = buildHarness();
});

describe('write tool harness — preview and confirm', () => {
    it('does not apply anything on the first call, and returns a token', async () => {
        const { structuredContent } = await harness.call('delete_media', { id: '5' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(harness.apply).not.toHaveBeenCalled();
    });

    it('applies once the token from that preview comes back', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        const second = await harness.call('delete_media', {
            id: '5',
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        expect(second.structuredContent.result).toEqual({ ok: true });
        expect(harness.apply).toHaveBeenCalledTimes(1);
    });

    it('tells the model exactly how to apply it', async () => {
        const { content } = await harness.call('delete_media', { id: '5' });
        expect(content[0]?.text).toContain('confirm');
        expect(content[0]?.text).toContain('delete_media');
    });

    // A client that forwards only `content` (Claude's remote MCP path, #234;
    // Hermes from 2026.9.7) never shows the model `structuredContent`, so the
    // token has to be readable in the text or the handshake cannot complete.
    it('puts the token itself in the text, not just a pointer to confirm_token', async () => {
        const { content, structuredContent } = await harness.call('delete_media', { id: '5' });
        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(content[0]?.text).toContain(structuredContent.confirm_token);
    });

    it('refuses to apply the same token twice', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        const token = first.structuredContent.confirm_token;

        await harness.call('delete_media', { id: '5', confirm: token });
        await expect(harness.call('delete_media', { id: '5', confirm: token })).rejects.toThrow(/already used/);
        expect(harness.apply).toHaveBeenCalledTimes(1);
    });

    // A rejected-but-not-spent token is a caller mistake with no risk of a
    // double-apply, so it degrades to a normal preview carrying the reason —
    // more useful than an error the model then has to work backwards from.
    it('returns a fresh preview, not an error, when the token is simply wrong', async () => {
        const { structuredContent } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_error).toBeTypeOf('string');
        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(harness.apply).not.toHaveBeenCalled();
    });

    it('puts the fresh token from a rejection in the text too', async () => {
        const { content, structuredContent } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        expect(content[0]?.text).toContain(structuredContent.confirm_token);
    });

    // Every failure that reissues carries a remedy telling the caller to call
    // again *without* `confirm`, which contradicts the usable token in the very
    // next sentence. A model that follows the remedy throws away a good token
    // and spends another preview. The diagnosis stays in `confirm_error`.
    // #312: the text said only "(foreign)", which is all a client that drops
    // structuredContent ever sees.
    it('says why the token was rejected in the text', async () => {
        const { content } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        expect(content[0]?.text).toContain('not a confirmation token issued by this server');
    });

    // Every rejection that reissues comes back as the fresh preview. A client
    // that drops structuredContent (#234) must still read it before the new
    // token, above all when what the write acts on has moved since the old one.
    it('puts the fresh preview\'s summary and effects in the text of a rejection', async () => {
        const { content } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        const text = content[0]?.text ?? '';

        expect(text).toContain(PLAN.summary);
        for (const effect of PLAN.effects) expect(text).toContain(`- ${effect}`);
        expect(text.indexOf(PLAN.effects[1] ?? '')).toBeLessThan(text.indexOf('Do not resend'));
    });

    it('leaves no empty list in a rejection whose preview has no effects', async () => {
        const bare = buildHarness({ plan: { ...PLAN, effects: [] } });
        const { content } = await bare.call('delete_media', { id: '5', confirm: 'nonsense' });

        expect(content[0]?.text).toContain(`${PLAN.summary}\n\nDo not resend the rejected one.`);
        expect(content[0]?.text).not.toContain('\n- ');
    });

    it('gives one next action on a rejection, not two', async () => {
        const { content, structuredContent } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        const text = content[0]?.text ?? '';

        expect(text).toContain(structuredContent.confirm_token);
        expect(text).not.toContain('without `confirm`');
        // #312: confirm_error said to call again without `confirm`, the text to
        // use the fresh token. Both now carry the reason alone.
        expect(structuredContent.confirm_error).toBe('That is not a confirmation token issued by this server.');
    });

    // The token is the last thing in both texts on purpose. A reader clipping
    // it out takes the trailing word or the final backticked span, and prose
    // after the token defeats both — `unwrap` strips punctuation, not a clause.
    it('ends both the preview and the rejection with the token itself', async () => {
        const ending = /`v2\.[\w.-]+`\.?$/u;

        const preview = await harness.call('delete_media', { id: '5' });
        expect(preview.content[0]?.text.trimEnd()).toMatch(ending);

        const rejected = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        expect(rejected.content[0]?.text.trimEnd()).toMatch(ending);
    });

    it('lets the fresh token from a rejection be used', async () => {
        const rejected = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        const applied = await harness.call('delete_media', {
            id: '5',
            confirm: rejected.structuredContent.confirm_token
        });
        expect(applied.structuredContent.applied).toBe(true);
    });
});

describe('write tool harness — dry_run', () => {
    it('describes the effect and changes nothing', async () => {
        const { structuredContent, content } = await harness.call('delete_media', { id: '5', dry_run: true });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.dry_run).toBe(true);
        expect(structuredContent.effects).toEqual(PLAN.effects);
        expect(content[0]?.text).toContain('nothing was changed');
        expect(harness.apply).not.toHaveBeenCalled();
    });

    // Issuing one would blur the two mechanisms: dry_run answers "what would
    // happen", the handshake is for when you mean to do it.
    it('issues no token, so a dry run cannot become a write', async () => {
        const { structuredContent } = await harness.call('delete_media', { id: '5', dry_run: true });
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    // Refusing it would withhold nothing — everything in a preview is already
    // reachable through the read tools — while making "what would I need to
    // enable?" unanswerable.
    it('still previews when the tier is off, and says the write would be refused', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });
        const { structuredContent, content } = await denied.call('delete_media', { id: '5', dry_run: true });

        expect(structuredContent.permission.allowed).toBe(false);
        expect(structuredContent.permission.remedy).toContain('permissions.destructive: true');
        expect(content[0]?.text).toContain('would currently be refused');
        expect(denied.plan).toHaveBeenCalledTimes(1);
    });
});

describe('write tool harness — permission tiers', () => {
    it('refuses a live write without resolving it first', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(/radarr:5/);
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(/destructive/);
        expect(denied.plan).not.toHaveBeenCalled();
        expect((denied.audit.recent() as { target: string }[])[0]?.target).toBe('5');
    });

    it('refuses a live write when the tier is off, before touching the service', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });

        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(ServiceError);
        expect(denied.apply).not.toHaveBeenCalled();
    });

    it('names the YAML key in the refusal', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(
            /services\.radarr\.permissions\.destructive: true/
        );
    });

    it('refuses before issuing a token, so a denial cannot be confirmed around', async () => {
        const denied = buildHarness({ permissions: { radarr: service(true, false) } });
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(ServiceError);
        expect(outcomes(denied)).toEqual(['denied']);
    });

    it('lets a safe-tier tool through on safe_write alone', async () => {
        const safe = buildHarness({ tier: 'safe', permissions: { radarr: service(true, false) } });
        const first = await safe.call('delete_media', { id: '5' });
        expect(first.structuredContent.confirm_token).toBeTypeOf('string');
    });
});

describe('write tool harness — no-op plans', () => {
    const noopPlan: WritePlan = {
        target: '5',
        summary: 'Alien (1979) is already unmonitored in Radarr.',
        effects: [],
        noop: true
    };

    it('short-circuits without asking for a confirmation nobody needs', async () => {
        const noop = buildHarness({ plan: noopPlan });
        const { structuredContent, content } = await noop.call('delete_media', { id: '5' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(content[0]?.text).toContain('Nothing to do');
        expect(noop.apply).not.toHaveBeenCalled();
    });
});

describe('write tool harness — the audit trail', () => {
    it('records a preview, then the write it turned into', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        await harness.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });

        expect(outcomes(harness)).toEqual(['unconfirmed', 'applied']);
    });

    it('records a dry run', async () => {
        await harness.call('delete_media', { id: '5', dry_run: true });
        expect(outcomes(harness)).toEqual(['dry_run']);
    });

    it('records a write the service refused, with the reason', async () => {
        const failing = buildHarness({
            apply: () => Promise.reject(new ServiceError('UpstreamError', 'radarr', 'HTTP 500 at /api/v3/movie/5'))
        });
        const first = await failing.call('delete_media', { id: '5' });

        await expect(
            failing.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token })
        ).rejects.toThrow(ServiceError);

        const rows = failing.audit.recent() as { outcome: string; detail: string | null }[];
        expect(rows[0]?.outcome).toBe('failed');
        expect(rows[0]?.detail).toContain('HTTP 500');
    });

    /**
     * Which credential asked. The context is rebuilt per request, so a request
     * that arrived on the static bearer token simply has no `caller` on it —
     * and that has to record as `bearer`, never as a blank. A blank means one
     * thing only: a row from before the column existed.
     */
    it('records the static bearer token under its own marker when no caller is set', async () => {
        await harness.call('delete_media', { id: '5', dry_run: true });
        expect((harness.audit.recent() as { caller: string | null }[])[0]?.caller).toBe(BEARER_CALLER);
    });

    it("records an OAuth request's client id", async () => {
        const oauth = buildHarness({ caller: 'oauth:desktop-client' });
        await oauth.call('delete_media', { id: '5', dry_run: true });
        expect((oauth.audit.recent() as { caller: string | null }[])[0]?.caller).toBe('oauth:desktop-client');
    });

    it('records a refusal thrown by the plan, with the argument as given', async () => {
        const refusing = buildHarness({
            plan: () => Promise.reject(new ServiceError('NotFound', 'radarr', 'no movie 5'))
        });
        await expect(refusing.call('delete_media', { id: '5' })).rejects.toThrow(/no movie 5/);

        const rows = refusing.audit.recent() as { outcome: string; target: string; service: string; detail: string | null }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ outcome: 'denied', target: '5', service: 'radarr' });
        expect(rows[0]?.detail).toContain('no movie 5');
    });

    it('records a plan refusal on a confirm call too', async () => {
        let refuse = false;
        const drifting = buildHarness({
            plan: () => (refuse ? Promise.reject(new ServiceError('NotFound', 'radarr', 'gone')) : Promise.resolve(PLAN))
        });
        const first = await drifting.call('delete_media', { id: '5' });
        refuse = true;
        await expect(
            drifting.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token })
        ).rejects.toThrow(/gone/);
        expect(outcomes(drifting)).toEqual(['unconfirmed', 'denied']);
    });

    it('records nothing for a dry run whose plan refuses', async () => {
        const refusing = buildHarness({
            plan: () => Promise.reject(new ServiceError('NotFound', 'radarr', 'no movie 5'))
        });
        await expect(refusing.call('delete_media', { id: '5', dry_run: true })).rejects.toThrow(/no movie 5/);
        expect(refusing.audit.recent()).toHaveLength(0);
    });

    it('records a refusal thrown while routing to an instance', async () => {
        const routing = buildHarness({
            route: () => {
                throw new ServiceError('NotFound', 'radarr', 'several radarr instances and none named');
            }
        });
        await expect(routing.call('delete_media', { id: '5' })).rejects.toThrow(/none named/);
        expect(routing.plan).not.toHaveBeenCalled();
        const rows = routing.audit.recent() as { outcome: string; target: string }[];
        expect(rows[0]).toMatchObject({ outcome: 'denied', target: '5' });
    });

    // A read token can never apply these, so a row per call would only let it
    // grow the permanent audit table as fast as it can ask.
    it('records nothing for a dry run the token could never apply', async () => {
        const readOnly = buildHarness({ ceiling: [] });
        const { structuredContent } = await readOnly.call('delete_media', { id: '5', dry_run: true });
        expect(structuredContent.permission.allowed).toBe(false);
        expect(structuredContent.audit_id).toBeUndefined();
        expect(readOnly.audit.recent()).toHaveLength(0);
    });

    it('records nothing for a no-op the token could never apply', async () => {
        const readOnly = buildHarness({ ceiling: [], plan: { ...PLAN, noop: true } });
        await readOnly.call('delete_media', { id: '5', dry_run: true });
        expect(readOnly.audit.recent()).toHaveLength(0);
    });

    it('records nothing for a dry run above the token that names an instance nobody configured', async () => {
        const audit = WriteAudit.ephemeral();
        const { server, call } = fakeServer();
        const permissions = cappedTo(permissionSourceFrom([]), new Set(), () => ({ reason: 'read-only', remedy: 'r' }));
        registerWriteTool(
            server,
            { permissions, confirm: new ConfirmTokens(), audit, library: { invalidate: vi.fn() } as unknown as LibraryLoader },
            {
                name: 'grab_release',
                title: 'Grab',
                description: 'Grabs.',
                inputSchema: z.object({ service: z.literal('radarr'), instance: z.string().optional() }),
                target: {
                    adapters: [],
                    to: { services: ['radarr'], can: (a): a is never => a !== undefined, cannot: 'cannot grab' }
                },
                operation: 'grab',
                tier: 'safe',
                plan: () => Promise.resolve(PLAN),
                apply: () => Promise.resolve({})
            }
        );
        await expect(call('grab_release', { service: 'radarr', instance: 'nope', dry_run: true })).rejects.toThrow();
        expect(audit.recent()).toHaveLength(0);
    });

    // As a dry run the plan or a `service` router refuses: nothing was asked for.
    it('records nothing for any dry run refused while routing to an instance, and a row for a live one', async () => {
        const audit = WriteAudit.ephemeral();
        const { server, call } = fakeServer();
        registerWriteTool(
            server,
            { permissions: permissionSourceFrom([]), confirm: new ConfirmTokens(), audit, library: { invalidate: vi.fn() } as unknown as LibraryLoader },
            {
                name: 'grab_release',
                title: 'Grab',
                description: 'Grabs.',
                inputSchema: z.object({ service: z.literal('radarr'), instance: z.string().optional() }),
                target: {
                    adapters: [],
                    to: { services: ['radarr'], can: (a): a is never => a !== undefined, cannot: 'cannot grab' }
                },
                operation: 'grab',
                tier: 'safe',
                plan: () => Promise.resolve(PLAN),
                apply: () => Promise.resolve({})
            }
        );
        await expect(call('grab_release', { service: 'radarr', instance: 'nope', dry_run: true })).rejects.toThrow();
        expect(audit.recent()).toHaveLength(0);
        await expect(call('grab_release', { service: 'radarr', instance: 'nope' })).rejects.toThrow();
        expect((audit.recent() as { outcome: string }[]).map(r => r.outcome)).toEqual(['denied']);
    });

    it('still records a live write the token refuses', async () => {
        const readOnly = buildHarness({ ceiling: [] });
        await expect(readOnly.call('delete_media', { id: '5' })).rejects.toThrow(/read-only/);
        expect(outcomes(readOnly)).toEqual(['denied']);
    });

    it('records repeated live writes the token refuses as one row a minute, with the count', async () => {
        vi.useFakeTimers();
        try {
            const readOnly = buildHarness({ ceiling: [], caller: 'bearer:phone#00000000' });
            for (let i = 0; i < 4; i++) await expect(readOnly.call('delete_media', { id: '5' })).rejects.toThrow(/read-only/);
            expect(outcomes(readOnly)).toEqual(['denied']);

            vi.advanceTimersByTime(61_000);
            await expect(readOnly.call('delete_media', { id: '5' })).rejects.toThrow(/read-only/);
            const rows = readOnly.audit.recent() as { outcome: string; detail: string }[];
            expect(rows.map(r => r.outcome)).toEqual(['denied', 'denied']);
            expect(rows[0]?.detail).toMatch(/and 3 more refused since the last row/);
            expect(rows[1]?.detail).not.toMatch(/more refused/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still records each live write a token may make but the config refuses', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });
        for (let i = 0; i < 3; i++) await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow();
        expect(outcomes(denied)).toEqual(['denied', 'denied', 'denied']);
    });

    it('still records a dry run when only the config refuses it', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });
        await denied.call('delete_media', { id: '5', dry_run: true });
        expect(outcomes(denied)).toEqual(['dry_run']);
    });

    it('records the resolved target, not the argument the caller typed', async () => {
        const resolving = buildHarness({ plan: { ...PLAN, target: 'radarr:5' } });
        await resolving.call('delete_media', { id: 'Alien', dry_run: true });

        const [row] = resolving.audit.recent() as { target: string }[];
        expect(row?.target).toBe('radarr:5');
    });
});

describe('write tool harness — cache invalidation', () => {
    it('drops the library cache after a write that landed (§16)', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        await harness.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });
        expect(harness.invalidate).toHaveBeenCalledTimes(1);
    });

    it('does not drop it for a preview or a dry run', async () => {
        await harness.call('delete_media', { id: '5' });
        await harness.call('delete_media', { id: '5', dry_run: true });
        expect(harness.invalidate).not.toHaveBeenCalled();
    });

    it('does not drop it when the write failed and changed nothing', async () => {
        const failing = buildHarness({ apply: () => Promise.reject(new Error('nope')) });
        const first = await failing.call('delete_media', { id: '5' });
        await expect(
            failing.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token })
        ).rejects.toThrow();
        expect(failing.invalidate).not.toHaveBeenCalled();
    });
});

describe('write tool harness — argument binding', () => {
    it('will not let a token previewed for one target apply to another', async () => {
        // Two tools over one harness would be closer to the real thing, but the
        // binding is per-plan: re-planning to a different target must invalidate
        // a token issued for the first.
        const first_plan: WritePlan = { ...PLAN, target: '5' };
        const second_plan: WritePlan = { ...PLAN, target: '9' };

        let called = false;
        const shifting = buildHarness({ plan: first_plan });
        shifting.plan.mockImplementation(() => {
            const next = called ? second_plan : first_plan;
            called = true;
            return Promise.resolve(next);
        });

        const first = await shifting.call('delete_media', { id: '5' });
        const second = await shifting.call('delete_media', {
            id: '9',
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(false);
        expect(second.structuredContent.confirm_error).toContain('different operation');
        expect(shifting.apply).not.toHaveBeenCalled();
    });
});

describe('write tool harness — cross-checks', () => {
    const SUBJECT = { kind: 'movie' as const, label: 'Alien (1979)', ids: { tmdb: 348 } };
    const SUBJECT_PLAN: WritePlan = { ...PLAN, subject: SUBJECT };
    const WARNING = 'Seerr still has a request for Alien (1979).';
    const advised = (warnings: string[] = [WARNING], unchecked: string[] = ['reclaimerr']) =>
        vi.fn<CrossChecker>(() => Promise.resolve({ warnings, unchecked }));
    const endsWithToken = /`v2\.[\w.-]+`\.?$/u;

    it('shows warnings on a preview, in the structured result and the text', async () => {
        const crossChecks = advised();
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5' });
        const text = content[0]?.text ?? '';

        expect(crossChecks).toHaveBeenCalledWith(SUBJECT, 'delete');
        expect(structuredContent.warnings).toEqual([WARNING]);
        expect(structuredContent.unchecked).toEqual(['reclaimerr']);
        expect(text).toContain(`Worth checking first:\n- ${WARNING}`);
        expect(text).toContain('Could not check: reclaimerr.');
        // Before the effects and the token, which stays last.
        expect(text.indexOf('Worth checking first')).toBeLessThan(text.indexOf(PLAN.effects[0] as string));
        expect(text.trimEnd()).toMatch(endsWithToken);
    });

    it('shows warnings in the dry-run text', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised(), crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5', dry_run: true });

        expect(content[0]?.text).toContain(WARNING);
        expect(content[0]?.text).toContain('Omit `dry_run`');
        expect(structuredContent.warnings).toEqual([WARNING]);
    });

    it('shows warnings on a rejected token, ahead of the fresh one', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised(), crossCheck: 'delete' });
        const { content } = await h.call('delete_media', { id: '5', confirm: 'nonsense' });
        const text = content[0]?.text ?? '';

        expect(text).toContain(WARNING);
        expect(text.indexOf(WARNING)).toBeLessThan(text.indexOf('Do not resend'));
        expect(text.trimEnd()).toMatch(endsWithToken);
    });

    it('omits both fields when there is nothing to say', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised([], []), crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5' });

        expect(structuredContent).not.toHaveProperty('warnings');
        expect(structuredContent).not.toHaveProperty('unchecked');
        expect(content[0]?.text).not.toContain('Worth checking');
    });

    it('does not run cross-checks when a confirm token is applied', async () => {
        const crossChecks = advised();
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const first = await h.call('delete_media', { id: '5' });
        const second = await h.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(second.structuredContent).not.toHaveProperty('warnings');
        expect(crossChecks).toHaveBeenCalledTimes(1);
    });

    it('applies a valid token whatever the warnings say now', async () => {
        const crossChecks = vi
            .fn<CrossChecker>()
            .mockResolvedValueOnce({ warnings: [], unchecked: [] })
            .mockResolvedValue({ warnings: ['A new warning.'], unchecked: [] });
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const first = await h.call('delete_media', { id: '5' });
        const second = await h.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(h.apply).toHaveBeenCalledTimes(1);
    });

    it('resolves a subject given as a function on the preview only', async () => {
        const crossChecks = advised();
        const subject = vi.fn(() => Promise.resolve(SUBJECT));
        const h = buildHarness({ plan: { ...PLAN, subject }, crossChecks, crossCheck: 'delete' });

        const first = await h.call('delete_media', { id: '5' });
        await h.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });

        expect(subject).toHaveBeenCalledTimes(1);
        expect(crossChecks).toHaveBeenCalledWith(SUBJECT, 'delete');
    });

    it('still previews when a subject function rejects', async () => {
        const crossChecks = advised();
        const h = buildHarness({
            plan: { ...PLAN, subject: () => Promise.reject(new Error('boom')) },
            crossChecks,
            crossCheck: 'delete'
        });
        const { structuredContent } = await h.call('delete_media', { id: '5' });

        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(structuredContent.unchecked).toEqual(['cross-service checks']);
        expect(crossChecks).not.toHaveBeenCalled();
    });

    it('still previews when the checker throws', async () => {
        const crossChecks = vi.fn<CrossChecker>(() => Promise.reject(new Error('boom')));
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5' });

        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(structuredContent.unchecked).toEqual(['cross-service checks']);
        expect(content[0]?.text).toContain('Could not check: cross-service checks.');
    });

    it('does not run cross-checks for a no-op or a refusal', async () => {
        const crossChecks = advised();
        const noop = buildHarness({ plan: { ...SUBJECT_PLAN, noop: true }, crossChecks, crossCheck: 'delete' });
        await noop.call('delete_media', { id: '5' });

        const denied = buildHarness({
            permissions: { radarr: service(false, false) },
            plan: SUBJECT_PLAN,
            crossChecks,
            crossCheck: 'delete'
        });
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(ServiceError);

        expect(crossChecks).not.toHaveBeenCalled();
    });

    it('asks nothing without a profile, a subject or a checker', async () => {
        const crossChecks = advised();
        await buildHarness({ plan: SUBJECT_PLAN, crossChecks }).call('delete_media', { id: '5' });
        await buildHarness({ plan: PLAN, crossChecks, crossCheck: 'delete' }).call('delete_media', { id: '5' });
        const bare = buildHarness({ plan: SUBJECT_PLAN, crossCheck: 'delete' });
        const { structuredContent } = await bare.call('delete_media', { id: '5' });

        expect(crossChecks).not.toHaveBeenCalled();
        expect(structuredContent).not.toHaveProperty('warnings');
    });

    it('records the same single audit row with or without cross-checks', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised(), crossCheck: 'delete' });
        await h.call('delete_media', { id: '5' });
        expect(outcomes(h)).toEqual(['unconfirmed']);
    });
});

describe('write tool harness: URLs in what it throws (#6)', () => {
    const KEY = '0123456789abcdef0123456789abcdef';
    const PASTED = `https://tracker.example.org/${KEY}/announce?passkey=${KEY}`;

    it('cuts a URL in a plan refusal down to scheme and host, in the message, detail and remedy', async () => {
        const refusing = buildHarness({
            plan: () => Promise.reject(new ServiceError('NotFound', 'radarr', `no such category ${PASTED}`, { remedy: `Not ${PASTED}.`, status: 404 }))
        });
        const err = (await refusing.call('delete_media', { id: '5' }).catch((e: unknown) => e)) as ServiceError;
        expect(err).toBeInstanceOf(ServiceError);
        expect(err).toMatchObject({ kind: 'NotFound', service: 'radarr', status: 404 });
        expect(err.message).toContain('no such category https://tracker.example.org/...');
        for (const text of [err.message, err.detail, err.remedy, err.stack]) expect(text).not.toContain(KEY);
        // Still the stack of where it was thrown, not of the scrub.
        expect(err.stack?.split('\n')[1]).toContain('writeTool.test.ts');
    });

    it('scrubs an error whose message has no setter, keeping its class and name', async () => {
        const harness = buildHarness({ apply: () => Promise.reject(new DOMException(`could not reach ${PASTED}`, 'AbortError')) });
        const preview = await harness.call('delete_media', { id: '5' });
        const err = (await harness.call('delete_media', { id: '5', confirm: preview.structuredContent.confirm_token }).catch((e: unknown) => e)) as DOMException;
        expect(err).toBeInstanceOf(DOMException);
        expect(err.name).toBe('AbortError');
        expect(err.message).toBe('could not reach https://tracker.example.org/...');
    });

    it('replaces a frozen error with a scrubbed copy, keeping the original as its cause', async () => {
        const frozen = Object.freeze(new Error(`could not reach ${PASTED}`));
        const err = (await buildHarness({ plan: () => Promise.reject(frozen) }).call('delete_media', { id: '5' }).catch((e: unknown) => e)) as Error;
        expect(err.message).toBe('could not reach https://tracker.example.org/...');
        expect(err.cause).toBe(frozen);
    });

    it('scrubs a stack that no longer repeats the message, still keeping its frames', async () => {
        const thrown = new Error(`could not reach ${PASTED}`);
        thrown.stack = `Error: was ${PASTED}\n    at plan (file:///app/src/tools/example.ts:12:34)`;
        const err = (await buildHarness({ plan: () => Promise.reject(thrown) }).call('delete_media', { id: '5' }).catch((e: unknown) => e)) as Error;
        expect(err.stack).toBe('Error: was https://tracker.example.org/...\n    at plan (file:///app/src/tools/example.ts:12:34)');
    });

    it('scrubs the fresh preview a rejected token gets back, and its token still applies', async () => {
        const quoting: WritePlan = { ...PLAN, summary: `Add it to category ${PASTED}.`, effects: [`Files under ${PASTED}.`] };
        const h = buildHarness({ plan: quoting });
        const rejected = await h.call('delete_media', { id: '5', confirm: 'not-a-token' });
        const { content, structuredContent } = rejected;
        const { confirm_token: _token, ...shown } = structuredContent;
        expect(JSON.stringify([content, shown])).not.toContain(KEY);
        // The target is what the token binds, shown as the plan resolved it in every reply.
        expect(structuredContent.target).toBe(PLAN.target);
        expect(structuredContent.summary).toBe('Add it to category https://tracker.example.org/...');
        const applied = await h.call('delete_media', { id: '5', confirm: structuredContent.confirm_token });
        expect(applied.structuredContent.applied).toBe(true);
    });

    it('scrubs only the first line of a stack, so frames given as file URLs keep their location', async () => {
        const thrown = new ServiceError('NotFound', 'radarr', `no such category ${PASTED}`);
        thrown.stack = `ServiceError: ${thrown.message}\n    at plan (file:///app/src/tools/example.ts:12:34)`;
        const err = (await buildHarness({ plan: () => Promise.reject(thrown) }).call('delete_media', { id: '5' }).catch((e: unknown) => e)) as Error;
        expect(err.stack).toBe('ServiceError: radarr not found: no such category https://tracker.example.org/...\n    at plan (file:///app/src/tools/example.ts:12:34)');
    });

    it('cuts a URL in a failed apply, and leaves out a magnet link', async () => {
        const harness = buildHarness({ apply: () => Promise.reject(new Error(`upstream refused ${PASTED} and magnet:?xt=urn:btih:${KEY}`)) });
        const preview = await harness.call('delete_media', { id: '5' });
        const err = (await harness.call('delete_media', { id: '5', confirm: preview.structuredContent.confirm_token }).catch((e: unknown) => e)) as Error;
        expect(err.message).toBe('upstream refused https://tracker.example.org/... and (a magnet link, left out)');
    });

    it.each([
        { as: 'failed', field: 'failed', outcome: { done: ['unlock title'], failed: `write the metadata: rejected ${PASTED}` } },
        { as: 'seerrBlocklistFailed', field: 'seerrBlocklistFailed', outcome: { deleted: true, seerrBlocklistFailed: `refused ${PASTED}` } },
        { as: 'syncFailed', field: 'syncFailed', outcome: { indexer: 'x', syncFailed: `refused ${PASTED}` } },
        { as: 'a list under failed', field: 'failed', outcome: { done: 1, failed: [`one ${PASTED}`, 2] } },
        // Whatever the tool calls it: fix_metadata and pause_downloads use `note`.
        { as: 'note', field: 'note', outcome: { resumed: 2, note: `could not remove the label: ${PASTED}` } },
        { as: 'a nested field', field: 'steps', outcome: { steps: [{ step: 'sync', error: `refused ${PASTED}` }] } }
    ])('scrubs the error a write that stopped part way reports as $as, in the result and the sentence built from it', async ({ field, outcome }) => {
        const harness = buildHarness({
            apply: () => Promise.resolve(outcome),
            // Built from the field, as update_book, delete_media and the indexer tools build theirs.
            applied: done => `Partly applied, but: ${JSON.stringify((done as Record<string, unknown>)[field])}`
        });
        const preview = await harness.call('delete_media', { id: '5' });
        const { content, structuredContent } = await harness.call('delete_media', { id: '5', confirm: preview.structuredContent.confirm_token });
        expect(JSON.stringify([content, structuredContent])).not.toContain(KEY);
        expect(content[0]?.text).toContain('https://tracker.example.org/...');
        expect(structuredContent.result).toMatchObject(Object.fromEntries(Object.keys(outcome).filter(key => key !== field).map(key => [key, (outcome as Record<string, unknown>)[key]])));
    });

    it('names a URL target the same cut-down way in the preview, a rejection, the receipt and its result', async () => {
        const target = `radarr:${PASTED}`;
        const harness = buildHarness({
            plan: { ...PLAN, target },
            apply: () => Promise.resolve({ grabbed: target, endpoint: 'http://192.0.2.10:7878', note: `the client said ${PASTED}` })
        });
        const preview = await harness.call('delete_media', { id: '5' });
        const rejected = await harness.call('delete_media', { id: '5', confirm: 'not-a-token' });
        const { structuredContent } = await harness.call('delete_media', { id: '5', confirm: preview.structuredContent.confirm_token });
        expect(preview.structuredContent.target).toBe('radarr:https://tracker.example.org/...');
        expect(rejected.structuredContent.target).toBe(preview.structuredContent.target);
        expect(structuredContent.target).toBe(preview.structuredContent.target);
        // A bare address is kept: nothing in it can be a key.
        expect(structuredContent.result).toEqual({ grabbed: preview.structuredContent.target, endpoint: 'http://192.0.2.10:7878', note: 'the client said https://tracker.example.org/...' });
    });

    it('scrubs a no-op, whose sentence can repeat a URL the plan quoted', async () => {
        const harness = buildHarness({ plan: { ...PLAN, target: `radarr:${PASTED}`, summary: `${PASTED} is already imported.`, noop: true } });
        const { content, structuredContent } = await harness.call('delete_media', { id: '5' });
        expect(JSON.stringify([content, structuredContent])).not.toContain(KEY);
        expect(structuredContent.noop).toBe(true);
    });

    it('rethrows a refusal with no URL in it untouched', async () => {
        const refusal = new ServiceError('NotFound', 'radarr', 'no movie 5 at http://192.0.2.10:7878');
        const refusing = buildHarness({ plan: () => Promise.reject(refusal) });
        await expect(refusing.call('delete_media', { id: '5' })).rejects.toBe(refusal);
    });
});

describe('write tool harness: one confirmed write per instance at a time (#7)', () => {
    // The lanes outlive a test, so a test that fails while holding one must still free it.
    const toRelease: (() => void)[] = [];
    afterEach(() => {
        for (const release of toRelease.splice(0)) release();
    });

    /** A plan and apply that log each step, with apply for `held` waiting until `release` is called. */
    function racing(held: string, opts: { route?: (args: { id: string }) => string; failFirst?: boolean } = {}) {
        const log: string[] = [];
        let release = (): void => undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        toRelease.push(release);
        const h = buildHarness({
            permissions: { radarr: service(false, true), sonarr: service(false, true) },
            ...(opts.route === undefined ? {} : { route: opts.route }),
            plan: ({ id }) => {
                log.push(`plan ${id}`);
                return Promise.resolve({ ...PLAN, target: id });
            },
            apply: async (_plan, { id }) => {
                log.push(`apply ${id}`);
                if (id === held) await gate;
                if (opts.failFirst === true && id === held) throw new Error('upstream broke');
                log.push(`applied ${id}`);
                return { ok: true };
            }
        });
        const tokens: (string | undefined)[] = [];
        const confirmAll = async (ids: string[], signal?: AbortSignal) => {
            tokens.length = 0;
            for (const id of ids) tokens.push((await h.call('delete_media', { id })).structuredContent.confirm_token);
            log.length = 0;
            return ids.map((id, i) => h.call('delete_media', { id, confirm: tokens[i] }, i === 0 ? undefined : signal).catch((e: unknown) => e));
        };
        return { h, log, release, confirmAll, tokens };
    }

    const settled = () => new Promise(resolve => setTimeout(resolve, 20));

    it('runs the second confirmation from its plan on only once the first has applied', async () => {
        const r = racing('5');
        const calls = await r.confirmAll(['5', '9']);
        await settled();
        const seen = [...r.log];
        r.release();
        await Promise.all(calls);
        expect(seen).toEqual(['plan 5', 'apply 5']);
        expect(r.log).toEqual(['plan 5', 'apply 5', 'applied 5', 'plan 9', 'apply 9', 'applied 9']);
    });

    it('lets a preview through while a confirmation holds the instance', async () => {
        const r = racing('5');
        const calls = await r.confirmAll(['5']);
        await settled();
        const preview = await r.h.call('delete_media', { id: '9' });
        expect(preview.structuredContent.applied).toBe(false);
        r.release();
        await Promise.all(calls);
    });

    it('does not hold a confirmation on another instance', async () => {
        const r = racing('5', { route: ({ id }) => (id === '5' ? 'radarr' : 'sonarr') });
        const calls = await r.confirmAll(['5', '9']);
        await settled();
        const seen = [...r.log];
        r.release();
        await Promise.all(calls);
        expect(seen).toContain('applied 9');
        expect(seen).not.toContain('applied 5');
    });

    it('refuses a confirmation that waited 30 seconds, unapplied and with its token unspent', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const r = racing('5');
            const [first, second] = await r.confirmAll(['5', '9']);
            await vi.advanceTimersByTimeAsync(30_000);
            const refusal = (await second) as Error;
            expect(refusal.message).toMatch(/^Not applied: another confirmed write to radarr was still running after 30 seconds\. This request did not use its confirmation token/);
            r.release();
            await first;
            expect(r.log).not.toContain('plan 9');
            expect(outcomes(r.h)).toContain('denied');
            const retried = await r.h.call('delete_media', { id: '9', confirm: r.tokens[1] });
            expect(retried.structuredContent.applied).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses a retry as already used when a duplicate of the refused request spent the token', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const r = racing('5');
            const token = (await r.h.call('delete_media', { id: '5' })).structuredContent.confirm_token;
            const first = r.h.call('delete_media', { id: '5', confirm: token });
            // The same request sent twice: the first spends the token and holds the lane.
            const second = r.h.call('delete_media', { id: '5', confirm: token }).catch((e: unknown) => e);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await second).toMatchObject({ message: expect.stringMatching(/This request did not use its confirmation token/) });
            r.release();
            await first;
            await expect(r.h.call('delete_media', { id: '5', confirm: token })).rejects.toThrow(/already used/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses a queued confirmation whose request was cancelled, and never plans or applies it', async () => {
        const r = racing('5');
        const abort = new AbortController();
        const [first, second] = await r.confirmAll(['5', '9'], abort.signal);
        await settled();
        abort.abort();
        await expect(second).resolves.toMatchObject({ message: expect.stringMatching(/cancelled while it waited for another confirmed write to radarr/) });
        r.release();
        await first;
        await settled();
        expect(r.log).toEqual(['plan 5', 'apply 5', 'applied 5']);
        expect(outcomes(r.h)).toContain('denied');
        const retried = await r.h.call('delete_media', { id: '9', confirm: r.tokens[1] });
        expect(retried.structuredContent.applied).toBe(true);
    });

    it('refuses a confirmation whose request was cancelled before it reached the lane', async () => {
        const r = racing('none');
        const abort = new AbortController();
        abort.abort();
        const preview = await r.h.call('delete_media', { id: '9' });
        await expect(r.h.call('delete_media', { id: '9', confirm: preview.structuredContent.confirm_token }, abort.signal)).rejects.toThrow(
            /^Not applied: the request was cancelled before this write started\. This request did not use its confirmation token/
        );
        expect(outcomes(r.h)).toContain('denied');
        expect(r.h.apply).not.toHaveBeenCalled();
    });

    it('refuses a waiter handed the lane after its deadline, even when its timer never ran', async () => {
        const r = racing('5');
        const start = performance.now();
        const [first, second] = await r.confirmAll(['5', '9']);
        await settled();
        const clock = vi.spyOn(performance, 'now').mockReturnValue(start + 31_000);
        try {
            r.release();
            await first;
            expect(await second).toMatchObject({ message: expect.stringMatching(/still running after 30 seconds/) });
        } finally {
            clock.mockRestore();
        }
        expect(r.log).not.toContain('plan 9');
        const retried = await r.h.call('delete_media', { id: '9', confirm: r.tokens[1] });
        expect(retried.structuredContent.applied).toBe(true);
    });

    it('hands the lane on past a waiter cancelled at the hand-off, and its token still applies later', async () => {
        const r = racing('5');
        // Aborted with no event, as a signal can be between the hand-off and the write starting.
        const quiet = { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined };
        const tokens: (string | undefined)[] = [];
        for (const id of ['5', '9', '7']) tokens.push((await r.h.call('delete_media', { id })).structuredContent.confirm_token);
        r.log.length = 0;
        const first = r.h.call('delete_media', { id: '5', confirm: tokens[0] });
        await settled();
        const second = r.h.call('delete_media', { id: '9', confirm: tokens[1] }, quiet as unknown as AbortSignal).catch((e: unknown) => e);
        const third = r.h.call('delete_media', { id: '7', confirm: tokens[2] });
        await settled();
        quiet.aborted = true;
        r.release();
        await first;
        expect(await second).toMatchObject({ message: expect.stringMatching(/cancelled while it waited/) });
        expect((await third).structuredContent.applied).toBe(true);
        expect(r.log).toEqual(['plan 5', 'apply 5', 'applied 5', 'plan 7', 'apply 7', 'applied 7']);
        const retried = await r.h.call('delete_media', { id: '9', confirm: tokens[1] });
        expect(retried.structuredContent.applied).toBe(true);
        const after = await r.h.call('delete_media', { id: '5' });
        expect((await r.h.call('delete_media', { id: '5', confirm: after.structuredContent.confirm_token })).structuredContent.applied).toBe(true);
    });

    it('keeps a URL target out of the row a confirm cancelled mid-plan writes', async () => {
        const passkey = '0123456789abcdef0123456789abcdef';
        const abort = new AbortController();
        let confirming = false;
        const h = buildHarness({
            plan: () => {
                if (confirming) abort.abort();
                return Promise.resolve({ ...PLAN, target: `radarr:https://indexer.example/get?apikey=${passkey}` });
            }
        });
        const token = (await h.call('delete_media', { id: '5' })).structuredContent.confirm_token;
        confirming = true;
        await expect(h.call('delete_media', { id: '5', confirm: token }, abort.signal)).rejects.toThrow(/being planned/);
        const [row] = h.audit.recent() as { outcome: string; target: string }[];
        expect(row?.outcome).toBe('denied');
        expect(row?.target).not.toContain(passkey);
        // Cut down rather than left out, so the row still names the host.
        expect(row?.target).toBe('radarr:https://indexer.example/...');
    });

    it('records a confirm cancelled mid-plan as refused, even when the plan finds nothing left to do', async () => {
        const abort = new AbortController();
        let confirming = false;
        const h = buildHarness({
            plan: () => {
                if (!confirming) return Promise.resolve(PLAN);
                abort.abort();
                return Promise.resolve({ ...PLAN, noop: true });
            }
        });
        const token = (await h.call('delete_media', { id: '5' })).structuredContent.confirm_token;
        confirming = true;
        await expect(h.call('delete_media', { id: '5', confirm: token }, abort.signal)).rejects.toThrow(/cancelled while this write was being planned/);
        expect(outcomes(h)).toEqual(['unconfirmed', 'denied']);
        expect(h.audit.recent()[0]).toMatchObject({ outcome: 'denied', target: PLAN.target });
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('leaves the token unspent when the request is cancelled while the confirm is being planned', async () => {
        const abort = new AbortController();
        let confirming = false;
        const h = buildHarness({
            plan: () => {
                // The caller goes while the plan reads the service.
                if (confirming) abort.abort();
                return Promise.resolve(PLAN);
            }
        });
        const token = (await h.call('delete_media', { id: '5' })).structuredContent.confirm_token;
        confirming = true;
        await expect(h.call('delete_media', { id: '5', confirm: token }, abort.signal)).rejects.toThrow(/cancelled while this write was being planned\. This request did not use its confirmation token/);
        expect(h.apply).not.toHaveBeenCalled();
        expect(outcomes(h)).toContain('denied');
        confirming = false;
        expect((await h.call('delete_media', { id: '5', confirm: token })).structuredContent.applied).toBe(true);
    });

    it('builds the fresh preview for a rejected token outside the lane, so its cross-checks hold up no write', async () => {
        let block = false;
        let unblock = (): void => undefined;
        const slow = new Promise<void>(resolve => {
            unblock = resolve;
        });
        toRelease.push(unblock);
        const crossChecks = vi.fn<CrossChecker>(async () => {
            if (block) await slow;
            return { warnings: [], unchecked: [] };
        });
        const h = buildHarness({ plan: { ...PLAN, subject: { kind: 'movie', label: 'Alien (1979)', ids: { tmdb: 348 } } }, crossChecks, crossCheck: 'delete' });
        const token = (await h.call('delete_media', { id: '5' })).structuredContent.confirm_token;
        block = true;
        const rejected = h.call('delete_media', { id: '5', confirm: 'not-a-token' });
        await settled();
        const applied = await Promise.race([h.call('delete_media', { id: '5', confirm: token }), settled().then(() => 'still waiting')]);
        expect(applied).toMatchObject({ structuredContent: { applied: true } });
        unblock();
        expect((await rejected).structuredContent.confirm_error).toBeDefined();
    });

    it('frees the instance after a write that failed', async () => {
        const r = racing('5', { failFirst: true });
        const calls = await r.confirmAll(['5', '9']);
        r.release();
        const [first, second] = await Promise.all(calls);
        expect(first).toBeInstanceOf(Error);
        expect((second as { structuredContent: WriteToolResult }).structuredContent.applied).toBe(true);
    });
});

describe('rawTarget', () => {
    it.each([
        [{ id: '7', title: 'Alien' }, '7'],
        [{ title: 'Alien', item_id: 'x' }, 'x'],
        [{ download_id: 'SABnzbd_nzo_1', title: 'T' }, 'SABnzbd_nzo_1'],
        [{ library: 'Books' }, 'Books'],
        [{ id: 15 }, '15'],
        [{ id: 5, item_id: 'x' }, '5'],
        [{ id: null, dry_run: true }, ''],
        [{}, '']
    ])('%j gives %j', (args, expected) => {
        expect(rawTarget(args as Record<string, unknown>)).toBe(expected);
    });
});
