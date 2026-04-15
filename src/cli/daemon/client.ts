import {
  PollResponseSchema,
  RegisterResponseSchema,
  type PollResponse,
  type RegisterResponse,
  type TaskApi,
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
    const res = await fetch(this.baseURL + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  async register(
    token: string,
    body: {
      workspace_id: string;
      daemon_id: string;
      device_name: string;
      cli_version: string;
      runtimes: {
        name: string;
        type: string;
        version: string;
        status: string;
      }[];
    },
  ): Promise<RegisterResponse> {
    const raw = await this.request<unknown>(
      "POST",
      "/api/daemon/register",
      token,
      body,
    );
    return RegisterResponseSchema.parse(raw);
  }

  deregister(token: string, daemonId: string) {
    return this.request("POST", "/api/daemon/deregister", token, {
      daemon_id: daemonId,
    });
  }

  async poll(token: string, daemonId: string, maxTasks: number): Promise<TaskApi[]> {
    const raw = await this.request<unknown>(
      "POST",
      "/api/daemon/tasks/poll",
      token,
      { daemon_id: daemonId, max_tasks: maxTasks },
    );
    const resp: PollResponse = PollResponseSchema.parse(raw);
    return resp.tasks;
  }

  startTask(token: string, taskId: string) {
    return this.request("POST", `/api/daemon/tasks/${taskId}/start`, token);
  }

  completeTask(
    token: string,
    taskId: string,
    body: {
      output: string;
      session_id?: string;
      branch_name?: string;
    },
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

  reportMessages(
    token: string,
    taskId: string,
    messages: {
      seq: number;
      type: string;
      tool?: string;
      call_id?: string;
      content?: string;
      input?: Record<string, unknown>;
      output?: string;
    }[],
  ) {
    return this.request(
      "POST",
      `/api/daemon/tasks/${taskId}/messages`,
      token,
      { messages },
    );
  }
}
