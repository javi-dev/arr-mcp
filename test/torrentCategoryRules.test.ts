import { describe, expect, it } from 'vitest';
import type { TorrentCategory, TorrentClientDefaults, TorrentShareRule } from '../src/services/types.ts';
import { NO_OWN_SHARE_RULE, categoryIncompletePath, categorySavePath, removalAtLimit, storageDirectory } from '../src/tools/torrentCategoryRules.ts';

const share = (over: Partial<TorrentShareRule> = {}): TorrentShareRule => ({ ...NO_OWN_SHARE_RULE, ...over });
const category = (over: Partial<TorrentCategory> = {}): TorrentCategory => ({ savePath: '', downloadPath: null, share: share(), ...over });
const defaults = (over: Partial<TorrentClientDefaults> = {}): TorrentClientDefaults => ({
    incompleteEnabled: false,
    incompletePath: '/data/incomplete',
    addsStopped: false,
    stopCondition: 'None',
    share: share({ action: 'Stop', ratio: -1, seedingMinutes: -1, inactiveMinutes: -1 }),
    ...over
});

describe('categorySavePath', () => {
    const categories = new Map([
        ['abs', category({ savePath: '/mnt/abs/' })],
        ['rel', category({ savePath: 'relative' })],
        ['tv', category({ savePath: '/mnt/tv' })],
        ['tv/show', category()],
        ['tv/rel', category({ savePath: 'nested' })],
        ['plain', category()]
    ]);

    it.each([
        ['', '/data/dl'],
        ['abs', '/mnt/abs'],
        ['rel', '/data/dl/relative'],
        ['tv/rel', '/data/dl/nested'],
        ['plain', '/data/dl/plain'],
        ['tv/show', '/mnt/tv/show']
    ])('resolves %j to %s', (name, path) => {
        expect(categorySavePath('/data/dl/', categories, name)).toBe(path);
    });
});

describe('categoryIncompletePath', () => {
    it('is none while nothing enables a folder', () => {
        expect(categoryIncompletePath(new Map([['a', category()]]), defaults(), 'a')).toBeUndefined();
    });

    it('names a category after itself under the global folder', () => {
        expect(categoryIncompletePath(new Map([['a', category()]]), defaults({ incompleteEnabled: true }), 'a')).toBe('/data/incomplete/a');
    });

    it('honours a category that opts out', () => {
        expect(categoryIncompletePath(new Map([['a', category({ downloadPath: false })]]), defaults({ incompleteEnabled: true }), 'a')).toBeUndefined();
    });

    it('takes an absolute folder from the category', () => {
        expect(categoryIncompletePath(new Map([['a', category({ downloadPath: '/mnt/x/' })]]), defaults(), 'a')).toBe('/mnt/x');
    });

    it('inherits an absolute folder from a parent even with the global folder off', () => {
        const categories = new Map([['a', category({ downloadPath: '/mnt/x' })], ['a/b', category()]]);
        expect(categoryIncompletePath(categories, defaults(), 'a/b')).toBe('/mnt/x');
    });

    it('builds a relative folder on its parent, as if the parent had one enabled', () => {
        const categories = new Map([['a', category({ downloadPath: false })], ['a/b', category({ downloadPath: 'rel' })]]);
        expect(categoryIncompletePath(categories, defaults(), 'a/b')).toBe('/data/incomplete/a/rel');
    });
});

describe('removalAtLimit', () => {
    const removing = share({ action: 'RemoveWithContent', ratio: 1 });

    it('finds the action of the category', () => {
        expect(removalAtLimit(NO_OWN_SHARE_RULE, new Map([['a', category({ share: removing })]]), defaults(), 'a')?.action).toBe('RemoveWithContent');
    });

    it('inherits the action and the limit from a parent', () => {
        const categories = new Map([['a', category({ share: removing })], ['a/b', category()]]);
        expect(removalAtLimit(NO_OWN_SHARE_RULE, categories, defaults(), 'a/b')?.action).toBe('RemoveWithContent');
    });

    it('falls back to the client', () => {
        const client = defaults({ share: share({ action: 'Remove', ratio: 2, seedingMinutes: -1, inactiveMinutes: -1 }) });
        expect(removalAtLimit(NO_OWN_SHARE_RULE, new Map(), client, '')?.action).toBe('Remove');
    });

    it('needs a limit to reach', () => {
        const client = defaults({ share: share({ action: 'Remove', ratio: -1, seedingMinutes: -1, inactiveMinutes: -1 }) });
        expect(removalAtLimit(NO_OWN_SHARE_RULE, new Map(), client, '')).toBeUndefined();
    });

    it('lets a limit of the torrent itself count', () => {
        const client = defaults({ share: share({ action: 'Remove', ratio: -1, seedingMinutes: -1, inactiveMinutes: -1 }) });
        expect(removalAtLimit(share({ seedingMinutes: 60 }), new Map(), client, '')?.action).toBe('Remove');
    });

    it('counts a limit on inactivity alone', () => {
        const categories = new Map([['a', category({ share: share({ action: 'Remove', ratio: -1, seedingMinutes: -1, inactiveMinutes: 30 }) })]]);
        expect(removalAtLimit(NO_OWN_SHARE_RULE, categories, defaults(), 'a')?.inactiveMinutes).toBe(30);
    });

    it('lets the action of the torrent itself win', () => {
        expect(removalAtLimit(share({ action: 'Stop' }), new Map([['a', category({ share: removing })]]), defaults(), 'a')).toBeUndefined();
    });
});

describe('storageDirectory', () => {
    it.each([
        ['a single file at the top level', '/data/dl/film.mkv', ['film.mkv'], '/data/dl'],
        ['a single file inside a folder', '/data/dl/Film/film.mkv', ['Film/film.mkv'], '/data/dl'],
        ['several files under one root folder', '/data/dl/Pack', ['Pack/a.mkv', 'Pack/b.mkv'], '/data/dl'],
        ['several files with no root folder', '/data/dl', ['a.mkv', 'sub/b.mkv'], '/data/dl'],
        ['files spread over two folders', '/data/dl', ['a/1.mkv', 'b/2.mkv'], '/data/dl'],
        ['a path that does not fit the files', '/data/dl/Other', ['Pack/a.mkv', 'Pack/b.mkv'], undefined],
        ['no files yet', '/data/dl', [], undefined],
        ['no content path', undefined, ['a.mkv'], undefined]
    ])('handles %s', (_why, content, files, expected) => {
        expect(storageDirectory(content, files)).toBe(expected);
    });
});
