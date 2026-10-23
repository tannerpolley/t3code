import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OwnerDecision, OwnerDecisionsListInput } from "@t3tools/contracts";
import { useRef, useState, type ComponentProps } from "react";
import { useServerConfigs } from "~/state/entities";
import { ownerDecisions, useOwnerDecisions } from "~/state/ownerDecisions";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

export function OwnerDecisionCard({
  environmentId,
  decision,
}: {
  environmentId: EnvironmentId;
  decision: OwnerDecision;
}) {
  const canChoose = useAtomValue(ownerDecisions.choose.permissionAtom(environmentId));
  const choose = useAtomCommand(ownerDecisions.choose, { reportFailure: false });
  const busy = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const respond = async (optionId: string) => {
    if (busy.current) return;
    busy.current = true;
    setSelected(optionId);
    setError(null);
    const result = await choose({ environmentId, input: { id: decision.id, optionId } });
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      setSelected(null);
      busy.current = false;
    }
  };
  const chosen = decision.options.find((option) => option.id === decision.chosenOptionId);
  const publishing = selected !== null || decision.pendingPublish !== null;
  return (
    <article
      className="space-y-2 rounded-lg border border-border bg-background p-3 text-xs"
      aria-label={`Owner decision: ${decision.question}`}
    >
      <p className="font-medium">{decision.question}</p>
      <p className="break-words text-muted-foreground">
        <a
          className="underline"
          href={`https://${decision.host}/${decision.repository}/issues/${decision.number}`}
          target="_blank"
          rel="noreferrer"
        >
          {decision.host}/{decision.repository}#{decision.number}
        </a>
        {" · "}
        {decision.requestingProjectTitle} / {decision.requestingThreadTitle}
      </p>
      <p>
        Recommended:{" "}
        <strong>
          {decision.options.find((option) => option.id === decision.recommendedOptionId)?.label}
        </strong>
        . {decision.recommendationReason}{" "}
        <a className="underline" href={decision.evidenceUrl} target="_blank" rel="noreferrer">
          Evidence
        </a>
      </p>
      <div className="space-y-2">
        {decision.options.map((option) => (
          <div key={option.id} className="flex items-start gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={
                !canChoose ||
                decision.state !== "awaiting_choice" ||
                selected !== null ||
                decision.chosenOptionId !== null
              }
              onClick={() => void respond(option.id)}
              aria-describedby={`${decision.id}-${option.id}-consequence`}
            >
              {option.label}
              {option.id === decision.recommendedOptionId ? " (recommended)" : ""}
            </Button>
            <p
              id={`${decision.id}-${option.id}-consequence`}
              className="min-w-0 flex-1 break-words text-muted-foreground"
            >
              {option.consequence}
            </p>
          </div>
        ))}
      </div>
      <p role="status" className="text-muted-foreground">
        {chosen ? `Owner chose ${chosen.label}. ` : ""}
        {decision.state === "publication_mismatch"
          ? "GitHub comment mismatch; publication stopped."
          : decision.state === "delivery_failed"
            ? "Choice published; requester notification could not be delivered."
            : decision.state === "withdrawn"
              ? `Withdrawn: ${decision.withdrawalReason}`
              : decision.pendingPublish !== null ||
                  (selected !== null && decision.chosenOptionId === null)
                ? "Publishing to GitHub…"
                : decision.pendingDelivery
                  ? "Choice recorded; notification awaiting delivery."
                  : decision.state === "awaiting_choice"
                    ? "Awaiting your choice"
                    : decision.deliveredAt !== null
                      ? "Choice published and requester notified."
                      : decision.state.replaceAll("_", " ")}
        {publishing && decision.state === "publication_failed" ? " Retrying publication." : ""}
      </p>
      {decision.choiceComment ? (
        <a className="underline" href={decision.choiceComment.url} target="_blank" rel="noreferrer">
          Owner record
        </a>
      ) : null}
      {(error ?? decision.lastError) ? (
        <p role="alert" className="text-destructive">
          {error ?? decision.lastError}
        </p>
      ) : null}
    </article>
  );
}

export function OwnerDecisionCards({
  environmentId,
  input,
}: {
  environmentId: EnvironmentId;
  input: OwnerDecisionsListInput;
}) {
  const configs = useServerConfigs();
  const supported = configs.get(environmentId)?.environment.capabilities.ownerDecisions === true;
  const query = useEnvironmentQuery(
    supported ? ownerDecisions.list({ environmentId, input }) : null,
  );
  if (!supported || (!query.error && !query.data?.length)) return null;
  return (
    <section aria-label="Owner decisions" className="mb-3 space-y-2">
      {query.error ? <p role="alert">{query.error}</p> : null}
      {query.data?.map((decision) => (
        <OwnerDecisionCard key={decision.id} environmentId={environmentId} decision={decision} />
      ))}
    </section>
  );
}

interface DecisionScope {
  /** The environments the surrounding list shows; omitted means every connected one. */
  environmentIds?: readonly EnvironmentId[] | undefined;
  host?: string | undefined;
  repository?: string | undefined;
}
const inScope = (
  { environmentId, decision }: ReturnType<typeof useOwnerDecisions>["records"][number],
  { environmentIds, host, repository }: DecisionScope,
) =>
  (!environmentIds || environmentIds.includes(environmentId)) &&
  (!host || decision.host === host.toLowerCase()) &&
  (!repository || decision.repository === repository.toLowerCase());

/** The Decisions toggle shared by the Issues and pull request browsers, counting unanswered requests. */
export function OwnerDecisionsToggle({
  view,
  pressed,
  onPressedChange,
  size = "default",
  ...scope
}: DecisionScope & {
  view: ReturnType<typeof useOwnerDecisions>;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  size?: ComponentProps<typeof Button>["size"];
}) {
  const count = view.records.filter(
    (record) =>
      record.decision.chosenOptionId === null &&
      record.decision.state !== "withdrawn" &&
      inScope(record, scope),
  ).length;
  return (
    <Button
      size={size}
      variant={pressed ? "secondary" : "outline"}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
    >
      Decisions ({count})
    </Button>
  );
}

/** The Decisions toggle and the view it swaps in for a browser's list. */
export function useOwnerDecisionsPane(scope: DecisionScope & { query: string }) {
  const view = useOwnerDecisions();
  const [open, setOpen] = useState(false);
  return {
    toggle: (
      <OwnerDecisionsToggle view={view} {...scope} pressed={open} onPressedChange={setOpen} />
    ),
    pane: open ? <OwnerDecisionsView view={view} {...scope} /> : null,
  };
}

export function OwnerDecisionsView({
  view,
  query,
  ...scope
}: DecisionScope & {
  view: ReturnType<typeof useOwnerDecisions>;
  query: string;
}) {
  const [project, setProject] = useState("");
  const [target, setTarget] = useState("");
  const projects = new Map(
    view.records.map(({ environmentId, decision }) => [
      JSON.stringify([environmentId, decision.requestingProjectId]),
      { title: decision.requestingProjectTitle, environmentId },
    ]),
  );
  const targets = [
    ...new Set(view.records.map(({ decision }) => `${decision.host}/${decision.repository}`)),
  ].sort();
  const records = view.records.filter(
    ({ environmentId, decision }) =>
      inScope({ environmentId, decision }, scope) &&
      (!project || JSON.stringify([environmentId, decision.requestingProjectId]) === project) &&
      (!target || `${decision.host}/${decision.repository}` === target) &&
      `${decision.question} ${decision.repository} ${decision.requestingProjectTitle} ${decision.requestingThreadTitle}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <section aria-label="Decisions" className="space-y-3 px-4 pb-4">
      <div className="flex gap-2">
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" />}>
            {projects.get(project)?.title ?? "All projects"}
          </MenuTrigger>
          <MenuPopup>
            <MenuRadioGroup value={project} onValueChange={setProject}>
              <MenuRadioItem value="">All projects</MenuRadioItem>
              {[...projects].map(([key, entry]) => (
                <MenuRadioItem key={key} value={key}>
                  {entry.title} · {view.labels.get(entry.environmentId)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        {!scope.repository ? (
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="outline" />}>
              {target || "All repositories"}
            </MenuTrigger>
            <MenuPopup>
              <MenuRadioGroup value={target} onValueChange={setTarget}>
                <MenuRadioItem value="">All repositories</MenuRadioItem>
                {targets.map((value) => (
                  <MenuRadioItem key={value} value={value}>
                    {value}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {view.unavailable.map((environment) => (
        <p key={environment.environmentId} role="alert" className="text-xs text-muted-foreground">
          {environment.label} is offline or connecting; its decisions may be missing.
        </p>
      ))}
      {view.errors.map((error) => (
        <p key={error.environmentId} role="alert" className="text-xs text-destructive">
          {view.labels.get(error.environmentId)}: {error.message}
        </p>
      ))}
      {view.waiting ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading decisions…
        </p>
      ) : null}
      {records.map(({ environmentId, decision }) => (
        <OwnerDecisionCard
          key={`${environmentId}:${decision.id}`}
          environmentId={environmentId}
          decision={decision}
        />
      ))}
      {!view.waiting && records.length === 0 ? (
        <p className="text-sm text-muted-foreground">No decisions match these filters.</p>
      ) : null}
    </section>
  );
}
