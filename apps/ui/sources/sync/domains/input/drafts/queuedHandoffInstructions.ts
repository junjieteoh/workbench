import { Platform } from 'react-native';
import { z } from 'zod';

import { readBrowserRecord, updateBrowserRecord } from '@/sync/domains/state/browserRecordStorage';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';

const instructionsSchema = z.array(z.object({ localId: z.string().min(1), text: z.string() }));
export type HandoffInstructions = z.infer<typeof instructionsSchema>[number];

export function queuedHandoffInstructionsKey(accountScopeKey: string, sessionId: string): string {
    return `queued-handoff-instructions-v1:${encodeURIComponent(accountScopeKey)}:${encodeURIComponent(sessionId)}`;
}

function parse(raw: string | undefined): HandoffInstructions[] {
    return raw === undefined ? [] : instructionsSchema.parse(JSON.parse(raw));
}

export async function readQueuedHandoffInstructions(key: string): Promise<HandoffInstructions[]> {
    return parse(Platform.OS === 'web' ? await readBrowserRecord(key) : getPersistenceStorage().getString(key));
}

// One record per session. Browser tabs merge changes inside the same IndexedDB transaction
// used for local draft records. These copies are never uploaded as draft metadata.
export async function updateQueuedHandoffInstructions(key: string, localId: string, text: string | null): Promise<void> {
    const update = (raw: string | undefined) => {
        const saved = parse(raw);
        const existing = saved.find((copy) => copy.localId === localId);
        if (text !== null && existing && existing.text !== text) {
            // The daemon deduplicates by localId. Replacing this text could spend a
            // newer draft after receiving a receipt for the older instructions.
            throw new Error('Handoff instructions changed after submission.');
        }
        const copies = saved.filter((copy) => copy.localId !== localId);
        if (text !== null) copies.push({ localId, text });
        return { value: copies.length ? JSON.stringify(copies) : undefined, result: undefined };
    };
    if (Platform.OS === 'web') {
        await updateBrowserRecord(key, update);
        return;
    }
    const records = getPersistenceStorage();
    const next = update(records.getString(key));
    if (next.value === undefined) records.delete(key);
    else records.set(key, next.value);
}
