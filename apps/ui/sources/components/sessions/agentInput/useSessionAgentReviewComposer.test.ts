import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSessionAgentReviewComposer } from './useSessionAgentReviewComposer';

const { prefetch, snapshot, discover } = vi.hoisted(() => ({ prefetch: vi.fn(), snapshot: vi.fn(), discover: vi.fn() }));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    prefetchMachineCapabilitiesIfStale: prefetch, getMachineCapabilitiesCacheState: snapshot,
}));
vi.mock('@/sync/ops/modelDiscovery', () => ({ discoverMachineModels: discover }));

describe('machine-scoped review mentions', () => {
    it('waits for a mention, targets only enabled delegates, and probes the chosen model in its connection context', async () => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: ['claude', 'gemini', 'codex'], acpCatalogSettingsV1: { v: 2, backends: [] },
        });
        snapshot.mockReturnValue({ status: 'loaded', snapshot: { response: { results: {
            'tool.executionRuns': { ok: true, data: { backends: {
                claude: { available: true, intents: ['delegate'] }, gemini: { available: true, intents: ['review'] },
                codex: { available: false, intents: ['delegate'] }, droid: { available: true, intents: ['delegate'] },
            } } },
        } } } });
        const hook = await renderHook(() => useSessionAgentReviewComposer({
            enabled: true, entries, machineId: 'machine-a', serverId: 'relay-a', cwd: '/project',
            settings: settingsDefaults, profileId: 'work', selection: null, onSelectionChange: vi.fn(),
        }));
        const binding = hook.getCurrent()!;
        expect(binding.matchesTargetPrefix('clau')).toBe(true);
        expect(binding.matchesTargetPrefix('README')).toBe(false);
        expect(prefetch).not.toHaveBeenCalled();
        expect(discover).not.toHaveBeenCalled();
        const targets = await binding.resolveTargets();
        expect(prefetch).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a', serverId: 'relay-a' }));
        expect(targets.map(target => target.agentId)).toEqual(['claude']);
        discover.mockResolvedValue({ kind: 'success', value: { availableModels: [{ id: 'model-1', name: 'Test model' }], supportsFreeform: false } });
        await binding.resolveModels(targets[0]);
        expect(discover).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a', serverId: 'relay-a', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            capabilityParams: expect.objectContaining({ profileId: 'work', cwd: '/project' }),
        }));
        discover.mockResolvedValue({ kind: 'error' });
        await expect(binding.resolveModels(targets[0])).rejects.toThrow();
        await hook.unmount();
    });
});
