// A connection that already keeps its sprints as a milestone or a property goes on doing so
// after an update (Jira REQ26): a pull changes neither how its tasks read nor how its board works.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMAIL, startFakeJira, TOKEN } from './fake-jira.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliFile = process.env['EIDOS_CLI'] ?? path.join(repo, 'node_modules', 'eidosmd', 'dist', 'src', 'cli.js');
const version = /^version:\s*(\S+)/m.exec(readFileSync(path.join(repo, 'manifest.yaml'), 'utf8'))![1]!;
const scratch = mkdtempSync(path.join(tmpdir(), 'eidos-jira-saved-'));
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
const story = (): string => {
  const dir = path.join(root, 'backlog');
  return readFileSync(
    path.join(
      dir,
      readdirSync(dir).find((file) => file.startsWith('t-acme-2-ship'))!,
    ),
    'utf8',
  );
};
const backlogSettings = (): string => readFileSync(path.join(root, '.eidos/plugins/backlog/settings.yaml'), 'utf8');
const setSprintPair = async (eidosSide: string): Promise<void> => {
  await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'customfield_10020', eidosSide]);
};

before(async () => {
  fake = await startFakeJira();
  const dir = path.join(scratch, 'app', 'plugins', 'jira', version);
  mkdirSync(dir, { recursive: true });
  for (const file of ['manifest.yaml', 'cli.js']) copyFileSync(path.join(repo, 'dist', file), path.join(dir, file));
  const cliVersion = /eidosmd (\S+)/.exec(await ok(['--version']))?.[1] ?? '';
  const manifest = path.join(dir, 'manifest.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^min_host: .*$/m, `min_host: ${cliVersion}`));
  await ok(['install', '--blank', root, '--product', 'Scratch', '--yes', '--offline']);
  await ok(['plugin', 'enable', 'backlog']);
  await ok(['plugin', 'enable', 'jira']);
  await ok(['plugin', 'allow', 'jira']);
  await ok(['jira', 'login', fake.url], `${EMAIL}\n${TOKEN}\n`);
  await ok(['jira', 'connect', 'acme', '--site', fake.url, '--key', 'ACME', '--board', '1']);
  await ok(['jira', 'describe', 'acme']);
});

after(async () => {
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
});

test('a connection that has pulled is not offered Backlog sprints by a draft, so saving its mapping changes nothing about them', async () => {
  await ok(['jira', 'pull', 'acme']);
  const draft = JSON.parse(await ok(['jira', 'map', 'acme', '--json'])) as { entries: Array<{ jira: string; eidos: string }> };
  assert.equal(draft.entries.find((entry) => entry.jira === 'customfield_10020')?.eidos, 'milestone');
});

test('a scrum board with its sprint field saved as the milestone keeps the milestone, and its board stays as it was', async () => {
  await setSprintPair('milestone');
  const fetched = await ok(['jira', 'fetch', 'acme', '--full']);
  assert.match(fetched, /milestones to add: Sprint 7/);
  assert.doesNotMatch(fetched, /sprints to add/);
  await ok(['jira', 'pull', 'acme', '--full']);
  assert.match(story(), /^milestone: Sprint 7$/m);
  assert.doesNotMatch(story(), /^sprint:/m);
  assert.doesNotMatch(backlogSettings(), /^\s*sprints: true|sprints_held/m, 'the board does not start running in sprints');
  assert.match(await ok(['backlog', 'sprints']), /no sprints/);
  assert.match(await ok(['jira', 'fetch', 'acme']), /nothing to pull/, 'and nothing reads as changed on the next look');
});

test('a sprint field saved to a property named sprint keeps writing it, with nothing removed', async () => {
  await ok(['backlog', 'configure:property', 'add', 'sprint', '--type', 'List']);
  await setSprintPair('property:sprint');
  await ok(['jira', 'pull', 'acme', '--full']);
  assert.match(story(), /^sprint: \["Sprint 7"\]$/m);
  assert.match(backlogSettings(), /name: sprint/, 'the property stays declared');
  assert.doesNotMatch(backlogSettings(), /sprints_held/);
  assert.match(await ok(['jira', 'fetch', 'acme', '--full']), /nothing to pull/);
});

test('Jira Pull REQ3: a sprint field moved to the milestone reads every issue again on the next pull, without --full', async () => {
  await setSprintPair('milestone');
  const fetched = await ok(['jira', 'fetch', 'acme']);
  assert.match(fetched, /the whole scope, read again as the mapping changed/);
  await ok(['jira', 'pull', 'acme']);
  assert.match(story(), /^milestone: Sprint 7$/m);
  assert.match(await ok(['jira', 'fetch', 'acme']), /nothing to pull \(changed since/, 'and the next look reads only what changed');
});

test('Jira Pull REQ3: a connection moved from a property to Backlog sprints and on to the milestone fills each in, without --full', async () => {
  await setSprintPair('property:sprint');
  await ok(['jira', 'pull', 'acme']);
  assert.match(story(), /^sprint: \["Sprint 7"\]$/m);
  await ok(['jira', 'sprints', 'acme', '--yes']);
  await ok(['jira', 'pull', 'acme']);
  assert.match(story(), /^sprint: Sprint 7$/m);
  // the milestone an earlier mapping wrote is the root's while nothing maps it (Jira Pull REQ6); cleared, so the pull below is what fills it
  await ok(['backlog', 'set', 'T-ACME-2', '--milestone', '']);
  assert.doesNotMatch(story(), /^milestone: Sprint 7$/m);
  await setSprintPair('milestone');
  await ok(['jira', 'pull', 'acme']);
  assert.match(story(), /^milestone: Sprint 7$/m);
  assert.match(await ok(['jira', 'fetch', 'acme']), /nothing to pull \(changed since/);
});
