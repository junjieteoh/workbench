import * as React from 'react';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { useStableValueBySignature } from '@/hooks/ui/useStableValueBySignature';
import { withTimeout } from '@/utils/timing/time';

import type { AgentReviewComposerBinding, ComposerAgentReviewModel, ComposerAgentReviewSelection, ComposerAgentReviewTarget } from '../agentReviewComposer';
import { formatAgentReviewMentionToken } from '../agentReviewComposer';
import {
    composerSequenceTargetAddress, formatComposerSequenceAddress, listComposerSequenceChoices, parseComposerAgentSequence,
    replaceComposerSequenceAddress, replaceComposerSequenceInstructions, reorderComposerSequence, resolveComposerSequenceAddress, type ComposerSequenceOrderChange, type ComposerAgentSequence, type ComposerSequenceCatalogEntry,
} from './composerAgentSequence';
import type { ComposerSequenceOption, ComposerSequenceStep } from './ComposerSequencePreview';

export type ComposerSequenceStatus = 'idle' | 'loading' | 'ready' | 'incomplete' | 'unknown' | 'ambiguous' | 'unavailable';
export type ComposerAgentSequencePreview = Readonly<{
    parsed: ComposerAgentSequence | null;
    ready: readonly ComposerAgentReviewSelection[] | null;
    steps: readonly ComposerSequenceStep[] | null;
    options: readonly ComposerSequenceOption[];
    status: ComposerSequenceStatus;
    replace(index: number, key: string): string | null;
    edit(index: number, instructions: string): string | null;
    reorder(change: ComposerSequenceOrderChange): string | null;
}>;

type Scope = {
    resolveModels: AgentReviewComposerBinding['resolveModels'];
    targets: readonly ComposerAgentReviewTarget[];
    session?: string | null;
};
type ModelObservation = { status: 'ready'; models: readonly ComposerAgentReviewModel[] } | { status: 'failed' };
type Catalog = {
    scope: Scope;
    models: ReadonlyMap<string, ModelObservation>;
};
const EMPTY_TARGETS: readonly ComposerAgentReviewTarget[] = [];

function modelCatalog(targets: readonly ComposerAgentReviewTarget[], machine?: Catalog): ComposerSequenceCatalogEntry[] {
    return targets.map(target => {
        const observed = machine?.models.get(buildBackendTargetKey(target.backendTarget));
        return { target, models: observed?.status === 'ready' ? observed.models : [] };
    });
}

function inspectAddress(address: string, catalog: readonly ComposerSequenceCatalogEntry[], machine: Catalog | undefined,
    currentTargetKey?: string | null, currentModelId?: string | null): {
    status: ComposerSequenceStatus; choice: ComposerAgentReviewSelection | null;
} {
    if (!machine) return { status: 'loading', choice: null };
    if (!address.trim()) return { status: 'incomplete', choice: null };
    if (!catalog.length) return { status: 'unavailable', choice: null };
    const result = resolveComposerSequenceAddress(address, catalog);
    // The worker default and a matching model actually running in this session
    // are usable without waiting for unrelated providers to finish probing.
    const matches = result.kind === 'ambiguous' ? result.choices : result.kind === 'resolved' ? [result.selection] : [];
    const current = currentModelId && matches.find(choice => choice.modelId === currentModelId && buildBackendTargetKey(choice.target.backendTarget) === currentTargetKey);
    if (current) return { status: 'ready', choice: current };
    if (result.kind === 'resolved' && result.selection.modelId === null) return { status: 'ready', choice: result.selection };
    if (result.kind === 'ambiguous') return { status: 'ambiguous', choice: null };

    const slash = address.indexOf('/');
    const qualifier = slash >= 0 ? address.slice(0, slash).toLowerCase() : '';
    const named = qualifier ? catalog.filter(({target}) => [composerSequenceTargetAddress(target), target.label].some(label => label.toLowerCase() === qualifier)) : [];
    const relevant = named.length ? named : catalog;
    const observed = relevant.map(({target}) => machine.models.get(buildBackendTargetKey(target.backendTarget)));
    if (observed.some(item => item === undefined)) return { status: 'loading', choice: null };
    if (result.kind === 'resolved') return { status: 'ready', choice: result.selection };
    return { status: observed.some(item => item?.status === 'failed') ? 'unavailable' : 'unknown', choice: null };
}

function displayLabel(choice: ComposerAgentReviewSelection): string {
    return choice.modelId === null ? choice.target.label : choice.target.label + ' · ' + choice.modelLabel;
}

export function useComposerAgentSequence(params: Readonly<{
    text: string;
    binding?: AgentReviewComposerBinding;
    resolveModels?: AgentReviewComposerBinding['resolveModels'];
    successorTargets?: readonly ComposerAgentReviewTarget[];
    currentTargetKey?: string | null;
    currentModelId?: string | null;
    scopeKey?: string | null;
}>): ComposerAgentSequencePreview {
    const parsed = React.useMemo(() => parseComposerAgentSequence(params.text), [params.text]);
    const active = parsed !== null;
    const targets = useStableValueBySignature(params.successorTargets, active ? JSON.stringify(params.successorTargets) ?? '' : '');
    const resolveModels = params.resolveModels ?? params.binding?.resolveModels;
    const scope = React.useMemo<Scope | null>(() => active && resolveModels && targets
        ? { resolveModels, targets, session: params.scopeKey } : null,
        [active, resolveModels, targets, params.scopeKey]);
    const [observed, setObserved] = React.useState<Catalog>();
    React.useEffect(() => {
        if (!scope) return;
        const controller = new AbortController();
        const { signal } = controller;
        setObserved({ scope, models: new Map() });
        for (const target of scope.targets) {
            const key = buildBackendTargetKey(target.backendTarget);
            void (async () => {
                let observation: ModelObservation;
                try {
                    const models = await withTimeout(() => scope.resolveModels(target, signal), NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, 'Sequence model discovery');
                    observation = { status: 'ready', models };
                } catch {
                    observation = { status: 'failed' };
                }
                if (!signal.aborted) setObserved(snapshot => snapshot?.scope === scope
                    ? { ...snapshot, models: new Map(snapshot.models).set(key, observation) } : snapshot);
            })();
        }
        return () => controller.abort();
    }, [scope]);

    const machine = scope && observed?.scope === scope ? observed : undefined;
    const catalog = React.useMemo(() => modelCatalog(scope?.targets ?? EMPTY_TARGETS, machine), [scope, machine]);
    const choices = React.useMemo(() => listComposerSequenceChoices(catalog), [catalog]);
    const options = React.useMemo(() => choices.map(choice => ({
        key: formatComposerSequenceAddress(choice), label: displayLabel(choice),
    })), [choices]);
    const replace = React.useCallback((index: number, key: string) => {
        const stage = parsed?.stages[index];
        const choice = choices.find(item => formatComposerSequenceAddress(item) === key);
        return stage && choice ? replaceComposerSequenceAddress(params.text, stage, choice) : null;
    }, [parsed, params.text, choices]);
    const edit = React.useCallback((index: number, instructions: string) => {
        const stage = parsed?.stages[index];
        return stage ? replaceComposerSequenceInstructions(params.text, stage, instructions) : null;
    }, [parsed, params.text]);

    const first = parsed?.stages[0];
    const picked = params.binding?.selection;
    // A selected model is displayed as a bare provider mention until the
    // assignment moves. Materialize it when rewriting rows to retain the choice.
    const explicitFirst = first && picked?.modelId && params.text.slice(first.start, first.end) === formatAgentReviewMentionToken(picked.target)
        ? picked : null;
    const selectedTarget = first?.implied && catalog.find(({ target }) => buildBackendTargetKey(target.backendTarget) === params.currentTargetKey)?.target;
    const selectedAddress = selectedTarget ? composerSequenceTargetAddress(selectedTarget)
        + (params.currentModelId && params.currentModelId !== 'default' ? '/' + encodeURIComponent(params.currentModelId) : '') : null;
    const firstChoice = explicitFirst ? formatComposerSequenceAddress(explicitFirst) : (selectedAddress ? '@' + selectedAddress : undefined);
    const reorder = (change: ComposerSequenceOrderChange) => parsed && (!first?.implied || firstChoice)
        ? reorderComposerSequence(params.text, parsed, change, firstChoice)
        : null;
    if (!parsed) return { parsed, ready: null, steps: null, options, status: 'idle', replace, edit, reorder };
    const results = parsed.stages.map((stage, index) => {
        if (stage.implied && !selectedAddress) return { status: (machine ? 'unavailable' : 'loading') as ComposerSequenceStatus, choice: null };
        const address = stage.implied ? selectedAddress!
            : index === 0 && explicitFirst ? composerSequenceTargetAddress(explicitFirst.target) + '/' + encodeURIComponent(explicitFirst.modelId!)
            : stage.address;
        return inspectAddress(address, catalog, machine, params.currentTargetKey, params.currentModelId);
    });
    const steps = parsed.stages.map((stage, index) => {
        const choice = results[index].choice;
        return { agentKey: choice ? formatComposerSequenceAddress(choice) : '', agentLabel: choice ? displayLabel(choice) : '@' + stage.address, task: stage.instructions };
    });
    const unresolved = results.find(result => result.status !== 'ready');
    const status = !scope ? 'unavailable' : unresolved?.status ?? (parsed.stages.some(stage => !stage.instructions.trim()) ? 'incomplete' : 'ready');
    const ready = status === 'ready' ? results.map(result => result.choice!) : null;
    return { parsed, ready, steps, options, status, replace, edit, reorder };
}
