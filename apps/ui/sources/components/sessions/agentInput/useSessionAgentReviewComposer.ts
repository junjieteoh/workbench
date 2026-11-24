import * as React from 'react';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore } from '@/agents/catalog/catalog';
import { getMachineCapabilitiesCacheState, prefetchMachineCapabilitiesIfStale } from '@/hooks/server/useMachineCapabilitiesCache';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import { readDynamicModelProbeCache, subscribeDynamicModelProbeCache, type DynamicModelProbeCacheEntry } from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { getModelOptionsForAgentType, getModelOptionsForModes, getModelOptionsForPreflightModelList } from '@/sync/domains/models/modelOptions';
import type { Settings } from '@/sync/domains/settings/settings';
import { discoverMachineModels } from '@/sync/ops/modelDiscovery';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { resolveNewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { buildSessionConnectedServicesBindings, readConnectedServicesBindingsFromMetadata } from './hooks/useSessionConnectedServicesAuthSwitch';
import type { AgentReviewComposerBinding, ComposerAgentReviewModel, ComposerAgentReviewSelection, ComposerAgentReviewTarget } from './agentReviewComposer';

function modelChoices(target: ComposerAgentReviewTarget, entry?: DynamicModelProbeCacheEntry): readonly ComposerAgentReviewModel[] {
    const core = getAgentCore(target.agentId);
    const options = entry?.kind === 'success' ? getModelOptionsForPreflightModelList(entry.value)
        : core.model.supportsSelection ? getModelOptionsForAgentType(target.agentId) : getModelOptionsForModes(['default']);
    const source = entry?.kind === 'success'
        ? entry.staticFallback ? 'catalog' : entry.errorUpdatedAt !== undefined ? 'cached' : undefined
        : 'catalog';
    return options.filter(option => option.value !== 'custom').map(option => ({
        id: option.value === 'default' ? null : option.value,
        label: option.label,
        ...(source && option.value !== 'default' ? { source } : {}),
    }));
}

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
    const peekTargets = React.useCallback((intent: 'delegate' | 'plan' = 'delegate') => {
        if (!machineId) return null;
        const backends = extractExecutionRunsBackendsFromMachineCapabilitiesState(getMachineCapabilitiesCacheState(machineId, serverId));
        if (!backends) return null;
        // A conversational review uses a bounded, read-only delegate. The review intent is for diffs.
        const available = new Set(resolveExecutionRunAvailableBackends(backends, intent));
        return entries.filter(entry => available.has(entry.targetKey) || available.has(entry.providerAgentId))
            .map(entry => ({ agentId: entry.providerAgentId, backendTarget: entry.target, label: entry.title }));
    }, [machineId, serverId, entries]);
    const resolveTargets = React.useCallback(async (signal?: AbortSignal, intent: 'delegate' | 'plan' = 'delegate') => {
        if (!machineId || signal?.aborted) return [];
        await prefetchMachineCapabilitiesIfStale({ machineId, serverId, staleMs: 60_000, request: { requests: [{ id: 'tool.executionRuns' }] } });
        const targets = peekTargets(intent);
        if (!targets) throw new Error('Review capabilities unavailable');
        return targets;
    }, [machineId, serverId, peekTargets]);
    const modelRequest = React.useCallback((target: ComposerAgentReviewTarget) => {
        const core = getAgentCore(target.agentId);
        if (!machineId || !core.model.supportsSelection || core.model.dynamicProbe === 'static-only') return null;
        const probe = resolveNewSessionCapabilityProbeContext({ backendTarget: target.backendTarget, settings, sessionMetadata: metadata });
        const connectedServices = buildSessionConnectedServicesBindings({
            supportedServiceIds: core.connectedServices?.supportedServiceIds ?? [],
            bindingsByServiceId: readConnectedServicesBindingsFromMetadata(metadata, target.agentId),
        });
        const cacheKey = buildDynamicModelProbeCacheKey({
            machineId, serverId: serverId ?? null, targetKey: buildBackendTargetKey(target.backendTarget), cwd, connectedServices,
            extraKeySuffixParts: [...(probe?.cacheKeySuffixParts ?? []), ...(profileId ? ['profile:' + profileId] : [])],
        });
        if (!cacheKey) return null;
        return {
            cacheKey, machineId, serverId: serverId ?? '', backendTarget: target.backendTarget, agentType: target.agentId,
            capabilityParams: { timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, ...(profileId ? { profileId } : {}),
                ...probe?.capabilityParams, connectedServices, ...(cwd ? { cwd } : {}) },
        };
    }, [machineId, serverId, cwd, profileId, metadata, settings]);
    const peekModels = React.useCallback((target: ComposerAgentReviewTarget) => {
        const request = modelRequest(target);
        if (!request) return modelChoices(target);
        const entry = readDynamicModelProbeCache(request.cacheKey);
        return entry?.kind === 'success' ? modelChoices(target, entry) : null;
    }, [modelRequest]);
    const subscribeModels = React.useCallback<NonNullable<AgentReviewComposerBinding['subscribeModels']>>((targets, onChange) => {
        const subscriptions = targets.flatMap(target => {
            const request = modelRequest(target);
            return request ? [subscribeDynamicModelProbeCache(request.cacheKey, onChange)] : [];
        });
        return () => subscriptions.forEach(unsubscribe => unsubscribe());
    }, [modelRequest]);
    const resolveModels = React.useCallback(async (target: ComposerAgentReviewTarget, signal?: AbortSignal) => {
        if (!machineId || signal?.aborted) return [];
        const request = modelRequest(target);
        if (!request) return modelChoices(target);
        const entry = await discoverMachineModels(request);
        if (entry?.kind !== 'success') throw new Error('Review model discovery unavailable');
        return modelChoices(target, entry);
    }, [machineId, modelRequest]);
    return React.useMemo(() => params.enabled && machineId ? { matchesTargetPrefix, peekTargets, resolveTargets, resolveModels, peekModels, subscribeModels, selection, onSelectionChange } : undefined,
        [params.enabled, machineId, matchesTargetPrefix, peekTargets, resolveTargets, resolveModels, peekModels, subscribeModels, selection, onSelectionChange]);
}
