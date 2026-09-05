import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import Markdown from "react-markdown";

import { api } from "@/lib/api";
import "./index.css";

type Agent = Awaited<ReturnType<typeof api.agents.list>>[number];
type Message = Agent["messages"][number];
type Skill = Awaited<ReturnType<typeof api.skills.list>>[number];
type BrowserInput = Parameters<typeof api.agents.browserInput>[0]["input"];
type AuthState = Awaited<ReturnType<typeof api.auth.state>>;
type ImageAttachment = NonNullable<
  Parameters<typeof api.agents.send>[0]["images"]
>[number];

const imageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;

function isImageMimeType(value: string): value is ImageAttachment["mimeType"] {
  return imageMimeTypes.some((mimeType) => mimeType === value);
}

async function imageAttachment(file: File): Promise<ImageAttachment> {
  if (!isImageMimeType(file.type))
    throw new Error("Paste a PNG, JPEG, or WebP image");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Each image must be 10 MB or smaller");
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the image"));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
  const separator = url.indexOf(",");
  if (separator < 0) throw new Error("Could not read the image");
  return { mimeType: file.type, data: url.slice(separator + 1) };
}

function imageUrl(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function Avatar({
  agent,
  working = false,
}: Readonly<{ agent: Agent; working?: boolean }>): React.ReactNode {
  return (
    <img
      src="/assets/slop-creature.png"
      alt={`${agent.name} mascot`}
      className={`size-11 shrink-0 rounded-xl object-cover ${working ? "agent-working" : ""}`}
    />
  );
}

function dateKey(value: string): string {
  return new Date(value).toLocaleDateString();
}
function dateLabel(value: string): string {
  const date = new Date(value),
    today = new Date(),
    yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (dateKey(value) === dateKey(today.toISOString())) return `Today ${time}`;
  if (dateKey(value) === dateKey(yesterday.toISOString()))
    return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

function messageKind(message: Message): string {
  return `${message.role}:${message.direction}`;
}

function messageStatus(status: Message["status"]): string | undefined {
  if (status === "queued") return "accepted";
  if (status === "processing") return "running";
  if (status === "delivered") return "completed";
  return status ?? undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Chat({ agent }: Readonly<{ agent: Agent }>): React.ReactNode {
  const scroll = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [agent.id, agent.messages.length]);

  return (
    <section
      className="min-h-0 overflow-auto px-5 py-7"
      id="messages"
      ref={scroll}
    >
      {agent.messages.map((message, index) => {
        const prior = agent.messages[index - 1];
        const dayChanged =
          prior && dateKey(prior.createdAt) !== dateKey(message.createdAt);
        const continued =
          prior && !dayChanged && messageKind(prior) === messageKind(message);
        const outbound =
          message.role === "user" ||
          (message.role === "agent" && message.direction === "outbound");
        return (
          <div key={message.id}>
            {dayChanged && (
              <div className="my-7 flex items-center justify-center gap-2 text-xs text-muted-foreground before:h-px before:w-8 before:bg-line after:h-px after:w-8 after:bg-line">
                {dateLabel(message.createdAt)}
              </div>
            )}
            <article
              className={`w-fit max-w-[78%] ${outbound ? "ml-auto" : ""} ${continued ? "mb-1" : "mt-5 mb-1"}`}
            >
              <div
                className={`rounded-2xl px-3 py-2.5 ${outbound ? "rounded-tr-md bg-[#37302a]" : "rounded-tl-md bg-[#212123]"}`}
              >
                {message.images.length > 0 && (
                  <div className="mb-2 flex max-w-lg flex-wrap gap-2">
                    {message.images.map((image, imageIndex) => (
                      <img
                        alt={`Attachment ${imageIndex + 1}`}
                        className="max-h-72 max-w-full rounded-lg object-contain"
                        key={imageIndex}
                        src={imageUrl(image)}
                      />
                    ))}
                  </div>
                )}
                <div className="message-markdown">
                  <Markdown>{message.text}</Markdown>
                </div>
              </div>
              {messageStatus(message.status) && (
                <div
                  className={`mt-1 text-[10px] uppercase tracking-wide text-muted-foreground ${outbound ? "text-right" : ""}`}
                >
                  {messageStatus(message.status)}
                </div>
              )}
            </article>
          </div>
        );
      })}
      {!agent.messages.length && (
        <div className="grid h-full place-content-center justify-items-center gap-4 text-sm text-muted-foreground">
          <img src="/assets/slop-creature.png" alt="A wonky lime-green slop creature" className="size-48 rounded-3xl" />
          <span className="slop-wordmark text-3xl">SLOPBOT</span>
        </div>
      )}
      {agent.status === "running" && (
        <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
          <Avatar agent={agent} working />
          <span>
            {agent.name} is working<span className="animate-pulse">...</span>
          </span>
        </div>
      )}
    </section>
  );
}

function App(): React.ReactNode {
  const [provider, setProvider] = useState<"openai-codex" | "nous">("openai-codex");
  const [models, setModels] = useState<readonly { id: string; name: string }[]>([]);
  const [auth, setAuth] = useState<AuthState>();
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [skills, setSkills] = useState<readonly Skill[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<readonly ImageAttachment[]>([]);
  const [composerError, setComposerError] = useState("");
  const [screenUrl, setScreenUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const viewer = useRef<HTMLImageElement>(null);
  const settings = useRef<HTMLDialogElement>(null);
  const agent = useMemo(
    () => agents.find((item) => item.id === selectedId) ?? agents[0],
    [agents, selectedId],
  );

  const refreshAuth = async (): Promise<void> => {
    setAuth(await api.auth.state());
  };
  const login = async (): Promise<void> => {
    try { setAuth(await api.auth.login({ provider })); await refresh(); }
    catch (error) { setAuth({ status: "error", message: errorText(error) }); }
  };

  const refresh = async (): Promise<void> => {
    setAgents(await api.agents.list());
  };
  const refreshSkills = async (): Promise<void> => {
    setSkills(await api.skills.list());
  };
  useEffect(() => {
    void refreshAuth();
    if (auth?.status === "authenticated") return;
    const timer = window.setInterval(() => void refreshAuth(), 1_000);
    return () => window.clearInterval(timer);
  }, [auth?.status]);
  useEffect(() => {
    if (auth?.status !== "authenticated") return;
    void refresh();
    void refreshSkills();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(timer);
  }, [auth?.status]);
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

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!agent || (!prompt.trim() && !images.length) || agent.status === "running")
      return;
    const text = prompt.trim();
    setComposerError("");
    try {
      await api.agents.send({ agentId: agent.id, text, images: [...images] });
      setPrompt("");
      setImages([]);
      await refresh();
    } catch (error) {
      setComposerError(errorText(error));
    }
  };
  const pasteImages = async (
    event: React.ClipboardEvent<HTMLInputElement>,
  ): Promise<void> => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!files.length) return;
    event.preventDefault();
    setComposerError("");
    try {
      const pasted = await Promise.all(files.map(imageAttachment));
      const next = [...images, ...pasted];
      if (next.length > 4) throw new Error("Attach up to 4 images");
      if (next.reduce((size, image) => size + image.data.length, 0) > 20_000_000)
        throw new Error("Image attachments are too large");
      setImages(next);
    } catch (error) {
      setComposerError(errorText(error));
    }
  };
  const clear = async (): Promise<void> => {
    if (
      !agent ||
      !window.confirm(`Clear ${agent.name}'s chat and start a fresh thread?`)
    )
      return;
    await api.agents.clear({ agentId: agent.id });
    settings.current?.close();
    await refresh();
  };
  const createSkill = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setSettingsError("");
    try {
      await api.skills.create({
        name: String(fields.get("name") ?? ""),
        description: String(fields.get("description") ?? ""),
        content: String(fields.get("content") ?? ""),
      });
      form.reset();
      await refreshSkills();
    } catch (error) {
      setSettingsError(errorText(error));
    }
  };
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
  if (!auth)
    return (
      <main className="grid h-screen place-items-center bg-app text-muted-foreground">
        Connecting to Pi…
      </main>
    );
  if (auth.status !== "authenticated")
    return (
      <main className="grid h-screen place-items-center bg-app p-6 text-zinc-100">
        <section className="w-full max-w-md rounded-3xl border border-line bg-panel p-8 shadow-2xl">
          <div className="mb-6 flex items-center gap-3 text-xl font-bold">
            <img src="/assets/slop-creature.png" alt="" className="size-14 rounded-xl" />
            <span className="slop-wordmark">SlopBot</span>
          </div>
          <h1 className="text-2xl font-semibold">
            Connect your model provider
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Sign in with your OpenAI or Nous account. Credentials stay in your local SlopBot data directory.
          </p>
          <label className="mt-4 block text-sm">Provider
            <select className="ml-3 rounded bg-raised p-2" value={provider} onChange={(event) => { setProvider(event.target.value === "nous" ? "nous" : "openai-codex"); }} disabled={auth.status === "pending" || auth.status === "starting"}>
              <option value="openai-codex">OpenAI Codex</option><option value="nous">Nous Portal</option>
            </select>
          </label>
          {auth.status === "pending" ? (
            <div className="mt-6 rounded-2xl bg-raised p-5">
              <div className="text-xs font-semibold tracking-[.08em] text-muted-foreground">
                DEVICE CODE
              </div>
              <button
                className="mt-2 font-mono text-3xl font-bold tracking-widest"
                onClick={() =>
                  void navigator.clipboard.writeText(auth.userCode)
                }
              >
                {auth.userCode}
              </button>
              <a
                className="mt-5 block rounded-xl bg-brand px-4 py-3 text-center font-semibold text-zinc-900"
                href={auth.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                Open provider and sign in
              </a>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                SlopBot will continue automatically after approval.
              </p>
            </div>
          ) : (
            <button
              type="button"
              className="mt-6 h-auto w-full rounded-xl bg-brand px-4 py-3 font-semibold text-zinc-900 disabled:opacity-50"
              disabled={auth.status === "starting"}
              onClick={() => void login()}
            >
              {auth.status === "starting"
                ? auth.message
                : `Sign in with ${provider === "nous" ? "Nous Portal" : "OpenAI"}`}
            </button>
          )}
          {auth.status === "error" && (
            <p className="mt-4 text-sm text-red-300">{auth.message}</p>
          )}
        </section>
      </main>
    );
  if (!agent)
    return (
      <main className="grid h-screen place-items-center bg-app text-muted-foreground">
        Loading agents…
      </main>
    );
  return (
    <main className="grid h-screen grid-cols-[240px_minmax(460px,1fr)_330px] overflow-hidden bg-app text-zinc-100">
      <aside className="border-r border-line bg-panel p-3">
        <div className="flex flex-col items-center gap-1 px-2 pb-6 pt-3 text-base font-bold">
          <img src="/assets/slop-creature.png" alt="SlopBot's googly-eyed slime mascot" className="size-32 -rotate-3 rounded-3xl" />
          <span className="slop-wordmark text-2xl">SLOPBOT</span>
        </div>
        <div className="px-2 pb-2 text-[11px] font-semibold tracking-[.08em] text-muted-foreground">
          AGENTS
        </div>
        {agents.map((item) => (
          <button
            className={`mb-1 flex w-full items-center gap-2 rounded-xl p-2 text-left ${item.id === agent.id ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
            key={item.id}
            onClick={() => setSelectedId(item.id)}
          >
            <Avatar agent={item} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between">
                <b>{item.name}</b>
                <i
                  className={`size-2 rounded-full ${item.status === "running" ? "bg-brand" : item.status === "error" ? "bg-red-400" : "bg-zinc-500"}`}
                />
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {item.role}
              </span>
            </span>
          </button>
        ))}
        <button
          className="mt-2 w-full rounded-xl border border-dashed border-line p-2 text-sm text-muted-foreground hover:text-zinc-100"
          onClick={() => settings.current?.showModal()}
        >
          + New bot
        </button>
      </aside>
      <section className="grid min-h-0 min-w-0 grid-rows-[auto_1fr_auto] overflow-hidden">
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <Avatar agent={agent} />
            <div>
              <b>{agent.name}</b>
              <div className="text-xs text-muted-foreground">
                {agent.id} · {agent.role}
              </div>
            </div>
          </div>
          <button
            className="text-xs text-muted-foreground hover:text-zinc-100"
            onClick={() => settings.current?.showModal()}
          >
            Settings
          </button>
        </header>
        <Chat agent={agent} />
        <form className="border-t border-line p-4" onSubmit={send}>
          {images.length > 0 && (
            <div className="mb-2 flex gap-2 overflow-auto">
              {images.map((image, imageIndex) => (
                <div className="relative shrink-0" key={imageIndex}>
                  <img
                    alt={`Pasted attachment ${imageIndex + 1}`}
                    className="size-20 rounded-lg border border-line object-cover"
                    src={imageUrl(image)}
                  />
                  <button
                    aria-label={`Remove image ${imageIndex + 1}`}
                    className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-zinc-100 text-xs text-zinc-900"
                    onClick={() =>
                      setImages((current) =>
                        current.filter((_, index) => index !== imageIndex),
                      )
                    }
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {composerError && (
            <p className="mb-2 text-xs text-red-300">{composerError}</p>
          )}
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-xl border border-line bg-raised px-3 py-2.5 outline-none focus:border-zinc-500"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={(event) => void pasteImages(event)}
              placeholder="Message agent or paste an image"
            />
            <button
              type="submit"
              className="h-auto rounded-xl bg-brand px-4 font-semibold text-zinc-900 disabled:opacity-40"
              disabled={
                agent.status === "running" || (!prompt.trim() && !images.length)
              }
            >
              Send
            </button>
          </div>
        </form>
      </section>
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
      <dialog
        className="max-h-[80vh] w-[min(680px,calc(100vw-2rem))] overflow-auto rounded-2xl border border-line bg-[#171719] p-5 text-zinc-100 backdrop:bg-black/60"
        ref={settings}
      >
        <div className="mb-5 flex items-center justify-between">
          <b>Settings</b>
          <button
            onClick={() => settings.current?.close()}
            className="text-sm text-muted-foreground"
          >
            Close
          </button>
        </div>
        {settingsError && (
          <p className="mb-4 rounded-lg bg-red-950 p-3 text-sm text-red-200">
            {settingsError}
          </p>
        )}
        <div className="mb-5 grid gap-3 text-sm">
          <p>Current model: {agent.provider} / {agent.model}</p>
          <label>Provider <select className="rounded bg-raised p-2" value={provider} onChange={(event) => setProvider(event.target.value === "nous" ? "nous" : "openai-codex")}>
            <option value="openai-codex">OpenAI Codex</option><option value="nous">Nous Portal</option>
          </select></label>
          <button className="rounded bg-brand p-2 text-zinc-900" onClick={() => void login()}>Sign in / switch provider</button>
          <button onClick={() => void api.auth.models().then(setModels).catch((error: unknown) => setSettingsError(errorText(error)))}>Load available models</button>
          <label>Model <select aria-label="Model" className="max-w-full rounded bg-raised p-2" value={agent.model} onChange={(event) => {
            void api.agents.profile().then((profile) => api.agents.update({ ...profile, model: event.target.value })).then(refresh).catch((error: unknown) => setSettingsError(errorText(error)));
          }}><option value={agent.model}>{agent.model}</option>{models.filter((item) => item.id !== agent.model).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        <p className="text-sm">Bot configuration is stored in SQLite. Use <code>bun run chat</code> and <code>/config</code> to inspect or edit it.</p>
        <div className="my-5 border-t border-line" />
        <div className="text-[11px] font-semibold tracking-[.08em] text-muted-foreground">
          ENABLED PI SKILLS ({skills.length})
        </div>
        <details className="mt-2 rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Add skill
          </summary>
          <form className="mt-3 grid gap-2" onSubmit={createSkill}>
            <input
              className="rounded-lg border border-line bg-raised px-3 py-2 text-sm"
              name="name"
              placeholder="skill-name"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
            />
            <input
              className="rounded-lg border border-line bg-raised px-3 py-2 text-sm"
              name="description"
              placeholder="When should Pi use this skill?"
              required
            />
            <textarea
              className="min-h-32 rounded-lg border border-line bg-raised px-3 py-2 font-mono text-sm"
              name="content"
              placeholder="Skill instructions"
              required
            />
            <button className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-zinc-900">
              Create skill
            </button>
          </form>
        </details>
        <div className="mt-2 grid max-h-[55vh] gap-2 overflow-auto">
          {skills.map((skill) => (
            <details className="rounded-xl bg-zinc-800 p-3" key={skill.name}>
              <summary className="cursor-pointer text-xs font-semibold">
                ${skill.name}
              </summary>
              <p className="mt-1 text-xs text-muted-foreground">
                {skill.description}
              </p>
              <pre className="mt-3 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs leading-5 text-zinc-300">
                {skill.content}
              </pre>
            </details>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
          <small className="max-w-48 text-muted-foreground">
            Clear this agent’s visible chat and start a fresh thread.
          </small>
          <button
            className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200 disabled:opacity-40"
            disabled={agent.status === "running" || !agent.messages.length}
            onClick={() => void clear()}
          >
            Clear chat
          </button>
        </div>
      </dialog>
    </main>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App,
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.querySelector("#root")!).render(
  <RouterProvider router={router} />,
);
