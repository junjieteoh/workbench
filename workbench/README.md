# Workbench server profiles

The private web workspace uses the fork's `workbench/focused-agent-picker` branch. It tracks Happier's stable `main` releases. The browser downloads the deployed UI from the relay. Provider executables and configuration live on the selected worker.

## Start a session

In **New Session**, choose **jj-server** and a project directory. Select **Gemini** to use the server's Google Cloud project through Vertex. Select **Claude with artifacts (jj-server)** in the launch profile picker to use the authenticated interactive Claude terminal. Paste a shared artifact link into the chat. Claude enforces the signed-in account's sharing permissions and may request approval.

The default Claude profile uses the Agent SDK. The artifact profile applies only to new sessions created with it and keeps normal Claude approvals enabled.

## Reproduce the server setup

The Ubuntu worker uses a checkout at `~/workbench-happier/fork-source`, a paired Happier launcher at `~/workbench-happier/happier`, and the systemd user service `happier-daemon.workbench-tailnet.service`. The server user needs Google application-default credentials with Vertex access and a signed-in Claude subscription profile at `~/workbench-happier/state/claude`.

On the worker, pull the deployment branch and apply the Gemini configuration. This installs the managed CLI and reloads the worker when the service configuration changes.

```sh
cd ~/workbench-happier/fork-source
git pull --ff-only origin workbench/focused-agent-picker
workbench/gemini-vertex/install-worker.sh "$GOOGLE_CLOUD_PROJECT" global
```

From a fork checkout with dependencies installed, set `HAPPIER_HOME_DIR` to the paired CLI's state directory and `HAPPIER_SERVER_URL` to the private relay. Save the named profiles to that account with the following command. The last path in each profile points at the selected machine. Credential contents stay out of Git.

```sh
node workbench/configure-worker-profiles.cjs jj-server /home/jj "$GOOGLE_CLOUD_PROJECT" global
```

The worker reads the artifact launcher from the Git checkout. Changes to the web UI require a new UI build and relay deployment. Pulling provider scripts alone does not rebuild the web UI.
