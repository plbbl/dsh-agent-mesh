#!/usr/bin/env node

import { MeshRuntime } from '../src/index.js';

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replaceAll('-', '_');
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) { values[key] = next; index += 1; }
    else values[key] = true;
  }
  return values;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`dsh-mesh — local harness control plane\n\nCommands:\n  discover                  Scan native harnesses and model configs\n  profiles                  List usable harness/model profiles\n  start --profile <id>     Start or resume a session\n  agents                   List persistent Agent Mesh sessions\n  send --to <id> --text    Queue a durable cross-agent message\n  inbox --to <id>          Read messages for a session\n  stop --session <id>      Stop a live process, retain its session mapping\n  snapshot                 Print the complete local control-plane snapshot\n  doctor                   Check common CLI binaries without starting agents\n\nOptions:\n  --home <path>            Override the Agent Mesh state directory\n  --cwd <path>             Workspace used by a started session\n  --session <id>           Stable Agent Mesh session id\n  --from <id>              Message sender id\n  --kind <kind>            Message kind\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === 'help' || args.help) {
  help();
  process.exit(0);
}
const runtime = new MeshRuntime({ homeDir: args.home, cwd: args.cwd, autoDiscover: args.no_discover !== true });
try {
  await runtime.ready;
  switch (args.command) {
    case 'doctor': print(await runtime.doctor()); break;
    case 'discover': print(await runtime.discover({ cwd: args.cwd })); break;
    case 'profiles': print({ profiles: runtime.listProfiles(), discovery: runtime.snapshot().discovery }); break;
    case 'agents': print({ agents: runtime.listAgents() }); break;
    case 'start': print(await runtime.start(args.profile, { sessionId: args.session, cwd: args.cwd })); break;
    case 'send': print(await runtime.sendMessage({ to: args.to, text: args.text, from: args.from ?? 'dsh-cli', kind: args.kind })); break;
    case 'inbox': print({ messages: runtime.inbox({ to: args.to, limit: args.limit }) }); break;
    case 'stop': print(await runtime.stop(args.session)); break;
    case 'snapshot': print(runtime.snapshot({ limit: args.limit })); break;
    default: help(); process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
