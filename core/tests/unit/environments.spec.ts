import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/client/errors.js';
import {
	environmentName,
	forkDurableObjects,
	planFork,
	planPromotion
} from '../../src/environments.js';
import { fromFiles } from '../../src/source.js';
import type { UploadMetadata } from '../../src/worker/upload.js';

const modules = fromFiles({ 'index.js': 'export default {};' });

const withDo: UploadMetadata = {
	exports: { Room: { type: 'durable-object', storage: 'sqlite' } },
	bindings: [{ type: 'durable_object_namespace', name: 'ROOMS', class_name: 'Room' }]
};

describe('environmentName', () => {
	it('leaves production alone and suffixes everything else', () => {
		expect(environmentName('api', 'production')).toBe('api');
		expect(environmentName('api', 'dev')).toBe('api-dev');
	});
});

describe('forkDurableObjects', () => {
	it('fresh keeps the declarations, so the fork gets its own empty namespaces', () => {
		const { metadata, followUp } = forkDurableObjects('fresh', 'api', withDo);
		expect(metadata.exports?.Room?.state).toBeUndefined();
		expect(followUp).toBeNull();
	});

	it('shared points the binding at the source and stops declaring the class', () => {
		const { metadata } = forkDurableObjects('shared', 'api', withDo);
		expect(metadata.exports).toBeUndefined();
		const binding = metadata.bindings?.[0] as { script_name?: string };
		expect(binding.script_name).toBe('api');
	});

	it('shared leaves an already cross-script binding alone', () => {
		const already: UploadMetadata = {
			bindings: [
				{
					type: 'durable_object_namespace',
					name: 'ROOMS',
					class_name: 'Room',
					script_name: 'somewhere-else'
				}
			],
			exports: { Room: { type: 'durable-object', storage: 'sqlite' } }
		};
		const { metadata } = forkDurableObjects('shared', 'api', already);
		const binding = metadata.bindings?.[0] as { script_name?: string };
		expect(binding.script_name).toBe('somewhere-else');
	});

	it('transfer declares the target as expecting and names the source', () => {
		const { metadata, followUp } = forkDurableObjects('transfer', 'api', withDo);
		expect(metadata.exports?.Room?.state).toBe('expecting-transfer');
		expect(metadata.exports?.Room?.transfer_from).toBe('api');
		expect(followUp?.script).toBe('api');
		expect(followUp?.exports.Room?.state).toBe('transferred');
	});

	it('does nothing at all when the Worker has no durable objects', () => {
		const plain: UploadMetadata = { bindings: [] };
		expect(forkDurableObjects('shared', 'api', plain).metadata).toEqual(plain);
	});
});

describe('planFork', () => {
	it('defaults to fresh namespaces', () => {
		const plan = planFork({ source: 'api', target: 'api-dev', modules, metadata: withDo });
		expect(plan.durableObjects).toBe('fresh');
	});

	it('refuses a transfer that was not confirmed, because it destroys the source copy', () => {
		expect(() =>
			planFork({
				source: 'api',
				target: 'api-dev',
				modules,
				metadata: withDo,
				durableObjects: 'transfer'
			})
		).toThrow(/confirmTransfer/);
	});

	it('performs a confirmed transfer and names the second deploy the caller still owes', () => {
		const plan = planFork({
			source: 'api',
			target: 'api-dev',
			modules,
			metadata: withDo,
			durableObjects: 'transfer',
			confirmTransfer: true
		});
		expect(plan.sourceFollowUp?.script).toBe('api');
		expect(plan.sourceFollowUp?.exports.Room?.transferred_to).toBe('api-dev');
	});

	it('refuses to fork a worker onto itself', () => {
		expect(() => planFork({ source: 'api', target: 'api', modules })).toThrow(UsageError);
	});

	it('names the secrets the fork will not have, because the API never returned them', () => {
		const plan = planFork(
			{ source: 'api', target: 'api-dev', modules, secrets: { KEPT: 'value' } },
			['KEPT', 'LOST']
		);
		expect(plan.secretsNotCarried).toEqual(['LOST']);
	});

	it('carries nothing when the caller supplied nothing', () => {
		const plan = planFork({ source: 'api', target: 'api-dev', modules }, ['A', 'B']);
		expect(plan.secretsNotCarried).toEqual(['A', 'B']);
	});

	it('builds an upload the target can receive', () => {
		const plan = planFork({ source: 'api', target: 'api-dev', modules });
		expect(plan.upload.metadata.main_module).toBe('index.js');
	});
});

describe('planPromotion', () => {
	it('keeps durable objects fresh, so promoting code never moves the target data', () => {
		const plan = planPromotion({
			from: 'api-dev',
			to: 'api',
			plane: { kind: 'cloudflare' } as never,
			modules,
			metadata: withDo
		});
		expect(plan.durableObjects).toBe('fresh');
		expect(plan.sourceFollowUp).toBeNull();
	});
});
