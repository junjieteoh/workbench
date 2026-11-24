import type { ComposerAgentReviewSelection } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { applySuggestion } from '@/components/autocomplete/applySuggestion';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionGrammar';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { formatComposerSuggestionToken, isComposerTokenBoundaryChar } from '@/components/autocomplete/composerSuggestionGrammar';
import { t } from '@/text';
import { composerSequenceTargetAddress, formatComposerReplyAddress, formatComposerSequenceAddress, listComposerSequenceChoices, parseComposerAgentSequence, resolveComposerSequenceAddress, type ComposerSequenceCatalogEntry } from './sequence/composerAgentSequence';

export type { ComposerAgentReviewSelection } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
export type ComposerAgentReviewTarget = ComposerAgentReviewSelection['target'];
export type ComposerAgentReviewModel = Readonly<{ id: string | null; label: string; source?: 'cached' | 'catalog' }>;
export type AgentReviewComposerBinding = Readonly<{
    selection: ComposerAgentReviewSelection | null;
    reviewEnabled?: boolean;
    /** The foreground runner's own catalog; Delegate eligibility is checked independently. */
    replyTargets?: readonly ComposerAgentReviewTarget[];
    peekModels?(target: ComposerAgentReviewTarget): readonly ComposerAgentReviewModel[] | null;
    subscribeModels?(targets: readonly ComposerAgentReviewTarget[], onChange: () => void): () => void;
    handoff?: Readonly<{
        first: ComposerAgentReviewSelection;
        targets: readonly ComposerAgentReviewTarget[];
        onStage(): void;
    }>;
    onSelectionChange(value: ComposerAgentReviewSelection | null): void;
    matchesTargetPrefix(query: string): boolean;
    peekTargets?(): readonly ComposerAgentReviewTarget[] | null;
    resolveTargets(signal?: AbortSignal, intent?: 'delegate' | 'plan'): Promise<readonly ComposerAgentReviewTarget[]>;
    resolveModels(target: ComposerAgentReviewTarget, signal?: AbortSignal): Promise<readonly ComposerAgentReviewModel[]>;
}>;
export type AgentReviewSuggestionAction =
    | { kind: 'open' | 'status' | 'delegate' }
    | { kind: 'target'; target: ComposerAgentReviewTarget }
    | { kind: 'model' | 'reply'; selection: ComposerAgentReviewSelection }
    | { kind: 'handoff'; target: ComposerAgentReviewTarget };

export function formatAgentReviewMentionToken(target: ComposerAgentReviewTarget): string {
    return formatComposerSuggestionToken('@', target.label);
}

export function findAgentReviewToken(text: string, target: ComposerAgentReviewTarget): number {
    const token = formatAgentReviewMentionToken(target);
    let index = text.indexOf(token);
    while (index !== -1) {
        if (isComposerTokenBoundaryChar(text.charAt(index - 1)) && (isComposerTokenBoundaryChar(text.charAt(index + token.length)) || text.charAt(index + token.length) === ':')) return index;
        index = text.indexOf(token, index + token.length);
    }
    return -1;
}

export function removeAgentReviewToken(text: string, target: ComposerAgentReviewTarget): { text: string; start: number; length: number } {
    const start = findAgentReviewToken(text, target);
    if (start === -1) return { text, start, length: 0 };
    const tokenEnd = start + formatAgentReviewMentionToken(target).length;
    const end = tokenEnd + (text[tokenEnd] === ' ' ? 1 : 0);
    return { text: text.slice(0, start) + text.slice(end), start, length: end - start };
}

/** Replacing a reviewer keeps the surrounding assignment and restores the caret after the mention. */
export function applyAgentReviewChoice(params: {
    text: string;
    selection: { start: number; end: number };
    token: string;
    kinds: readonly ComposerSuggestionKindId[];
    modelChosen: boolean;
    previous: ComposerAgentReviewTarget | null;
}) {
    let { text, selection } = params;
    if (params.modelChosen && params.previous) {
        const removal = removeAgentReviewToken(text, params.previous);
        text = removal.text;
        if (removal.start >= 0 && removal.start < selection.start) {
            selection = { start: selection.start - removal.length, end: selection.end - removal.length };
        }
    }
    const result = applySuggestion(text, selection, params.token, params.kinds, params.modelChosen);
    // applySuggestion reuses a space already following the edited token. Advance over it
    // so a selection in the middle of a sentence closes the picker just like one at the end.
    if (params.modelChosen && result.text[result.cursorPosition] === ' ') result.cursorPosition += 1;
    return result;
}

/** A foreground selection either edits the addressed stage or makes the selected
 * participant the first speaker while keeping the user's current instructions. */
export function applyComposerReplyChoice(
    text: string, mention: { offset: number; endOffset: number },
    selection: ComposerAgentReviewSelection, previousDelegate?: ComposerAgentReviewTarget,
): { text: string; cursorPosition: number } {
    const sequence = parseComposerAgentSequence(text);
    const stage = sequence?.stages.find(candidate => candidate.start === mention.offset && !candidate.implied);
    if (stage && sequence!.stages.length > 1) {
        const token = stage.addressed ? formatComposerReplyAddress(selection) : formatComposerSequenceAddress(selection);
        const suffix = text.slice(mention.endOffset);
        const space = !suffix || !/^\s/u.test(suffix) ? ' ' : '';
        return { text: text.slice(0, mention.offset) + token + space + suffix,
            cursorPosition: mention.offset + token.length + (space || suffix.match(/^\s/u)?.[0] || '').length };
    }
    let prefix = text.slice(0, mention.offset);
    let suffix = text.slice(mention.endOffset);
    const priorFirst = sequence?.stages[0];
    if (priorFirst?.addressed && priorFirst.end <= mention.offset) prefix = prefix.slice(priorFirst.instructionStart);
    if (previousDelegate) {
        const removal = removeAgentReviewToken(prefix, previousDelegate);
        if (removal.start >= 0) prefix = removal.text;
        else suffix = removeAgentReviewToken(suffix, previousDelegate).text;
    }
    if ((!prefix || /\s$/u.test(prefix)) && suffix.startsWith(' ')) suffix = suffix.slice(1);
    if (!suffix) prefix = prefix.trimEnd();
    const address = formatComposerReplyAddress(selection) + ' ';
    return { text: address + prefix + suffix, cursorPosition: address.length + prefix.length };
}

/** A scoped backend may contain slashes in its model IDs. File paths and other
 * native mention scopes keep their existing lookup path. */
export function replyModelSearchTargets(query: string, targets: readonly ComposerAgentReviewTarget[] | undefined): readonly ComposerAgentReviewTarget[] {
    if (!targets?.length || !query) return [];
    const slash = query.indexOf('/');
    if (slash >= 0) {
        const qualifier = query.slice(0, slash).toLowerCase();
        return targets.filter(target => [composerSequenceTargetAddress(target), target.label].some(name => name.toLowerCase() === qualifier));
    }
    if (/[:\\]/u.test(query) || /(?:^\.|\.\p{L}+$)/u.test(query)) return [];
    return targets;
}

function matchingReplySelections(query: string, catalog: readonly ComposerSequenceCatalogEntry[]): ComposerAgentReviewSelection[] {
    const exact = resolveComposerSequenceAddress(query, catalog);
    if (exact.kind === 'resolved' && exact.selection.modelId !== null) return [exact.selection];
    if (exact.kind === 'ambiguous') return [...exact.choices].filter(choice => choice.modelId !== null);
    const search = query.slice(query.indexOf('/') + 1).toLowerCase();
    return listComposerSequenceChoices(catalog).filter(choice => choice.modelId !== null &&
        [choice.modelId, choice.modelLabel].some(label => label.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(search))
            || label.toLowerCase().startsWith(search)));
}

function replySuggestion(selection: ComposerAgentReviewSelection, query: string): AutocompleteSuggestion {
    const address = formatComposerSequenceAddress(selection);
    return { kind: 'agentReview', key: 'agentReview:reply:' + address, text: address,
        label: selection.modelLabel, description: selection.target.label + ' · ' + t('agentInput.agentReview.reply'),
        agentReview: { kind: 'reply', selection }, agentReviewQuery: query };
}

async function searchReplyModels(binding: AgentReviewComposerBinding, query: string, signal?: AbortSignal): Promise<AutocompleteSuggestion[]> {
    const targets = replyModelSearchTargets(query, binding.replyTargets);
    if (!targets.length || signal?.aborted) return [];
    // An unqualified alias should name a machine-observed model. Provider static
    // fallback remains available (and identified) in the explicit model picker.
    const entry = (target: ComposerAgentReviewTarget, models: readonly ComposerAgentReviewModel[]): ComposerSequenceCatalogEntry =>
        ({ target, models: models.filter(model => model.source !== 'catalog') });
    const cached = targets.map(target => entry(target, binding.peekModels?.(target) ?? []));
    const current = matchingReplySelections(query, cached);
    const discovering = Promise.all(targets.map(async target => entry(target, await binding.resolveModels(target, signal).catch(() => []))));
    // The canonical shared model cache wakes the open menu as each provider responds.
    // A warm match can surface while another CLI is still being probed.
    if (current.length && binding.subscribeModels) return current.map(choice => replySuggestion(choice, query));
    const observed = await discovering;
    return signal?.aborted ? [] : matchingReplySelections(query, observed).map(choice => replySuggestion(choice, query));
}

export async function resolveAgentReviewSuggestions(params: {
    binding?: AgentReviewComposerBinding; query: string; scopedQuery: string; scope: string | null; signal?: AbortSignal;
}): Promise<AutocompleteSuggestion[]> {
    const { binding, query, scopedQuery, scope, signal } = params;
    if (!binding || signal?.aborted) return [];
    const row = (key: string, text: string, label: string, agentReview: AgentReviewSuggestionAction): AutocompleteSuggestion => ({
        kind: 'agentReview', key: 'agentReview:' + key, text, label, agentReview, agentReviewQuery: query,
    });
    const bareTarget = scope === null && (!query || binding.matchesTargetPrefix(query));
    if (scope === null && query && !bareTarget && binding.replyTargets?.length && !'agent'.startsWith(query.toLowerCase())) {
        return searchReplyModels(binding, query, signal);
    }
    if (scope !== 'agent' && !bareTarget) {
        return scope === null && !!query && 'agent'.startsWith(query.toLowerCase())
            ? [row('open', '@agent:', t('agentInput.agentReview.choose'), { kind: 'open' })] : [];
    }
    const separator = scopedQuery.indexOf('/');
    try {
        // The unscoped picker also shows files and sessions. Its discovery deadline
        // can omit a slow agent section for the lifetime of this query. Offer the
        // scoped picker immediately on a cold machine; it can await the live catalog.
        const handoffTargets = binding.handoff?.targets ?? [];
        const peek = !query && scope === null ? binding.peekTargets : undefined;
        const reviewTargets = binding.reviewEnabled === false ? []
            : peek ? peek() : await binding.resolveTargets(signal).catch(error => {
                if (!handoffTargets.length && !binding.replyTargets?.length) throw error;
                return [];
            });
        if (peek && !reviewTargets?.length && !handoffTargets.length && !binding.replyTargets?.length) {
            return [row('open', '@agent:', t('agentInput.agentReview.choose'), { kind: 'open' })];
        }
        if (signal?.aborted) return [];
        const targets = new Map([...(binding.replyTargets ?? []), ...handoffTargets, ...(reviewTargets ?? [])].map(target => [composerSequenceTargetAddress(target), target]));
        if (separator === -1) {
            const search = scopedQuery.toLowerCase();
            const matches = [...targets].filter(([id, target]) => [target.label, id].some(value => {
                const name = value.toLowerCase();
                return bareTarget ? name.startsWith(search) : name.includes(search);
            }));
            if (matches.length) return matches.map(([id, target]) => row(id, '@agent:' + id + '/', target.label, { kind: 'target', target }));
        } else {
            const id = scopedQuery.slice(0, separator);
            const target = targets.get(id);
            if (target) {
                const actionQuery = scopedQuery.slice(separator + 1).toLowerCase();
                const canDelegate = reviewTargets?.some(candidate => composerSequenceTargetAddress(candidate) === id);
                const canReply = binding.replyTargets?.some(candidate => composerSequenceTargetAddress(candidate) === id);
                if (scope === null && canReply) return searchReplyModels(binding, query, signal);
                if (actionQuery.startsWith('reply/') && canReply) {
                    const search = actionQuery.slice('reply/'.length);
                    const models = await binding.resolveModels(target, signal);
                    if (signal?.aborted) return [];
                    return models.filter(model => [model.label, model.id].some(value => value?.toLowerCase().includes(search))).map(model => ({
                        ...replySuggestion({target, modelId: model.id, modelLabel: model.label}, query),
                        ...(model.source ? { description: t(model.source === 'cached' ? 'agentInput.agentReview.cachedModels' : 'agentInput.agentReview.catalogModels') } : {}),
                    }));
                }
                if (actionQuery.startsWith('delegate/')) {
                    if (!canDelegate) return [];
                    const search = actionQuery.slice('delegate/'.length);
                    const models = await binding.resolveModels(target, signal);
                    if (signal?.aborted) return [];
                    const matches = models.filter(model => [model.label, model.id].some(value => value?.toLowerCase().includes(search)));
                    if (matches.length) return matches.map(model => ({
                        ...row(id + '/' + (model.id ?? ''), formatAgentReviewMentionToken(target), model.label,
                            { kind: 'model', selection: { target, modelId: model.id, modelLabel: model.label } }),
                        ...(model.source ? { description: t(model.source === 'cached' ? 'agentInput.agentReview.cachedModels' : 'agentInput.agentReview.catalogModels') } : {}),
                    }));
                } else {
                    const handoffLabel = t('agentInput.sequence.handOff');
                    const delegateLabel = t('executionRuns.newRun.intents.delegate');
                    const actions: AutocompleteSuggestion[] = [];
                    const replyLabel = t('agentInput.agentReview.reply');
                    if (canReply && replyLabel.toLowerCase().includes(actionQuery)) {
                        actions.push(row(id + '/reply', '@agent:' + id + '/reply/', replyLabel, { kind: 'open' }));
                    }
                    if (handoffTargets.some(candidate => composerSequenceTargetAddress(candidate) === id) && handoffLabel.toLowerCase().includes(actionQuery)) {
                        actions.push(row(id + '/handoff', '@' + query, handoffLabel, { kind: 'handoff', target }));
                    }
                    if (canDelegate && delegateLabel.toLowerCase().includes(actionQuery)) {
                        actions.push(row(id + '/delegate', '@agent:' + id + '/delegate/', delegateLabel, { kind: 'delegate' }));
                    }
                    if (actions.length) return actions;
                }
            }
        }
        if (bareTarget) return [];
        return [row('none', '@' + query, t('agentInput.agentReview.none'), { kind: 'status' })];
    } catch {
        return signal?.aborted ? [] : [row('unavailable', '@' + query, t('agentInput.agentReview.unavailable'), { kind: 'status' })];
    }
}
