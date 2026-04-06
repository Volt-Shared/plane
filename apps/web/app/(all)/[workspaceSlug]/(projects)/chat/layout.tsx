/**
 * Rocket.Chat integration — layout wrapper
 */

import { Outlet } from "react-router";
import { AppHeader } from "@/components/core/app-header";
import { WorkspaceChatHeader } from "./header";

export default function WorkspaceChatLayout() {
  return (
    <>
      <AppHeader header={<WorkspaceChatHeader />} />
      {/* No ContentWrapper — the iframe fills the entire area */}
      <Outlet />
    </>
  );
}
