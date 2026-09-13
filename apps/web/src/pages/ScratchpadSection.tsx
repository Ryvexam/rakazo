import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine, ScratchpadItem } from "@rakazo/contracts";
import { Button, Checkbox, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ChevronLeft, FileText, Folder, Lightbulb, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { rpc } from "../lib/rpc";
import {
  AUTONOMY_ROUTINE_NAME,
  type AutonomyMode,
  autonomyCron,
  buildAutonomyPrompt,
  goalTitle,
  HEARTBEAT_OPTIONS,
  type HeartbeatMinutes,
  heartbeatFromCrons,
  isAutonomyPrompt,
  isIdeaTitle,
  parseAutonomyMode,
} from "./autonomy";

type WorkspaceEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
};

type AutonomyRoutineState = Pick<
  Routine,
  "id" | "active" | "lastRunAt" | "nextRunAt" | "prompt" | "crons"
>;

function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  if (!clean || clean === "/") return "/";
  const separator = clean.lastIndexOf("/");
  return separator <= 0 ? "/" : clean.slice(0, separator);
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const separator = clean.lastIndexOf("/");
  return clean.slice(separator + 1) || "/";
}

function formatRunAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function ScratchpadSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [items, setItems] = useState<ScratchpadItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listGeneration = useRef(0);

  const [autonomyRoutine, setAutonomyRoutine] = useState<AutonomyRoutineState | null>(null);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>("off");
  const [heartbeatMinutes, setHeartbeatMinutes] = useState<HeartbeatMinutes>(30);

  const [workspacePath, setWorkspacePath] = useState("/");
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  const goals = useMemo(() => items.filter((item) => !isIdeaTitle(item.title)), [items]);
  const ideas = useMemo(() => items.filter((item) => isIdeaTitle(item.title)), [items]);

  function applyAutonomyRoutine(routine: AutonomyRoutineState | null) {
    setAutonomyRoutine(routine);
    if (routine) {
      setHeartbeatMinutes(heartbeatFromCrons(routine.crons));
      setAutonomyMode(routine.active ? parseAutonomyMode(routine.prompt) : "off");
      return;
    }
    setAutonomyMode("off");
    setHeartbeatMinutes(30);
  }

  async function refresh() {
    const generation = ++listGeneration.current;
    const [list, routines] = await Promise.all([
      rpc.scratchpad.list({ botId }),
      rpc.routines.list({ botId }),
    ]);
    if (generation !== listGeneration.current) return;
    setItems(list);
    applyAutonomyRoutine(routines.find((entry) => isAutonomyPrompt(entry.prompt)) ?? null);
  }

  useEffect(() => {
    const generation = ++listGeneration.current;
    void Promise.all([rpc.scratchpad.list({ botId }), rpc.routines.list({ botId })])
      .then(([list, routines]) => {
        if (generation !== listGeneration.current) return;
        setItems(list);
        applyAutonomyRoutine(routines.find((entry) => isAutonomyPrompt(entry.prompt)) ?? null);
      })
      .catch(() => {
        if (generation !== listGeneration.current) return;
        setItems([]);
        applyAutonomyRoutine(null);
      });
    return () => {
      listGeneration.current += 1;
    };
  }, [botId]);

  async function addGoal() {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.scratchpad.create({ botId, title, status: "open" });
      setDraft("");
      setItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      await refresh();
    } catch {
      setError(t`Could not add`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(item: ScratchpadItem, status: ScratchpadItem["status"]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.scratchpad.update({ itemId: item.id, status });
      setItems((current) => {
        const next = current.map((entry) => (entry.id === updated.id ? updated : entry));
        return status === "done" ? next.filter((entry) => entry.status !== "done") : next;
      });
      await refresh();
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: ScratchpadItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.remove({ itemId: item.id });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  async function promoteIdea(item: ScratchpadItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.scratchpad.update({
        itemId: item.id,
        title: goalTitle(item.title),
        status: "open",
        notes: [item.notes.trim(), "Promoted from product discovery."].filter(Boolean).join("\n\n"),
      });
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAutonomy() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (autonomyMode === "off") {
        if (autonomyRoutine) {
          await rpc.routines.update({ routineId: autonomyRoutine.id, active: false });
        }
      } else {
        const prompt = buildAutonomyPrompt(autonomyMode);
        const crons = [autonomyCron(heartbeatMinutes)];
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        if (autonomyRoutine) {
          await rpc.routines.update({
            routineId: autonomyRoutine.id,
            name: AUTONOMY_ROUTINE_NAME,
            prompt,
            crons,
            timezone,
            active: true,
            notify: false,
          });
        } else {
          await rpc.routines.create({
            botId,
            name: AUTONOMY_ROUTINE_NAME,
            prompt,
            crons,
            timezone,
            active: true,
            notify: false,
            webhookEnabled: false,
            githubEnabled: false,
            messageProvider: null,
          });
        }
      }
      await refresh();
    } catch {
      setError(t`Could not save`);
    } finally {
      setBusy(false);
    }
  }

  async function runAutonomyNow() {
    if (!autonomyRoutine?.active || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.routines.testRun({
        routineId: autonomyRoutine.id,
        clientNonce: `autonomy:${autonomyRoutine.id}:${Date.now()}`,
      });
      await refresh();
    } catch {
      setError(t`Could not start`);
    } finally {
      setBusy(false);
    }
  }

  async function loadWorkspace(path: string) {
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    setSelectedFile(null);
    setFileContent(null);
    try {
      const entries = await rpc.computer.files({ botId, path });
      setWorkspacePath(path);
      setWorkspaceEntries(
        [...entries].sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
          return a.path.localeCompare(b.path);
        }),
      );
    } catch {
      setWorkspaceEntries([]);
      setWorkspaceError(t`Could not load files`);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function openWorkspaceFile(path: string) {
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    try {
      const file = await rpc.computer.readFile({ botId, path });
      setSelectedFile(file.path);
      setFileContent(file.content);
    } catch {
      setWorkspaceError(t`Could not open file`);
    } finally {
      setWorkspaceLoading(false);
    }
  }

  return (
    <div className="mt-6" data-testid="bot-scratchpad">
      <div className="mb-3 text-[14px] text-muted-foreground">
        <Trans>Goals</Trans>
      </div>
      {goals.length === 0 ? (
        <div className="py-1 text-[13.5px] text-muted-foreground/80">
          <Trans>None yet</Trans>
        </div>
      ) : (
        goals.map((item) => (
          <div
            key={item.id}
            className="flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 hover:bg-accent"
          >
            <Checkbox
              aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
              checked={item.status === "done"}
              disabled={busy}
              onCheckedChange={(checked) => void setStatus(item, checked ? "done" : "open")}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div
                className={`text-start text-[14.5px] ${
                  item.status === "done"
                    ? "text-muted-foreground/80 line-through"
                    : "text-foreground"
                }`}
                dir="auto"
              >
                {item.title}
              </div>
              {item.notes ? (
                <div
                  className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-muted-foreground/80"
                  dir="auto"
                >
                  {item.notes}
                </div>
              ) : null}
            </div>
            <span className="shrink-0 text-[12px] text-muted-foreground/80">{item.status}</span>
            {item.status === "open" ? (
              <Button
                variant="ghost"
                size="xs"
                aria-label={t`Park`}
                disabled={busy}
                onClick={() => void setStatus(item, "parked")}
                className="shrink-0 text-muted-foreground/70"
              >
                <Trans>Park</Trans>
              </Button>
            ) : item.status === "parked" ? (
              <Button
                variant="ghost"
                size="xs"
                aria-label={t`Reopen`}
                disabled={busy}
                onClick={() => void setStatus(item, "open")}
                className="shrink-0 text-muted-foreground/70"
              >
                <Trans>Open</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Remove`}
              disabled={busy}
              onClick={() => void removeItem(item)}
              className="shrink-0 text-muted-foreground/70"
            >
              <X />
            </Button>
          </div>
        ))
      )}
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addGoal();
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t`Add goal`}
          aria-label={t`New goal`}
          maxLength={200}
          className="min-w-0 flex-1"
        />
        <Button
          variant="secondary"
          className="rounded-full"
          disabled={busy || !draft.trim()}
          onClick={() => void addGoal()}
        >
          <Trans>Add</Trans>
        </Button>
      </form>

      {ideas.length > 0 ? (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-2 text-[14px] text-muted-foreground">
            <Lightbulb size={15} />
            <Trans>Product ideas</Trans>
          </div>
          {ideas.map((item) => (
            <div key={item.id} className="rounded-xl px-2.5 py-2.5 hover:bg-accent">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] text-foreground" dir="auto">
                    {goalTitle(item.title)}
                  </div>
                  {item.notes ? (
                    <div
                      className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-muted-foreground/80"
                      dir="auto"
                    >
                      {item.notes}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void promoteIdea(item)}
                >
                  <Trans>Promote</Trans>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Remove`}
                  disabled={busy}
                  onClick={() => void removeItem(item)}
                  className="text-muted-foreground/70"
                >
                  <X />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 border-t border-border pt-5">
        <div className="text-[14px] text-muted-foreground">
          <Trans>Autonomy</Trans>
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <NativeSelect
            aria-label={t`Autonomy mode`}
            value={autonomyMode}
            onChange={(event) => setAutonomyMode(event.target.value as AutonomyMode)}
          >
            <NativeSelectOption value="off">{t`Off`}</NativeSelectOption>
            <NativeSelectOption value="continue">{t`Continue goals`}</NativeSelectOption>
            <NativeSelectOption value="propose">{t`Propose ideas`}</NativeSelectOption>
            <NativeSelectOption value="autonomous">{t`Autonomous`}</NativeSelectOption>
          </NativeSelect>
          <NativeSelect
            aria-label={t`Heartbeat`}
            value={String(heartbeatMinutes)}
            disabled={autonomyMode === "off"}
            onChange={(event) =>
              setHeartbeatMinutes(Number(event.target.value) as HeartbeatMinutes)
            }
          >
            {HEARTBEAT_OPTIONS.map((minutes) => (
              <NativeSelectOption key={minutes} value={String(minutes)}>
                {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {autonomyRoutine ? (
          <div className="mt-2 text-[12.5px] text-muted-foreground/80">
            <Trans>Last run</Trans>: {formatRunAt(autonomyRoutine.lastRunAt)} · <Trans>Next</Trans>:{" "}
            {formatRunAt(autonomyRoutine.nextRunAt)}
          </div>
        ) : null}
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void saveAutonomy()}>
            <Trans>Save</Trans>
          </Button>
          {autonomyRoutine?.active ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void runAutonomyNow()}>
              <Play size={14} />
              <Trans>Run now</Trans>
            </Button>
          ) : null}
        </div>
      </div>

      <details
        className="mt-6 border-t border-border pt-5"
        onToggle={(event) => {
          if (event.currentTarget.open && workspaceEntries.length === 0 && !workspaceLoading) {
            void loadWorkspace(workspacePath);
          }
        }}
      >
        <summary className="cursor-pointer text-[14px] text-muted-foreground">
          <Trans>Workspace</Trans>
        </summary>
        <div className="mt-3 rounded-xl border border-border bg-background/40 p-2">
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Parent folder`}
              disabled={workspaceLoading || workspacePath === "/"}
              onClick={() => void loadWorkspace(parentPath(workspacePath))}
            >
              <ChevronLeft />
            </Button>
            <div className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
              {workspacePath}
            </div>
          </div>
          {workspaceError ? (
            <div className="px-2 py-2 text-[13px] text-destructive">{workspaceError}</div>
          ) : null}
          {selectedFile && fileContent !== null ? (
            <div>
              <div className="mb-2 flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
                <FileText size={14} />
                <span className="truncate">{basename(selectedFile)}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  className="ms-auto"
                  onClick={() => {
                    setSelectedFile(null);
                    setFileContent(null);
                  }}
                >
                  <Trans>Back</Trans>
                </Button>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-[12px] text-foreground">
                {fileContent}
              </pre>
            </div>
          ) : workspaceLoading ? (
            <div className="px-2 py-3 text-[13px] text-muted-foreground">
              <Trans>Loading…</Trans>
            </div>
          ) : workspaceEntries.length === 0 ? (
            <div className="px-2 py-3 text-[13px] text-muted-foreground">
              <Trans>None yet</Trans>
            </div>
          ) : (
            <div className="space-y-0.5">
              {workspaceEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                  onClick={() =>
                    entry.kind === "dir"
                      ? void loadWorkspace(entry.path)
                      : void openWorkspaceFile(entry.path)
                  }
                >
                  {entry.kind === "dir" ? <Folder size={14} /> : <FileText size={14} />}
                  <span className="min-w-0 flex-1 truncate">{basename(entry.path)}</span>
                  {entry.kind === "file" ? (
                    <span className="text-[11px] text-muted-foreground/70">{entry.size} B</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </details>

      {error ? <div className="mt-2 text-[13px] text-destructive">{error}</div> : null}
    </div>
  );
}
