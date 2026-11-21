import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src/core/errors.ts';
import { chooseOne, PROFILE_MATCH } from '../src/tools/chooseOne.ts';

/**
 * Which kind each refusal carries (#29). Something missing is `NotFound`; a
 * request that names nothing, or names more than one option that exists, is
 * `InvalidRequest`, so it does not render as "radarr not found" while every
 * option it lists is there.
 */

type Profile = { id: number; name: string; display: string };
const profile = (id: number, name: string): Profile => ({ id, name, display: name });
const choose = (options: readonly Profile[], requested: string | undefined) =>
    chooseOne(options, requested, PROFILE_MATCH, p => `${p.display} (id ${p.id})`, 'quality profile', 'radarr');

const refusal = (fn: () => unknown): ServiceError => {
    try {
        fn();
    } catch (err) {
        if (err instanceof ServiceError) return err;
        throw err;
    }
    throw new Error('expected a refusal');
};

const two = [profile(8, 'Balanced 2160p'), profile(12, 'Balanced 2160p Plus')];

describe('chooseOne refusals', () => {
    it('reports a service with no options as not found', () => {
        const err = refusal(() => choose([], undefined));
        expect(err.kind).toBe('NotFound');
        expect(err.message).toMatch(/^radarr not found: radarr has no quality profile configured/);
    });

    it('reports a name that matches nothing as not found', () => {
        const err = refusal(() => choose(two, 'Remux'));
        expect(err.kind).toBe('NotFound');
        expect(err.message).toMatch(/^radarr not found: no quality profile on radarr matches "Remux"/);
    });

    it('reports an empty name as not found', () => {
        const err = refusal(() => choose(two, '  '));
        expect(err.kind).toBe('NotFound');
        expect(err.message).toMatch(/^radarr not found: an empty quality profile matches nothing on radarr/);
    });

    it('reports a name that matches several options as an invalid request that lists them', () => {
        const err = refusal(() => choose(two, 'Balanced'));
        expect(err.kind).toBe('InvalidRequest');
        expect(err.message).toMatch(/^radarr invalid request: "Balanced" matches more than one quality profile on radarr/);
        expect(err.remedy).toContain('Balanced 2160p (id 8); Balanced 2160p Plus (id 12)');
    });

    it('reports several options and none named as an invalid request that lists them', () => {
        const err = refusal(() => choose(two, undefined));
        expect(err.kind).toBe('InvalidRequest');
        expect(err.message).toMatch(/^radarr invalid request: radarr has several quality profiles and none was named/);
        expect(err.remedy).toContain('Balanced 2160p (id 8); Balanced 2160p Plus (id 12)');
    });

    it('still chooses without refusing when the request is clear', () => {
        expect(choose(two, '12').id).toBe(12);
        expect(choose(two, 'balanced 2160p').id).toBe(8);
        expect(choose([profile(3, 'Any')], undefined).id).toBe(3);
    });
});
