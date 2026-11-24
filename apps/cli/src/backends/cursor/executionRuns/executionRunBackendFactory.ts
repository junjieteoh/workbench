import { createCatalogDefinedExecutionRunBackendFactory } from '@/agent/acp/catalog/createCatalogDefinedExecutionRunBackendFactory';
import {
  resolveCursorSessionConfigOptionUpdate,
  resolveCursorSessionModelConfigUpdate,
} from '@/backends/cursor/acp/cursorModelConfig';

export const executionRunBackendFactory = createCatalogDefinedExecutionRunBackendFactory('cursor', {
  resolveSessionModelConfigUpdate: (params) => {
    const update = resolveCursorSessionModelConfigUpdate(params);
    if (!update) throw new Error(`Cursor model '${params.modelId}' is unavailable for this session`);
    return update;
  },
  resolveSessionConfigOptionUpdate: resolveCursorSessionConfigOptionUpdate,
});
