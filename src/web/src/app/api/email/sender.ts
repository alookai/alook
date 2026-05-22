import { queries } from "@alook/shared";
import { cached, cacheKeys } from "@/lib/cache";

type Database = Parameters<typeof queries.agent.getAgent>[0];
type Agent = NonNullable<Awaited<ReturnType<typeof queries.agent.getAgent>>>;

export async function resolveEmailSender(
  db: Database,
  input: {
    agent: Agent;
    agentId: string;
    workspaceId: string;
    from?: string;
    customAccountId?: string;
  }
) {
  let customAccountId = input.customAccountId;

  if (input.from && !customAccountId) {
    const alookAddress = input.agent.emailHandle ? `${input.agent.emailHandle}@alook.ai` : null;
    if (input.from === alookAddress) {
      return { fromAddress: input.from, customAccountId: undefined };
    }

    const allAccounts = await cached(cacheKeys.allEmailAccounts(input.workspaceId), 600, () =>
      queries.emailAccount.getAllEmailAccountsForWorkspace(db, input.workspaceId)
    );
    const match = allAccounts.find((account) =>
      account.agentId === input.agentId && account.emailAddress === input.from
    );
    if (!match) {
      return { error: `email address '${input.from}' is not configured for this agent`, status: 400 as const };
    }

    customAccountId = match.id;
    return { fromAddress: match.emailAddress, customAccountId };
  }

  if (customAccountId) {
    const account = await queries.emailAccount.getEmailAccountScoped(
      db,
      customAccountId,
      input.agentId,
      input.workspaceId
    );
    if (!account) {
      return { error: "custom email account not found", status: 404 as const };
    }

    return { fromAddress: account.emailAddress, customAccountId };
  }

  if (!input.agent.emailHandle) {
    return { error: "agent has no email handle configured", status: 400 as const };
  }

  return { fromAddress: `${input.agent.emailHandle}@alook.ai`, customAccountId: undefined };
}
