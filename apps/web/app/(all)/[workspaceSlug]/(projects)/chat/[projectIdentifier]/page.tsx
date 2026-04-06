/**
 * Rocket.Chat integration — project-specific channel page
 *
 * URL: /:workspaceSlug/chat/:projectIdentifier
 * Opens the RC channel named after the project identifier (e.g. "PROJ").
 */

import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { useUser } from "@/hooks/store/user";
import { Loader } from "@plane/ui";

const CHAT_BASE_URL = "/chat";
const CHAT_SSO_URL = "/chat-svc/sso/token";

export default function ProjectChatPage() {
  const { projectIdentifier } = useParams();
  const { data: currentUser } = useUser();

  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const authenticateAndLoadChat = useCallback(async () => {
    const channelPath = projectIdentifier ? `/channel/${projectIdentifier.toLowerCase()}` : "";
    const fallbackUrl = `${CHAT_BASE_URL}${channelPath}`;

    if (!currentUser?.id) {
      setIframeSrc(fallbackUrl);
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(CHAT_SSO_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      if (!response.ok) {
        setIframeSrc(fallbackUrl);
        setLoading(false);
        return;
      }

      const data = await response.json();
      const src = `${CHAT_BASE_URL}${channelPath}?resumeToken=${data.authToken}&userId=${data.userId}`;
      setIframeSrc(src);
    } catch {
      setIframeSrc(fallbackUrl);
    } finally {
      setLoading(false);
    }
  }, [currentUser, projectIdentifier]);

  useEffect(() => {
    authenticateAndLoadChat();
  }, [authenticateAndLoadChat]);

  return (
    <>
      <PageHead title={`Chat - ${projectIdentifier ?? "Project"}`} />
      <div className="relative h-full w-full">
        {loading && (
          <div className="flex h-full w-full items-center justify-center">
            <Loader>
              <Loader.Item height="100%" width="100%" />
            </Loader>
          </div>
        )}
        {!loading && iframeSrc && (
          // eslint-disable-next-line react/iframe-missing-sandbox
          <iframe
            src={iframeSrc}
            title={`Rocket.Chat - ${projectIdentifier}`}
            className="h-full w-full border-0"
            allow="camera; microphone; clipboard-write; clipboard-read"
          />
        )}
      </div>
    </>
  );
}
