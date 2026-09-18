/**
 * SSH and SFTP, over edgeport.
 *
 * **Everything here imports edgeport lazily and nothing else in the package imports this file.**
 * edgeport is built on `cloudflare:sockets`, which exists only on the Workers runtime, so a static
 * import at the top of a module the root export reaches would make the whole package fail to load
 * under plain node. `@earth-app/smoke` names the failure exactly: lazy "so the test barrel never
 * pulls cloudflare:sockets", and a barrel that pulls it breaks every file in the run rather than the
 * one that wanted it.
 *
 * The rest of the shape is `MyLoRA`'s, which reached it first: pin the host key, map errors to named
 * diagnoses, and reuse one session for everything rather than opening a connection per operation.
 */

import { AuthError, TransportError, UsageError } from './client/errors.js';
import { normalisePath, type ModuleSet } from './source.js';

export interface RemoteCredentials {
	hostname: string;
	port?: number;
	username: string;
	password?: string;
	privateKey?: { pem: string; passphrase?: string };
	/**
	 * The host key fingerprint this connection expects.
	 *
	 * When set, a different key is refused. When unset, the key is captured and returned so the
	 * caller can pin it next time. Accepting any key forever is the one thing this must not do
	 * quietly.
	 */
	expectFingerprint?: string | null;
}

export interface HostKey {
	type: string;
	fingerprint: string;
}

export interface RemoteSession {
	exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
	readFile(path: string): Promise<Uint8Array>;
	readDir(path: string): Promise<string[]>;
	close(): Promise<void>;
	/** what the host presented, so a first connection can be pinned afterwards */
	hostKey: HostKey | null;
}

/** the edgeport surface this file uses, named so the lazy import has a type */
interface EdgePort {
	ssh: {
		connect(options: Record<string, unknown>): Promise<SshSession>;
	};
	sftp: {
		connect(options: Record<string, unknown>): Promise<SftpSession>;
	};
}

interface SshSession {
	exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
	close(): Promise<void>;
}

interface SftpSession {
	readFile(path: string): Promise<Uint8Array>;
	readdir(path: string): Promise<{ filename: string }[]>;
	close?(): Promise<void>;
}

/** overridable so the unit lane drives this without a socket */
let loader: () => Promise<EdgePort> = async () => {
	const [ssh, sftp] = await Promise.all([import('edgeport/ssh'), import('edgeport/sftp')]);
	return { ssh, sftp } as unknown as EdgePort;
};

/** @internal swaps the edgeport loader, so the session logic is testable over a stand-in */
export function _setEdgePortLoader(next: () => Promise<EdgePort>): void {
	loader = next;
}

async function fingerprintOf(key: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', key as BufferSource);
	let binary = '';
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return `SHA256:${btoa(binary).replace(/=+$/, '')}`;
}

/**
 * Turns an edgeport failure into something a caller can act on.
 *
 * Relaying the raw message makes every failure look the same to a UI, and "connection refused",
 * "host key changed" and "permission denied on that path" want three different answers.
 */
export function diagnose(error: unknown, hostname: string): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (/host key|fingerprint/i.test(message)) {
		return new AuthError(
			`${hostname} presented a different host key than the one pinned, which is what a machine-in-the-middle looks like`,
			{ cause: error }
		);
	}
	if (/auth|permission denied|publickey|password/i.test(message)) {
		return new AuthError(`${hostname} refused the credential`, { cause: error });
	}
	if (/refused|unreachable|timed? ?out|econn|enotfound|dns/i.test(message)) {
		return new TransportError(`${hostname} could not be reached`, { cause: error });
	}
	return new TransportError(`${hostname}: ${message}`, { cause: error });
}

/**
 * Opens one session and keeps it.
 *
 * MyLoRA records why this is one connection rather than several: edgeport 1.0.2 fixed the
 * channel-reuse bug that previously forced a connection per operation, so one handshake now carries
 * both the sftp session and any exec. One handshake is also the difference between a polite tool and
 * one that hammers a box being migrated.
 */
export async function connect(creds: RemoteCredentials): Promise<RemoteSession> {
	if (creds.password === undefined && creds.privateKey === undefined) {
		throw new UsageError(
			`no credential for ${creds.hostname}: pass a password or a private key`
		);
	}

	const captured: { value: HostKey | null } = { value: null };
	const edge = await loader();

	let ssh: SshSession;
	let sftp: SftpSession;
	try {
		ssh = await edge.ssh.connect({
			hostname: creds.hostname,
			port: creds.port ?? 22,
			username: creds.username,
			password: creds.password,
			privateKey: creds.privateKey,
			hostKeys: {
				async verify(type: string, key: Uint8Array): Promise<boolean> {
					const fingerprint = await fingerprintOf(key);
					captured.value = { type, fingerprint };
					// pin when we already know it; a change is refused rather than logged
					if (creds.expectFingerprint !== undefined && creds.expectFingerprint !== null) {
						return creds.expectFingerprint === fingerprint;
					}
					return true;
				}
			}
		});
		sftp = await edge.sftp.connect({ session: ssh });
	} catch (error) {
		throw diagnose(error, creds.hostname);
	}

	return {
		hostKey: captured.value,
		async exec(command) {
			try {
				return await ssh.exec(command);
			} catch (error) {
				throw diagnose(error, creds.hostname);
			}
		},
		async readFile(path) {
			try {
				return await sftp.readFile(path);
			} catch (error) {
				throw diagnose(error, creds.hostname);
			}
		},
		async readDir(path) {
			try {
				return (await sftp.readdir(path)).map((e) => e.filename);
			} catch (error) {
				throw diagnose(error, creds.hostname);
			}
		},
		async close() {
			await sftp.close?.();
			await ssh.close();
		}
	};
}

export interface RemoteTreeOptions {
	/** keep only paths the predicate accepts, relative to the root */
	filter?: (path: string) => boolean;
	/** stop after this many files, so a mistaken root does not read a whole disk */
	maxFiles?: number;
	/** how deep to walk */
	maxDepth?: number;
}

/**
 * Reads a directory on a remote host into a {@link ModuleSet}.
 *
 * Bounded by construction: a wrong root on a production box should cost one refusal rather than an
 * afternoon of transfer.
 */
export async function readRemoteTree(
	session: RemoteSession,
	root: string,
	options: RemoteTreeOptions = {}
): Promise<ModuleSet> {
	const maxFiles = options.maxFiles ?? 5_000;
	const maxDepth = options.maxDepth ?? 16;
	const out: ModuleSet = new Map();
	const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];

	while (queue.length > 0) {
		const next = queue.shift();
		if (next === undefined) break;
		if (next.depth > maxDepth) continue;

		const names = await session.readDir(next.path);
		for (const name of names) {
			if (name === '.' || name === '..') continue;
			const full = `${next.path.replace(/\/+$/, '')}/${name}`;
			const relative = normalisePath(full.slice(root.replace(/\/+$/, '').length + 1));
			if (options.filter !== undefined && !options.filter(relative)) continue;
			try {
				out.set(relative, await session.readFile(full));
			} catch {
				// a directory answers readFile with an error on every server this targets, so the
				// cheap way to tell them apart is to try the file read and walk what refuses
				queue.push({ path: full, depth: next.depth + 1 });
				continue;
			}
			if (out.size >= maxFiles) {
				throw new UsageError(
					`${root} holds more than ${maxFiles} files; narrow the root or raise maxFiles rather than copying a disk`
				);
			}
		}
	}
	return out;
}

/** One-shot: connect, read a tree, close. For a caller that wants the files and nothing else. */
export async function fromRemote(
	creds: RemoteCredentials,
	root: string,
	options: RemoteTreeOptions = {}
): Promise<{ modules: ModuleSet; hostKey: HostKey | null }> {
	const session = await connect(creds);
	try {
		return { modules: await readRemoteTree(session, root, options), hostKey: session.hostKey };
	} finally {
		await session.close();
	}
}
