import { expect, it, vi } from 'vitest';

import { queuedHandoffInstructionsKey, readQueuedHandoffInstructions, updateQueuedHandoffInstructions } from './queuedHandoffInstructions';

const records = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/sync/domains/state/persistence', () => ({
    getPersistenceStorage: () => ({
        getString: (key: string) => records.get(key),
        set: (key: string, value: string) => records.set(key, value),
        delete: (key: string) => records.delete(key),
    }),
}));

it('keeps each original instruction across a retry, a later handoff and clearing another account’s copy', async () => {
    const key = queuedHandoffInstructionsKey('account-a', 'thread');
    const other = queuedHandoffInstructionsKey('account-b', 'thread');
    await updateQueuedHandoffInstructions(key, 'first', 'Review the results');
    await updateQueuedHandoffInstructions(key, 'first', 'Review the results');
    await expect(updateQueuedHandoffInstructions(key, 'first', 'Edited after submission')).rejects.toThrow();
    await updateQueuedHandoffInstructions(key, 'second', 'Implement the review');
    await updateQueuedHandoffInstructions(other, 'first', 'Other account');
    await updateQueuedHandoffInstructions(other, 'first', null);
    expect(await readQueuedHandoffInstructions(key)).toEqual([
        { localId: 'first', text: 'Review the results' },
        { localId: 'second', text: 'Implement the review' },
    ]);
    await updateQueuedHandoffInstructions(key, 'first', null);
    expect(await readQueuedHandoffInstructions(key)).toEqual([{ localId: 'second', text: 'Implement the review' }]);
});
