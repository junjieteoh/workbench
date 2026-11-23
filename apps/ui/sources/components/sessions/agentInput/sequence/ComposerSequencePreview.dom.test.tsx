/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposerSequencePreview, type ComposerSequenceOption } from './ComposerSequencePreview';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : undefined }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const plans = [{ key: 'oak', label: 'Oak' }, { key: 'birch', label: 'Birch' }];
const builds = [{ key: 'moss', label: 'Moss' }, { key: 'elm', label: 'Elm' }];
const roles = [plans, builds] as const;
const noOptions: readonly ComposerSequenceOption[] = [];

function Composer({ disabled = false, status }: { disabled?: boolean; status?: string }) {
    const [selected, setSelected] = React.useState([plans[0], builds[0]]);
    return <ComposerSequencePreview
        steps={[
            { agentKey: selected[0].key, agentLabel: selected[0].label, task: 'Draft an agenda' },
            { agentKey: selected[1].key, agentLabel: selected[1].label, task: 'Review the agenda' },
        ]}
        options={noOptions}
        optionsByStep={roles}
        onAgentChange={(step, key) => setSelected(current => current.map((previous, index) =>
            index === step ? roles[step].find(option => option.key === key)! : previous))}
        status={status}
        disabled={disabled}
    />;
}

const lookup = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const visible = (id: string) => vi.waitFor(async () => {
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const element = lookup(id);
    if (!element) throw new Error(`Missing ${id}`);
    return element;
});
const click = async (id: string) => {
    const button = await visible(id);
    await act(async () => { button.focus(); button.click(); });
};
const key = async (name: string) => act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', {
        key: name, bubbles: true, cancelable: true,
    }));
});

describe('ComposerSequencePreview', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(160, 160, 160, 40));
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('allows changing either agent without changing the tasks or offering targets from the other step', async () => {
        await act(async () => root.render(<Composer />));
        expect(container.textContent).toContain('Draft an agenda');
        await click('composer-sequence-agent-0');
        expect(lookup('composer-sequence-option-elm')).toBeNull();
        await click('composer-sequence-option-birch');
        await vi.waitFor(() => expect(lookup('composer-sequence-agent-0')?.textContent).toContain('Birch'));
        await click('composer-sequence-agent-1');
        await visible('composer-sequence-option-elm');
        await key('ArrowDown');
        await key('Enter');
        await vi.waitFor(() => expect(lookup('composer-sequence-agent-1')?.textContent).toContain('Elm'));
        expect(container.textContent).toContain('Draft an agenda');
        expect(container.textContent).toContain('Review the agenda');
        await click('composer-sequence-agent-1');
        await visible('composer-sequence-option-elm');
        await key('Escape');
        await vi.waitFor(() => expect(lookup('composer-sequence-option-moss')).toBeNull());
        expect(lookup('composer-sequence-agent-1')?.textContent).toContain('Elm');
    });

    it('keeps both tasks visible and closes picking while sending', async () => {
        await act(async () => root.render(<Composer />));
        await click('composer-sequence-agent-1');
        await act(async () => root.render(<Composer disabled status="Checking agents" />));
        expect(lookup('composer-sequence-option-moss')).toBeNull();
        expect(container.textContent).toContain('Checking agents');
        expect(container.textContent).toContain('Review the agenda');
        expect(lookup('composer-sequence-agent-1')?.getAttribute('aria-disabled')).toBe('true');
    });
});
