// The Backlog board a connection pulls onto (Jira REQ25), and the Backlog's
// settings as that board sees them. A board uses a subset of the root's one
// pool of statuses, types, and properties, with its own columns or the root's
// narrowed to its statuses; a pull, a sync, a create, and a mapping read the
// board's view, so a value the mapping leaves out falls to one the board uses.
// A status's category stays the root's whatever board shows it, so it is fixed
// from the root's columns before the board's own replace them. A host from
// before boards has none, and every connection reads the whole backlog.
import { backlogCategory } from './mapping.ts';
import type { BacklogApi, Board, BoardSettings } from './types.ts';
import type { Connection } from './connections.ts';

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// Whether the host's Backlog holds boards and lets a plugin make and change them.
export const boardsSupported = (backlog: BacklogApi): boolean => Array.isArray(backlog.settings().boards) && typeof backlog.addBoard === 'function' && typeof backlog.setBoard === 'function';

// The board a connection names, when the Backlog declares it; null for a connection that names none, or one the Backlog no longer has.
export function boardOf(settings: BoardSettings, connection: Connection): Board | null {
  const wanted = connection.backlog_board;
  if (!wanted) return null;
  return (settings.boards ?? []).find((board) => same(board.name, wanted) || same(board.title, wanted)) ?? null;
}

export function onBoard(settings: BoardSettings, board: Board | null): BoardSettings {
  if (board === null) return settings;
  const usedStatuses = board.statuses;
  const usedTypes = board.types;
  const usedProperties = board.properties;
  const statuses = usedStatuses === null ? settings.statuses : settings.statuses.filter((status) => usedStatuses.includes(status));
  const columns =
    board.columns ?? settings.columns.map((column) => ({ ...column, statuses: column.statuses.filter((status) => statuses.includes(status)) })).filter((column) => column.statuses.length > 0);
  const defaultStatus =
    (board.default_status && statuses.includes(board.default_status) ? board.default_status : null) ??
    (statuses.includes(settings.default_status) ? settings.default_status : (statuses[0] ?? settings.default_status));
  return {
    ...settings,
    statuses,
    columns,
    default_status: defaultStatus,
    types: usedTypes === null ? settings.types : settings.types.filter((type) => usedTypes.includes(type.name)),
    properties: usedProperties === null ? settings.properties : settings.properties.filter((property) => usedProperties.includes(property.name)),
    status_categories: Object.fromEntries(settings.statuses.map((status) => [status, backlogCategory(settings, status)])),
  };
}

// The Backlog's settings as a connection's board sees them: the whole backlog for a connection that names none.
export const settingsFor = (backlog: BacklogApi, connection: Connection): BoardSettings => {
  const settings = backlog.settings();
  return onBoard(settings, boardOf(settings, connection));
};

// A board's name from a Jira board's: letters, digits, _ and -, as the Backlog takes one.
export const boardKey = (title: string): string =>
  title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'jira';
