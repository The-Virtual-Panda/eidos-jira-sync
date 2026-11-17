// The Jira key written to a Backlog property of the root's choosing (`key_property`), so the Backlog's table, its cards,
// and a bulk edit show which issue a task holds. Off while the setting is empty. The key is written only to a Text
// property the connection's board uses and its field mapping does not carry: anything else writes nothing, so a pull,
// a create, or a sync never stops on it.
import type { Host } from 'eidosmd/plugin';
import { settingsFor } from './boards.ts';
import type { Connection } from './connections.ts';
import { fieldsOf } from './mapping.ts';
import type { BacklogApi, TaskView } from './types.ts';

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// The property `key_property` names, or null while it is off.
export function keyPropertyName(host: Host): string | null {
  const held = host.settings().get<unknown>('key_property');
  if (typeof held !== 'string') return null;
  const name = held.trim();
  return name === '' ? null : name;
}

// Why a connection's tasks cannot take their key in the property, or null when they can.
export function keyPropertyRefusal(backlog: BacklogApi, connection: Connection, name: string): string | null {
  const board = settingsFor(backlog, connection);
  const declared = board.properties.find((property) => same(property.name, name));
  if (!declared) return `${connection.name}'s Backlog board does not use the property ${name}`;
  if (declared.type.toLowerCase() !== 'text') return `${name} is a ${declared.type} property; the Jira key goes in a Text one`;
  const mapped = fieldsOf(connection, board).find((pair) => same(pair.eidos, `property:${declared.name}`));
  if (mapped) return `${connection.name}'s mapping carries ${mapped.jira} to ${name}; a property the mapping carries cannot also hold the key`;
  return null;
}

// The property a connection's tasks take their key in: its declared name, or null while it is off or refused.
export function keyPropertyOf(host: Host, backlog: BacklogApi, connection: Connection): string | null {
  const name = keyPropertyName(host);
  if (name === null) return null;
  if (keyPropertyRefusal(backlog, connection, name) !== null) return null;
  const board = settingsFor(backlog, connection);
  const declared = board.properties.find((property) => same(property.name, name));
  return declared?.name ?? null;
}

// The property a task's write adds so it holds its issue's key: empty where it is off, or the task already holds it.
export function keyedProperties(host: Host, backlog: BacklogApi, connection: Connection, task: TaskView | null, key: string): Record<string, string> {
  const name = keyPropertyOf(host, backlog, connection);
  if (name === null) return {};
  if (task !== null && task.properties[name] === key) return {};
  return { [name]: key };
}
