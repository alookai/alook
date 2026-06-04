import {
  PollResponseSchema,
  RegisterResponseSchema,
  type CompleteTaskRequest,
  type FileRequestItem,
  type MessageItem,
  type PollMeetingItem,
  type PollResponse,
  type RegisterDaemonRequest,
  type RegisterResponse,
  type SkillSyncRequest,
  type TaskApi,
  type WorkspaceFileReport,
} from "@alook/shared";

export class DaemonClient {
  constructor(private baseURL: string) {}

  private async request<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 500;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(this.baseURL + path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        if (res.status === 204) return undefined as T;
        return res.json();
      } catch (e) {
        if (e instanceof TypeError) {
          lastError = e;
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
            continue;
          }
        }
        throw e;
      }
    }
    throw lastError;
  }

  async register(
    token: string,
    body: RegisterDaemonRequest,
  ): Promise<RegisterResponse> {
    const raw = await this.request<unknown>(
      "POST",
      "/api/daemon/register",
      token,
      body,
    );
    return RegisterResponseSchema.parse(raw);
  }

  heartbeat(token: string, daemonId: string): Promise<unknown> {
    return this.request("POST", "/api/daemon/heartbeat", token, {
      daemon_id: daemonId,
    });
  }

  sweep(token: string, daemonId: string): Promise<unknown> {
    return this.request("POST", "/api/daemon/sweep", token, {
      daemon_id: daemonId,
    });
  }

  deregister(token: string, daemonId: string) {
    return this.request("POST", "/api/daemon/deregister", token, {
      daemon_id: daemonId,
    });
  }

  async poll(
    token: string,
    daemonId: string,
    maxTasks: number,
    cliVersion?: string,
  ): Promise<{
    tasks: TaskApi[];
    evicted: boolean;
    pending_update?: { version: string };
    pending_rescan?: boolean;
    file_requests?: FileRequestItem[];
    meetings?: PollMeetingItem[];
  }> {
    const raw = await this.request<unknown>(
      "POST",
      "/api/daemon/tasks/poll",
      token,
      { daemon_id: daemonId, max_tasks: maxTasks, ...(cliVersion && { cli_version: cliVersion }) },
    );
    const resp: PollResponse = PollResponseSchema.parse(raw);
    return {
      tasks: resp.tasks,
      evicted: resp.evicted ?? false,
      pending_update: resp.pending_update,
      pending_rescan: resp.pending_rescan,
      file_requests: resp.file_requests,
      meetings: resp.meetings,
    };
  }

  startTask(token: string, taskId: string) {
    return this.request("POST", `/api/daemon/tasks/${taskId}/start`, token);
  }

  completeTask(
    token: string,
    taskId: string,
    body: CompleteTaskRequest,
  ) {
    return this.request(
      "POST",
      `/api/daemon/tasks/${taskId}/complete`,
      token,
      body,
    );
  }

  failTask(token: string, taskId: string, error: string) {
    return this.request("POST", `/api/daemon/tasks/${taskId}/fail`, token, {
      error,
    });
  }

  supersedeTask(token: string, taskId: string) {
    return this.request("POST", `/api/daemon/tasks/${taskId}/supersede`, token);
  }

  async getArtifactMeta(
    token: string,
    artifactId: string,
    workspaceId: string,
  ): Promise<{ id: string; filename: string; content_type: string; size: number }> {
    return this.request(
      "GET",
      `/api/artifacts/${artifactId}?workspace_id=${encodeURIComponent(workspaceId)}`,
      token,
    );
  }

  async downloadArtifact(
    token: string,
    artifactId: string,
    workspaceId: string,
  ): Promise<ArrayBuffer> {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 500;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(
          `${this.baseURL}/api/artifacts/${artifactId}/content?workspace_id=${encodeURIComponent(workspaceId)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) {
          throw new Error(`artifact download failed: HTTP ${res.status}`);
        }
        return res.arrayBuffer();
      } catch (e) {
        if (e instanceof TypeError) {
          lastError = e;
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
            continue;
          }
        }
        throw e;
      }
    }
    throw lastError;
  }

  reportMessages(
    token: string,
    taskId: string,
    messages: MessageItem[],
  ) {
    return this.request(
      "POST",
      `/api/daemon/tasks/${taskId}/messages`,
      token,
      { messages },
    );
  }

  reportFileData(token: string, body: WorkspaceFileReport) {
    return this.request(
      "POST",
      "/api/daemon/workspace/report",
      token,
      body,
    );
  }

  syncSkills(token: string, body: SkillSyncRequest) {
    return this.request(
      "POST",
      "/api/daemon/skills/sync",
      token,
      body,
    );
  }

  async checkStandby(
    token: string,
    body: RegisterDaemonRequest,
  ): Promise<RegisterResponse & { standby?: boolean; workspaceId?: string }> {
    return this.request(
      "POST",
      "/api/daemon/register",
      token,
      body,
    );
  }

}
