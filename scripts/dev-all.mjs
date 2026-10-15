import {spawn} from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', 'server/index.js'], {stdio: 'inherit'}),
  spawn('npm', ['run', 'dev'], {stdio: 'inherit', shell: true}),
];

const stop = code => {
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
};
for (const child of children) child.on('exit', code => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
