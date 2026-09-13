import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine, RunActivityRow } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";

import { rpc } from "../lib/rpc";
import {
  AUTONOMY_PROMPT_MARKER,
  AUTONOMY_ROUTINE_NAME,
  type AutonomyMode,
  autonomyCron,
  buildAutonomyPrompt,
  DEFAULT_AUTONOMY_LIMITS,
  HEARTBEAT_OPTIONS,
  type HeartbeatMinutes,
  heartbeatFromCrons,
  isAutonomyPrompt,
  MAX_AUTONOMOUS_GOALS_OPTIONS,
  type MaxAutonomousGoalsPerDay,
  MAX_GOAL_CHAIN_DEPTH_OPTIONS,
  type MaxGoalChainDepth,
  parseAutonomyLimits,
  parseAutonomyMode,
} from "./autonomy";

type AutonomyRoutineState = Pick<
  Routine,
  "id" | "active" | "lastRunAt" | "nextRunAt" | "prompt" | "crons"
>;

function formatRunAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function runStatus(status: RunActivityRow["status"]): string {
  return status.replaceAll("_", " ");
}

export function AutonomySection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [routine, setRoutine] = useState<AutonomyRoutineState | null>(null);
  const [mode, setMode] = useState<AutonomyMode>("off");
  const [heartbeatMinutes, setHeartbeatMinutes] = useState<HeartbeatMinutes>(30);
  const [maxGoalsPerDay, setMaxGoalsPerDay] = useState<MaxAutonomousGoalsPerDay>(
    DEFAULT_AUTONOMY_LIMITS.maxGoalsPerDay,
  );
  const [maxChainDepth, setMaxChainDepth] = useState<MaxGoalChainDepth>(
    DEFAULT_AUTONOMY_LIMITS.maxChainDepth,
  );
  const [runs, setRuns] = useState<RunActivityRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyRoutine(next: AutonomyRoutineState | null) {
    setRoutine(next);
    if (!next) {
      setMode("off");
      setHeartbeatMinutes(30);
      setMaxGoalsPerDay(DEFAULT_AUTONOMY_LIMITS.maxGoalsPerDay);
      setMaxChainDepth(DEFAULT_AUTONOMY_LIMITS.maxChainDepth);
      return;
    }
    setHeartbeatMinutes(heartbeatFromCrons(next.crons));
    const limits = parseAutonomyLimits(next.prompt);
    setMaxGoalsPerDay(limits.maxGoalsPerDay);
    setMaxChainDepth(limits.maxChainDepth);
    setMode(next.active ? parseAutonomyMode(next.prompt) : "off");
  }

  async function refresh() {
    const [routines, recent] = await Promise.all([
      rpc.routines.list({ botId }),
      rpc.runs.list({ filter: "recent" }),
    ]);
    applyRoutine(routines.find((entry) => isAutonomyPrompt(entry.prompt)) ?? null);
    setRuns(
      recent.runs
        .filter(
          (run) =>
            run.botId === botId &&
            run.trigger === "routine" &&
            run.promptSnippet.includes(AUTONOMY_PROMPT_MARKER),
        )
        .slice(0, 5),
    );
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([rpc.routines.list({ botId }), rpc.runs.list({ filter: "recent" })])
      .then(([routines, recent]) => {
        if (cancelled) return;
        applyRoutine(routines.find((entry) => isAutonomyPrompt(entry.prompt)) ?? null);
        setRuns(
          recent.runs
            .filter(
              (run) =>
                run.botId === botId &&
                run.trigger === "routine" &&
                run.promptSnippet.includes(AUTONOMY_PROMPT_MARKER),
            )
            .slice(0, 5),
        );
      })
      .catch(() => {
        if (cancelled) return;
        applyRoutine(null);
        setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "off") {
        if (routine) await rpc.routines.update({ routineId: routine.id, active: false });
      } else {
        const prompt = buildAutonomyPrompt(mode, { maxGoalsPerDay, maxChainDepth });
        const crons = [autonomyCron(heartbeatMinutes)];
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        if (routine) {
          await rpc.routines.update({
            routineId: routine.id,
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

  async function runNow() {
    if (!routine?.active || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.routines.testRun({
        routineId: routine.id,
        clientNonce: `autonomy:${routine.id}:${Date.now()}`,
      });
      await refresh();
    } catch {
      setError(t`Could not start`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 border-t border-border pt-5" data-testid="bot-autonomy">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Autonomy</Trans>
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
        <NativeSelect
          aria-label={t`Autonomy mode`}
          value={mode}
          onChange={(event) => setMode(event.target.value as AutonomyMode)}
        >
          <NativeSelectOption value="off">{t`Off`}</NativeSelectOption>
          <NativeSelectOption value="continue">{t`Continue goals`}</NativeSelectOption>
          <NativeSelectOption value="propose">{t`Propose ideas`}</NativeSelectOption>
          <NativeSelectOption value="autonomous">{t`Autonomous`}</NativeSelectOption>
        </NativeSelect>
        <NativeSelect
          aria-label={t`Heartbeat`}
          value={String(heartbeatMinutes)}
          disabled={mode === "off"}
          onChange={(event) => setHeartbeatMinutes(Number(event.target.value) as HeartbeatMinutes)}
        >
          {HEARTBEAT_OPTIONS.map((minutes) => (
            <NativeSelectOption key={minutes} value={String(minutes)}>
              {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {mode === "autonomous" ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-[12px] text-muted-foreground">
            <Trans>Goals per day</Trans>
            <NativeSelect
              aria-label={t`Goals per day`}
              className="mt-1 w-full"
              value={String(maxGoalsPerDay)}
              onChange={(event) =>
                setMaxGoalsPerDay(Number(event.target.value) as MaxAutonomousGoalsPerDay)
              }
            >
              {MAX_AUTONOMOUS_GOALS_OPTIONS.map((value) => (
                <NativeSelectOption key={value} value={String(value)}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="text-[12px] text-muted-foreground">
            <Trans>Chain depth</Trans>
            <NativeSelect
              aria-label={t`Chain depth`}
              className="mt-1 w-full"
              value={String(maxChainDepth)}
              onChange={(event) =>
                setMaxChainDepth(Number(event.target.value) as MaxGoalChainDepth)
              }
            >
              {MAX_GOAL_CHAIN_DEPTH_OPTIONS.map((value) => (
                <NativeSelectOption key={value} value={String(value)}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        </div>
      ) : null}

      {routine ? (
        <div className="mt-2 text-[12.5px] text-muted-foreground/80">
          <Trans>Last run</Trans>: {formatRunAt(routine.lastRunAt)} · <Trans>Next</Trans>:{" "}
          {formatRunAt(routine.nextRunAt)}
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save()}>
          <Trans>Save</Trans>
        </Button>
        {routine?.active ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void runNow()}>
            <Play size={14} />
            <Trans>Run now</Trans>
          </Button>
        ) : null}
      </div>

      {runs.length > 0 ? (
        <div className="mt-4" data-testid="autonomy-activity">
          <div className="mb-1 text-[12px] text-muted-foreground">
            <Trans>Recent autonomous runs</Trans>
          </div>
          {runs.map((run) => (
            <div key={run.runId} className="flex items-center gap-2 py-1 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {formatRunAt(run.updatedAt)}
              </span>
              <span className="shrink-0 text-foreground">{runStatus(run.status)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <div className="mt-2 text-[13px] text-destructive">{error}</div> : null}
    </section>
  );
}
