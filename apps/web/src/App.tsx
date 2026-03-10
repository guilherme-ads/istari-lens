import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./components/ui/theme-provider";
import AppLayout from "./components/shared/AppLayout";
import { clearAuthSession, getStoredUser, hasAuthSession, isAuthTokenFresh } from "./lib/auth";
import { api } from "./lib/api";
import AccountPage from "./pages/AccountPage";
import AdminPage from "./pages/AdminPage";
import AdminUsersPage from "./pages/AdminUsersPage";
import ApiConfigPage from "./pages/ApiConfigPage";
import BuilderPage from "./pages/BuilderPage";
import DashboardViewPage from "./pages/DashboardViewPage";
import DashboardsPage from "./pages/DashboardsPage";
import DatasetDetailPage from "./pages/DatasetDetailPage";
import DatasetsPage from "./pages/DatasetsPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import NewDatasetPage from "./pages/NewDatasetPage";
import NotFound from "./pages/NotFound";
import OverviewPage from "./pages/OverviewPage";
import SharedAnalysisPage from "./pages/SharedAnalysisPage";

const queryClient = new QueryClient();

const RequireAdmin = ({ children }: { children: JSX.Element }) => {
  const user = getStoredUser();
  if (!user?.is_admin) return <Navigate to="/home" replace />;
  return children;
};

const RequireAuth = ({ children }: { children: JSX.Element }) => {
  if (!hasAuthSession()) return <Navigate to="/login" replace />;
  return children;
};

const RedirectIfAuthenticated = ({ children }: { children: JSX.Element }) => {
  if (hasAuthSession()) return <Navigate to="/home" replace />;
  return children;
};

const App = () => {
  const [authReady, setAuthReady] = useState(hasAuthSession());

  useEffect(() => {
    let cancelled = false;
    const alreadyHasSession = hasAuthSession();
    const hasStaleSession = alreadyHasSession && !isAuthTokenFresh();

    // If a session exists, render immediately — don't block the UI.
    // restoreSession still runs to silently refresh an expired access token.
    if (alreadyHasSession) setAuthReady(true);

    (async () => {
      const restored = await api.restoreSession();
      if (!restored && hasStaleSession) {
        clearAuthSession();
        if (!cancelled && window.location.pathname !== "/login") {
          window.location.assign("/login");
          return;
        }
      }
      if (!cancelled && !alreadyHasSession) setAuthReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            {authReady ? (
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/login" element={<RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>} />
                <Route path="/shared/:shareToken" element={<SharedAnalysisPage />} />
                <Route
                  path="/presentation/datasets/:datasetId/dashboard/:dashboardId"
                  element={<DashboardViewPage />}
                />
                <Route
                  path="/public/dashboard/:dashboardId"
                  element={<DashboardViewPage />}
                />

                <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                  <Route path="/home" element={<OverviewPage />} />
                  <Route path="/datasets" element={<DatasetsPage />} />
                  <Route path="/datasets/new" element={<NewDatasetPage />} />
                  <Route path="/datasets/:datasetId/edit" element={<NewDatasetPage />} />
                  <Route path="/dashboards" element={<DashboardsPage />} />
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="/datasets/:datasetId" element={<DatasetDetailPage />} />
                  <Route path="/datasets/:datasetId/dashboard/:dashboardId" element={<DashboardViewPage />} />
                  <Route path="/datasets/:datasetId/builder" element={<BuilderPage />} />
                  <Route path="/datasets/:datasetId/builder/:dashboardId" element={<BuilderPage />} />
                  <Route path="/api-config" element={<RequireAdmin><ApiConfigPage /></RequireAdmin>} />
                  <Route path="/admin" element={<RequireAdmin><AdminPage /></RequireAdmin>} />
                  <Route path="/admin/users" element={<RequireAdmin><AdminUsersPage /></RequireAdmin>} />
                </Route>

                <Route path="*" element={<NotFound />} />
              </Routes>
            ) : null}
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};

export default App;
