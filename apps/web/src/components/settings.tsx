import { useEffect, useState } from "react";
import type * as React from "react";
import { api } from "@/lib/api";

type Agent = Awaited<ReturnType<typeof api.agents.list>>[number];
type Skill = Awaited<ReturnType<typeof api.skills.list>>[number];
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Settings({ agent, agents, settings, refresh, select }: Readonly<{
  agent: Agent;
  agents: readonly Agent[];
  settings: React.RefObject<HTMLDialogElement | null>;
  refresh: () => Promise<void>;
  select: (agentId: string) => void;
}>): React.ReactNode {
  const [skills, setSkills] = useState<readonly Skill[]>([]);
  const [settingsError, setSettingsError] = useState("");
  const refreshSkills = async (): Promise<void> => { setSkills(await api.skills.list()); };
  useEffect(() => { void refreshSkills(); }, []);
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
  const createAgent = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setSettingsError("");
    try {
      const created = await api.agents.create({
        id: String(fields.get("id") ?? ""),
        name: String(fields.get("name") ?? ""),
        role: String(fields.get("role") ?? ""),
        instructions: String(fields.get("instructions") ?? ""),
      });
      form.reset();
      select(created.id);
      await refresh();
    } catch (error) {
      setSettingsError(errorText(error));
    }
  };
  const deleteAgent = async (target: Agent): Promise<void> => {
    if (!window.confirm(`Delete ${target.name} and its SlopBot history?`)) return;
    setSettingsError("");
    try {
      await api.agents.remove({ agentId: target.id });
      if (target.id === agent.id) select("");
      await refresh();
    } catch (error) {
      setSettingsError(errorText(error));
    }
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
  return (
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
      <div className="text-[11px] font-semibold tracking-[.08em] text-muted-foreground">
        BOTS ({agents.length})
      </div>
      <div className="mt-2 grid gap-2">
        {agents.map((item) => (
          <div className="flex items-center justify-between rounded-xl bg-zinc-800 p-3" key={item.id}>
            <span>
              <b className="block text-sm">{item.name}</b>
              <small className="text-muted-foreground">{item.id} · {item.role}</small>
            </span>
            <button
              className="text-xs text-red-300 disabled:opacity-40"
              disabled={item.id === "lead" || item.status === "running" || agents.length === 1}
              onClick={() => void deleteAgent(item)}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <details className="mt-2 rounded-xl border border-line p-3">
        <summary className="cursor-pointer text-sm font-semibold">Add bot</summary>
        <form className="mt-3 grid gap-2" onSubmit={createAgent}>
          <input className="rounded-lg border border-line bg-raised px-3 py-2 text-sm" name="id" placeholder="bot-id" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
          <input className="rounded-lg border border-line bg-raised px-3 py-2 text-sm" name="name" placeholder="Bot name" required />
          <input className="rounded-lg border border-line bg-raised px-3 py-2 text-sm" name="role" placeholder="Role" required />
          <textarea className="min-h-24 rounded-lg border border-line bg-raised px-3 py-2 text-sm" name="instructions" placeholder="Instructions" required />
          <button className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-zinc-900">Create bot</button>
        </form>
      </details>
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
  );
}
