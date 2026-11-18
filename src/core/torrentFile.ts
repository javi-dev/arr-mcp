import { createHash } from 'node:crypto';
import { trackerHost } from './torrentGuards.ts';

/**
 * Reads what a preview needs out of a `.torrent` file: its name, id, whether it
 * is private and where it announces, so the person approving an upload sees
 * what the bytes are. Tracker URLs are reduced to hosts here and go no further.
 */

/** Far above any real metainfo file, and small enough to hold in memory on every preview. */
export const MAX_TORRENT_BYTES = 10 * 1024 * 1024;

const MAX_DEPTH = 32;

type Value = number | Buffer | Value[] | Map<string, Value>;

class Reader {
    readonly bytes: Buffer;
    at = 0;
    /** Where the top-level `info` dictionary sits, because its id is the hash of those exact bytes. */
    info: Buffer | undefined;

    constructor(bytes: Buffer) {
        this.bytes = bytes;
    }

    value(depth: number): Value {
        if (depth > MAX_DEPTH) throw new Error('nested too deeply');
        const c = this.bytes[this.at];
        if (c === undefined) throw new Error('ended early');
        if (c === 0x69) return this.int();
        if (c === 0x6c) return this.list(depth);
        if (c === 0x64) return this.dict(depth);
        return this.string();
    }

    int(): number {
        const end = this.bytes.indexOf(0x65, this.at);
        if (end < 0) throw new Error('unterminated integer');
        const text = this.bytes.toString('latin1', this.at + 1, end);
        if (!/^-?\d+$/.test(text)) throw new Error('bad integer');
        this.at = end + 1;
        return Number(text);
    }

    string(): Buffer {
        const colon = this.bytes.indexOf(0x3a, this.at);
        if (colon < 0) throw new Error('unterminated string length');
        const text = this.bytes.toString('latin1', this.at, colon);
        if (!/^\d+$/.test(text)) throw new Error('bad string length');
        const end = colon + 1 + Number(text);
        if (end > this.bytes.length) throw new Error('string runs past the end');
        this.at = end;
        return this.bytes.subarray(colon + 1, end);
    }

    list(depth: number): Value[] {
        this.at += 1;
        const out: Value[] = [];
        while (this.bytes[this.at] !== 0x65) out.push(this.value(depth + 1));
        this.at += 1;
        return out;
    }

    dict(depth: number): Map<string, Value> {
        this.at += 1;
        const out = new Map<string, Value>();
        while (this.bytes[this.at] !== 0x65) {
            const key = this.string().toString('latin1');
            const start = this.at;
            out.set(key, this.value(depth + 1));
            if (depth === 0 && key === 'info') this.info = this.bytes.subarray(start, this.at);
        }
        this.at += 1;
        return out;
    }
}

type TorrentFileFacts = {
    /** The id qBittorrent will list it under. */
    hash: string;
    name: string;
    private: boolean;
    fileCount: number;
    sizeBytes: number;
    trackers: string[];
};

const text = (v: Value | undefined): string | undefined => (Buffer.isBuffer(v) ? v.toString('utf8') : undefined);

/** Every announce URL, reduced to its host. */
function hosts(root: Map<string, Value>): string[] {
    const tiers = root.get('announce-list');
    const urls = [text(root.get('announce')), ...(Array.isArray(tiers) ? tiers.flatMap(t => (Array.isArray(t) ? t.map(text) : [])) : [])];
    return [...new Set(urls.flatMap(u => (u === undefined ? [] : (trackerHost(u) ?? []))))];
}

/** Throws a plain `Error` naming what is wrong; the bytes themselves never reach the message. */
export function readTorrentFile(bytes: Buffer): TorrentFileFacts {
    if (bytes.length > MAX_TORRENT_BYTES) throw new Error('larger than the 10 MiB limit');
    const reader = new Reader(bytes);
    let root: Value;
    try {
        root = reader.value(0);
    } catch (err) {
        throw new Error(`not a valid .torrent file: ${(err as Error).message}`, { cause: err });
    }
    const info = root instanceof Map ? root.get('info') : undefined;
    if (!(root instanceof Map) || !(info instanceof Map) || reader.info === undefined) throw new Error('not a valid .torrent file: no info dictionary');

    const name = text(info.get('name.utf-8')) ?? text(info.get('name'));
    if (name === undefined || name === '') throw new Error('not a valid .torrent file: no name');

    // A v2 or hybrid torrent goes by its truncated SHA-256; a v1 torrent by its SHA-1.
    const v2 = info.get('meta version') === 2;
    const hash = v2 ? createHash('sha256').update(reader.info).digest('hex').slice(0, 40) : createHash('sha1').update(reader.info).digest('hex');

    const files = info.get('files');
    const sizes = Array.isArray(files) ? files.map(f => (f instanceof Map ? f.get('length') : undefined)) : [info.get('length')];
    return {
        hash,
        name,
        private: info.get('private') === 1,
        fileCount: Array.isArray(files) ? files.length : 1,
        sizeBytes: sizes.reduce<number>((sum, n) => sum + (typeof n === 'number' ? n : 0), 0),
        trackers: hosts(root)
    };
}
