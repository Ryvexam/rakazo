import { Trans } from "@lingui/react/macro";
import { Button, Wordmark } from "@ryvoko/ui-web";
import { useNavigate } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col bg-background" data-ryvoko-surface="welcome">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-11 pb-[90px]">
        <Wordmark className="scale-[1.75]" />
        <p className="max-w-[600px] text-center text-[27px] leading-[1.4] text-foreground/75">
          <Trans>
            Your team of always-on agents
            <br />
            that you can give real work to.
          </Trans>
        </p>
        <Button
          type="button"
          size="lg"
          onClick={() => navigate("/sign-up")}
          className="app-no-drag h-12 rounded-full px-8 text-base transition hover:scale-[1.04]"
        >
          <Trans>Sign up</Trans>&nbsp;&nbsp;→
        </Button>
      </div>
    </div>
  );
}
