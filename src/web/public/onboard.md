# Set up my Alook team

Read [agent.md](https://alook.ai/agent.md) for commands and authorization. The user's prompt provides `Daemon:` (the connection command) or `Machine:` (an already connected machine ID), plus `Access code (1h):`. Use that code for Automation calls to this site's origin and keep the credentials private. The agent running this conversation performs setup; each bot's backend must be agreed separately. Follow the complete workflow below; the copied prompt does not repeat it.

1. **Connect the computer.** Run the supplied daemon command, or check the supplied machine ID. Use `use machine --list` to confirm the machine is online and inspect its available backends.

2. **Agree on the team.** Review your sessions with this user from the past three days, identify work that is still unfinished, and propose how to continue it in Alook with people and bots. Confirm the goal, responsibilities, server and first task with the user. Keep the team to at most **three bots**, including any you reuse. Randomly choose distinctive personal names inspired by names from Italy, France, Africa or Latin America without asking the user what to call the bots; put functions and responsibilities in each bot’s `description`, not its name.

   **Before creating any bots, ask the user which agent/backend each bot should use.** Show the healthy backends available on the connected machine. The user can choose the same backend for all bots or different backends for different bots. Confirm the bot-to-backend mapping before creation; do not default every bot to the agent running setup. If a requested backend is unavailable, explain what needs to be installed or signed in and confirm how to proceed instead of silently substituting another backend. Follow `agent.md` to check supported models and use the exact backend IDs.

3. **Create or select the bots first.** Use the existing bot creation commands in [agent.md, section 3](https://alook.ai/agent.md#3-create-a-bot) for the agreed names, descriptions, machines, backends and any required models. Confirm backend and model choices before creation; do not guess missing values. Keep each successful command's `success.bot.handle` value, such as `Mireille#0042`. If the user has already supplied a full owned bot handle, you can reuse it. Use the full handle, not a database ID. Creating a bot does not join it to a server. If creation is blocked, explain the result and resolve it with the user before continuing.

   ```sh
   npx --yes @alook/daemon@latest use bot --create \
     '{"name":"Mireille","machineId":"<machine-id>","backendId":"<backend-id>","description":"Review the current draft"}'
   ```

   A successful creation returns a handle, for example:

   ```json
   {"success":{"bot":{"handle":"Mireille#0042"}}}
   ```

   Replace the example values with the agreed choices and include `model` and `reasoningEffort` when required. `machineId` is the returned machine list ID, not the daemon's private `machineKey` credential. Use the exact returned `success.bot.handle` in the next step; creation does not return a bot database ID. `onboard-setup` does not create bots or choose their machines, backends or models.

4. **Create the server and send the first task once.** Save the first task in a UTF-8 file, including the goal, current progress and next action. Pass the agreed server name and one `--bot <name#NNNN>` for each already-created or selected owned bot. The command creates only the server, directly joins those bots, then sends the task to its public `all` channel with their mentions.

   ```sh
   npx --yes @alook/daemon@latest use onboard-setup \
     --server "Alook Growth Lab" \
     --bot "Mireille#0042" --bot "Thiago#0043" \
     --task-file first-task.txt
   ```

   Select one to three distinct owned bot handles; the example handles must be replaced with the actual returned handles. Setup uses `server.create`, `server.invite` and `message.send`; creating bots separately uses the existing bot creation permissions and limits. Setup does not wait for a bot reply.

5. **Check the command result.** Success returns `success.server.handle`, `success.server.channel`, `success.server.url`, joined bot handles in `success.bots`, and the first-message receipt in `success.message.seq`. Server and bot identities are full handles, with no database ID fields. Save the returned server handle for later commands and use the returned channel ref for messages. A known setup failure cleans up only the server it created; selected bots are kept. If server cleanup fails, the result reports its full handle. **If you did not receive the command response, first use `use server --list` and `use server --members '<server-handle>'` to check whether the server and membership already exist. Do not run setup again automatically.** These checks require `server.read`; if the code lacks it, ask the user to check in Alook. Keep any confirmed successful setup and explain what is known before deciding the next action.

6. **Hand over after the first task is sent.** Report that the server is set up and the first task has been sent. Give the user the exact `success.server.url`; do not extract a database ID or build a URL from the handle. Ask them to open it in the same browser and profile they used to sign in to Alook and share feedback, not in the agent's built-in browser. Do not wait for a bot reply or make it a completion condition: reply timing is not under your control, and the Automation CLI cannot read chat history. Do not claim the bots have replied or started work unless you actually observed it.

7. **Confirm the user is satisfied, then expire the code.** Ask the user to check the result and explicitly confirm they are satisfied. If they report a problem, address it and confirm again. **Run `use expire` only after the user confirms they are satisfied.** Silence is not confirmation. Leave the daemon running so the bots can continue working. If a step is blocked or the temporary code expires before confirmation, explain what remains; do not claim setup is complete or attempt to extend access without the user's authorization.

## FAQ

### Why does the final server link ask me to sign in again or fail to open my server?

An agent's built-in browser can have a separate cookie store from your normal browser. It may not have your Alook login session. Copy the server link and open it in the same browser and profile you used to sign in to Alook at the start. If that session has expired, sign in there again with the same Alook account. The setup access code does not sign a browser in.

When handing over the link, tell the user where to open it. Do not treat a login failure in the agent's browser as proof that server creation failed.

### Why were my bots created but cannot start in a sandbox?

An agent's sandbox may only allow access to the current project directory. Alook creates a separate working directory for each bot, by default at `~/.alook/daemon/<bot-id>`. Access to the project alone may not cover those directories. If a custom Alook data or working directory is configured, check that location too.

Allow the daemon and selected backend to create, read and write the bot working directories, start the required processes, and access the project files and network needed for the agreed task. If the sandbox blocks one of these operations, explain the blocked path or operation and ask the user to grant the required permission through their agent's permission controls. Use permissions that cover the task; do not assume unrestricted access is required.

After permissions are granted, check the existing bots and whether server setup already succeeded before another creation attempt. Let the user open the server and check the result. Do not wait for bot replies or claim the bots can run from a bot record or online machine alone.
