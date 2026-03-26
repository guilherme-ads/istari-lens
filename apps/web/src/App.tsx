import { lazy, Suspense, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./components/ui/theme-provider";
import AppLayout from "./components/shared/AppLayout";
import { clearAuthSession, getStoredUser, hasAuthSession, isAuthTokenFresh } from "./lib/auth";
import { api } from "./lib/api";

const AccountPage = lazy(() => import("./pages/AccountPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const AdminUsersPage = lazy(() => import("./pages/AdminUsersPage"));
const ApiConfigPage = lazy(() => import("./pages/ApiConfigPage"));
const BuilderPage = lazy(() => import("./pages/BuilderPage"));
const DashboardViewPage = lazy(() => import("./pages/DashboardViewPage"));
const DatasetCanvas = lazy(() => import("./pages/DatasetCanvas"));
const DashboardsPage = lazy(() => import("./pages/DashboardsPage"));
const DatasetDetailPage = lazy(() => import("./pages/DatasetDetailPage"));
const DatasetsPage = lazy(() => import("./pages/DatasetsPage"));
const HomePage = lazy(() => import("./pages/HomePage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const NotFound = lazy(() => import("./pages/NotFound"));
const OverviewPage = lazy(() => import("./pages/OverviewPage"));

const queryClient = new QueryClient();
const fullPageFallback = <div className="min-h-screen bg-background" />;
const inLayoutFallback = <div className="app-container py-6" />;
const withFullPageSuspense = (element: JSX.Element) => <Suspense fallback={fullPageFallback}>{element}</Suspense>;
const withInLayoutSuspense = (element: JSX.Element) => <Suspense fallback={inLayoutFallback}>{element}</Suspense>;

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
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            {authReady ? (
              <Routes>
                <Route path="/" element={withFullPageSuspense(<HomePage />)} />
                <Route path="/login" element={withFullPageSuspense(<RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>)} />
                <Route
                  path="/presentation/datasets/:datasetId/dashboard/:dashboardId"
                  element={withFullPageSuspense(<DashboardViewPage />)}
                />
                <Route
                  path="/public/dashboard/:dashboardId"
                  element={withFullPageSuspense(<DashboardViewPage />)}
                />

                <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                  <Route path="/home" element={withInLayoutSuspense(<OverviewPage />)} />
                  <Route path="/datasets" element={withInLayoutSuspense(<DatasetsPage />)} />
                  <Route path="/datasets/new" element={withInLayoutSuspense(<DatasetCanvas />)} />
                  <Route path="/datasets/:datasetId/edit" element={withInLayoutSuspense(<DatasetCanvas />)} />
                  <Route path="/dashboards" element={withInLayoutSuspense(<DashboardsPage />)} />
                  <Route path="/account" element={withInLayoutSuspense(<AccountPage />)} />
                  <Route path="/datasets/:datasetId" element={withInLayoutSuspense(<DatasetDetailPage />)} />
                  <Route path="/datasets/:datasetId/dashboard/:dashboardId" element={withInLayoutSuspense(<DashboardViewPage />)} />
                  <Route path="/datasets/:datasetId/builder" element={withInLayoutSuspense(<BuilderPage />)} />
                  <Route path="/datasets/:datasetId/builder/:dashboardId" element={withInLayoutSuspense(<BuilderPage />)} />
                  <Route path="/api-config" element={withInLayoutSuspense(<RequireAdmin><ApiConfigPage /></RequireAdmin>)} />
                  <Route path="/admin" element={withInLayoutSuspense(<RequireAdmin><AdminPage /></RequireAdmin>)} />
                  <Route path="/admin/users" element={withInLayoutSuspense(<RequireAdmin><AdminUsersPage /></RequireAdmin>)} />
                </Route>

                <Route path="*" element={withFullPageSuspense(<NotFound />)} />
              </Routes>
            ) : null}
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};

export default App;
