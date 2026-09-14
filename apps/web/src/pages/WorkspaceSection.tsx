import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ryvoko/ui-web";
import { ChevronLeft, FileText, Folder } from "lucide-react";
import { useState } from "react";

import { rpc } from "../lib/rpc";

type WorkspaceEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
};

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

export function WorkspaceSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  async function loadDirectory(nextPath: string) {
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setFileContent(null);
    try {
      const files = await rpc.computer.files({ botId, path: nextPath });
      setPath(nextPath);
      setEntries(
        [...files].sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
          return a.path.localeCompare(b.path);
        }),
      );
    } catch {
      setEntries([]);
      setError(t`Could not load files`);
    } finally {
      setLoading(false);
    }
  }

  async function openFile(filePath: string) {
    setLoading(true);
    setError(null);
    try {
      const file = await rpc.computer.readFile({ botId, path: filePath });
      setSelectedFile(file.path);
      setFileContent(file.content);
    } catch {
      setError(t`Could not open file`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="mt-6 border-t border-border pt-5"
      data-testid="bot-workspace"
      onToggle={(event) => {
        if (event.currentTarget.open && entries.length === 0 && !loading) {
          void loadDirectory(path);
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
            disabled={loading || path === "/"}
            onClick={() => void loadDirectory(parentPath(path))}
          >
            <ChevronLeft />
          </Button>
          <div className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
            {path}
          </div>
        </div>

        {error ? <div className="px-2 py-2 text-[13px] text-destructive">{error}</div> : null}

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
        ) : loading ? (
          <div className="px-2 py-3 text-[13px] text-muted-foreground">
            <Trans>Loading…</Trans>
          </div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-3 text-[13px] text-muted-foreground">
            <Trans>None yet</Trans>
          </div>
        ) : (
          <div className="space-y-0.5">
            {entries.map((entry) => (
              <Button
                key={entry.path}
                type="button"
                variant="ghost"
                className="h-auto w-full items-center justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                onClick={() =>
                  entry.kind === "dir" ? void loadDirectory(entry.path) : void openFile(entry.path)
                }
              >
                {entry.kind === "dir" ? <Folder size={14} /> : <FileText size={14} />}
                <span className="min-w-0 flex-1 truncate">{basename(entry.path)}</span>
                {entry.kind === "file" ? (
                  <span className="text-[11px] text-muted-foreground/70">{entry.size} B</span>
                ) : null}
              </Button>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
