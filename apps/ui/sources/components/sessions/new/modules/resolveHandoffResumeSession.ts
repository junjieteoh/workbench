import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { getAgentVendorResumeId, type ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { AgentId } from '@/agents/catalog/catalog';
import type { Session } from '@/sync/domains/state/storageTypes';

export function resolveHandoffResumeSession(params: Readonly<{
    sessions: readonly Session[];
    resumeId: string;
    serverId: string;
    machineId: string;
    agentId: AgentId;
    readServerId(sessionId: string): string | null;
    capabilities?: ResumeCapabilityOptions;
}>): { kind: 'missing' | 'ambiguous' } | { kind: 'existing'; session: Session } {
    const matches = params.sessions.filter(session =>
        session.metadata?.machineId === params.machineId
        && params.readServerId(session.id) === params.serverId
        && resolveAgentIdFromSessionMetadata(session.metadata) === params.agentId
        && getAgentVendorResumeId(session.metadata, params.agentId, params.capabilities) === params.resumeId
    );
    if (matches.length > 1) return { kind: 'ambiguous' };
    return matches[0] ? { kind: 'existing', session: matches[0] } : { kind: 'missing' };
}
