import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend } from '@/agent/core';
import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import { getExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendRegistry';

const createCatalogAcpBackend = vi.fn();
vi.mock('@/agent/acp/createCatalogAcpBackend', () => ({
  createCatalogAcpBackend: (...args: unknown[]) => createCatalogAcpBackend(...args),
}));

import { createCatalogDefinedExecutionRunBackendFactory } from './createCatalogDefinedExecutionRunBackendFactory';

function fakeBackend(): AgentBackend {
  return {
    startSession: vi.fn(async () => ({ sessionId: 'agy-session-1' })),
    loadSession: vi.fn(async (sessionId) => ({ sessionId })),
    sendPrompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onMessage: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

describe('createCatalogDefinedExecutionRunBackendFactory', () => {
  beforeEach(() => createCatalogAcpBackend.mockReset());

  it('defers catalog backend resolution until session launch so managed prerequisites can be ensured', async () => {
    const resolved = fakeBackend();
    const mcpServers = { happier: { command: 'happier-mcp', args: ['bridge'] } };
    const resolveMcpServers = vi.fn(async () => mcpServers);
    createCatalogAcpBackend.mockResolvedValue({ backend: resolved });
    const factory = createCatalogDefinedExecutionRunBackendFactory('agy');
    const backend = factory({
      cwd: '/workspace',
      backendId: 'agy',
      permissionMode: 'read_only',
      accountSettings: {},
      permissionHandler: { handleToolCall: vi.fn() },
      resolveMcpServers,
    });

    expect(createCatalogAcpBackend).not.toHaveBeenCalled();
    await backend.startSession();
    expect(createCatalogAcpBackend).toHaveBeenCalledTimes(1);
    expect(createCatalogAcpBackend).toHaveBeenCalledWith('agy', expect.objectContaining({
      cwd: '/workspace',
      permissionMode: 'read-only',
      accountSettings: {},
      mcpServers,
    }));
    expect(resolveMcpServers).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight catalog resolution across concurrent launch calls', async () => {
    const resolved = fakeBackend();
    createCatalogAcpBackend.mockResolvedValue({ backend: resolved });
    const backend = createCatalogDefinedExecutionRunBackendFactory('agy')({
      cwd: '/workspace',
      backendId: 'agy',
      permissionMode: 'read_only',
      permissionHandler: { handleToolCall: vi.fn() },
    });

    await Promise.all([backend.startSession(), backend.loadSession?.('agy-session-existing')]);
    expect(createCatalogAcpBackend).toHaveBeenCalledTimes(1);
  });

  it('applies a Cursor CLI variant using the learned ACP model and effort options', async () => {
    const setSessionConfigOption = vi.fn(async () => {});
    const configOptions = [
      {
        id: 'model', name: 'Model', type: 'select', currentValue: 'auto',
        options: [{ value: 'auto', name: 'Auto' }, { value: 'grok-4.7', name: 'Grok 4.7' }],
      },
      {
        id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'high',
        options: [{ value: 'high', name: 'High' }, { value: 'medium', name: 'Medium' }],
      },
    ] satisfies readonly SessionConfigOption[];
    const resolved = {
      ...fakeBackend(),
      getSessionConfigOptionsState: () => configOptions,
      setSessionConfigOption,
    };
    createCatalogAcpBackend.mockResolvedValue({ backend: resolved });
    const factory = getExecutionRunBackendFactory('cursor');
    if (!factory) throw new Error('Cursor must support execution runs');
    const backend = factory({
      cwd: '/workspace',
      backendId: 'cursor',
      modelId: 'grok-4.7-medium',
      permissionMode: 'read_only',
      permissionHandler: { handleToolCall: vi.fn() },
    });

    const { sessionId } = await backend.startSession();

    expect(setSessionConfigOption.mock.calls).toEqual([
      [sessionId, 'model', 'grok-4.7'],
      [sessionId, 'reasoning_effort', 'medium'],
    ]);
  });
});
