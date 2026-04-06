/**
 * Rocket.Chat integration — header component
 */

import { PiChatLogo } from "@plane/propel/icons";

export function WorkspaceChatHeader() {
  return (
    <div className="flex items-center gap-2 px-4">
      <PiChatLogo className="size-4 text-primary" />
      <span className="text-base font-medium">Chat</span>
    </div>
  );
}
