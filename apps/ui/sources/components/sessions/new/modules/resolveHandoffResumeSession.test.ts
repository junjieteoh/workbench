import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveHandoffResumeSession } from './resolveHandoffResumeSession';

function session(id: string, machineId: string, vendorId: string): Session {
    return {
        id, active: false, metadata: { flavor: 'claude', machineId, claudeSessionId: vendorId },
    } as Session;
}

const source = session('existing', 'machine', 'claude-native-id');
const request = {
    resumeId: 'claude-native-id', serverId: 'relay', machineId: 'machine', agentId: 'claude' as const,
    readServerId: (id: string) => id === 'other-relay' ? 'elsewhere' : 'relay',
};

describe('resolveHandoffResumeSession', () => {
    it('returns the original Happier session for a known vendor resume ID on this machine and relay', () => {
        expect(resolveHandoffResumeSession({
            ...request, sessions: [source, session('wrong-machine', 'elsewhere', request.resumeId), session('other-relay', 'machine', request.resumeId)],
        })).toEqual({ kind: 'existing', session: source });
    });

    it('leaves vendor-only resume IDs to normal session creation', () => {
        expect(resolveHandoffResumeSession({ ...request, sessions: [session('different', 'machine', 'other-native-id')] }))
            .toEqual({ kind: 'missing' });
    });

    it('does not choose arbitrarily between duplicate Happier records', () => {
        expect(resolveHandoffResumeSession({ ...request, sessions: [source, session('duplicate', 'machine', request.resumeId)] }))
            .toEqual({ kind: 'ambiguous' });
    });
});
