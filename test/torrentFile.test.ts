import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_TORRENT_BYTES, readTorrentFile } from '../src/core/torrentFile.ts';
import { bencode } from './helpers/fakeQbittorrent.ts';

const PASSKEY = 'd41d8cd98f00b204e9800998ecf8427e';
const info = { length: 2048, name: 'Some.Film.mkv', 'piece length': 16384, pieces: 'x'.repeat(20), private: 1 };

describe('readTorrentFile', () => {
    it('reads the name, the v1 id, the private flag and the size', () => {
        const facts = readTorrentFile(bencode({ announce: `https://tracker.example.org/${PASSKEY}/announce`, info }));
        expect(facts).toEqual({
            hash: createHash('sha1').update(bencode(info)).digest('hex'),
            name: 'Some.Film.mkv',
            private: true,
            fileCount: 1,
            sizeBytes: 2048,
            trackers: ['tracker.example.org']
        });
    });

    it('reduces every tracker to its host', () => {
        const facts = readTorrentFile(
            bencode({
                announce: `https://a.example/${PASSKEY}/announce`,
                'announce-list': [[`https://a.example/${PASSKEY}/announce`], [`udp://b.example:80/${PASSKEY}`]],
                info
            })
        );
        expect(facts.trackers).toEqual(['a.example', 'b.example']);
        expect(JSON.stringify(facts)).not.toContain(PASSKEY);
    });

    it('adds up a multi-file torrent', () => {
        const multi = { files: [{ length: 10, path: ['a'] }, { length: 32, path: ['b'] }], name: 'Pack', 'piece length': 16384, pieces: 'x'.repeat(20) };
        expect(readTorrentFile(bencode({ info: multi }))).toMatchObject({ fileCount: 2, sizeBytes: 42, private: false, trackers: [] });
    });

    it('goes by the truncated SHA-256 for a v2 torrent', () => {
        const v2 = { 'meta version': 2, name: 'New', 'piece length': 16384 };
        expect(readTorrentFile(bencode({ info: v2 })).hash).toBe(createHash('sha256').update(bencode(v2)).digest('hex').slice(0, 40));
    });

    it.each([
        ['an empty file', Buffer.alloc(0)],
        ['something that is not bencode', Buffer.from('<html>nope</html>')],
        ['a file cut short', bencode({ info }).subarray(0, 20)],
        ['no info dictionary', bencode({ announce: 'x' })],
        ['no name', bencode({ info: { length: 1 } })],
        ['a string longer than the file', Buffer.from('d4:infod4:name99:xee')],
        ['nesting past the limit', Buffer.from('l'.repeat(64))]
    ])('refuses %s', (_why, bytes) => {
        expect(() => readTorrentFile(bytes)).toThrow(/not a valid \.torrent file/);
    });

    it('refuses a file over the limit before parsing it', () => {
        expect(() => readTorrentFile(Buffer.alloc(MAX_TORRENT_BYTES + 1))).toThrow(/10 MiB/);
    });

    it('never quotes the file in a refusal', () => {
        let message = '';
        try {
            readTorrentFile(Buffer.from(`d8:announce40:https://t.example/${PASSKEY}`));
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).not.toContain(PASSKEY);
    });
});
