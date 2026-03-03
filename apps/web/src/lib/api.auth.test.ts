import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  clearAuthSession: vi.fn(),
  getAuthToken: vi.fn(),
}));

import { api, ApiError } from "@/lib/api";
import { clearAuthSession, getAuthToken } from "@/lib/auth";

describe("api auth behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthToken).mockReturnValue("fake-token");
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
});
