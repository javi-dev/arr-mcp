import * as z from 'zod/v4';
import type { AnyServiceConfig } from '../../src/config/schema.ts';
import { WriteAudit } from '../../src/core/audit.ts';
import { ConfirmTokens } from '../../src/core/confirm.ts';
import type { LibraryLoader } from '../../src/tools/library.ts';
import { registerWriteTool, type WriteToolResult } from '../../src/tools/write.ts';

type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent: WriteToolResult }>;

/**
 * Another confirmed write to the instance `service` names, as a second tool
 * would send it: for a test that needs a write waiting behind, or ahead of,
 * the tool it exercises. The lanes are shared by every registration, so this
 * one queues with the real tool's.
 */
export function otherWrite(service: string) {
    let handler: Handler = () => Promise.reject(new Error('not registered'));
    let gate: Promise<void> = Promise.resolve();
    let open = (): void => undefined;
    const server = {
        registerTool(_name: string, config: { inputSchema: z.ZodObject }, h: Handler) {
            handler = args => h(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const allowed = { permissions: { safe_write: true, destructive: true } } as unknown as AnyServiceConfig;
    registerWriteTool(
        server as never,
        {
            permissions: { get: () => allowed },
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: () => undefined } as unknown as LibraryLoader
        },
        {
            name: 'other_write',
            title: 'Another write',
            description: 'A write to the same instance.',
            inputSchema: z.object({ id: z.string() }),
            service,
            operation: 'other_write',
            tier: 'safe',
            plan: ({ id }) => Promise.resolve({ target: id, summary: `Change ${id}.`, effects: [`Changes ${id}.`] }),
            apply: async () => {
                await gate;
                return { changed: true };
            }
        }
    );

    return {
        /** Previews and confirms it; its apply waits for `release` when `hold` was called first. */
        async confirm(id = '1'): Promise<WriteToolResult> {
            const token = (await handler({ id })).structuredContent.confirm_token;
            return (await handler({ id, confirm: token })).structuredContent;
        },
        /** Makes the next confirm hold the instance until `release`. */
        hold(): void {
            gate = new Promise<void>(resolve => {
                open = resolve;
            });
        },
        release: (): void => open()
    };
}
