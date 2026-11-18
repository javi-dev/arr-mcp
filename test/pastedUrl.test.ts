import { describe, expect, it } from 'vitest';
import { shownValue } from '../src/core/pastedUrl.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { selectAdapters } from '../src/tools/instanceOptions.ts';

const PASSKEY = 'd41d8cd98f00b204e9800998ecf8427e';

describe('shownValue', () => {
    it.each([
        `https://tracker.example/${PASSKEY}/announce`,
        ` https://tracker.example/${PASSKEY}/announce`,
        `<https://tracker.example/${PASSKEY}/announce>`,
        `udp://tracker.example:80/${PASSKEY}`,
        `magnet:?xt=urn:btih:abc&tr=${PASSKEY}`
    ])('leaves out %s', value => {
        expect(shownValue(value)).not.toContain(PASSKEY);
    });

    it.each(['radarr/4k', 'vpn', 'torrent-novpn', 'Alien: Covenant', '42'])('repeats the ordinary value %s', value => {
        expect(shownValue(value)).toBe(value);
    });
});

describe('selectAdapters', () => {
    it('does not repeat a tracker URL passed as an instance', () => {
        const adapters = [{ id: 'radarr', type: 'radarr' }] as unknown as ServiceAdapter[];
        expect(() => selectAdapters(adapters, { instance: `https://tracker.example/${PASSKEY}/announce` })).toThrow(/left out/);
        expect(() => selectAdapters(adapters, { instance: `https://tracker.example/${PASSKEY}/announce` })).not.toThrow(PASSKEY);
    });
});
