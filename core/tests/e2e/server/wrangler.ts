/**
 * Runs a real `wrangler dev` per uploaded Worker.
 *
 * The spawn, poll and teardown shape is `drupflare/worker/scripts/e2e-lifecycle.ts`, including its
 * `--keep` flag: a failing e2e run is much easier to read when the worker it was driving is still up.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DevWorker {
	name: string;
	port: number;
	url: string;
	dir: string;
	stop(): Promise<void>;
}

const KEEP = process.env.WORKFORCE_KEEP_DEV === '1';

let nextPort = 8910;

function takePort(): number {
	nextPort += 1;
	return nextPort;
}

async function reachable(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
			if (response.status > 0) return true;
		} catch {
			// not up yet; a dev server refuses the connection until it binds
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

/** whether wrangler is on PATH at all, so the lane can skip with a reason rather than fail */
export async function wranglerAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn('bunx', ['wrangler', '--version'], { stdio: 'ignore' });
		child.on('error', () => resolve(false));
		child.on('exit', (code) => resolve(code === 0));
	});
}

export interface StartOptions {
	name: string;
	modules: Map<string, Uint8Array>;
	main: string;
	compatibilityDate?: string;
	compatibilityFlags?: string[];
	timeoutMs?: number;
}

/**
 * Writes the modules to a temp directory, derives a wrangler config from the upload metadata, and
 * brings the worker up.
 */
export async function startDevWorker(options: StartOptions): Promise<DevWorker | null> {
	const dir = await mkdtemp(join(tmpdir(), `wf-dev-${options.name}-`));
	for (const [path, bytes] of options.modules) {
		const full = join(dir, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, bytes);
	}
	await writeFile(
		join(dir, 'wrangler.json'),
		JSON.stringify(
			{
				name: options.name,
				main: options.main,
				compatibility_date: options.compatibilityDate ?? '2026-08-01',
				compatibility_flags: options.compatibilityFlags ?? []
			},
			null,
			'\t'
		)
	);

	const port = takePort();
	const child: ChildProcess = spawn(
		'bunx',
		[
			'wrangler',
			'dev',
			'--local',
			'--port',
			String(port),
			'--inspector-port',
			String(port + 1000),
			'-c',
			join(dir, 'wrangler.json')
		],
		{ cwd: dir, stdio: 'ignore', env: { ...process.env, CLOUDFLARE_API_TOKEN: '' } }
	);

	const url = `http://127.0.0.1:${port}`;
	const up = await reachable(url, options.timeoutMs ?? 45_000);
	if (!up) {
		child.kill('SIGTERM');
		if (!KEEP) await rm(dir, { recursive: true, force: true });
		return null;
	}

	return {
		name: options.name,
		port,
		url,
		dir,
		async stop() {
			if (KEEP) return;
			child.kill('SIGTERM');
			await new Promise((resolve) => setTimeout(resolve, 100));
			await rm(dir, { recursive: true, force: true });
		}
	};
}
