import type { TorrentCategory, TorrentClientDefaults, TorrentShareRule } from '../services/types.ts';

/**
 * What a qBittorrent category resolves to once its parents and the client's
 * defaults are taken into account, worked out the way release 5.3.0 does
 * (`SessionImpl::categorySavePath`, `categoryDownloadPath`, `categoryShareLimits`).
 * A preview that read only the category's own fields would promise the wrong
 * folder, or miss a removal the category inherits.
 */

type Categories = ReadonlyMap<string, TorrentCategory>;

const parentOf = (category: string): string => category.slice(0, Math.max(category.lastIndexOf('/'), 0));
const leafOf = (category: string): string => category.slice(category.lastIndexOf('/') + 1);
const trimmed = (path: string): string => path.replace(/\/+$/, '');
const joined = (base: string, path: string): string => (path === '' ? trimmed(base) : `${trimmed(base)}/${path}`);

/** Where a finished torrent of this category is kept under automatic management. */
export function categorySavePath(base: string, categories: Categories, category: string): string {
    if (category === '') return trimmed(base);
    const own = categories.get(category)?.savePath ?? '';
    if (own !== '') return own.startsWith('/') ? trimmed(own) : joined(base, own);
    return joined(categorySavePath(base, categories, parentOf(category)), leafOf(category));
}

/** A category's folder setting, inherited from its parents when it has none of its own. */
const incompleteOption = (categories: Categories, defaults: TorrentClientDefaults, category: string): string | boolean => {
    if (category === '') return defaults.incompleteEnabled;
    const own = categories.get(category)?.downloadPath ?? null;
    return own ?? incompleteOption(categories, defaults, parentOf(category));
};

/**
 * Where an unfinished torrent of this category keeps its data, or undefined when
 * the category uses no incomplete-downloads folder. A parent's disabled folder
 * still lends its name to a child's relative path, as it does in qBittorrent.
 */
export function categoryIncompletePath(categories: Categories, defaults: TorrentClientDefaults, category: string, forced?: string): string | undefined {
    if (category === '') return defaults.incompleteEnabled ? trimmed(defaults.incompletePath) : undefined;
    const option = forced ?? incompleteOption(categories, defaults, category);
    if (option === false) return undefined;
    const path = typeof option === 'string' && option !== '' ? option : leafOf(category);
    if (path.startsWith('/')) return trimmed(path);
    const parent = parentOf(category);
    const parentOption = categories.get(parent)?.downloadPath;
    const base = categoryIncompletePath(categories, defaults, parent, typeof parentOption === 'string' ? parentOption : '');
    return joined(base === undefined || base === '' ? defaults.incompletePath : base, path);
}

const INHERIT = -2;

/** The rule that applies to a torrent: its own, then its category, that category's parents, then the client's. */
function effectiveShare(own: TorrentShareRule, categories: Categories, defaults: TorrentClientDefaults, category: string): TorrentShareRule {
    const chain = [own];
    for (let name = category; name !== ''; name = parentOf(name)) {
        const rule = categories.get(name)?.share;
        if (rule !== undefined) chain.push(rule);
    }
    chain.push(defaults.share);
    const limit = (read: (rule: TorrentShareRule) => number): number => chain.map(read).find(value => value !== INHERIT) ?? -1;
    return {
        action: chain.map(rule => rule.action).find(action => action !== 'Default') ?? 'Default',
        ratio: limit(rule => rule.ratio),
        seedingMinutes: limit(rule => rule.seedingMinutes),
        inactiveMinutes: limit(rule => rule.inactiveMinutes)
    };
}

/** The action that would delete this torrent once it reaches a limit in this category, or undefined when none would. */
export function removalAtLimit(own: TorrentShareRule, categories: Categories, defaults: TorrentClientDefaults, category: string): 'Remove' | 'RemoveWithContent' | undefined {
    const rule = effectiveShare(own, categories, defaults, category);
    if (rule.action !== 'Remove' && rule.action !== 'RemoveWithContent') return undefined;
    return rule.ratio >= 0 || rule.seedingMinutes >= 0 || rule.inactiveMinutes >= 0 ? rule.action : undefined;
}

/** A torrent being added inherits everything. */
export const NO_OWN_SHARE_RULE: TorrentShareRule = { action: 'Default', ratio: INHERIT, seedingMinutes: INHERIT, inactiveMinutes: INHERIT };
