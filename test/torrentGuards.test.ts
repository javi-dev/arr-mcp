import { describe, expect, it } from 'vitest';
import { allowedPath, downloadHost, renamedPath, trackerHost } from '../src/core/torrentGuards.ts';

const ROOTS = ['/data/torrents', '/data/media'];

describe('allowedPath', () => {
    it.each([
        ['/data/torrents', '/data/torrents'],
        ['/data/media/movies/', '/data/media/movies'],
        ['/data//torrents/x', '/data/torrents/x']
    ])('accepts %s as %s', (given, normal) => {
        expect(allowedPath('qb', given, ROOTS)).toBe(normal);
    });

    it.each([
        ['outside the roots', '/etc/passwd'],
        ['a sibling sharing a prefix', '/data/torrents-old/x'],
        ['the parent of a root', '/data'],
        ['a climb out of a root', '/data/torrents/../../etc'],
        ['a dot segment', '/data/torrents/./x'],
        ['a relative path', 'data/torrents'],
        ['a backslash', '/data/torrents\\..\\x'],
        ['a newline', '/data/torrents/x\n/etc'],
        ['surrounding whitespace', ' /data/torrents']
    ])('refuses %s', (_why, path) => {
        expect(() => allowedPath('qb', path, ROOTS)).toThrow();
    });

    it('refuses a URL pasted as a path without repeating it', () => {
        const path = '/https://tracker.example/d41d8cd98f00b204e9800998ecf8427e/announce';
        let message = '';
        try {
            allowedPath('qb', path, ROOTS);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('is a URL');
        expect(message).not.toContain('d41d8cd98f00b204e9800998ecf8427e');
    });

    it('names the allowed roots in its remedy', () => {
        expect(() => allowedPath('qb', '/etc', ROOTS)).toThrow(expect.objectContaining({ remedy: expect.stringContaining('/data/torrents, /data/media') }));
    });
});

describe('renamedPath', () => {
    const files = ['Pack/a.mkv', 'Pack/sub/b.mkv'];

    it('keeps a rename inside the root folder', () => {
        expect(renamedPath('qb', 'Pack/a.mkv', 'Pack/sub/c.mkv', files)).toBe('Pack/sub/c.mkv');
    });

    it('keeps a single-file torrent at the top level', () => {
        expect(renamedPath('qb', 'a.mkv', 'b.mkv', ['a.mkv'])).toBe('b.mkv');
        // A colon after a scheme's name is a file name, not a URL.
        expect(renamedPath('qb', 'a.mkv', 'FTP:Archive.mkv', ['a.mkv'])).toBe('FTP:Archive.mkv');
        expect(renamedPath('qb', 'Series/a.mkv', 'Series/FTP:Archive.mkv#1', ['Series/a.mkv'])).toBe('Series/FTP:Archive.mkv#1');
        expect(() => renamedPath('qb', 'a.mkv', 'sub/b.mkv', ['a.mkv'])).toThrow(/leave the torrent/);
    });

    it.each([
        ['another folder', 'Other/a.mkv'],
        ['the top level', 'a.mkv'],
        ['a climb', 'Pack/../../etc/passwd'],
        ['an absolute path', '/etc/passwd'],
        ['a backslash', 'Pack\\a.mkv'],
        ['an empty segment', 'Pack//a.mkv'],
        ['a control character', 'Pack/a\n.mkv']
    ])('refuses %s', (_why, target) => {
        expect(() => renamedPath('qb', 'Pack/a.mkv', target, files)).toThrow();
    });

    it('refuses a file the torrent does not have, and a name already taken', () => {
        expect(() => renamedPath('qb', 'Pack/x.mkv', 'Pack/y.mkv', files)).toThrow(/no such file/);
        expect(() => renamedPath('qb', 'Pack/a.mkv', 'Pack/sub/b.mkv', files)).toThrow(/already has that name/);
    });
});

describe('trackerHost', () => {
    it('keeps only the host of a URL that carries a passkey', () => {
        expect(trackerHost('https://user:secret@Tracker.Example.org:443/abc123/announce?passkey=abc123')).toBe('tracker.example.org');
    });

    it('masks a host label that looks like a passkey', () => {
        expect(trackerHost('https://d41d8cd98f00b204e9800998ecf8427e.tracker.example.org/announce')).toBe('***.tracker.example.org');
    });

    it.each(['** [DHT] **', '** [PeX] **', '', 'not a url'])('has no host for %j', value => {
        expect(trackerHost(value)).toBeUndefined();
    });
});

describe('downloadHost', () => {
    it('answers with the host alone', () => {
        expect(downloadHost('qb', 'https://indexer.example/get/1.torrent?passkey=abc')).toBe('indexer.example');
    });

    it.each([
        ['another scheme', 'file:///etc/passwd'],
        ['embedded credentials', 'https://user:pass@indexer.example/x'],
        ['a second URL on a new line', 'https://a.example/x\nhttps://b.example/y'],
        ['something that is not a URL', 'indexer.example/x']
    ])('refuses %s without repeating it', (_why, raw) => {
        let message = '';
        try {
            downloadHost('qb', raw);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).not.toBe('');
        expect(message).not.toContain('pass@');
        expect(message).not.toContain('indexer.example');
    });
});
