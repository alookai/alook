export class APIClient {
  constructor(
    private baseURL: string,
    private token: string,
    private workspaceId?: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;

    const res = await fetch(this.baseURL + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  getJSON<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  postJSON<T>(path: string, body?: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  deleteJSON<T>(path: string): Promise<T> {
    return this.request("DELETE", path);
  }

  patchJSON<T>(path: string, body?: unknown): Promise<T> {
    return this.request("PATCH", path, body);
  }

  putJSON<T>(path: string, body?: unknown): Promise<T> {
    return this.request("PUT", path, body);
  }

  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;

    const res = await fetch(this.baseURL + path, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  async getText(path: string): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;

    const res = await fetch(this.baseURL + path, { method: "GET", headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.text();
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getJSON("/health");
      return true;
    } catch {
      return false;
    }
  }
}
