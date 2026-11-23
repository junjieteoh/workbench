import * as React from 'react';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore } from '@/agents/catalog/catalog';
import { getMachineCapabilitiesCacheState, prefetchMachineCapabilitiesIfStale } from '@/hooks/server/useMachineCapabilitiesCache';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { getModelOptionsForAgentType, getModelOptionsForModes, getModelOptionsForPreflightModelList } from '@/sync/domains/models/modelOptions';
import type { Settings } from '@/sync/domains/settings/settings';
import { discoverMachineModels } from '@/sync/ops/modelDiscovery';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { buildSessionConnectedServicesBindings, readConnectedServicesBindingsFromMetadata } from './hooks/useSessionConnectedServicesAuthSwitch';
import type { AgentReviewComposerBinding, ComposerAgentReviewModel, ComposerAgentReviewSelection, ComposerAgentReviewTarget } from './agentReviewComposer';

export function useSessionAgentReviewComposer(params: Readonly<{
    enabled: boolean;
    entries: readonly ResolvedBackendCatalogEntry[];
    machineId: string | null | undefined;
    serverId: string | null | undefined;
    cwd?: string | null;
    profileId?: string | null;
    settings: Settings;
    metadata?: unknown;
    selection: ComposerAgentReviewSelection | null;
    onSelectionChange: AgentReviewComposerBinding['onSelectionChange'];
}>): AgentReviewComposerBinding | undefined {
    const { machineId, serverId, cwd, profileId, metadata, settings, entries, selection, onSelectionChange } = params;
    const matchesTargetPrefix = React.useCallback((query: string) => !!query && entries.some(entry =>
        [entry.title, entry.builtInAgentId ?? entry.targetKey].some(value => value.toLowerCase().startsWith(query.toLowerCase()))
    ), [entries]);
    const resolveTargets = React.useCallback(async (signal?: AbortSignal) => {
        if (!machineId || signal?.aborted) return [];
        await prefetchMachineCapabilitiesIfStale({ machineId, serverId, staleMs: 60_000, request: { requests: [{ id: 'tool.executionRuns' }] } });
        const backends = extractExecutionRunsBackendsFromMachineCapabilitiesState(getMachineCapabilitiesCacheState(machineId, serverId));
        if (!backends) throw new Error('Review capabilities unavailable');
        // A conversational review uses a bounded, read-only delegate. The review intent is for diffs.
        const available = new Set(resolveExecutionRunAvailableBackends(backends, 'delegate'));
        return entries.filter(entry => available.has(entry.targetKey) || available.has(entry.providerAgentId))
            .map(entry => ({ agentId: entry.providerAgentId, backendTarget: entry.target, label: entry.title }));
    }, [machineId, serverId, entries]);
    const resolveModels = React.useCallback(async (target: ComposerAgentReviewTarget, signal?: AbortSignal) => {
        if (!machineId || signal?.aborted) return [];
        const core = getAgentCore(target.agentId);
        let source: ComposerAgentReviewModel['source'];
        let options = core.model.supportsSelection ? getModelOptionsForAgentType(target.agentId) : getModelOptionsForModes(['default']);
        if (core.model.supportsSelection && core.model.dynamicProbe !== 'static-only') {
            const probe = resolveNewSessionCapabilityProbeContext({ backendTarget: target.backendTarget, settings, sessionMetadata: metadata });
            const connectedServices = buildSessionConnectedServicesBindings({
                supportedServiceIds: core.connectedServices?.supportedServiceIds ?? [],
                bindingsByServiceId: readConnectedServicesBindingsFromMetadata(metadata, target.agentId),
            });
            const cacheKey = buildDynamicModelProbeCacheKey({
                machineId, serverId: serverId ?? null, targetKey: buildBackendTargetKey(target.backendTarget), cwd, connectedServices,
                extraKeySuffixParts: [...(probe?.cacheKeySuffixParts ?? []), ...(profileId ? ['profile:' + profileId] : [])],
            });
            if (!cacheKey) throw new Error('Review model scope unavailable');
            const entry = await discoverMachineModels({
                cacheKey, machineId, serverId: serverId ?? '', backendTarget: target.backendTarget, agentType: target.agentId,
                capabilityParams: { timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, ...(profileId ? { profileId } : {}),
                    ...probe?.capabilityParams, connectedServices, ...(cwd ? { cwd } : {}) },
            });
            if (entry?.kind !== 'success') throw new Error('Review model discovery unavailable');
            // The native picker retains the last observed list, then the provider's
            // catalog when live discovery fails. Keep that choice explicit in each row.
            source = entry.staticFallback ? 'catalog' : entry.errorUpdatedAt !== undefined ? 'cached' : undefined;
            options = getModelOptionsForPreflightModelList(entry.value);
        }
        return options.filter(option => option.value !== 'custom').map(option => ({ id: option.value === 'default' ? null : option.value, label: option.label, ...(source ? { source } : {}) }));
    }, [machineId, serverId, cwd, profileId, metadata, settings]);
    return React.useMemo(() => params.enabled && machineId ? { matchesTargetPrefix, resolveTargets, resolveModels, selection, onSelectionChange } : undefined,
        [params.enabled, machineId, matchesTargetPrefix, resolveTargets, resolveModels, selection, onSelectionChange]);
}
