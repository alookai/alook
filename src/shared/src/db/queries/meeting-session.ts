import { meetingSession } from "../schema";
import type { Database } from "../index";

export async function createMeetingSession(
  db: Database,
  data: {
    agentId: string;
    workspaceId: string;
    title?: string;
    meetingUrl: string;
    status?: string;
    fromEmail?: string | null;
    isWhitelisted?: boolean;
    participants?: string[];
    scheduledAt?: string | null;
  }
) {
  const now = new Date().toISOString();
  const rows = await db
    .insert(meetingSession)
    .values({
      agentId: data.agentId,
      workspaceId: data.workspaceId,
      title: data.title ?? "",
      meetingUrl: data.meetingUrl,
      status: data.status ?? "scheduled",
      fromEmail: data.fromEmail ?? null,
      isWhitelisted: data.isWhitelisted ?? true,
      participants: data.participants ?? [],
      scheduledAt: data.scheduledAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0]!;
}
