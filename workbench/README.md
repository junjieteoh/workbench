# Workbench server profiles

The browser downloads the deployed UI from the relay. Provider executables and configuration live on the selected worker.

## Developing Workbench extensions

`workbench/main` is the fork's default branch. Start a short feature branch from it and open the PR against `workbench/main` in this fork. Bring stable Happier updates from `upstream/main` through a separate sync PR. Deploy a tested commit when it is ready.

Build each connector as a separate module. Keep its authentication, API calls and event handling together. Reuse Happier's session, inbox and approval code where the extension needs them. If a change to shared code is necessary, describe the integration point in the PR and keep that change small. Use sample data in tests and keep live credentials outside the checkout.

## Start a session

In **New Session**, choose **jj-server** and a project directory. Select **Gemini** to use the server's Google Cloud project through Vertex. Select **Claude with artifacts (jj-server)** in the launch profile picker to use the authenticated interactive Claude terminal. Paste a shared artifact link into the chat. Claude enforces the signed-in account's sharing permissions and may request approval.

The default Claude profile uses the Agent SDK. The artifact profile applies only to new sessions created with it and keeps normal Claude approvals enabled.

## Plan with Neon and execute with Opus

In a Claude Opus session, type **Neon → Opus** followed by the task. For example, “Neon → Opus: group the rows in orders.csv by product and verify the totals.” Neon plans in a read-only Gemini run in that thread. Opus receives the plan, does the work and checks the result. You can open **Agents** to inspect the planner.

To install this optional rule, run the following from a paired checkout with dependencies installed and `HAPPIER_HOME_DIR` and `HAPPIER_SERVER_URL` set for your relay. Start a new Opus session after installation. You can edit or disable the rule in **Settings → Subagents**. Reinstalling preserves your edits.

```sh
node workbench/configure-worker-profiles.cjs --neon-opus
```

## Reproduce the server setup

The Ubuntu worker uses a checkout at `~/workbench-happier/fork-source`, a paired Happier launcher at `~/workbench-happier/happier`, and the systemd user service `happier-daemon.workbench-tailnet.service`. The server user needs Google application-default credentials with Vertex access and a signed-in Claude subscription profile at `~/workbench-happier/state/claude`.

On the worker, pull the deployment branch and apply the Gemini configuration. This installs the managed CLI and reloads the worker when the service configuration changes.

```sh
cd ~/workbench-happier/fork-source
git pull --ff-only origin workbench/main
workbench/gemini-vertex/install-worker.sh "$GOOGLE_CLOUD_PROJECT" global
```

From a fork checkout with dependencies installed, set `HAPPIER_HOME_DIR` to the paired CLI's state directory and `HAPPIER_SERVER_URL` to the private relay. Save the named profiles to that account with the following command. The last path in each profile points at the selected machine. Credential contents stay out of Git.

```sh
node workbench/configure-worker-profiles.cjs jj-server /home/jj "$GOOGLE_CLOUD_PROJECT" global
```

The worker reads the artifact launcher from the Git checkout. Changes to the web UI require a new UI build and relay deployment. Pulling provider scripts alone does not rebuild the web UI.
