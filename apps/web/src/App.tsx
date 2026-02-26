import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { getStoredUser, hasAuthSession } from "./lib/auth";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import AppLayout from "./components/shared/AppLayout";
import OverviewPage from "./pages/OverviewPage";
import AdminPage from "./pages/AdminPage";
import DatasetsPage from "./pages/DatasetsPage";
import DashboardsPage from "./pages/DashboardsPage";
import DatasetDetailPage from "./pages/DatasetDetailPage";
import DashboardViewPage from "./pages/DashboardViewPage";
import BuilderPage from "./pages/BuilderPage";
import ApiConfigPage from "./pages/ApiConfigPage";
import SharedAnalysisPage from "./pages/SharedAnalysisPage";
import NotFound from "./pages/NotFound";
import AdminUsersPage from "./pages/AdminUsersPage";

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

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Public pages — no sidebar */}
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>} />
          <Route path="/shared/:shareToken" element={<SharedAnalysisPage />} />
          <Route
            path="/presentation/datasets/:datasetId/dashboard/:dashboardId"
            element={<RequireAuth><DashboardViewPage /></RequireAuth>}
          />

          {/* Authenticated pages — sidebar layout */}
          <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
            <Route path="/home" element={<OverviewPage />} />
            <Route path="/datasets" element={<DatasetsPage />} />
            <Route path="/dashboards" element={<DashboardsPage />} />
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
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
