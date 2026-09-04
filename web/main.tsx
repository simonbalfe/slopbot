import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { z } from "zod";

import "./style.css";

const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "agent", "assistant"]),
  direction: z.enum(["inbound", "outbound"]),
  text: z.string(),
  createdAt: z.string(),
});
const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.enum(["idle", "running", "error"]),
  desktop: z.object({ cdpUrl: z.string() }).nullable(),
  messages: z.array(MessageSchema),
});
const AgentsSchema = z.array(AgentSchema);
const SkillsSchema = z.array(z.object({ name: z.string(), description: z.string() }));

type Agent = z.infer<typeof AgentSchema>;
type Message = z.infer<typeof MessageSchema>;
type BrowserInput = Readonly<Record<string, string | number>>;

const avatarStyle = (id: string): string => id === "lead" ? "bg-accent text-zinc-900 rounded-[42%_58%_52%_48%] -rotate-6" : id === "worker" ? "bg-emerald-300 text-emerald-950 [clip-path:polygon(50%_0,94%_28%,78%_88%,22%_88%,6%_28%)]" : "bg-blue-300 text-blue-950 rounded-[50%_42%_55%_45%] rotate-30";

function Avatar({ agent, working = false }: Readonly<{ agent: Agent; working?: boolean }>): React.ReactNode {
  return <span className={`grid size-9 shrink-0 place-items-center text-xs font-black ${avatarStyle(agent.id)} ${working ? "agent-working" : ""}`}>{agent.name[0]}</span>;
}

function Inline({ value }: Readonly<{ value: string }>): React.ReactNode {
  return value.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith("`")) return <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs" key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function Markdown({ value }: Readonly<{ value: string }>): React.ReactNode {
  return value.split(/\n{2,}/).map((block, index) => {
    if (block.startsWith("```") && block.endsWith("```")) return <pre className="my-2 overflow-auto rounded-lg bg-black/40 p-2 text-xs" key={index}><code>{block.slice(3, -3).trim()}</code></pre>;
    const lines = block.split("\n");
    if (lines.every((line) => /^[-*]\s+/.test(line))) return <ul className="my-1 list-disc space-y-1 pl-5" key={index}>{lines.map((line) => <li key={line}><Inline value={line.replace(/^[-*]\s+/, "")} /></li>)}</ul>;
    if (lines.every((line) => /^\d+\.\s+/.test(line))) return <ol className="my-1 list-decimal space-y-1 pl-5" key={index}>{lines.map((line) => <li key={line}><Inline value={line.replace(/^\d+\.\s+/, "")} /></li>)}</ol>;
    const heading = lines.length === 1 ? lines[0]?.match(/^(#{1,3})\s+(.+)/) : undefined;
    if (heading) return <h3 className="mb-2 text-sm font-semibold" key={index}><Inline value={heading[2] ?? ""} /></h3>;
    return <p className="mb-2 last:mb-0" key={index}>{lines.map((line, lineIndex) => <span key={line}>{lineIndex > 0 && <br />}<Inline value={line} /></span>)}</p>;
  });
}

function dateKey(value: string): string { return new Date(value).toLocaleDateString(); }
function dateLabel(value: string): string {
  const date = new Date(value), today = new Date(), yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (dateKey(value) === dateKey(today.toISOString())) return `Today ${time}`;
  if (dateKey(value) === dateKey(yesterday.toISOString())) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

function messageKind(message: Message): string { return `${message.role}:${message.direction}`; }

function Chat({ agent }: Readonly<{ agent: Agent }>): React.ReactNode {
  return <section className="min-h-0 overflow-auto px-5 py-7" id="messages">
    {agent.messages.map((message, index) => {
      const prior = agent.messages[index - 1];
      const dayChanged = prior && dateKey(prior.createdAt) !== dateKey(message.createdAt);
      const continued = prior && !dayChanged && messageKind(prior) === messageKind(message);
      const outbound = message.role === "user" || (message.role === "agent" && message.direction === "outbound");
      return <div key={message.id}>
        {dayChanged && <div className="my-7 flex items-center justify-center gap-2 text-xs text-muted before:h-px before:w-8 before:bg-line after:h-px after:w-8 after:bg-line">{dateLabel(message.createdAt)}</div>}
        <article className={`w-fit max-w-[78%] ${outbound ? "ml-auto" : ""} ${continued ? "mb-1" : "mt-5 mb-1"}`}>
          <div className={`rounded-2xl px-3 py-2.5 ${outbound ? "rounded-tr-md bg-[#37302a]" : "rounded-tl-md bg-[#212123]"}`}><Markdown value={message.text} /></div>
        </article>
      </div>;
    })}
    {!agent.messages.length && <div className="grid h-full place-items-center text-sm text-muted">Start with a task. Your agent will work in its own thread.</div>}
    {agent.status === "running" && <div className="mt-5 flex items-center gap-2 text-xs text-muted"><Avatar agent={agent} working /><span>{agent.name} is working<span className="animate-pulse">...</span></span></div>}
  </section>;
}

function App(): React.ReactNode {
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [skills, setSkills] = useState<readonly z.infer<typeof SkillsSchema>[number][]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [screenUrl, setScreenUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const viewer = useRef<HTMLImageElement>(null);
  const settings = useRef<HTMLDialogElement>(null);
  const agent = useMemo(() => agents.find((item) => item.id === selectedId) ?? agents[0], [agents, selectedId]);

  const refresh = async (): Promise<void> => {
    const response = await fetch("/api/agents");
    if (response.ok) setAgents(AgentsSchema.parse(await response.json()));
  };
  const refreshSkills = async (): Promise<void> => {
    const response = await fetch("/api/skills");
    if (response.ok) setSkills(SkillsSchema.parse(await response.json()));
  };
  useEffect(() => { void refresh(); void refreshSkills(); const timer = window.setInterval(() => void refresh(), 500); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!agent?.desktop) return;
    let cancelled = false;
    const frame = async (): Promise<void> => {
      try { const response = await fetch(`/api/agents/${agent.id}/browser/screenshot?at=${Date.now()}`); if (!response.ok || cancelled) return; const url = URL.createObjectURL(await response.blob()); if (!cancelled) setScreenUrl((current) => { if (current) URL.revokeObjectURL(current); return url; }); else URL.revokeObjectURL(url); } finally { if (!cancelled) window.setTimeout(() => void frame(), 750); }
    };
    void frame();
    return () => { cancelled = true; };
  }, [agent?.desktop?.cdpUrl, agent?.id]);

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!agent || !prompt.trim() || agent.status === "running") return;
    const text = prompt.trim(); setPrompt("");
    await fetch(`/api/agents/${agent.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    await refresh();
  };
  const clear = async (): Promise<void> => {
    if (!agent || !window.confirm(`Clear ${agent.name}'s chat and start a fresh thread?`)) return;
    await fetch(`/api/agents/${agent.id}/clear`, { method: "POST" });
    settings.current?.close(); await refresh();
  };
  const browserInput = async (input: BrowserInput): Promise<void> => { if (agent?.desktop) await fetch(`/api/agents/${agent.id}/browser/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); };
  const point = (event: React.PointerEvent | React.WheelEvent): { x: number; y: number } | undefined => {
    const image = viewer.current; if (!image?.naturalWidth || !image.naturalHeight) return undefined;
    const rect = image.getBoundingClientRect(), scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale, x = event.clientX - rect.left - (rect.width - width) / 2, y = event.clientY - rect.top - (rect.height - height) / 2;
    return x < 0 || y < 0 || x > width || y > height ? undefined : { x: x / scale, y: y / scale };
  };
  if (!agent) return <main className="grid h-screen place-items-center bg-app text-muted">Connecting to Codex…</main>;
  return <main className="grid h-screen grid-cols-[240px_minmax(460px,1fr)_330px] overflow-hidden bg-app text-zinc-100">
    <aside className="border-r border-line bg-panel p-3"><div className="flex items-center gap-2 px-2 py-3 text-base font-bold"><i className="size-2 rounded-full bg-accent" />OpenBot</div><div className="px-2 pb-2 text-[11px] font-semibold tracking-[.08em] text-muted">AGENTS</div>{agents.map((item) => <button className={`mb-1 flex w-full items-center gap-2 rounded-xl p-2 text-left ${item.id === agent.id ? "bg-zinc-800" : "hover:bg-zinc-900"}`} key={item.id} onClick={() => setSelectedId(item.id)}><Avatar agent={item} /><span className="min-w-0 flex-1"><span className="flex items-center justify-between"><b>{item.name}</b><i className={`size-2 rounded-full ${item.status === "running" ? "bg-accent" : item.status === "error" ? "bg-red-400" : "bg-zinc-500"}`} /></span><span className="block truncate text-xs text-muted">{item.role}</span></span></button>)}</aside>
    <section className="grid min-w-0 grid-rows-[auto_1fr_auto]"><header className="flex items-center justify-between border-b border-line px-6 py-4"><div className="flex items-center gap-3"><Avatar agent={agent} /><div><b>{agent.name}</b><div className="text-xs text-muted">{agent.id} · {agent.role}</div></div></div><button className="text-xs text-muted hover:text-zinc-100" onClick={() => settings.current?.showModal()}>Settings</button></header><Chat agent={agent} /><form className="border-t border-line p-4" onSubmit={send}><div className="flex gap-2"><input className="min-w-0 flex-1 rounded-xl border border-line bg-raised px-3 py-2.5 outline-none focus:border-zinc-500" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Message agent" /><button className="rounded-xl bg-accent px-4 font-semibold text-zinc-900 disabled:opacity-40" disabled={agent.status === "running"}>Send</button></div></form></section>
    <aside className={`flex min-h-0 flex-col border-l border-line bg-panel p-4 ${expanded ? "fixed inset-0 z-10 border-l-0" : ""}`}><div className="pb-2 text-[11px] font-semibold tracking-[.08em] text-muted">LIVE BROWSER</div><img ref={viewer} className={`w-full rounded-xl border border-line bg-zinc-800 object-contain ${expanded ? "min-h-0 flex-1" : "aspect-video"}`} src={screenUrl} alt={`${agent.name} browser`} onPointerDown={(event) => { const position = point(event); if (!position) return; event.currentTarget.focus(); void browserInput({ type: "mousePressed", ...position, button: "left", clickCount: 1, modifiers: 0 }); }} onPointerUp={(event) => { const position = point(event); if (position) void browserInput({ type: "mouseReleased", ...position, button: "left", clickCount: 1, modifiers: 0 }); }} onWheel={(event) => { const position = point(event); if (!position) return; event.preventDefault(); void browserInput({ type: "mouseWheel", ...position, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: 0 }); }} /><div className="flex items-center justify-between pt-2 text-xs text-muted"><span>{agent.name} browser</span><button className="text-zinc-100" onClick={() => setExpanded((value) => !value)}>{expanded ? "Exit" : "Expand"}</button></div></aside>
    <dialog className="w-[420px] rounded-2xl border border-line bg-[#171719] p-5 text-zinc-100 backdrop:bg-black/60" ref={settings}><div className="mb-5 flex items-center justify-between"><b>Settings</b><button onClick={() => settings.current?.close()} className="text-sm text-muted">Close</button></div><div className="text-[11px] font-semibold tracking-[.08em] text-muted">ENABLED CODEX SKILLS</div><div className="mt-2 grid max-h-60 gap-2 overflow-auto">{skills.map((skill) => <div className="rounded-xl bg-zinc-800 p-3" key={skill.name}><b className="text-xs">${skill.name}</b><p className="mt-1 text-xs text-muted">{skill.description}</p></div>)}</div><div className="mt-5 flex items-center justify-between border-t border-line pt-4"><small className="max-w-48 text-muted">Clear this agent’s visible chat and start a fresh thread.</small><button className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200 disabled:opacity-40" disabled={agent.status === "running" || !agent.messages.length} onClick={() => void clear()}>Clear chat</button></div></dialog>
  </main>;
}

createRoot(document.querySelector("#root")!).render(<App />);
