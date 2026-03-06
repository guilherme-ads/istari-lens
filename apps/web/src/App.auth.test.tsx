import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Outlet } from "react-router-dom";

vi.mock("./lib/auth", () => ({
  hasAuthSession: vi.fn(),
  getStoredUser: vi.fn(),
}));
vi.mock("./lib/api", () => ({
  api: {
    restoreSession: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("./components/shared/AppLayout", () => ({
  default: () => <Outlet />,
}));
vi.mock("./pages/HomePage", () => ({ default: () => <div>home-public</div> }));
vi.mock("./pages/LoginPage", () => ({ default: () => <div>login-page</div> }));
vi.mock("./pages/OverviewPage", () => ({ default: () => <div>overview-page</div> }));
vi.mock("./pages/AdminPage", () => ({ default: () => <div>admin-page</div> }));
vi.mock("./pages/DatasetsPage", () => ({ default: () => <div>datasets-page</div> }));
vi.mock("./pages/DashboardsPage", () => ({ default: () => <div>dashboards-page</div> }));
vi.mock("./pages/DatasetDetailPage", () => ({ default: () => <div>dataset-detail-page</div> }));
vi.mock("./pages/DashboardViewPage", () => ({ default: () => <div>dashboard-view-page</div> }));
vi.mock("./pages/BuilderPage", () => ({ default: () => <div>builder-page</div> }));
vi.mock("./pages/ApiConfigPage", () => ({ default: () => <div>api-config-page</div> }));
vi.mock("./pages/SharedAnalysisPage", () => ({ default: () => <div>shared-analysis-page</div> }));
vi.mock("./pages/NotFound", () => ({ default: () => <div>not-found-page</div> }));
vi.mock("./pages/AdminUsersPage", () => ({ default: () => <div>admin-users-page</div> }));

import App from "./App";
import { getStoredUser, hasAuthSession } from "./lib/auth";
import { api } from "./lib/api";

describe("auth route guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tries restore session on app bootstrap when unauthenticated", async () => {
    vi.mocked(hasAuthSession).mockReturnValue(false);
    vi.mocked(getStoredUser).mockReturnValue(null);
    window.history.pushState({}, "", "/datasets");

    render(<App />);

    expect(api.restoreSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("login-page")).toBeInTheDocument();
  });

  it("redirects unauthenticated users to /login for protected routes", async () => {
    vi.mocked(hasAuthSession).mockReturnValue(false);
    vi.mocked(getStoredUser).mockReturnValue(null);
    window.history.pushState({}, "", "/datasets");

    render(<App />);

    expect(await screen.findByText("login-page")).toBeInTheDocument();
  });

  it("redirects non-admin users away from admin-only pages", async () => {
    vi.mocked(hasAuthSession).mockReturnValue(true);
    vi.mocked(getStoredUser).mockReturnValue({
      id: 10,
      email: "user@test.com",
      full_name: "User",
      is_admin: false,
    });
    window.history.pushState({}, "", "/admin/users");

    render(<App />);

    expect(await screen.findByText("overview-page")).toBeInTheDocument();
  });
});
