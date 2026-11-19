import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { BEARER_CALLER, type WriteAudit } from '../core/audit.ts';
import { CONFIRM_REASON, type ConfirmTokens, type WriteIntent } from '../core/confirm.ts';
import { ServiceError } from '../core/errors.ts';
import { nextStepLine, type NextStep } from '../core/nextStep.ts';
import { checkPermission, type PermissionSource, type WriteTier } from '../core/permissions.ts';
import { toolInput } from '../core/shape.ts';
import { logger } from '../core/logger.ts';
import { scrubUrls, shownValue } from '../core/pastedUrl.ts';
import type { CrossCheckProfile, CrossCheckSubject, CrossChecker } from './crossChecks.ts';
import type { LibraryLoader } from './library.ts';
import { resolveTarget, type ServiceTarget } from './serviceTarget.ts';
import type { ServiceId } from '../config/schema.ts';
import type { ServiceAdapter } from '../services/types.ts';

/**
 * The four properties every write must have (permission tier, `dry_run`, an
 * audit record, per-call confirmation) are this function, not four things each
 * tool remembers. A tool supplies only what is specific to it: `plan`, which
 * describes an effect without touching anything, and `apply`, reached only once
 * all four gates pass.
 *
 * That split is the design. A tool physically cannot mutate during preview,
 * because preview only calls `plan`; the mutating code sits in a callback the
 * harness declines to invoke. So reviewing a write tool means reading its
 * `plan`/`apply` pair, not auditing whether it checked permissions.
 */

/** What `plan` resolved the request into: a concrete target and a description
 *  of the effect, in the model's words rather than the service's. */
export type WritePlan<Bound extends Record<string, unknown> = Record<string, unknown>> = {
    /** The resolved id the write will act on. The confirmation token binds to
     *  this, so a token cannot survive re-resolving a title to a different film. */
    target: string;
    /** One sentence, safe to show a human: "Delete Alien (1979) from radarr/4k, leaving its files on disk." */
    summary: string;
    /** Itemised consequences, most severe first. Empty is legitimate for a
     *  no-op; see the `noop` field. */
    effects: string[];
    /** Effect-bearing arguments, folded into the token binding. Anything that
     *  changes what `apply` does belongs here or the token would not commit to it. */
    args?: Bound;
    /**
     * Set when the plan resolved successfully but there is nothing to do; the
     * film is already monitored, the request is already approved. The harness
     * short-circuits: no token, no confirmation, no write, and the audit
     * records it as a dry run. A confirmation prompt for a no-op trains a
     * model to confirm reflexively.
     */
    noop?: boolean;
    /**
     * On a no-op that only lists (`remove_queue_item` with `orphaned: true`):
     * the calls to make for what it lists. The text then carries the effects
     * and these, since the listing is the answer.
     */
    next?: NextStep[];
    /**
     * The title this write touches, for the cross-checks. Only read when the
     * tool sets `crossCheck`, so a plan can always fill it in. A function is
     * for a subject that costs an upstream read to name: the harness calls it
     * only when it asks for advice, so a confirm never pays for it.
     */
    subject?: CrossCheckSubject | (() => Promise<CrossCheckSubject>);
};

/** For a tool whose `apply` returns the sentence to show: use it as the applied text. */
export const outcomeText = (outcome: unknown): string | undefined => (typeof outcome === 'string' ? outcome : undefined);

/**
 * Which service's permissions govern a call: either worked out from the
 * arguments, or the adapter a `target` resolves them to, which `plan` and
 * `apply` then receive rather than looking it up again.
 */
type Routing<Schema extends z.ZodObject, Adapter> =
    | {
          /**
           * A fixed id for a single-service tool, or a function of the
           * arguments for one that spans several.
           *
           * It must be derived from the arguments and nothing else. Resolving it from
           * the *plan* would let a tool that had already done a read decide its own
           * permission scope, and a fixed id on a multi-service tool is worse still:
           * it would check Sonarr writes against Radarr's `permissions` block, so
           * enabling one service would quietly enable the other.
           */
          service: string | ((args: z.infer<Schema>) => string);
          target?: never;
      }
    | {
          /**
           * The instance the `service` and `instance` arguments name, refused unless
           * it can do this write. Its id is the permission key, not the bare type:
           * checking `radarr` against a config that only grants `radarr/hd` would
           * deny a permitted write, or worse, the reverse.
           */
          target: { adapters: readonly ServiceAdapter[]; to: ServiceTarget<Adapter & ServiceAdapter> };
          service?: never;
      };

type WriteToolSpec<
    Schema extends z.ZodObject,
    Adapter = undefined,
    Bound extends Record<string, unknown> = Record<string, unknown>
> = Routing<Schema, Adapter> & {
    name: string;
    /** What a client shows a person in place of `delete_episode_files`. */
    title: string;
    description: string;
    /** Tool-specific arguments. `dry_run` and `confirm` are added here, so no
     *  write tool can accidentally omit or redefine them. */
    inputSchema: Schema;
    /** The adapter-level verb, e.g. `delete_movie`; one tool may reach several. */
    operation: string;
    /**
     * Fixed for most tools. A function for one whose actions differ in kind
     * (`blocklist_media` adds or removes), derived from the arguments for
     * the same reason `service` is. Such a tool is advertised as destructive,
     * since it can be.
     */
    tier: WriteTier | ((args: z.infer<Schema>) => WriteTier);
    /** `adapter` is the one `target` resolved; a tool routed by `service` has none. */
    plan(args: z.infer<Schema>, adapter: Adapter & ServiceAdapter): Promise<WritePlan<Bound>>;
    apply(plan: WritePlan<Bound>, args: z.infer<Schema>, adapter: Adapter & ServiceAdapter): Promise<unknown>;
    /**
     * Optional override for the sentence shown after a successful apply.
     * Most tools need none; `plan.summary` describes the effect and the
     * effect happened, so `Applied. ${plan.summary}` is always true. A tool
     * whose apply can turn out to have done nothing (a sync that found
     * nothing to pull) supplies this to say so; returning `undefined` falls
     * back to the default sentence. A sentence returned here is also the
     * applied result's `summary`.
     */
    applied?(outcome: unknown, plan: WritePlan<Bound>): string | undefined;
    /** False when apply found its change already made (a torrent the client
     *  already had): the result then reads `applied: false` and `noop: true`. */
    landed?(outcome: unknown): boolean;
    /**
     * Calls worth offering now that the write has landed, as data for a client
     * to put to the person. Never run here. Called after the write only: a
     * throw is logged and the write is still reported, since it already happened.
     */
    followUps?(outcome: unknown, args: z.infer<Schema>, plan: WritePlan<Bound>): NextStep[];
    /**
     * Which questions to ask the rest of the stack when this write is
     * previewed. Run by the harness, not by `plan`: `plan` runs again on the
     * confirm call, and reads there would make an apply slow or fail on a
     * service that is down. Previews only, so the invariant above holds: the
     * preview path cannot mutate, and a valid token applies whatever the
     * warnings say now.
     */
    crossCheck?: CrossCheckProfile;
};

export type WriteContext = {
    permissions: PermissionSource;
    confirm: ConfirmTokens;
    audit: WriteAudit;
    /** Invalidated after a successful write. */
    library: LibraryLoader;
    /**
     * Which credential this request arrived on, for the audit row.
     *
     * Every `/mcp` request sets it, in `cappedTools` (`app.ts`). The
     * `BEARER_CALLER` fallback only serves contexts built outside `/mcp`.
     */
    caller?: string;
    /** Absent in a context built without one; a tool that sets `crossCheck` then previews as it always did. */
    crossChecks?: CrossChecker;
};

const DryRunSchema = z
    .boolean()
    .default(false)
    .describe('Preview only, no token issued: for "what if" questions, not the first step of a change.');

const ConfirmSchema = z
    .string()
    .optional()
    .describe('The token from this tool\'s preview; pass it back to apply.');

/**
 * What every write answers with, declared for the same reason the read
 * envelope is (#103): a client that gates `structuredContent` on a declared
 * schema shows the caller nothing without one.
 *
 * It matters more here than on a read. `applied` is the difference between "I
 * deleted it" and "I would delete it, confirm first", and a model that cannot
 * see the structured half has to infer which happened from a sentence. Getting
 * that wrong in the reassuring direction (reporting a preview as done) is the
 * failure the whole confirm handshake exists to prevent.
 *
 * Loose, like the read envelope: a validation failure here would fail the call
 * *after* the write had already landed, reporting a completed deletion as an
 * error.
 *
 * Only the fields every write result carries are declared. This schema goes
 * to the client with each of the twenty-odd write tools on every session, and
 * the conditional ones (`confirm_token`, `warnings`, `next_steps`, ...) still
 * arrive in `structuredContent`, which a loose object lets through; the text
 * says the same, and `WriteToolResult` below documents them.
 */
const WriteOutputSchema = z.looseObject({
    applied: z.boolean().describe('Whether the change actually happened. False on every preview, refusal and no-op.'),
    dry_run: z.boolean(),
    tool: z.string(),
    service: z.string(),
    operation: z.string(),
    tier: z.enum(['safe', 'destructive']),
    target: z.string(),
    summary: z.string(),
    effects: z.array(z.string()),
    noop: z.boolean(),
    permission: z.looseObject({ allowed: z.boolean() })
});

export type WriteToolResult = {
    applied: boolean;
    dry_run: boolean;
    tool: string;
    service: string;
    operation: string;
    tier: WriteTier;
    target: string;
    summary: string;
    effects: string[];
    noop: boolean;
    permission: { allowed: boolean; reason?: string; remedy?: string };
    /** On a preview awaiting confirmation: single-use, expiring, bound to this operation and its arguments. */
    confirm_token?: string;
    /** Why a presented token was rejected. Present only when one was presented. */
    confirm_error?: string;
    /** Whatever `apply` returned, on a real write. */
    result?: unknown;
    /** The audit row this call wrote. Absent on a dry run above the token's tier. */
    audit_id?: number;
    /** Other services' findings, on a preview. Omitted when there are none. */
    warnings?: string[];
    /** Services the cross-checks could not read. Omitted when there are none. */
    unchecked?: string[];
    /** Calls worth offering after an applied write. Omitted when there are none. */
    next_steps?: NextStep[];
};

/** What a write tool call answers with. */
type ToolReply = { content: { type: 'text'; text: string }[]; structuredContent: WriteToolResult };

/**
 * A refusal's reply with every URL the caller reads cut down (#6): a rejected
 * token's fresh preview can repeat what the plan quoted, and a target can be a
 * release guid that is a URL. The token is left as it is: it binds the target
 * the plan resolved, not this copy.
 */
const scrubbedReply = ({ content, structuredContent: result }: ToolReply): ToolReply => ({
    content: content.map(part => ({ ...part, text: scrubUrls(part.text) })),
    structuredContent: {
        ...result,
        target: scrubUrls(result.target),
        summary: scrubUrls(result.summary),
        effects: result.effects.map(scrubUrls),
        ...(result.warnings === undefined ? {} : { warnings: result.warnings.map(scrubUrls) })
    }
});

const TARGET_KEYS = [
    'id',
    'item_id',
    'download_id',
    'external_id',
    'media_id',
    'library',
    'title',
    'definition',
    'query',
    'database'
] as const;

/** The identifying argument as the caller gave it, for a refusal that never resolved the plan. */
export function rawTarget(args: Record<string, unknown>): string {
    for (const key of TARGET_KEYS) {
        const value = args[key];
        // A tracker URL or magnet pasted by mistake would carry its passkey into the audit log.
        if (typeof value === 'string') return shownValue(value);
        if (typeof value === 'number') return String(value);
    }
    return '';
}

/**
 * A write tool's full input, built once per tool schema and reused by every
 * request's server (#573). Keyed on the spec's own schema, which is a module
 * constant (or, for the media-server tools, shared per server pair).
 */
const writeInputs = new WeakMap<z.ZodObject, z.ZodObject>();
function writeInput(schema: z.ZodObject): z.ZodObject {
    let full = writeInputs.get(schema);
    if (full === undefined) {
        // Rebuilt through `toolInput` rather than extended; see the note where it is registered.
        full = toolInput({ ...schema.shape, dry_run: DryRunSchema, confirm: ConfirmSchema });
        writeInputs.set(schema, full);
    }
    return full;
}

/**
 * How long a confirmed write waits for its instance. Some applies wait on the
 * service for minutes (a rename's command, a watched recheck), and a client
 * stops waiting long before that, so a write queued behind one is refused
 * rather than landing after its caller was told it failed.
 */
const LANE_WAIT_MS = 30_000;

/** The confirmed writes waiting for an instance, oldest first. Present only while one runs. */
type Lane = { waiting: (() => void)[] };

/**
 * One lane per instance id, shared by every request's server: a confirmed
 * write runs its plan, its token check and its apply in that lane, so two
 * confirmations racing on one instance cannot interleave their writes and
 * leave a mix of both (#7). Previews and dry runs only read, so they never wait.
 */
const writeLanes = new Map<string, Lane>();

/** Hands the instance to the oldest write still waiting, or frees it. */
function release(service: string, lane: Lane): void {
    const next = lane.waiting.shift();
    if (next !== undefined) next();
    else writeLanes.delete(service);
}

type Turn<T> = { ran: true; value: T } | { ran: false; why: 'busy' | 'cancelled' };

/**
 * Runs `task` once every confirmed write queued ahead of it on `service` has
 * finished. Gives up without running it after `LANE_WAIT_MS`, or as soon as
 * the request is cancelled, so the token it would have spent stays unused. A
 * write that gives up leaves the queue at once, holding nothing.
 */
async function inLane<T>(service: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<Turn<T>> {
    // A function, so the check after the wait reads the signal as it is then.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) return { ran: false, why: 'cancelled' };
    let lane = writeLanes.get(service);
    if (lane === undefined) {
        lane = { waiting: [] };
        writeLanes.set(service, lane);
    } else {
        const queue = lane.waiting;
        // Checked again at the hand-off: a timer the event loop ran late must not let an overdue write in.
        const deadline = performance.now() + LANE_WAIT_MS;
        const turn = await new Promise<'go' | 'busy' | 'cancelled'>(resolve => {
            const settle = (outcome: 'go' | 'busy' | 'cancelled'): void => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancelled);
                const at = queue.indexOf(go);
                if (at !== -1) queue.splice(at, 1);
                resolve(outcome);
            };
            const go = (): void => settle('go');
            const cancelled = (): void => settle('cancelled');
            const timer = setTimeout(() => settle('busy'), LANE_WAIT_MS);
            signal?.addEventListener('abort', cancelled, { once: true });
            queue.push(go);
        });
        if (turn !== 'go') return { ran: false, why: turn };
        if (performance.now() >= deadline) {
            release(service, lane);
            return { ran: false, why: 'busy' };
        }
    }
    // The instance is this write's now, until `release` hands it on.
    if (aborted()) {
        release(service, lane);
        return { ran: false, why: 'cancelled' };
    }
    try {
        return { ran: true, value: await task() };
    } finally {
        release(service, lane);
    }
}

/**
 * A stack with its first lines, which repeat the message, rewritten. The
 * frames are kept as they are: `file:///` frames name where it was thrown.
 */
function restacked(stack: string | undefined, from: string, to: string): string | undefined {
    if (stack === undefined) return undefined;
    if (stack.includes(from)) return stack.replace(from, () => to);
    const frames = stack.indexOf('\n    at ');
    return frames === -1 ? scrubUrls(stack) : scrubUrls(stack.slice(0, frames)) + stack.slice(frames);
}

/**
 * The error a write tool throws, with every URL in its message cut down the
 * way the audit detail is (#6). A refusal can quote what the caller passed, and
 * a URL there can carry a tracker passkey. A `ServiceError` is rebuilt rather
 * than edited, so its `detail` and `remedy` agree with its message; any other
 * error keeps its class and fields.
 */
function scrubbedError(err: unknown): unknown {
    if (err instanceof ServiceError) {
        const detail = scrubUrls(err.detail);
        const remedy = err.remedy === undefined ? undefined : scrubUrls(err.remedy);
        if (detail === err.detail && remedy === err.remedy) return err;
        const rebuilt = new ServiceError(err.kind, err.service, detail, {
            ...(remedy === undefined ? {} : { remedy }),
            ...(err.cause === undefined ? {} : { cause: err.cause }),
            ...(err.reason === undefined ? {} : { reason: err.reason }),
            ...(err.status === undefined ? {} : { status: err.status })
        });
        // The original's frames, so a log still shows where it was thrown.
        const stack = restacked(err.stack, err.message, rebuilt.message);
        if (stack !== undefined) rebuilt.stack = stack;
        return rebuilt;
    }
    if (err instanceof Error) {
        const message = scrubUrls(err.message);
        if (message === err.message) return err;
        const stack = restacked(err.stack, err.message, message);
        // The thrown object itself is changed, on purpose: a copy would lose its class and fields.
        try {
            // Defined rather than assigned: a DOMException's `message` is a getter with no setter.
            Object.defineProperty(err, 'message', { value: message, writable: true, configurable: true });
            if (stack !== undefined) Object.defineProperty(err, 'stack', { value: stack, writable: true, configurable: true });
            return err;
        } catch {
            // A frozen error: nothing on it can change, so the caller gets a copy
            // of its text and the original stays the cause, for the logs.
            return new Error(message, { cause: err });
        }
    }
    return typeof err === 'string' ? scrubUrls(err) : err;
}

/**
 * The one place a write tool is turned into an MCP tool. Every branch below
 * either records an audit row or is a pure preview that records one as
 * `dry_run`; there is no path from arguments to `apply` that skips the tier
 * check, the confirmation, or the trail. Refusals above the caller's own
 * credential are counted into one row a minute rather than one each.
 */
export function registerWriteTool<
    Schema extends z.ZodObject,
    Adapter = undefined,
    Bound extends Record<string, unknown> = Record<string, unknown>
>(server: McpServer, context: WriteContext, spec: WriteToolSpec<Schema, Adapter, Bound>): void {
    const { permissions, confirm, audit, library } = context;
    // Resolved once per registration, not per call: the context is rebuilt per
    // request, so a tool registered from it already belongs to one credential.
    const caller = context.caller ?? BEARER_CALLER;

    server.registerTool(
        spec.name,
        {
            title: spec.title,
            /**
             * The permission tier, said out loud to the client.
             *
             * Read from `spec.tier` rather than declared a second time, because
             * a tool gated as destructive and advertised as safe is worse than
             * one that says nothing at all; a client auto-approving on the
             * annotation would be reading a claim the gate itself contradicts.
             *
             * `idempotentHint` is deliberately omitted, which the spec reads as
             * false. It would be a lie in either direction here: the confirm
             * token is single-use, so an identical repeated call does not
             * repeat the write; it fails the token check. Nothing a client
             * would do with the hint is right for that.
             */
            annotations: { readOnlyHint: false, destructiveHint: spec.tier !== 'safe' },
            description: spec.description,
            // Rebuilt through `toolInput` rather than extended, and the
            // difference is the error text: strictness carried over from the
            // spec's own schema would list only the tool's half, so a caller
            // that mistyped one argument would be told `dry_run` and `confirm`
            // (the two parameters the write protocol itself runs on) are not
            // parameters of this tool.
            inputSchema: writeInput(spec.inputSchema),
            outputSchema: WriteOutputSchema
        },
        // Every refusal and failure leaves through here, so one scrub covers all of them.
        async (raw: Record<string, unknown>, ctx?: unknown) => {
            try {
                return await handle(raw, (ctx as { mcpReq?: { signal?: AbortSignal } } | undefined)?.mcpReq?.signal);
            } catch (err) {
                throw scrubbedError(err);
            }
        }
    );

    async function handle(raw: Record<string, unknown>, signal: AbortSignal | undefined) {
        const { dry_run: dryRun, confirm: presented, ...rest } = raw as {
            dry_run: boolean;
            confirm?: string;
        };
        const args = rest as z.infer<Schema>;

        // Resolved from the arguments alone, before anything else runs, so
        // the service whose permissions are checked is the service the
        // audit names and the token binds to. Deriving it later, from the
        // plan, say, would let the three disagree.
        const tier = typeof spec.tier === 'function' ? spec.tier(args) : spec.tier;
        // A refusal of a live call, and one row for it. A call the caller's
        // own credential could never make is rate-limited per caller and
        // tool (`refusedAboveCeiling`): a row each would let a read token
        // grow the permanent audit table as fast as it can ask.
        const deny = (named: string, target: string, detail: string): void => {
            const record = { tool: spec.name, service: named, operation: spec.operation, tier, target, args: {}, caller };
            if (permissions.permits?.(tier, named) === false) {
                audit.refusedAboveCeiling(record, detail);
                return;
            }
            audit.settle(audit.begin(record), 'denied', detail);
        };
        // An argument the plan or router refused, or a title it could not
        // find. A dry run records nothing for it, whichever refused it.
        const refused = (named: string, err: unknown): void => {
            if (dryRun) return;
            deny(named, rawTarget(args), err instanceof Error ? err.message : String(err));
        };
        let service: string;
        let adapter: Adapter & ServiceAdapter;
        if (spec.target !== undefined) {
            const { service: type, instance } = args as { service: ServiceId; instance?: string };
            try {
                adapter = resolveTarget(spec.target.adapters, spec.target.to, type, instance);
            } catch (err) {
                // Refused before anything else ran, and recorded like any other refusal.
                refused(type, err);
                throw err;
            }
            service = adapter.id;
        } else {
            try {
                service = typeof spec.service === 'function' ? spec.service(args) : spec.service;
            } catch (err) {
                // A router resolves the instance, so its refusal is the
                // `target` refusal above by another route.
                refused(String((args as { service?: unknown }).service ?? ''), err);
                throw err;
            }
            adapter = undefined as unknown as Adapter & ServiceAdapter;
        }

        // A refusal costs no upstream read, so it names the argument as
        // given rather than the resolved title. A dry run still resolves
        // the plan, because that is how "what would I need to enable?"
        // gets answered.
        const verdict = checkPermission(permissions, service, tier);
        const permission: WriteToolResult['permission'] = verdict.allowed
            ? { allowed: true }
            : { allowed: false, reason: verdict.reason, remedy: verdict.remedy };
        // A preview from a credential whose tier refuses this write writes no
        // audit row. It changes nothing and the token can never apply it, so
        // a row per call would only let a read token grow the permanent
        // audit table as fast as it can ask.
        const quiet = permissions.permits?.(tier, service) === false;

        if (!verdict.allowed && !dryRun) {
            const given = rawTarget(args);
            deny(service, given, verdict.reason);
            throw new ServiceError(
                'PermissionDenied',
                service,
                `${verdict.reason} (${tier} write ${spec.operation} on ${given === '' ? service : `${service}:${given}`})`,
                { remedy: verdict.remedy }
            );
        }

        // A reply, or one still to finish once the lane is released.
        const proceed = async (): Promise<ToolReply | (() => Promise<ToolReply>)> => {
            let plan: WritePlan<Bound>;
            try {
                plan = await spec.plan(args, adapter);
            } catch (err) {
                refused(service, err);
                throw err;
            }

            const record = {
                tool: spec.name,
                service,
                operation: spec.operation,
                tier,
                target: plan.target,
                args: plan.args ?? {},
                caller
            };

            const preview = (extra: Partial<WriteToolResult>): WriteToolResult => ({
                applied: false,
                dry_run: dryRun,
                tool: spec.name,
                service,
                operation: spec.operation,
                tier,
                target: plan.target,
                summary: plan.summary,
                effects: plan.effects,
                noop: plan.noop === true,
                permission,
                ...extra
            });

            const respond = (result: WriteToolResult, text: string): ToolReply => ({
                content: [{ type: 'text' as const, text }],
                structuredContent: result
            });

            // Asked on the preview paths only, never for a no-op, a refusal or
            // an applied write. Reads are not permission-gated, and they write no
            // audit row.
            const advise = async (): Promise<{ fields: Partial<WriteToolResult>; block: string }> => {
                if (spec.crossCheck === undefined || plan.subject === undefined || context.crossChecks === undefined) {
                    return { fields: {}, block: '' };
                }
                let advice: { warnings: string[]; unchecked: string[] };
                try {
                    const subject = typeof plan.subject === 'function' ? await plan.subject() : plan.subject;
                    advice = await context.crossChecks(subject, spec.crossCheck);
                } catch (err) {
                    logger.warn({ tool: spec.name, err }, 'cross-checks threw; previewing without them');
                    advice = { warnings: [], unchecked: ['cross-service checks'] };
                }
                const parts = [
                    advice.warnings.length === 0 ? '' : `Worth checking first:\n${advice.warnings.map(w => `- ${w}`).join('\n')}`,
                    advice.unchecked.length === 0 ? '' : `Could not check: ${advice.unchecked.join(', ')}.`
                ].filter(p => p !== '');
                return {
                    fields: {
                        ...(advice.warnings.length === 0 ? {} : { warnings: advice.warnings }),
                        ...(advice.unchecked.length === 0 ? {} : { unchecked: advice.unchecked })
                    },
                    block: parts.join('\n\n')
                };
            };

            // --- 1. Nothing to do -------------------------------------------------
            if (plan.noop === true) {
                const id = quiet ? undefined : audit.begin(record);
                const next = plan.next ?? [];
                if (id !== undefined) audit.settle(id, 'dry_run', next.length > 0 ? 'no-op: listed only' : 'no-op: already in the requested state');
                if (next.length > 0) {
                    return respond(
                        preview({ ...(id === undefined ? {} : { audit_id: id }), next_steps: next }),
                        `${plan.summary}\n\n${plan.effects.map(e => `- ${e}`).join('\n')}\n\n${next.map(nextStepLine).join('\n')}\n\nNo change was made and no confirmation is needed.`
                    );
                }
                return respond(
                    preview(id === undefined ? {} : { audit_id: id }),
                    `Nothing to do: ${plan.summary} No change was made and no confirmation is needed.`
                );
            }

            // --- 2. dry_run: terminal preview, never gated ------------------------
            //
            // A dry run is deliberately *not* refused when the tier is off. It
            // performs no mutation, and everything it reveals is already
            // reachable through the read tools, so refusing it would withhold
            // nothing while making "what would I need to enable to do this?"
            // unanswerable. The verdict rides along in `permission` instead, so
            // the model learns the write would be refused and can say so.
            if (dryRun) {
                const id = quiet ? undefined : audit.begin(record);
                if (id !== undefined) audit.settle(id, 'dry_run', verdict.allowed ? undefined : verdict.reason);
                const advice = await advise();
                return respond(
                    preview({ ...(id === undefined ? {} : { audit_id: id }), ...advice.fields }),
                    `Dry run: nothing was changed. ${plan.summary}` +
                        (advice.block === '' ? ' ' : `\n\n${advice.block}\n\n`) +
                        (verdict.allowed
                            ? 'Omit `dry_run` to preview it for real and receive a confirmation token.'
                            : `Note that this write would currently be refused: ${verdict.reason}. ${verdict.remedy}`)
                );
            }

            const intent: WriteIntent = {
                tool: spec.name,
                service,
                tier,
                operation: spec.operation,
                target: plan.target,
                ...(plan.args === undefined ? {} : { args: plan.args })
            };

            // --- 4. Confirmation --------------------------------------------------
            if (presented !== undefined) {
                const check = confirm.verifyAndConsume(presented, intent);
                if (!check.ok) {
                    // An already-spent token is the one rejection that does not
                    // get a fresh one. The write it authorised may well have
                    // happened, and handing back a new token invites a model
                    // that lost track to apply it twice; the exact duplicate
                    // single-use exists to prevent. Every other rejection is a
                    // caller mistake with no such risk, so it degrades to a
                    // normal preview carrying the reason.
                    if (check.failure === 'used') {
                        const id = audit.begin(record);
                        audit.settle(id, 'denied', 'confirmation token already used');
                        throw new ServiceError('PermissionDenied', service, 'confirmation token already used', {
                            remedy: check.remedy
                        });
                    }

                    const id = audit.begin(record);
                    audit.settle(id, 'unconfirmed', `confirmation ${check.failure}`);
                    const fresh = confirm.issue(intent);
                    // Finished outside the lane: the cross-checks read other services,
                    // and nothing from here on writes, so no confirm should wait for them.
                    return async () => {
                        const advice = await advise();
                        return scrubbedReply(respond(
                            preview({
                                audit_id: id,
                                ...advice.fields,
                                confirm_error: CONFIRM_REASON[check.failure],
                                confirm_token: fresh
                            }),
                            // `check.remedy` says to call again *without* `confirm`, which is
                            // right when no token comes back and wrong here, because one does,
                            // so both fields carry the reason alone (#312). The text gives the
                            // single next action, worded as the plain preview words it. The
                            // token goes last in both: a reader clipping the trailing word or
                            // the final backticked span gets it, and prose after it would not.
                            // The fresh preview is in the text too, as in a plain preview: a
                            // client that drops structuredContent (#234) would otherwise apply
                            // the new token without seeing what changed since the old one.
                            `Not applied: the confirmation token was rejected. ${CONFIRM_REASON[check.failure]} ${plan.summary}\n\n` +
                                (advice.block === '' ? '' : `${advice.block}\n\n`) +
                                (plan.effects.length === 0 ? '' : `${plan.effects.map(e => `- ${e}`).join('\n')}\n\n`) +
                                `Do not resend the rejected one. To apply this, call ${spec.name} again with ` +
                                `the same arguments plus \`confirm\` set to \`${fresh}\`.`
                        ));
                    };
                }
            } else {
                const id = audit.begin(record);
                audit.settle(id, 'unconfirmed');
                // The token goes in the text as well as in `confirm_token`: not
                // every client forwards structuredContent to the model (#234), and
                // a preview whose text names a field the model cannot see is a
                // handshake it can never complete.
                const token = confirm.issue(intent);
                const advice = await advise();
                return respond(
                    preview({ audit_id: id, confirm_token: token, ...advice.fields }),
                    `Not applied yet. ${plan.summary}\n\n` +
                        (advice.block === '' ? '' : `${advice.block}\n\n`) +
                        `${plan.effects.map(e => `- ${e}`).join('\n')}\n\n` +
                        `To apply this, call ${spec.name} again with the same arguments plus \`confirm\` set to \`${token}\`.`
                );
            }

            // --- 5. Apply ---------------------------------------------------------
            const id = audit.begin(record);
            let outcome: unknown;
            try {
                outcome = await spec.apply(plan, args, adapter);
            } catch (err) {
                audit.settle(id, 'failed', err instanceof Error ? err.message : String(err));
                throw err;
            }

            // Only after a write that actually landed: a failed write changed
            // nothing, and dropping the cache for it would cost every cached
            // library snapshot for no reason.
            library.invalidate();
            audit.settle(id, 'applied');

            // After the write, and guarded: the write has happened, so a follow-up
            // that fails to build must not turn a landed change into an error.
            let nextSteps: NextStep[] = [];
            try {
                nextSteps = spec.followUps?.(outcome, args, plan) ?? [];
            } catch (err) {
                logger.warn({ tool: spec.name, err }, 'followUps threw; reporting the write without next steps');
            }

            // A tool's own sentence is what happened, where the plan's summary
            // is what was asked: a partial or empty result says so in
            // `summary` too, not only in the text.
            const said = spec.applied?.(outcome, plan);
            const landed = spec.landed?.(outcome) ?? true;
            return respond(
                {
                    ...preview({ audit_id: id }),
                    applied: landed,
                    ...(landed ? {} : { noop: true }),
                    ...(said === undefined ? {} : { summary: said }),
                    ...(outcome === undefined ? {} : { result: outcome }),
                    ...(nextSteps.length === 0 ? {} : { next_steps: nextSteps })
                },
                // In the text as well as the field (#234).
                (said ?? `Applied. ${plan.summary}`) + nextSteps.map(step => `\n${nextStepLine(step)}`).join('')
            );
        };

        const finish = async (reply: ToolReply | (() => Promise<ToolReply>)): Promise<ToolReply> => (typeof reply === 'function' ? reply() : reply);
        if (presented === undefined || dryRun) return finish(await proceed());
        // A confirm call holds its instance's lane from the plan's reads to the
        // apply, so the state its token is checked against is still the state
        // it writes over. Everything else runs at once.
        const turn = await inLane(service, signal, proceed);
        if (turn.ran) return finish(turn.value);
        const detail =
            turn.why === 'busy'
                ? `another confirmed write to ${service} was still running after ${LANE_WAIT_MS / 1000} seconds`
                : `the request was cancelled while it waited for another confirmed write to ${service} to finish`;
        deny(service, rawTarget(args), detail);
        // Not a ServiceError: no kind fits, since the service was never asked anything.
        throw new Error(
            `Not applied: ${detail}. Its confirmation token was not used: call ${spec.name} again with the same arguments and token once that write has finished. ` +
                'A token that has expired by then comes back as a fresh preview with a new one.'
        );
    }
}
