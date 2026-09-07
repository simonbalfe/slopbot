import { useState } from "react";
import type * as React from "react";

import { api } from "@/lib/api";

type Agent = Awaited<ReturnType<typeof api.agents.list>>[number];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function botId(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function Settings({ agents, settings, refresh, select }: Readonly<{
  agents: readonly Agent[];
  settings: React.RefObject<HTMLDialogElement | null>;
  refresh: () => Promise<void>;
  select: (agentId: string) => void;
}>): React.ReactNode {
  const [settingsError, setSettingsError] = useState("");

  const updateAgent = async (
    event: React.FormEvent<HTMLFormElement>,
    agent: Agent,
  ): Promise<void> => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setSettingsError("");
    try {
      await api.agents.update({
        agentId: agent.id,
        name: String(fields.get("name") ?? ""),
        role: agent.role,
        instructions: String(fields.get("instructions") ?? ""),
      });
      await refresh();
    } catch (error) {
      setSettingsError(errorText(error));
    }
  };

  const createAgent = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get("name") ?? "").trim();
    setSettingsError("");
    try {
      const created = await api.agents.create({
        id: botId(name),
        name,
        role: "Assistant",
        instructions: String(fields.get("instructions") ?? ""),
      });
      form.reset();
      select(created.id);
      await refresh();
    } catch (error) {
      setSettingsError(errorText(error));
    }
  };

  const deleteAgent = async (agent: Agent): Promise<void> => {
    if (!window.confirm(`Delete ${agent.name} and its chat history?`)) return;
    setSettingsError("");
    try {
      await api.agents.remove({ agentId: agent.id });
      await refresh();
    } catch (error) {
      setSettingsError(errorText(error));
    }
  };

  return (
    <dialog
      className="max-h-[80vh] w-[min(560px,calc(100vw-2rem))] overflow-auto rounded-2xl border border-line bg-[#171719] p-5 text-zinc-100 backdrop:bg-black/60"
      ref={settings}
    >
      <div className="mb-5 flex items-center justify-between">
        <b>Bots</b>
        <button
          className="text-sm text-muted-foreground"
          onClick={() => settings.current?.close()}
        >
          Close
        </button>
      </div>
      {settingsError && (
        <p className="mb-4 rounded-lg bg-red-950 p-3 text-sm text-red-200">
          {settingsError}
        </p>
      )}
      <div className="grid gap-2">
        {agents.map((agent) => (
          <details
            className="rounded-xl border border-line bg-zinc-800 p-3"
            key={`${agent.id}:${agent.name}:${agent.instructions}`}
          >
            <summary className="cursor-pointer text-sm font-semibold">
              {agent.name}
              <span className="ml-2 font-normal text-muted-foreground">
                {agent.id}
              </span>
            </summary>
            <form
              className="mt-4 grid gap-3"
              onSubmit={(event) => void updateAgent(event, agent)}
            >
              <label className="grid gap-1 text-xs text-muted-foreground">
                Name
                <input
                  className="rounded-lg border border-line bg-raised px-3 py-2 text-sm text-zinc-100"
                  defaultValue={agent.name}
                  name="name"
                  required
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Base prompt
                <textarea
                  className="min-h-28 rounded-lg border border-line bg-raised px-3 py-2 text-sm text-zinc-100"
                  defaultValue={agent.instructions}
                  name="instructions"
                  required
                />
              </label>
              <div className="flex items-center justify-between">
                <button
                  className="text-xs text-red-300 disabled:opacity-40"
                  disabled={agent.id === "lead" || agent.status === "running" || agents.length === 1}
                  onClick={() => void deleteAgent(agent)}
                  type="button"
                >
                  Delete bot
                </button>
                <button className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-zinc-900">
                  Save
                </button>
              </div>
            </form>
          </details>
        ))}
      </div>
      <details className="mt-3 rounded-xl border border-line p-3">
        <summary className="cursor-pointer text-sm font-semibold">Add bot</summary>
        <form className="mt-4 grid gap-3" onSubmit={createAgent}>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Name
            <input
              className="rounded-lg border border-line bg-raised px-3 py-2 text-sm text-zinc-100"
              name="name"
              placeholder="Researcher"
              required
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Base prompt
            <textarea
              className="min-h-28 rounded-lg border border-line bg-raised px-3 py-2 text-sm text-zinc-100"
              name="instructions"
              placeholder="What should this bot do?"
              required
            />
          </label>
          <button className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-zinc-900">
            Add bot
          </button>
        </form>
      </details>
    </dialog>
  );
}
