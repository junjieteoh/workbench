// Run from a paired fork checkout with its dependencies installed.
const { createRequire } = require('node:module');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

async function configure() {
  const [machine, serverHome, project, location] = process.argv.slice(2);
  if (!machine || !/^[a-z0-9-]+$/i.test(machine) || !serverHome?.startsWith('/') || !project || !location ||
      !process.env.HAPPIER_HOME_DIR || !process.env.HAPPIER_SERVER_URL) {
    throw new Error('Set HAPPIER_HOME_DIR and HAPPIER_SERVER_URL, then pass the worker name, its home, the Google Cloud project, and the location.');
  }
  const worker = path.posix.join(serverHome, 'workbench-happier');
  const cliDir = path.resolve(__dirname, '../apps/cli');
  process.env.TSX_TSCONFIG_PATH = path.join(cliDir, 'tsconfig.json');
  require('tsx/cjs');
  const fromCli = createRequire(path.join(cliDir, 'package.json'));
  const { configuration } = fromCli('./src/configuration');
  if (new URL(configuration.apiServerUrl).origin !== new URL(process.env.HAPPIER_SERVER_URL).origin) {
    throw new Error('Selected relay differs from HAPPIER_SERVER_URL.');
  }
  const { readCredentials } = fromCli('./src/persistence');
  const { updateAccountSettingsV2WithRetry } = fromCli('./src/settings/accountSettings/updateAccountSettingsV2WithRetry');
  const { AIBackendProfileSchema, DEFAULT_BUILT_IN_BACKEND_PROFILES } = fromCli('@happier-dev/protocol');
  const { AGENT_IDS } = fromCli('@happier-dev/agents');
  const definitions = [
    {
      id: 'workbench-vertex-' + machine, name: 'Gemini on Vertex (' + machine + ')',
      agent: 'gemini', baseId: 'gemini-vertex',
      env: {
        GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location,
        GEMINI_CLI_HOME: path.posix.join(worker, 'state/gemini'),
        GOOGLE_APPLICATION_CREDENTIALS: path.posix.join(serverHome, '.config/gcloud/application_default_credentials.json'),
      },
    },
    {
      id: 'workbench-claude-artifacts-' + machine, name: 'Claude with artifacts (' + machine + ')',
      agent: 'claude', baseId: 'anthropic',
      env: {
        HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1',
        CLAUDE_CONFIG_DIR: path.posix.join(worker, 'state/claude'),
        HAPPIER_CLAUDE_PATH: path.posix.join(worker, 'fork-source/workbench/claude-artifacts/claude'),
      },
    },
  ];
  const credentials = await readCredentials();
  if (!credentials) throw new Error('Sign in to the selected Workbench relay first.');
  await updateAccountSettingsV2WithRetry({credentials, mutate(settings) {
    const profiles = [...(settings.profiles ?? [])];
    const now = Date.now();
    for (const definition of definitions) {
      const base = DEFAULT_BUILT_IN_BACKEND_PROFILES.find(p => p.id === definition.baseId);
      if (!base) throw new Error('Missing built-in profile ' + definition.baseId);
      const index = profiles.findIndex(p => p.id === definition.id);
      const old = profiles[index];
      const candidate = AIBackendProfileSchema.parse({
        ...base, id: definition.id, name: definition.name, isBuiltIn: false,
        createdAt: old?.createdAt ?? now, updatedAt: old?.updatedAt ?? now,
        envVarRequirements: [],
        compatibilityByTargetKey: Object.fromEntries(AGENT_IDS.map(id => ['agent:' + id, id === definition.agent])),
        environmentVariables: [...base.environmentVariables, ...Object.entries(definition.env).map(([name,value]) => ({name,value}))],
      });
      if (old && isDeepStrictEqual(candidate, AIBackendProfileSchema.parse(old))) continue;
      candidate.updatedAt = now;
      if (old) profiles[index] = candidate;
      else profiles.push(candidate);
    }
    return {...settings, useProfiles: true, profiles};
  }});
  console.log('Configured Workbench profiles for ' + machine + ' on ' + configuration.apiServerUrl);
}
configure().catch(error => { console.error(error.message); process.exitCode = 1; });
