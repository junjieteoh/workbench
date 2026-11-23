import * as React from 'react';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { useStableValueBySignature } from '@/hooks/ui/useStableValueBySignature';
import { withTimeout } from '@/utils/timing/time';

import type { AgentReviewComposerBinding, ComposerAgentReviewModel, ComposerAgentReviewSelection, ComposerAgentReviewTarget } from '../agentReviewComposer';
import { formatAgentReviewMentionToken } from '../agentReviewComposer';
import {
    composerSequenceTargetAddress, formatComposerSequenceAddress, listComposerSequenceChoices, parseComposerAgentSequence,
    replaceComposerSequenceAddress, resolveComposerSequenceAddress, type ComposerAgentSequence, type ComposerSequenceCatalogEntry,
} from './composerAgentSequence';
import type { ComposerSequenceOption, ComposerSequenceStep } from './ComposerSequencePreview';

export type ComposerSequenceStatus = 'idle' | 'loading' | 'ready' | 'incomplete' | 'unknown' | 'ambiguous' | 'unavailable';
export type ComposerAgentSequencePreview = Readonly<{
    parsed: ComposerAgentSequence | null;
    ready: { planner: ComposerAgentReviewSelection; successor: ComposerAgentReviewSelection } | null;
    steps: readonly [ComposerSequenceStep, ComposerSequenceStep] | null;
    optionsByStep: readonly [readonly ComposerSequenceOption[], readonly ComposerSequenceOption[]];
    status: ComposerSequenceStatus;
    replace(index: 0 | 1, key: string): string | null;
}>;

type Scope = Pick<AgentReviewComposerBinding, 'resolveTargets' | 'resolveModels'> & {
    successors?: readonly ComposerAgentReviewTarget[];
    session?: string | null;
};
type ModelObservation = { status: 'ready'; models: readonly ComposerAgentReviewModel[] } | { status: 'failed' };
type Catalog = {
    scope: Scope;
    planners: readonly ComposerAgentReviewTarget[];
    successors: readonly ComposerAgentReviewTarget[];
    models: ReadonlyMap<string, ModelObservation>;
    unavailable: boolean;
};
const EMPTY_TARGETS: readonly ComposerAgentReviewTarget[] = [];

function choicesForRole(targets: readonly ComposerAgentReviewTarget[], machine?: Catalog): ComposerSequenceCatalogEntry[] {
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
    if (machine.unavailable) return { status: 'unavailable', choice: null };
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
    successorTargets?: readonly ComposerAgentReviewTarget[];
    currentTargetKey?: string | null;
    currentModelId?: string | null;
    scopeKey?: string | null;
}>): ComposerAgentSequencePreview {
    const parsed = React.useMemo(() => parseComposerAgentSequence(params.text), [params.text]);
    const active = parsed !== null && !!params.binding;
    const successors = useStableValueBySignature(params.successorTargets, active ? JSON.stringify(params.successorTargets) ?? '' : '');
    const resolveTargets = params.binding?.resolveTargets;
    const resolveModels = params.binding?.resolveModels;
    const scope = React.useMemo<Scope | null>(() => active && resolveTargets && resolveModels
        ? { resolveTargets, resolveModels, successors, session: params.scopeKey } : null,
        [active, resolveTargets, resolveModels, successors, params.scopeKey]);
    const [observed, setObserved] = React.useState<Catalog>();
    React.useEffect(() => {
        if (!scope) return;
        const controller = new AbortController();
        const { signal } = controller;
        const load = async () => {
            let planners: readonly ComposerAgentReviewTarget[];
            try {
                planners = await withTimeout(() => scope.resolveTargets(signal, 'plan'), NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, 'Sequence planner discovery');
            } catch {
                if (!signal.aborted) setObserved({ scope, planners: [], successors: [], models: new Map(), unavailable: true });
                return;
            }
            if (signal.aborted) return;
            const successors = scope.successors ?? planners;
            const targets = new Map([...planners, ...successors].map(target => [buildBackendTargetKey(target.backendTarget), target]));
            setObserved({ scope, planners, successors, models: new Map(), unavailable: false });
            await Promise.all([...targets].map(async ([key, target]) => {
                let observation: ModelObservation;
                try {
                    const models = await withTimeout(() => scope.resolveModels(target, signal), NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, 'Sequence model discovery');
                    observation = { status: 'ready', models };
                } catch {
                    observation = { status: 'failed' };
                }
                if (!signal.aborted) setObserved(snapshot => snapshot?.scope === scope
                    ? { ...snapshot, models: new Map(snapshot.models).set(key, observation) } : snapshot);
            }));
        };
        void load();
        return () => controller.abort();
    }, [scope]);

    const machine = scope && observed?.scope === scope ? observed : undefined;
    const catalogs = React.useMemo(() => [
        choicesForRole(machine?.planners ?? EMPTY_TARGETS, machine), choicesForRole(machine?.successors ?? EMPTY_TARGETS, machine),
    ] as const, [machine]);
    const choices = React.useMemo(() => [listComposerSequenceChoices(catalogs[0]), listComposerSequenceChoices(catalogs[1])] as const, [catalogs]);
    const optionsByStep = React.useMemo(() => {
        const options = (list: readonly ComposerAgentReviewSelection[]) => list.map(choice => ({ key: formatComposerSequenceAddress(choice), label: displayLabel(choice) }));
        return [options(choices[0]), options(choices[1])] as const;
    }, [choices]);
    const replace = React.useCallback((index: 0 | 1, key: string) => {
        const choice = choices[index].find(item => formatComposerSequenceAddress(item) === key);
        return parsed && choice ? replaceComposerSequenceAddress(params.text, parsed.stages[index], choice) : null;
    }, [parsed, params.text, choices]);

    if (!parsed) return { parsed, ready: null, steps: null, optionsByStep, status: 'idle', replace };
    const resolve = (index: 0 | 1) => {
        const stage = parsed.stages[index];
        const picked = params.binding?.selection;
        // A model selected from the mention menu is displayed as its provider token.
        // Preserve that explicit choice when the user adds a second assignment.
        const address = index === 0 && picked?.modelId && params.text.slice(stage.start, stage.end) === formatAgentReviewMentionToken(picked.target)
            ? composerSequenceTargetAddress(picked.target) + '/' + encodeURIComponent(picked.modelId)
            : stage.address;
        return inspectAddress(address, catalogs[index], machine, params.currentTargetKey, params.currentModelId);
    };
    const results = [resolve(0), resolve(1)] as const;
    const step = (index: 0 | 1): ComposerSequenceStep => {
        const choice = results[index].choice;
        const stage = parsed.stages[index];
        return { agentKey: choice ? formatComposerSequenceAddress(choice) : '', agentLabel: choice ? displayLabel(choice) : '@' + stage.address, task: stage.instructions };
    };
    const steps = [step(0), step(1)] as const;
    const [planner, successor] = results.map(result => result.choice);
    const needsInstructions = parsed.stages.some(stage => !stage.instructions);
    const ready = !needsInstructions && planner && successor ? { planner, successor } : null;
    const unresolved = results.find(result => result.status !== 'ready');
    const status = !scope ? 'unavailable' : unresolved?.status ?? (needsInstructions ? 'incomplete' : 'ready');
    return { parsed, ready, steps, optionsByStep, status, replace };
}
