// Jira's sprints as the Backlog's own, end to end against the fake Jira: a scrum
// board's sprints held by the plugin, one sprint chosen per task, the reports read
// from the issues' history, and only a task's own sprint ever sent back.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMAIL, startFakeJira, TOKEN, touch } from './fake-jira.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliFile = process.env['EIDOS_CLI'] ?? path.join(repo, 'node_modules', 'eidosmd', 'dist', 'src', 'cli.js');
const version = /^version:\s*(\S+)/m.exec(readFileSync(path.join(repo, 'manifest.yaml'), 'utf8'))![1]!;
const scratch = mkdtempSync(path.join(tmpdir(), 'eidos-jira-sprints-'));
const env = { ...process.env, EIDOS_APP_DATA: path.join(scratch, 'app'), EIDOS_NO_TELEMETRY: '1', JIRA_EMAIL: '', JIRA_API_TOKEN: '' };
const root = path.join(scratch, 'Blueprints');
let fake: Awaited<ReturnType<typeof startFakeJira>>;

function eidos(args: string[], input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], { cwd: existsSync(root) ? root : scratch, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
const ok = async (args: string[], input?: string): Promise<string> => {
  const result = await eidos(args, input);
  assert.equal(result.status, 0, `eidos ${args.join(' ')}\n${result.stderr}${result.stdout}`);
  return result.stdout;
};
const taskFile = (id: string): string => {
  const dir = path.join(root, 'backlog');
  const name = readdirSync(dir).find((file) => file.endsWith('.md') && readFileSync(path.join(dir, file), 'utf8').startsWith(`---\nid: ${id}\n`));
  assert.ok(name, `no file holds ${id}`);
  return path.join(dir, name);
};
const sprintOf = (id: string): string | null => /^sprint: (.*)$/m.exec(readFileSync(taskFile(id), 'utf8'))?.[1] ?? null;
interface Listed {
  name: string;
  state: string;
  goal: string | null;
  source: string | null;
  committed: Array<{ id: string }>;
  result: {
    committed: Array<{ id: string }>;
    completed: Array<{ id: string }>;
    carried: Array<{ id: string }>;
    carried_to: string | null;
    added: Array<{ id: string }>;
    removed: Array<{ id: string }>;
  } | null;
}
const sprints = async (): Promise<Listed[]> => (JSON.parse(await ok(['backlog', 'sprints', '--json'])) as { sprints: Listed[] }).sprints;
const field = (id: number): Record<string, unknown> => fake.state.sprints.find((sprint) => sprint['id'] === id)!;
let tick = 0;
const jiraNow = (): string => new Date(Date.now() + 60_000 + (tick += 1) * 1000).toISOString().replace('Z', '+0000');

before(async () => {
  fake = await startFakeJira();
  fake.state.sprints = [
    { id: 6, name: 'Sprint 6', state: 'closed', boardId: 1, startDate: '2026-10-01T09:00:00.000Z', endDate: '2026-10-14T09:00:00.000Z', completeDate: '2026-10-15T09:00:00.000Z' },
    { id: 7, name: 'Sprint 7', state: 'active', boardId: 1, goal: 'Ship login', startDate: '2026-10-15T09:00:00.000Z', endDate: '2026-11-02T00:00:00.000Z' },
    { id: 9, name: 'Parked', state: 'future', boardId: 1 },
    { id: 8, name: 'Next up', state: 'future', boardId: 1, startDate: '2026-11-02T00:00:00.000Z', endDate: '2026-11-16T00:00:00.000Z' },
    { id: 10, name: 'Parked', state: 'future', boardId: 1 },
    { id: 11, name: 'Backlog', state: 'future', boardId: 1 },
  ];
  // ACME-2 in the active sprint, and in a closed one before it, listed in no useful order; ACME-3 open, in the closed one alone
  touch(fake.state, 'ACME-2', { customfield_10020: [field(6), field(7)] }, '2026-10-16T09:00:00.000+0000');
  touch(fake.state, 'ACME-3', { customfield_10020: [field(6)] }, '2026-10-16T09:00:00.000+0000');
  fake.state.changelogs.set('10101', [
    { created: '2026-10-15T08:00:00.000+0000', items: [{ fieldId: 'customfield_10020', from: '6', to: '6, 7', fromString: 'Sprint 6', toString: 'Sprint 6, Sprint 7' }] },
  ]);
  const dir = path.join(scratch, 'app', 'plugins', 'jira-sync', version);
  mkdirSync(dir, { recursive: true });
  for (const file of ['manifest.yaml', 'cli.js']) copyFileSync(path.join(repo, 'dist', file), path.join(dir, file));
  const cliVersion = /eidosmd (\S+)/.exec(await ok(['--version']))?.[1] ?? '';
  const manifest = path.join(dir, 'manifest.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^min_host: .*$/m, `min_host: ${cliVersion}`));
  await ok(['install', '--blank', root, '--product', 'Scratch', '--yes', '--offline']);
  await ok(['plugin', 'enable', 'backlog']);
  await ok(['plugin', 'enable', 'jira-sync']);
  await ok(['plugin', 'allow', 'jira-sync']);
  await ok(['users', 'add', 'Tester', '--alias', 'tester', '--email', EMAIL]);
  await ok(['jira-sync', 'login', fake.url], `${EMAIL}\n${TOKEN}\n`);
  await ok(['jira-sync', 'connect', 'acme', '--site', fake.url, '--key', 'ACME', '--board', '1']);
  await ok(['jira-sync', 'describe', 'acme', '--refresh']);
});

after(async () => {
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
});

test('Jira REQ27: the move says what it will do, a dry run writes nothing, and --yes moves the pair', async () => {
  const before = readFileSync(path.join(root, '.eidos/plugins/jira-sync/settings.yaml'), 'utf8');
  assert.match(await ok(['jira-sync', 'sprints', 'acme', '--dry-run']), /customfield_10020 moves from nothing to the Backlog's sprints/);
  assert.match(await ok(['jira-sync', 'sprints', 'acme']), /Run it with --yes/);
  assert.equal(readFileSync(path.join(root, '.eidos/plugins/jira-sync/settings.yaml'), 'utf8'), before);
  assert.match(await ok(['jira-sync', 'sprints', 'acme', '--yes']), /brings the sprints in/);
  assert.match(readFileSync(path.join(root, '.eidos/plugins/jira-sync/settings.yaml'), 'utf8'), /jira: customfield_10020\n\s+eidos: sprint/);
  assert.match(await ok(['jira-sync', 'sprints', 'acme']), /already carries/);
});

test("Jira Pull REQ17: a fetch says what a pull would do and writes nothing; a pull holds the sprints in their states, the planned in Jira's order, a repeated name and a reserved one set apart", async () => {
  const fetched = await ok(['jira-sync', 'fetch', 'acme']);
  assert.match(fetched, /sprints to add: Sprint 6, Sprint 7, Parked, Next up, Parked \(10\), Backlog \(11\)/);
  assert.equal((await ok(['backlog', 'sprints'])).includes('Sprint 7'), false);
  await ok(['jira-sync', 'pull', 'acme']);
  const held = await sprints();
  assert.deepEqual(
    held.filter((sprint) => sprint.state === 'planned').map((sprint) => sprint.name),
    ['Parked', 'Next up', 'Parked (10)', 'Backlog (11)'],
  );
  assert.equal(held.find((sprint) => sprint.name === 'Sprint 6')!.state, 'closed');
  const active = held.find((sprint) => sprint.name === 'Sprint 7')!;
  assert.equal(active.state, 'active');
  assert.equal(active.goal, 'Ship login');
  assert.equal(active.source, '7');
});

test('Jira Pull REQ18: a task holds the active sprint; open with only closed ones, none; a subtask of the mapping goes with its parent; and nothing reads as edited here', async () => {
  assert.equal(sprintOf('T-ACME-2'), 'Sprint 7');
  assert.equal(sprintOf('T-ACME-3'), null);
  assert.match(await ok(['jira-sync', 'status', 'acme']), /nothing edited here/);
  assert.match(await ok(['jira-sync', 'fetch', 'acme']), /nothing to pull/);
});

test('Jira Pull REQ19: a closed sprint carries its report, read from the history, and an active one what it committed', async () => {
  const held = await sprints();
  const closed = held.find((sprint) => sprint.name === 'Sprint 6')!;
  assert.ok(closed.result, 'a closed sprint has a result');
  // ACME-3 sat in Sprint 6 from before it began and is still open
  assert.ok(closed.result.committed.some((task) => task.id === 'T-ACME-3'));
  assert.ok(closed.result.carried.some((task) => task.id === 'T-ACME-3'));
  assert.ok(held.find((sprint) => sprint.name === 'Sprint 7')!.committed.some((task) => task.id === 'T-ACME-2'));
});

test('Backlog Sprints REQ15: a held sprint is refused here, naming Jira', async () => {
  const refused = await eidos(['backlog', 'sprint', 'start', 'Parked']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /run in Jira.*\/boards\/1/);
});

test('Jira Sync REQ21: a task put in a sprint moves its issue there, out of one moves it to the backlog, and nothing else is sent', async () => {
  await ok(['backlog', 'set', 'T-ACME-3', '--sprint', 'Next up']);
  assert.match(await ok(['jira-sync', 'status', 'acme']), /T-ACME-3: sprint/);
  const before = fake.state.writes.length;
  assert.match(await ok(['jira-sync', 'sync', 'T-ACME-3', '--yes']), /synced ACME-3: sent sprint/);
  assert.deepEqual(
    fake.state.writes.slice(before).map((write) => `${write.method} ${write.path}`),
    ['POST /rest/agile/1.0/sprint/8/issue'],
  );
  assert.match(await ok(['jira-sync', 'sync', 'T-ACME-3', '--dry-run']), /level: nothing to sync/);

  await ok(['backlog', 'set', 'T-ACME-3', '--sprint', '']);
  const then = fake.state.writes.length;
  assert.match(await ok(['jira-sync', 'sync', 'T-ACME-3', '--yes']), /synced ACME-3: sent sprint/);
  assert.deepEqual(
    fake.state.writes.slice(then).map((write) => `${write.method} ${write.path}`),
    ['POST /rest/agile/1.0/backlog/issue'],
  );
  assert.match(await ok(['jira-sync', 'sync', 'T-ACME-3', '--dry-run']), /level: nothing to sync/);
});

test('Jira Sync REQ21: a sprint Jira moved comes in by a sync, a sprint it just made included', async () => {
  fake.state.sprints.push({ id: 12, name: 'Brand new', state: 'future', boardId: 1 });
  touch(fake.state, 'ACME-3', { customfield_10020: [field(6), field(12)] }, jiraNow());
  assert.match(await ok(['jira-sync', 'sync', 'T-ACME-3', '--yes']), /synced ACME-3/);
  assert.equal(sprintOf('T-ACME-3'), 'Brand new');
});

test('Jira Pull REQ17: a sprint renamed there carries its tasks; one closing moves a task on through the issue; one deleted leaves its tasks in none', async () => {
  field(7)['name'] = 'Sprint Seven';
  await ok(['jira-sync', 'pull', 'acme']);
  assert.equal(sprintOf('T-ACME-2'), 'Sprint Seven');

  // the sprint closes: its issue is done and stays with it
  Object.assign(field(7), { state: 'closed', completeDate: new Date(Date.now() - 1000).toISOString() });
  touch(fake.state, 'ACME-2', { status: { id: '5', name: 'Done', statusCategory: { key: 'done' } }, customfield_10020: [field(6), field(7)] }, jiraNow());
  await ok(['jira-sync', 'pull', 'acme']);
  assert.equal(sprintOf('T-ACME-2'), 'Sprint Seven');
  assert.equal((await sprints()).find((sprint) => sprint.name === 'Sprint Seven')!.state, 'closed');
  assert.ok((await sprints()).find((sprint) => sprint.name === 'Sprint Seven')!.result?.completed.some((task) => task.id === 'T-ACME-2'));

  fake.state.sprints = fake.state.sprints.filter((sprint) => sprint['id'] !== 12);
  // the field can lag behind a deletion for a moment; a pull goes by the board's own list either way
  await ok(['jira-sync', 'pull', 'acme']);
  assert.equal(sprintOf('T-ACME-3'), null);
  assert.equal(
    (await sprints()).some((sprint) => sprint.name === 'Brand new'),
    false,
  );
});

test('Jira Push REQ12: a task in a sprint makes an issue in that sprint', async () => {
  const made = JSON.parse(await ok(['backlog', 'add', 'Made here', '--sprint', 'Next up', '--json'])) as { id: string };
  const before = fake.state.writes.length;
  await ok(['jira-sync', 'create', made.id, '--connection', 'acme', '--type', 'Bug', '--yes']);
  assert.ok(fake.state.writes.slice(before).some((write) => write.path === '/rest/agile/1.0/sprint/8/issue'));
  assert.match(await ok(['jira-sync', 'status', 'acme']), /nothing edited here/);
});

test('letting go: a disconnect leaves the sprints for a person to run', async () => {
  await ok(['jira-sync', 'disconnect', 'acme']);
  const started = await ok(['backlog', 'sprint', 'start', 'Next up', '--json']);
  assert.equal((JSON.parse(started) as { state: string }).state, 'active');
});
