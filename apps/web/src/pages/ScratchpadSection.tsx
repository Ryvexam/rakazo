import { Trans, useLingui } from "@lingui/react/macro";
import type { ScratchpadItem } from "@rakazo/contracts";
import { Button, Checkbox, Input } from "@rakazo/ui-web";
import { Lightbulb, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { rpc } from "../lib/rpc";
import {
  buildUserPromotedGoalNotes,
  goalTitle,
  isIdeaTitle,
  parseOpportunityMetadata,
  visibleWorkNotes,
} from "./autonomy";
import { WorkspaceSection } from "./WorkspaceSection";

export function ScratchpadSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [items, setItems] = useState<ScratchpadItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listGeneration = useRef(0);

  const goals = useMemo(
    () => items.filter((item) => item.status !== "done" && !isIdeaTitle(item.title)),
    [items],
  );
  const ideas = useMemo(
    () => items.filter((item) => item.status !== "done" && isIdeaTitle(item.title)),
    [items],
  );

  async function refresh() {
    const generation = ++listGeneration.current;
    const list = await rpc.scratchpad.list({ botId, includeDone: true });
    if (generation !== listGeneration.current) return;
    setItems(list);
  }

  useEffect(() => {
    const generation = ++listGeneration.current;
    void rpc.scratchpad
      .list({ botId, includeDone: true })
      .then((list) => {
        if (generation !== listGeneration.current) return;
        setItems(list);
      })
      .catch(() => {
        if (generation !== listGeneration.current) return;
        setItems([]);
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
      await rpc.scratchpad.update({ itemId: item.id, status });
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
      await rpc.scratchpad.update({
        itemId: item.id,
        title: goalTitle(item.title),
        status: "open",
        notes: buildUserPromotedGoalNotes(item.id, item.notes),
      });
      await refresh();
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
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
        goals.map((item) => {
          const notes = visibleWorkNotes(item.notes);
          return (
            <div
              key={item.id}
              className="flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 hover:bg-accent"
            >
              <Checkbox
                aria-label={t`Complete`}
                checked={false}
                disabled={busy}
                onCheckedChange={(checked) => {
                  if (checked) void setStatus(item, "done");
                }}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <div className="text-start text-[14.5px] text-foreground" dir="auto">
                  {item.title}
                </div>
                {notes ? (
                  <div
                    className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-muted-foreground/80"
                    dir="auto"
                  >
                    {notes}
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
              ) : (
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
              )}
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
          );
        })
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
          {ideas.map((item) => {
            const metadata = parseOpportunityMetadata(item.notes);
            const notes = visibleWorkNotes(item.notes);
            return (
              <div key={item.id} className="rounded-xl px-2.5 py-2.5 hover:bg-accent">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] text-foreground" dir="auto">
                      {goalTitle(item.title)}
                    </div>
                    {metadata ? (
                      <div className="mt-0.5 text-[11.5px] text-muted-foreground/70">
                        {metadata.value ? `${metadata.value} value` : null}
                        {metadata.value && metadata.effort ? " · " : null}
                        {metadata.effort ? `${metadata.effort} effort` : null}
                        {(metadata.value || metadata.effort) && metadata.confidence ? " · " : null}
                        {metadata.confidence ? `${metadata.confidence} confidence` : null}
                      </div>
                    ) : null}
                    {notes ? (
                      <div
                        className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-muted-foreground/80"
                        dir="auto"
                      >
                        {notes}
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
            );
          })}
        </div>
      ) : null}

      <WorkspaceSection botId={botId} />

      {error ? <div className="mt-2 text-[13px] text-destructive">{error}</div> : null}
    </div>
  );
}
