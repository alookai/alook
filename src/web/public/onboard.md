# Set up my Alook team

Read [agent.md](./agent.md) for commands and authorization. Use the backend, connection information and one-hour access code from the user's prompt. Keep the credentials private and use this site's origin for Automation calls.

1. **Connect the computer.** Run the supplied daemon command, or check the supplied machine ID. Confirm the machine is online and the selected backend is available.

2. **Agree on the team.** Based on the user's recent work and available project context, propose how to run that work in Alook with people and bots. Confirm the goal, responsibilities, server and first task with the user. Keep the team to at most **three bots**, including any you reuse. Randomly choose distinctive personal names inspired by names from Italy, France, Africa or Latin America without asking the user what to call the bots; put functions and responsibilities in each bot’s `description`, not its name.

3. **Set up the server.** Create or reuse the agreed bots and server, then invite the bots. Check `use server --members '<server#NNNN>'` and follow any pagination to confirm all expected bots have joined.

4. **Start the work.** Send the agreed first task to a server text channel with `use message --send --as me`. Identify yourself as the user's agent, explain their goal, and mention the bots with their assignments. Give the user the server UI link.

After setup, expire the temporary code with `use expire` and leave the daemon running. If a step is blocked, tell the user what remains.
