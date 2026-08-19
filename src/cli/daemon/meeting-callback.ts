export interface MeetingCallbackInput {
  meetingId: string
  workspaceId: string
  callbackUrl: string
  authToken: string
}

export async function sendMeetingCallback(
  input: MeetingCallbackInput,
  status: "completed" | "failed",
  transcript?: string,
  error?: string,
): Promise<Response> {
  const response = await fetch(`${input.callbackUrl}/api/meeting/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.authToken}`,
    },
    body: JSON.stringify({
      meetingId: input.meetingId,
      workspaceId: input.workspaceId,
      status,
      transcript: transcript || undefined,
      error: error || undefined,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`)
  }

  return response
}
