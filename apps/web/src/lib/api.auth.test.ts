import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  clearAuthSession: vi.fn(),
  getAuthToken: vi.fn(),
  isAuthTokenFresh: vi.fn(),
  setAuthSession: vi.fn(),
  updateAuthToken: vi.fn(),
  updateStoredUser: vi.fn(),
}));

import { api, ApiError } from "@/lib/api";
import { clearAuthSession, getAuthToken, isAuthTokenFresh, setAuthSession } from "@/lib/auth";

describe("api auth behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthToken).mockReturnValue("fake-token");
    vi.mocked(isAuthTokenFresh).mockReturnValue(false);
  });

  it("clears session and redirects to /login on 401 for authenticated requests", async () => {
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    delete (window as Window & { location?: Location }).location;
    Object.defineProperty(window, "location", {
      value: { ...originalLocation, assign: assignSpy },
      writable: true,
      configurable: true,
    });

    window.history.pushState({}, "", "/home");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Unauthorized" }),
      }),
    );

    await expect(api.listDatasources()).rejects.toBeInstanceOf(ApiError);
    expect(clearAuthSession).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/login");

    delete (window as Window & { location?: Location }).location;
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it("refreshes access token and retries request once on 401", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Unauthorized" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-token",
          token_type: "bearer",
          remember_me: true,
          user: { id: 1, email: "user@test.com", full_name: "User", is_admin: false, is_owner: false, created_at: "2026-01-01T00:00:00Z" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await api.listDatasources();
    expect(Array.isArray(response)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/auth/refresh");
    expect(clearAuthSession).not.toHaveBeenCalled();
  });

  it("sends remember_me on login payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-token",
        token_type: "bearer",
        remember_me: false,
        user: { id: 1, email: "user@test.com", full_name: "User", is_admin: false, is_owner: false, created_at: "2026-01-01T00:00:00Z" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.login("user@test.com", "secret123", false);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toContain("\"remember_me\":false");
  });

  it("restores session from refresh when no access token exists", async () => {
    vi.mocked(getAuthToken).mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-token",
          token_type: "bearer",
          remember_me: true,
          user: { id: 1, email: "user@test.com", full_name: "User", is_admin: false, is_owner: false, created_at: "2026-01-01T00:00:00Z" },
        }),
      }),
    );

    const restored = await api.restoreSession();
    expect(restored).toBe(true);
    expect(setAuthSession).toHaveBeenCalledWith(
      "new-token",
      expect.objectContaining({ email: "user@test.com" }),
      true,
    );
  });
});
