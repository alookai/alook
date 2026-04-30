import { eq, and, desc, lte, isNotNull } from "drizzle-orm";
import { meetingSession, agent } from "../schema";
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

export async function getMeetingSession(
  db: Database,
  id: string,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(meetingSession)
    .where(
      and(eq(meetingSession.id, id), eq(meetingSession.workspaceId, workspaceId))
    );
  return rows[0] ?? null;
}

export async function getMeetingSessionById(db: Database, id: string) {
  const rows = await db
    .select()
    .from(meetingSession)
    .where(eq(meetingSession.id, id));
  return rows[0] ?? null;
}

export async function listMeetingSessions(
  db: Database,
  agentId: string,
  workspaceId: string
) {
  return db
    .select()
    .from(meetingSession)
    .where(
      and(
        eq(meetingSession.agentId, agentId),
        eq(meetingSession.workspaceId, workspaceId)
      )
    )
    .orderBy(desc(meetingSession.createdAt));
}

export async function updateMeetingSession(
  db: Database,
  id: string,
  workspaceId: string,
  patch: Partial<{
    title: string;
    status: string;
    startedAt: string;
    completedAt: string;
    transcriptR2Key: string;
    summary: string;
    error: string;
    workerSessionId: string;
  }>
) {
  const rows = await db
    .update(meetingSession)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(
      and(eq(meetingSession.id, id), eq(meetingSession.workspaceId, workspaceId))
    )
    .returning();
  return rows[0] ?? null;
}

export async function claimMeetingSession(
  db: Database,
  id: string,
  workspaceId: string,
  startedAt: string,
) {
  const rows = await db
    .update(meetingSession)
    .set({ status: "joining", startedAt, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(meetingSession.id, id),
        eq(meetingSession.workspaceId, workspaceId),
        eq(meetingSession.status, "scheduled"),
      )
    )
    .returning();
  return rows[0] ?? null;
}

export async function deleteMeetingSession(
  db: Database,
  id: string,
  workspaceId: string
) {
  const rows = await db
    .delete(meetingSession)
    .where(
      and(eq(meetingSession.id, id), eq(meetingSession.workspaceId, workspaceId))
    )
    .returning();
  return rows[0] ?? null;
}

export async function listScheduledMeetings(
  db: Database,
  workspaceId: string,
  beforeOrAt: string
) {
  return db
    .select({
      id: meetingSession.id,
      agentId: meetingSession.agentId,
      workspaceId: meetingSession.workspaceId,
      title: meetingSession.title,
      meetingUrl: meetingSession.meetingUrl,
      status: meetingSession.status,
      participants: meetingSession.participants,
      scheduledAt: meetingSession.scheduledAt,
      agentName: agent.name,
    })
    .from(meetingSession)
    .leftJoin(agent, eq(agent.id, meetingSession.agentId))
    .where(
      and(
        eq(meetingSession.workspaceId, workspaceId),
        eq(meetingSession.status, "scheduled"),
        eq(meetingSession.isWhitelisted, true),
        lte(meetingSession.scheduledAt, beforeOrAt)
      )
    )
    .orderBy(meetingSession.scheduledAt);
}

export async function listMeetingsWithSchedule(
  db: Database,
  workspaceId: string
) {
  return db
    .select()
    .from(meetingSession)
    .where(
      and(
        eq(meetingSession.workspaceId, workspaceId),
        isNotNull(meetingSession.scheduledAt)
      )
    )
    .orderBy(meetingSession.scheduledAt);
}
