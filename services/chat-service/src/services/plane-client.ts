// ──────────────────────────────────────────────────────────────────────────────
// Plane REST-API client
// Reads workspace members, projects, and project members.
// ──────────────────────────────────────────────────────────────────────────────

import axios, { type AxiosInstance } from "axios";
import axiosRetry, { exponentialDelay } from "axios-retry";
import { config } from "../config/index.js";

class PlaneClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.plane.apiUrl,
      timeout: 15_000,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": config.plane.apiToken,
      },
    });
    axiosRetry(this.http, { retries: 2, retryDelay: exponentialDelay });
  }

  // ── Workspace members ─────────────────────────────────────────────────────

  async listWorkspaceMembers(): Promise<any[]> {
    const slug = config.plane.workspaceSlug;
    const results: any[] = [];
    let cursor: string | null = null;

    do {
      const params: Record<string, string> = { per_page: "100" };
      if (cursor) params.cursor = cursor;

      // eslint-disable-next-line no-await-in-loop -- pagination is inherently sequential
      const { data } = await this.http.get(`/api/v1/workspaces/${slug}/members/`, { params });

      if (Array.isArray(data)) {
        results.push(...data);
        break; // non-paginated response
      }

      results.push(...(data.results ?? []));
      cursor = data.next_page_results ? (data.next_cursor ?? null) : null;
    } while (cursor);

    return results;
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(): Promise<any[]> {
    const slug = config.plane.workspaceSlug;
    const results: any[] = [];
    let cursor: string | null = null;

    do {
      const params: Record<string, string> = { per_page: "100" };
      if (cursor) params.cursor = cursor;

      // eslint-disable-next-line no-await-in-loop -- pagination is inherently sequential
      const { data } = await this.http.get(`/api/v1/workspaces/${slug}/projects/`, { params });

      if (Array.isArray(data)) {
        results.push(...data);
        break;
      }

      results.push(...(data.results ?? []));
      cursor = data.next_page_results ? (data.next_cursor ?? null) : null;
    } while (cursor);

    return results;
  }

  // ── Project members ───────────────────────────────────────────────────────

  async listProjectMembers(projectId: string): Promise<any[]> {
    const slug = config.plane.workspaceSlug;
    const { data } = await this.http.get(`/api/v1/workspaces/${slug}/projects/${projectId}/members/`);
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  // ── Single member lookup ──────────────────────────────────────────────────

  async getWorkspaceMember(memberId: string): Promise<any | null> {
    const slug = config.plane.workspaceSlug;
    try {
      const { data } = await this.http.get(`/api/v1/workspaces/${slug}/members/${memberId}/`);
      return data;
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  // ── Single project lookup ─────────────────────────────────────────────────

  async getProject(projectId: string): Promise<any | null> {
    const slug = config.plane.workspaceSlug;
    try {
      const { data } = await this.http.get(`/api/v1/workspaces/${slug}/projects/${projectId}/`);
      return data;
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }
}

export const planeClient = new PlaneClient();
