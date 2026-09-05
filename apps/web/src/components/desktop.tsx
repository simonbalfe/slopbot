import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { api } from "@/lib/api";

type Agent = Awaited<ReturnType<typeof api.agents.list>>[number];
type BrowserInput = Parameters<typeof api.agents.browserInput>[0]["input"];
export function Desktop({ agent }: Readonly<{ agent: Agent }>): React.ReactNode {
  const [screenUrl, setScreenUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const viewer = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!agent?.desktop) {
      setScreenUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });
      return;
    }
    let cancelled = false;
    const frame = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/agents/${agent.id}/browser/screenshot?at=${Date.now()}`,
        );
        if (!response.ok || cancelled) return;
        const url = URL.createObjectURL(await response.blob());
        if (!cancelled)
          setScreenUrl((current) => {
            if (current) URL.revokeObjectURL(current);
            return url;
          });
        else URL.revokeObjectURL(url);
      } finally {
        if (!cancelled) window.setTimeout(() => void frame(), 750);
      }
    };
    void frame();
    return () => {
      cancelled = true;
    };
  }, [agent?.desktop?.viewerUrl, agent?.id]);
  const browserInput = async (input: BrowserInput): Promise<void> => {
    if (agent?.desktop)
      await api.agents.browserInput({ agentId: agent.id, input });
  };
  const point = (
    event: React.PointerEvent | React.WheelEvent,
  ): { x: number; y: number } | undefined => {
    const image = viewer.current;
    if (!image?.naturalWidth || !image.naturalHeight) return undefined;
    const rect = image.getBoundingClientRect(),
      scale = Math.min(
        rect.width / image.naturalWidth,
        rect.height / image.naturalHeight,
      );
    const width = image.naturalWidth * scale,
      height = image.naturalHeight * scale,
      x = event.clientX - rect.left - (rect.width - width) / 2,
      y = event.clientY - rect.top - (rect.height - height) / 2;
    return x < 0 || y < 0 || x > width || y > height
      ? undefined
      : { x: x / scale, y: y / scale };
  };
  return (
    <aside
      className={`flex min-h-0 flex-col border-l border-line bg-panel p-4 ${expanded ? "fixed inset-0 z-10 border-l-0" : ""}`}
    >
      <div className="pb-2 text-[11px] font-semibold tracking-[.08em] text-muted-foreground">
        LIVE DESKTOP
      </div>
      {agent.desktop ? (
        <img
          ref={viewer}
          className={`w-full rounded-xl border border-line bg-zinc-800 object-contain ${expanded ? "min-h-0 flex-1" : "aspect-video"}`}
          src={screenUrl}
          alt={`${agent.name} desktop`}
          onPointerUp={(event) => {
            const position = point(event);
            if (position)
              void browserInput({
                type: "click",
                ...position,
                button: "left",
                clickCount: 1,
              });
          }}
          onWheel={(event) => {
            const position = point(event);
            if (!position) return;
            event.preventDefault();
            void browserInput({
              type: "scroll",
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            });
          }}
        />
      ) : (
        <div className="grid aspect-video place-items-center rounded-xl border border-line bg-zinc-900 px-6 text-center text-xs text-muted-foreground">
          No computer assigned. This bot can still use Pi, files, shell,
          messaging, and skills.
        </div>
      )}
      <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
        <span>{agent.desktop ? `${agent.name} desktop` : "No computer"}</span>
        <span className="flex gap-3">
          {agent.desktop?.viewerUrl && (
            <a
              href={agent.desktop.viewerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-100"
            >
              Open login
            </a>
          )}
          {agent.desktop && (
            <button
              className="text-zinc-100"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Exit" : "Expand"}
            </button>
          )}
        </span>
      </div>
    </aside>
  );
}
