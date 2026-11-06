import type { SftpSession } from 'edgeport/sftp';
import type { SshConnectOptions, SshSession } from 'edgeport/ssh';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, TransportError, UsageError } from '../../src/client/errors.js';
import {
	_setEdgePortLoader,
	connect,
	diagnose,
	fromRemote,
	readRemoteTree,
	type EdgeSftpSession,
	type EdgeSshOptions,
	type EdgeSshSession,
	type RemoteSession
} from '../../src/remote.js';
import { toUtf8 } from '../../src/source.js';

// compile-time: what remote.ts passes and calls must exist on edgeport's own types
export const conforms = {
	options: (options: EdgeSshOptions): SshConnectOptions => options,
	ssh: (session: SshSession): EdgeSshSession => session,
	sftp: (session: SftpSession): EdgeSftpSession => session
};

const encoder = new TextEncoder();

interface FakeTree {
	[path: string]: string | FakeTree;
}

/** a stand-in for one ssh + sftp session over an in-memory tree */
function fakeEdgePort(tree: FakeTree, hostKey = new Uint8Array([1, 2, 3])) {
	const opened: Record<string, unknown>[] = [];
	let sshConnects = 0;

	function at(path: string): string | FakeTree | undefined {
		const parts = path.split('/').filter((p) => p !== '');
		let node: string | FakeTree | undefined = tree;
		for (const part of parts) {
			if (typeof node !== 'object' || node === undefined) return undefined;
			node = node[part];
		}
		return node;
	}

	const loader = async () => ({
		ssh: {
			async connect(options: EdgeSshOptions) {
				sshConnects += 1;
				opened.push(options as unknown as Record<string, unknown>);
				const accepted = await options.hostKey.verify('ssh-ed25519', hostKey);
				if (!accepted) throw new Error('host key verification failed');
				return {
					async exec(command: string) {
						return { stdoutText: `ran ${command}`, stderrText: '', code: 0 };
					},
					async close() {}
				};
			}
		},
		sftp: {
			async connect() {
				return {
					async readFile(path: string) {
						const node = at(path);
						if (typeof node !== 'string') throw new Error(`${path} is not a file`);
						return encoder.encode(node);
					},
					async list(path: string) {
						const node = at(path);
						if (typeof node !== 'object' || node === undefined) {
							throw new Error(`${path} is not a directory`);
						}
						return Object.keys(node).map((filename) => ({ filename }));
					},
					async close() {}
				};
			}
		}
	});
	return { loader, opened, connects: () => sshConnects };
}

const creds = { hostname: 'box.example', username: 'root', password: 'hunter2' };

afterEach(() => {
	_setEdgePortLoader(async () => {
		throw new Error('edgeport loader not set for this test');
	});
});

describe('diagnose', () => {
	it('reads a changed host key as the machine-in-the-middle it looks like', () => {
		const error = diagnose(new Error('host key verification failed'), 'box');
		expect(error).toBeInstanceOf(AuthError);
		expect(error.message).toMatch(/machine-in-the-middle/);
	});

	it('separates a refused credential from an unreachable host', () => {
		expect(diagnose(new Error('permission denied (publickey)'), 'box')).toBeInstanceOf(
			AuthError
		);
		expect(diagnose(new Error('connection refused'), 'box')).toBeInstanceOf(TransportError);
		expect(diagnose(new Error('ETIMEDOUT'), 'box')).toBeInstanceOf(TransportError);
	});

	it('keeps the original as the cause rather than swallowing it', () => {
		const original = new Error('something odd');
		expect(diagnose(original, 'box').cause).toBe(original);
	});
});

describe('connect', () => {
	it('refuses with no credential rather than opening a socket', async () => {
		await expect(connect({ hostname: 'box', username: 'root' })).rejects.toBeInstanceOf(
			UsageError
		);
	});

	it('captures the host key so a first connection can be pinned afterwards', async () => {
		const { loader } = fakeEdgePort({ etc: {} });
		_setEdgePortLoader(loader);
		const session = await connect(creds);
		expect(session.hostKey?.fingerprint).toMatch(/^SHA256:/);
		await session.close();
	});

	it('accepts the pinned key and refuses a different one', async () => {
		const { loader } = fakeEdgePort({ etc: {} }, new Uint8Array([9, 9, 9]));
		_setEdgePortLoader(loader);
		const first = await connect(creds);
		const pinned = first.hostKey?.fingerprint as string;
		await first.close();

		_setEdgePortLoader(loader);
		const second = await connect({ ...creds, expectFingerprint: pinned });
		expect(second.hostKey?.fingerprint).toBe(pinned);
		await second.close();

		_setEdgePortLoader(loader);
		await expect(
			connect({ ...creds, expectFingerprint: 'SHA256:somethingelse' })
		).rejects.toBeInstanceOf(AuthError);
	});

	it('passes the pin under hostKey, the only name edgeport reads', async () => {
		const fake = fakeEdgePort({ etc: {} });
		_setEdgePortLoader(fake.loader);
		const session = await connect({ ...creds, expectFingerprint: 'SHA256:anything' }).catch(
			(error: unknown) => error
		);
		expect(session).toBeInstanceOf(AuthError);
		expect(Object.keys(fake.opened[0] ?? {})).toContain('hostKey');
		expect(fake.opened[0]).not.toHaveProperty('hostKeys');
	});

	it('returns command output as text, not as the bytes edgeport carries', async () => {
		const { loader } = fakeEdgePort({ etc: {} });
		_setEdgePortLoader(loader);
		const session = await connect(creds);
		expect(await session.exec('uname -a')).toEqual({
			stdout: 'ran uname -a',
			stderr: '',
			code: 0
		});
		await session.close();
	});

	it('opens one ssh connection for the session rather than one per operation', async () => {
		const fake = fakeEdgePort({ a: { 'one.txt': 'x', 'two.txt': 'y' } });
		_setEdgePortLoader(fake.loader);
		const session = await connect(creds);
		await session.readFile('/a/one.txt');
		await session.readFile('/a/two.txt');
		await session.exec('uname -a');
		await session.close();
		expect(fake.connects()).toBe(1);
	});
});

describe('readRemoteTree', () => {
	async function sessionFor(tree: FakeTree): Promise<RemoteSession> {
		const { loader } = fakeEdgePort(tree);
		_setEdgePortLoader(loader);
		return connect(creds);
	}

	it('walks a tree into module paths relative to the root', async () => {
		const session = await sessionFor({
			var: { www: { 'index.php': '<?php', sites: { 'settings.php': 'db' } } }
		});
		const tree = await readRemoteTree(session, '/var/www');
		expect([...tree.keys()].sort()).toEqual(['index.php', 'sites/settings.php']);
		expect(toUtf8(tree.get('index.php') as Uint8Array)).toBe('<?php');
		await session.close();
	});

	it('keeps only what the filter accepts', async () => {
		const session = await sessionFor({ srv: { 'a.php': '1', 'b.log': '2' } });
		const tree = await readRemoteTree(session, '/srv', { filter: (p) => p.endsWith('.php') });
		expect([...tree.keys()]).toEqual(['a.php']);
		await session.close();
	});

	it('refuses past its ceiling rather than copying a disk', async () => {
		const session = await sessionFor({ srv: { a: '1', b: '2', c: '3' } });
		await expect(readRemoteTree(session, '/srv', { maxFiles: 2 })).rejects.toThrow(
			/more than 2 files/
		);
		await session.close();
	});

	it('stops descending at the depth it was given', async () => {
		const session = await sessionFor({ srv: { deep: { deeper: { 'x.txt': '1' } } } });
		const tree = await readRemoteTree(session, '/srv', { maxDepth: 0 });
		expect(tree.size).toBe(0);
		await session.close();
	});
});

describe('fromRemote', () => {
	it('connects, reads and closes, handing back the key it saw', async () => {
		const { loader } = fakeEdgePort({ opt: { 'app.js': 'code' } });
		_setEdgePortLoader(loader);
		const { modules, hostKey } = await fromRemote(creds, '/opt');
		expect([...modules.keys()]).toEqual(['app.js']);
		expect(hostKey?.type).toBe('ssh-ed25519');
	});
});
