// Run from a paired checkout with its dependencies installed. The profile is stored on the selected relay.
const { createRequire } = require('node:module');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

async function configure() {
  const [machine, serverHome, project, location] = process.argv.slice(2);
  if (!machine || !/^[a-z0-9-]+$/i.test(machine) || !serverHome?.startsWith('/') || !project || !location ||
      !process.env.HAPPIER_HOME_DIR || !process.env.HAPPIER_SERVER_URL) {
    throw new Error('Set HAPPIER_HOME_DIR and HAPPIER_SERVER_URL, then pass the machine name, remote home, Google Cloud project, and location.');
  }
  const cliDir = path.resolve(__dirname, '../../apps/cli');
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
  const base = DEFAULT_BUILT_IN_BACKEND_PROFILES.find(p => p.id === 'gemini-vertex');
  if (!base) throw new Error('This release does not include the Gemini Vertex profile.');
  const credentials = await readCredentials();
  if (!credentials) throw new Error('Sign in to the selected Workbench relay first.');
  const id = 'workbench-vertex-' + machine;
  await updateAccountSettingsV2WithRetry({credentials, mutate(settings) {
    const profiles = settings.profiles ?? [];
    const existing = profiles.find(p => p.id === id);
    const now = Date.now();
    const candidate = AIBackendProfileSchema.parse({
      ...base, id, isBuiltIn: false, name: 'Gemini on Vertex (' + machine + ')',
      createdAt: existing?.createdAt ?? now, updatedAt: existing?.updatedAt ?? now,
      envVarRequirements: [],
      compatibilityByTargetKey: Object.fromEntries(AGENT_IDS.map(agent => ['agent:' + agent, agent === 'gemini'])),
      environmentVariables: [
        ...base.environmentVariables,
        {name:'GOOGLE_CLOUD_PROJECT', value:project}, {name:'GOOGLE_CLOUD_LOCATION', value:location},
        {name:'GEMINI_CLI_HOME', value:path.posix.join(serverHome,'workbench-happier/state/gemini')},
        {name:'GOOGLE_APPLICATION_CREDENTIALS', value:path.posix.join(serverHome,'.config/gcloud/application_default_credentials.json')},
      ],
    });
    if (existing && isDeepStrictEqual(candidate, AIBackendProfileSchema.parse(existing)) && settings.useProfiles) return settings;
    candidate.updatedAt = now;
    return {...settings, useProfiles:true, profiles: existing
      ? profiles.map(p => p.id === id ? candidate : p)
      : [...profiles, candidate]};
  }});
  console.log('Configured ' + id + ' on ' + configuration.apiServerUrl);
}
configure().catch(error => { console.error(error.message); process.exitCode = 1; });
