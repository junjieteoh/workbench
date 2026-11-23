import { formatComposerSuggestionToken, parseComposerSuggestionQuery, parseComposerTokenEnd } from '@/components/autocomplete/composerSuggestionGrammar';
import { t } from '@/text';

import type { ComposerAgentReviewModel, ComposerAgentReviewSelection, ComposerAgentReviewTarget } from '../agentReviewComposer';

export type ComposerSequenceStage = Readonly<{
    /** Address without the @ or enclosing quotes. start/end cover the original @token only. */
    address: string;
    start: number;
    end: number;
    instructions: string;
}>;
export type ComposerAgentSequence = Readonly<{ stages: readonly [ComposerSequenceStage, ComposerSequenceStage] }>;
export type ComposerSequenceCatalogEntry = Readonly<{ target: ComposerAgentReviewTarget; models: readonly ComposerAgentReviewModel[] }>;
export type ComposerSequenceAddressResolution =
    | { kind: 'resolved'; selection: ComposerAgentReviewSelection }
    | { kind: 'ambiguous'; choices: readonly ComposerAgentReviewSelection[] }
    | { kind: 'unknown' };

function readStage(text: string, start: number, limit: number): ComposerSequenceStage | null {
    if (text[start] !== '@') return null;
    let end = parseComposerTokenEnd(text, start, limit);
    // In "@agent: do this", the colon belongs to the assignment, not the address.
    if (text.charAt(end - 1) === ':') end -= 1;
    const token = text.slice(start, end);
    if (token.startsWith('@"') && !/^@"(?:[^"\r\n]|"")+"$/u.test(token)) return null;
    const address = parseComposerSuggestionQuery(token)?.query;
    const rest = text.slice(end, limit);
    if (!address?.trim() || (rest && !/^[\s,:]/u.test(rest))) return null;
    return { address, start, end, instructions: rest.replace(/^\s*[,:]/u, '').trim() };
}

export function parseComposerAgentSequence(text: string): ComposerAgentSequence | null {
    const start = text.search(/\S/u);
    if (start === -1 || text[start] !== '@') return null;

    // Ignore quoted examples and Markdown code while locating the single handoff.
    // Offsets remain in the original draft so choosing a different model is a local edit.
    const markers = /(?<ticks>`+)|"(?:""|[^"\r\n])*"|(?<divider>\b(?:and\s+)?then\b,?(?=\s)|→|->|=>)\s*(?=@)/giu;
    let codeTicks = '';
    let separator: { start: number; nextAddress: number } | null = null;
    for (const match of text.matchAll(markers)) {
        const ticks = match.groups?.ticks;
        if (ticks) {
            if (ticks === codeTicks) codeTicks = '';
            else if (!codeTicks) codeTicks = ticks;
            continue;
        }
        const divider = match.groups?.divider;
        if (codeTicks || !divider) continue;
        if (/^\w/u.test(divider) && !/[\s,]/u.test(text.charAt(match.index - 1))) continue;
        if (separator) return null;
        separator = { start: match.index, nextAddress: match.index + match[0].length };
    }
    if (!separator) return null;
    let firstEnd = separator.start;
    while (firstEnd > start && /\s/u.test(text[firstEnd - 1])) firstEnd--;
    if (text[firstEnd - 1] === ',') firstEnd--;
    const first = readStage(text, start, firstEnd);
    const second = readStage(text, separator.nextAddress, text.length);
    return first && second ? { stages: [first, second] } : null;
}

export function composerSequenceTargetAddress(target: ComposerAgentReviewTarget): string {
    const backend = target.backendTarget;
    return backend.kind === 'builtInAgent' ? backend.agentId : 'acp:' + encodeURIComponent(backend.backendId);
}

export function formatComposerSequenceAddress(choice: ComposerAgentReviewSelection): string {
    const target = composerSequenceTargetAddress(choice.target);
    return formatComposerSuggestionToken('@', choice.modelId === null ? target : target + '/' + encodeURIComponent(choice.modelId));
}

export function replaceComposerSequenceAddress(text: string, stage: ComposerSequenceStage, choice: ComposerAgentReviewSelection): string {
    if (parseComposerSuggestionQuery(text.slice(stage.start, stage.end))?.query !== stage.address) return text;
    return text.slice(0, stage.start) + formatComposerSequenceAddress(choice) + text.slice(stage.end);
}

export function listComposerSequenceChoices(catalog: readonly ComposerSequenceCatalogEntry[]): ComposerAgentReviewSelection[] {
    const choices = new Map<string, ComposerAgentReviewSelection>();
    for (const { target, models } of catalog) {
        const providerDefault = models.find(model => model.id === null) ?? { id: null, label: t('agentInput.model.useCliSettings') };
        for (const model of [providerDefault, ...models]) {
            const choice = { target, modelId: model.id, modelLabel: model.label };
            choices.set(formatComposerSequenceAddress(choice), choice);
        }
    }
    return [...choices.values()];
}

function resolution(choices: ComposerAgentReviewSelection[]): ComposerSequenceAddressResolution {
    if (!choices.length) return { kind: 'unknown' };
    if (choices.length === 1) return { kind: 'resolved', selection: choices[0] };
    return { kind: 'ambiguous', choices };
}

function words(name: string): string {
    return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

function resolveModel(name: string, choices: ComposerAgentReviewSelection[]): ComposerSequenceAddressResolution {
    const parts = words(name);
    const lower = name.toLowerCase();
    const models = choices.filter(choice => choice.modelId !== null);
    const exact = models.filter(choice => choice.modelId === name);
    if (exact.length) return resolution(exact);
    const labels = models.filter(choice => choice.modelId?.toLowerCase() === lower || choice.modelLabel.toLowerCase() === lower);
    if (labels.length) return resolution(labels);
    if (!parts) return { kind: 'unknown' };
    const matches = models.filter(choice => [choice.modelId!, choice.modelLabel].some(value =>
        (' ' + words(value) + ' ').includes(' ' + parts + ' ')));
    return resolution(matches);
}

export function resolveComposerSequenceAddress(address: string, catalog: readonly ComposerSequenceCatalogEntry[]): ComposerSequenceAddressResolution {
    const name = address.trim();
    if (!name) return { kind: 'unknown' };
    const choices = listComposerSequenceChoices(catalog);
    const lower = name.toLowerCase();
    const defaults = choices.filter(choice => choice.modelId === null);
    // The canonical machine target is unambiguous even if a different configured
    // backend uses its name as a display label.
    const canonical = defaults.filter(choice => composerSequenceTargetAddress(choice.target) === name);
    if (canonical.length) return resolution(canonical);
    const named = defaults.filter(choice => composerSequenceTargetAddress(choice.target).toLowerCase() === lower || choice.target.label.toLowerCase() === lower);
    if (named.length) return resolution(named);

    const slash = name.indexOf('/');
    if (slash !== -1) {
        const explicitTarget = name.slice(0, slash);
        const canonicalTarget = choices.filter(choice => composerSequenceTargetAddress(choice.target) === explicitTarget);
        const scoped = canonicalTarget.length ? canonicalTarget : choices.filter(choice =>
            [composerSequenceTargetAddress(choice.target), choice.target.label].some(label => label.toLowerCase() === explicitTarget.toLowerCase()));
        if (scoped.length) {
            const model = name.slice(slash + 1);
            const canonicalModels = scoped.filter(choice => choice.modelId !== null && encodeURIComponent(choice.modelId) === model);
            return canonicalModels.length ? resolution(canonicalModels) : resolveModel(model, scoped);
        }
    }
    return resolveModel(name, choices);
}
