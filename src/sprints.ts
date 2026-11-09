// Jira's sprints as the Backlog's own (Jira REQ26, Jira Pull REQ17 to REQ19): a
// scrum board's sprints read from the Agile API and given to the Backlog, which
// holds them as Jira has them. Jira is where a sprint is made, started, and
// closed; the Backlog shows them, and a task holds one, chosen here from the
// many Jira lists on an issue. A closed sprint's report is built once from the
// issues' history, the public changelog being all Jira offers of it.
import { JiraError, siteBase, type Requester } from './client.ts';
import type { Connection, Pair } from './connections.ts';
import { categoryOf, cachedDescription } from './describe.ts';
import { backlogCategory, statusFor } from './mapping.ts';
import type { BoardSettings, HeldSprint, SprintHold, SprintResult, SprintTask, SprintView } from './types.ts';
import type { Host } from 'eidosmd/plugin';

export const SPRINT_SIDE = 'sprint';
// The Backlog keeps these words for its commands; a sprint named one is written apart.
const RESERVED = ['backlog', 'active'];

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  activatedDate?: string;
}

// A sprint as an issue's field lists it.
export interface FieldSprint extends JiraSprint {
  boardId?: number;
}

// What a run knows of the board's sprints: by Jira's id, each with its name in the Backlog, its state, and its place on the board.
export type SprintIndex = Map<string, { name: string; state: string; at: number }>;

export const carriesSprints = (pairs: Pair[]): boolean => pairs.some((pair) => pair.eidos === SPRINT_SIDE);

export const holdFor = (connection: Connection): SprintHold => ({
  tool: 'jira-sync',
  title: 'Jira',
  url: `${siteBase(connection.site)}/jira/software/projects/${connection.project}/boards/${connection.board}`,
});

export async function readBoardSprints(client: Requester, board: number): Promise<JiraSprint[]> {
  const out: JiraSprint[] = [];
  for (;;) {
    const page = await client.get<{ values?: JiraSprint[]; isLast?: boolean }>(`/rest/agile/1.0/board/${board}/sprint`, { startAt: out.length, maxResults: 50 });
    out.push(...(page.values ?? []));
    if (page.isLast !== false || (page.values ?? []).length === 0) return out;
  }
}

const fileKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// A name for each sprint the Backlog can take: Jira's, except one it repeats or one the Backlog keeps, which takes its id (Jira Pull REQ17).
export function sprintNames(sprints: readonly JiraSprint[]): Map<number, string> {
  const seen = new Set<string>();
  const out = new Map<number, string>();
  for (const sprint of sprints) {
    const name = sprint.name.trim();
    const key = fileKey(name);
    const apart = key === '' || seen.has(key) || RESERVED.includes(name.toLowerCase());
    const given = apart ? `${name} (${sprint.id})` : name;
    seen.add(fileKey(given));
    out.set(sprint.id, given);
  }
  return out;
}

const day = (value: string | undefined): string | null => (value ? value.slice(0, 10) : null);
const stateOf = (state: string): HeldSprint['state'] => (state === 'active' ? 'active' : state === 'closed' ? 'closed' : 'planned');

// The board's sprints as the Backlog takes them, closed and active first, then the planned in the board's order.
export function heldSprints(sprints: readonly JiraSprint[], names: Map<number, string>, reports: Map<number, Report> = new Map()): HeldSprint[] {
  return sprints.map((sprint) => {
    const state = stateOf(sprint.state);
    const report = reports.get(sprint.id);
    return {
      id: String(sprint.id),
      name: names.get(sprint.id)!,
      state,
      goal: sprint.goal?.trim() || null,
      start: day(sprint.startDate),
      end: day(sprint.endDate),
      started: state === 'planned' ? null : (sprint.activatedDate ?? sprint.startDate ?? null),
      closed: state === 'closed' ? (sprint.completeDate ?? null) : null,
      ...(report ? { committed: report.committed, ...(report.result ? { result: report.result } : {}) } : {}),
    };
  });
}

export function indexOf(sprints: readonly JiraSprint[], names: Map<number, string>): SprintIndex {
  return new Map(sprints.map((sprint, at) => [String(sprint.id), { name: names.get(sprint.id)!, state: sprint.state === 'future' ? 'planned' : sprint.state, at }]));
}

// What the Backlog already holds, for a sync, which asks Jira nothing it need not.
export function indexFromBacklog(sprints: readonly SprintView[]): SprintIndex {
  return new Map(sprints.flatMap((sprint, at) => (sprint.source === null ? [] : [[sprint.source, { name: sprint.name, state: sprint.state, at }] as const])));
}

const listed = (value: unknown): FieldSprint[] =>
  Array.isArray(value) ? value.filter((sprint): sprint is FieldSprint => typeof sprint === 'object' && sprint !== null && typeof (sprint as FieldSprint).id === 'number') : [];

// The one sprint a task holds of those an issue lists (Jira Pull REQ18): the active one, else the first planned in the
// board's order, else, once done, the last to close; none while it is open with only closed ones, as Jira's backlog reads it.
// One another board runs is not carried. A sync, which reads only what the Backlog holds, judges a sprint it has not seen by
// the field; a pull has just read them all, so one it did not find is not this board's, whatever the field says.
export function chooseSprint(value: unknown, known: SprintIndex, board: number | undefined, done: boolean, whole = false): { name: string | null; foreign: number } {
  let foreign = 0;
  const candidates = listed(value).flatMap((sprint) => {
    const held = known.get(String(sprint.id));
    if (held) return [{ sprint, name: held.name, state: held.state, at: held.at }];
    if (whole || (board !== undefined && sprint.boardId !== undefined && sprint.boardId !== board)) {
      foreign += 1;
      return [];
    }
    return [{ sprint, name: sprint.name.trim(), state: sprint.state === 'future' ? 'planned' : sprint.state, at: Number.MAX_SAFE_INTEGER }];
  });
  const active = candidates.find((candidate) => candidate.state === 'active');
  if (active) return { name: active.name, foreign };
  const planned = candidates.filter((candidate) => candidate.state === 'planned').sort((a, b) => a.at - b.at)[0];
  if (planned) return { name: planned.name, foreign };
  if (!done) return { name: null, foreign };
  const closedAt = (sprint: FieldSprint): string => sprint.completeDate ?? sprint.endDate ?? '';
  const last = candidates.filter((candidate) => candidate.state === 'closed').sort((a, b) => closedAt(b.sprint).localeCompare(closedAt(a.sprint)))[0];
  return { name: last?.name ?? null, foreign };
}

// Jira's own value of the field as a sync's base hashes it: the sprints not yet closed, by id. The closed ones it lists are
// history, which grows without anything changing for the task; a sprint closing is seen as it leaves this list.
export const openSprintIds = (value: unknown): unknown => {
  const ids = listed(value)
    .filter((sprint) => sprint.state !== 'closed')
    .map((sprint) => sprint.id)
    .sort((a, b) => a - b);
  return ids.length === 0 ? null : ids;
};

// ---- the reports --------------------------------------------------------------------

export interface Report {
  committed: SprintTask[];
  result: SprintResult | null;
}

interface Change {
  at: number;
  sprintsFrom: number[] | null;
  sprintsTo: number[] | null;
  statusTo: string | null;
  statusFrom: string | null;
}

interface ReportIssue {
  id: string;
  key: string;
  created: number;
  title: string;
  status: string;
  sprints: number[];
}

const momentOf = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' ? new Date(value).getTime() : 0);
const idsOf = (value: unknown): number[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];

// Each issue's sprint and status changes, oldest first; null when Jira will not say, so no report is guessed.
async function changesOf(client: Requester, issues: readonly string[], sprintField: string): Promise<Map<string, Change[]> | null> {
  const out = new Map<string, Change[]>();
  try {
    for (let at = 0; at < issues.length; at += 1000) {
      let nextPageToken: string | undefined;
      for (;;) {
        const page = await client.post<{
          issueChangeLogs?: Array<{
            issueId: string;
            changeHistories?: Array<{ created: unknown; items?: Array<{ fieldId?: string; from?: unknown; to?: unknown; fromString?: unknown; toString?: unknown }> }>;
          }>;
          nextPageToken?: string;
        }>('/rest/api/3/changelog/bulkfetch', { issueIdsOrKeys: issues.slice(at, at + 1000), fieldIds: [sprintField, 'status'], maxResults: 1000, ...(nextPageToken ? { nextPageToken } : {}) });
        for (const log of page.issueChangeLogs ?? []) {
          const held = out.get(log.issueId) ?? [];
          for (const history of log.changeHistories ?? [])
            for (const item of history.items ?? []) {
              const sprint = item.fieldId === sprintField;
              const status = item.fieldId === 'status';
              if (!sprint && !status) continue;
              const named = (value: unknown): string | null => (status && typeof value === 'string' ? value : null);
              held.push({
                at: momentOf(history.created),
                sprintsFrom: sprint ? idsOf(item.from) : null,
                sprintsTo: sprint ? idsOf(item.to) : null,
                statusFrom: named(item.fromString),
                statusTo: named(item.toString),
              });
            }
          out.set(log.issueId, held);
        }
        if (!page.nextPageToken) break;
        nextPageToken = page.nextPageToken;
      }
    }
  } catch (cause) {
    if (cause instanceof JiraError) return null;
    throw cause;
  }
  for (const held of out.values()) held.sort((a, b) => a.at - b.at);
  return out;
}

const inSprintAt = (issue: ReportIssue, changes: readonly Change[], sprint: number, at: number): boolean => {
  const moves = changes.filter((change) => change.sprintsTo !== null);
  const before = moves.filter((change) => change.at <= at);
  if (before.length > 0) return before[before.length - 1]!.sprintsTo!.includes(sprint);
  // nothing moved it by then: what the first move took it from, else what it holds now, once it exists
  if (moves.length > 0) return moves[0]!.sprintsFrom!.includes(sprint);
  return issue.created <= at && issue.sprints.includes(sprint);
};

const statusAt = (issue: ReportIssue, changes: readonly Change[], at: number): string => {
  const moves = changes.filter((change) => change.statusTo !== null);
  const before = moves.filter((change) => change.at <= at);
  if (before.length > 0) return before[before.length - 1]!.statusTo!;
  return moves[0]?.statusFrom ?? issue.status;
};

// Jira Pull REQ19: what each sprint held at its start and at its close, read off the issues' history. A sprint's close moves
// the unfinished in the same breath, so a move within a minute of it says where they went.
export function buildReports(
  sprints: readonly JiraSprint[],
  names: Map<number, string>,
  issues: readonly ReportIssue[],
  changes: Map<string, Change[]>,
  taskOf: (issue: ReportIssue) => SprintTask,
  isDone: (status: string) => boolean,
): Map<number, Report> {
  const out = new Map<number, Report>();
  const started = (sprint: JiraSprint): number => momentOf(sprint.activatedDate ?? sprint.startDate);
  for (const sprint of sprints) {
    const start = started(sprint);
    const closing = sprint.state === 'closed' ? momentOf(sprint.completeDate) : Number.NaN;
    const history = (issue: ReportIssue): Change[] => changes.get(issue.id) ?? [];
    // a moment past the start itself: planning right up to the start counts as what was committed
    const committed = issues.filter((issue) => inSprintAt(issue, history(issue), sprint.id, start + 1000));
    if (Number.isNaN(closing)) {
      out.set(sprint.id, { committed: committed.map(taskOf), result: null });
      continue;
    }
    const closeAt = closing - 60_000;
    const atClose = issues.filter((issue) => inSprintAt(issue, history(issue), sprint.id, closeAt));
    const finished = atClose.filter((issue) => isDone(statusAt(issue, history(issue), closing)));
    const unfinished = atClose.filter((issue) => !finished.includes(issue));
    const next = new Set(
      unfinished.map((issue) => {
        const move = history(issue).find((change) => change.sprintsTo !== null && change.at >= closeAt && change.sprintsTo.some((id) => id !== sprint.id && !change.sprintsFrom!.includes(id)));
        return move?.sprintsTo!.find((id) => id !== sprint.id && !move.sprintsFrom!.includes(id)) ?? null;
      }),
    );
    const only = next.size === 1 ? [...next][0]! : null;
    const committedTasks = committed.map(taskOf);
    out.set(sprint.id, {
      committed: committedTasks,
      result: {
        committed: committedTasks,
        added: atClose.filter((issue) => !committed.includes(issue)).map(taskOf),
        removed: committed.filter((issue) => !atClose.includes(issue)).map(taskOf),
        completed: finished.map(taskOf),
        carried: unfinished.map(taskOf),
        carried_to: only === null ? null : (names.get(only) ?? null),
      },
    });
  }
  return out;
}

// The reports a board's sprints still want, read from Jira in a few requests whatever their number: the issues with one
// search, their history in bulk. An issue that has left the scope since is not read, and a report says only what it could.
export async function readReports(
  context: { client: Requester; connection: Connection; host: Host },
  wanting: readonly JiraSprint[],
  names: Map<number, string>,
  sprintField: string,
  scope: string,
  search: (jql: string, fields: string[]) => Promise<Array<{ id: string; key: string; fields: Record<string, unknown> }>>,
  taskOf: (issue: { id: string; key: string; title: string }) => SprintTask,
  board: BoardSettings,
): Promise<Map<number, Report>> {
  if (wanting.length === 0) return new Map();
  const found = await search(`(${scope}) AND ${sprintField.replace('customfield_', 'cf[')}] is not EMPTY`, ['summary', 'status', 'created', sprintField]).catch((cause: unknown) => {
    if (cause instanceof JiraError) return null;
    throw cause;
  });
  if (found === null) return new Map();
  const issues: ReportIssue[] = found.map((issue) => ({
    id: issue.id,
    key: issue.key,
    created: momentOf(issue.fields['created']),
    title: typeof issue.fields['summary'] === 'string' ? issue.fields['summary'] : issue.key,
    status: (issue.fields['status'] as { name?: string } | undefined)?.name ?? '',
    sprints: listed(issue.fields[sprintField]).map((sprint) => sprint.id),
  }));
  const changes = await changesOf(
    context.client,
    issues.map((issue) => issue.id),
    sprintField,
  );
  if (changes === null) return new Map();
  const categories = new Map(
    found.flatMap((issue) => {
      const status = issue.fields['status'] as { name?: string; statusCategory?: { key?: string } } | undefined;
      return status?.name ? [[status.name, categoryOf(status.statusCategory?.key)] as const] : [];
    }),
  );
  for (const type of cachedDescription(context.host.workspace, context.connection.name)?.types ?? [])
    for (const status of type.statuses) if (!categories.has(status.name)) categories.set(status.name, status.category);
  const isDone = (status: string): boolean => backlogCategory(board, statusFor(context.connection.mapping, board, status, categories.get(status) ?? 'todo')) === 'done';
  return buildReports(wanting, names, issues, changes, taskOf, isDone);
}
