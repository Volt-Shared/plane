/**
 * Rocket.Chat integration — embedded chat page
 *
 * Embeds Rocket.Chat in an iframe. Auto-login is handled by RC's
 * Accounts_iframe_url setting — RC's client JS automatically calls
 * /chat-svc/sso/rc-iframe-auth with the browser's cookies, gets a
 * loginToken, and logs the user in. No client-side SSO code needed.
 */

import { PageHead } from "@/components/core/page-title";

export default function WorkspaceChatPage() {
  return (
    <>
      <PageHead title="Chat" />
      <div className="relative h-full w-full">
        {/* eslint-disable-next-line react/iframe-missing-sandbox */}
        <iframe
          src="/chat"
          title="Rocket.Chat"
          className="h-full w-full border-0"
          allow="camera; microphone; clipboard-write; clipboard-read"
        />
      </div>
    </>
  );
}
