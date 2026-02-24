import { useNavigate } from "react-router-dom";
import {
  Layers, Settings, LogOut, Home, Users, LayoutDashboard, KeyRound,
} from "lucide-react";
import { NavLink } from "@/components/NavLink";
import BrandLogo from "@/components/shared/BrandLogo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getStoredUser } from "@/lib/auth";

export function AppSidebar() {
  const navigate = useNavigate();
  const user = getStoredUser();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const mainNav = [
    { title: "Home", url: "/home", icon: Home },
    { title: "Datasets", url: "/datasets", icon: Layers },
    { title: "Dashboards", url: "/dashboards", icon: LayoutDashboard },
    ...(user?.is_admin
      ? [
        { title: "Fontes", url: "/admin", icon: Settings },
        { title: "Usuários", url: "/admin/users", icon: Users },
        { title: "APIs", url: "/api-config", icon: KeyRound },
      ]
      : []),
  ];

  return (
    <Sidebar collapsible="icon">
      {/* Brand */}
      <SidebarHeader className="p-3">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent shadow-sm">
            <span className="text-sm font-extrabold text-accent-foreground">iL</span>
          </div>
          {!collapsed && (
            <BrandLogo className="text-sidebar-foreground" />
          )}
        </div>
      </SidebarHeader>

      <Separator className="bg-sidebar-border mx-3 w-auto" />

      {/* Main nav */}
      <SidebarContent className="pt-2">
        <SidebarGroup>
          {!collapsed && (
            <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-sidebar-foreground/50 px-3">
              Menu
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNav.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild>
                        <NavLink
                          to={item.url}
                          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                          activeClassName="bg-sidebar-accent text-sidebar-foreground"
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          {!collapsed && <span>{item.title}</span>}
                        </NavLink>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {collapsed && (
                      <TooltipContent side="right" className="text-xs">
                        {item.title}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer */}
      <SidebarFooter className="p-3">
        <Separator className="bg-sidebar-border mb-2" />
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuButton asChild>
                  <button
                    onClick={() => navigate("/login")}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    {!collapsed && <span>Sair</span>}
                  </button>
                </SidebarMenuButton>
              </TooltipTrigger>
              {collapsed && (
                <TooltipContent side="right" className="text-xs">
                  Sair
                </TooltipContent>
              )}
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
