import type { IDataObject } from 'n8n-workflow';

// The node sleeps between polls; keep a virtual clock so timeout/poll-interval
// clamping is observable without real waiting.
let virtualNow = 1_700_000_000_000;
const sleepMock = jest.fn(async (ms: number) => {
	virtualNow += ms;
});

jest.mock('n8n-workflow', () => {
	const actual = jest.requireActual('n8n-workflow');
	return { ...actual, sleep: (ms: number) => sleepMock(ms) };
});

import { WaveSpeed } from '../nodes/WaveSpeed/WaveSpeed.node';

const envelope = (data: IDataObject): IDataObject => ({ code: 200, message: 'success', data });

interface ContextOptions {
	items?: number;
	params?: Record<string, unknown>;
	apiResponses: Array<IDataObject | Error> | ((options: IDataObject) => IDataObject | Error);
	continueOnFail?: boolean;
	downloads?: Record<string, { body: Buffer; headers: Record<string, string> }>;
}

function makeExecuteContext(options: ContextOptions) {
	const apiCalls: IDataObject[] = [];
	const downloadCalls: IDataObject[] = [];
	let callIndex = 0;

	const params: Record<string, unknown> = {
		resource: 'media',
		operation: 'generateImage',
		model: 'bytedance/seedream-v5.0-pro',
		prompt: 'a lighthouse at dawn',
		imageOptions: {},
		videoOptions: {},
		options: {},
		...(options.params ?? {}),
	};

	const context = {
		getInputData: () => Array.from({ length: options.items ?? 1 }, () => ({ json: {} })),
		getNode: () => ({ name: 'WaveSpeed', type: 'waveSpeed', typeVersion: 1 }),
		continueOnFail: () => options.continueOnFail === true,
		getNodeParameter: (name: string, index: number, fallback?: unknown) => {
			const value = params[name];
			if (value === undefined) return fallback;
			return typeof value === 'function' ? (value as (i: number) => unknown)(index) : value;
		},
		helpers: {
			httpRequestWithAuthentication: async function (_credential: string, opts: IDataObject) {
				apiCalls.push(opts);
				const response = Array.isArray(options.apiResponses)
					? options.apiResponses[Math.min(callIndex, options.apiResponses.length - 1)]
					: options.apiResponses(opts);
				callIndex++;
				if (response instanceof Error) throw response;
				return response;
			},
			httpRequest: async function (opts: IDataObject) {
				downloadCalls.push(opts);
				const download = (options.downloads ?? {})[opts.url as string];
				if (download === undefined) throw new Error(`unexpected download: ${String(opts.url)}`);
				return download;
			},
			prepareBinaryData: async (body: Buffer, fileName: string, mimeType?: string) => ({
				fileName,
				mimeType,
				fileSize: body.length,
			}),
		},
	};

	return { context: context as never, apiCalls, downloadCalls };
}

const httpError = (statusCode: number) =>
	Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, message: `HTTP ${statusCode}` });

beforeEach(() => {
	sleepMock.mockClear();
	virtualNow = 1_700_000_000_000;
	jest.spyOn(Date, 'now').mockImplementation(() => virtualNow);
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe('WaveSpeed.execute - polling resilience', () => {
	it('retries a transient poll failure and still returns the completed prediction', async () => {
		const { context, apiCalls } = makeExecuteContext({
			apiResponses: [
				envelope({ id: 'task-1', status: 'created' }),
				httpError(503),
				Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
				envelope({ id: 'task-1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/a.png'] }),
			],
		});

		const result = await WaveSpeed.prototype.execute.call(context);

		expect(result[0][0].json.urls).toEqual(['https://cdn.wavespeed.ai/a.png']);
		expect(result[0][0].json.id).toBe('task-1');
		expect(apiCalls).toHaveLength(4);
	});

	it('fails fast on a 4xx poll error instead of burning retries', async () => {
		const { context, apiCalls } = makeExecuteContext({
			apiResponses: [envelope({ id: 'task-1', status: 'created' }), httpError(404)],
		});

		await expect(WaveSpeed.prototype.execute.call(context)).rejects.toThrow(/task ID: task-1/);
		expect(apiCalls).toHaveLength(2);
	});

	it('gives up after the retry budget and names the task in the error', async () => {
		const { context, apiCalls } = makeExecuteContext({
			apiResponses: [envelope({ id: 'task-1', status: 'created' }), httpError(500)],
		});

		await expect(WaveSpeed.prototype.execute.call(context)).rejects.toThrow(
			/poll failed after 6 attempts \(task ID: task-1\)/,
		);
		// 1 submit + 6 poll attempts (initial + 5 retries)
		expect(apiCalls).toHaveLength(7);
	});

	it('throws when the submit response carries no task ID', async () => {
		const { context, apiCalls } = makeExecuteContext({
			apiResponses: [envelope({ status: 'created' })],
		});

		await expect(WaveSpeed.prototype.execute.call(context)).rejects.toThrow(/did not return a task ID/);
		expect(apiCalls).toHaveLength(1);
		expect(apiCalls.every((call) => !String(call.url).includes('undefined'))).toBe(true);
	});
});

describe('WaveSpeed.execute - clamping', () => {
	it('clamps a zero poll interval to 1s and a zero timeout to the default deadline', async () => {
		const { context } = makeExecuteContext({
			params: { options: { pollInterval: 0, timeout: 0 } },
			apiResponses: [envelope({ id: 'task-1', status: 'processing' })],
		});

		await expect(WaveSpeed.prototype.execute.call(context)).rejects.toThrow(/after the configured timeout/);
		expect(sleepMock).toHaveBeenCalledWith(1000);
		expect(sleepMock.mock.calls.every(([ms]) => ms >= 1000)).toBe(true);
		// 600s default deadline at a 1s interval, not an unbounded wait.
		expect(sleepMock.mock.calls.length).toBeLessThanOrEqual(601);
	});

	it('honours a configured poll interval', async () => {
		const { context } = makeExecuteContext({
			params: { options: { pollInterval: 5, timeout: 30 } },
			apiResponses: [
				envelope({ id: 'task-1', status: 'created' }),
				envelope({ id: 'task-1', status: 'processing' }),
				envelope({ id: 'task-1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/a.png'] }),
			],
		});

		await WaveSpeed.prototype.execute.call(context);
		expect(sleepMock).toHaveBeenCalledWith(5000);
	});
});

describe('WaveSpeed.execute - outputs', () => {
	it('keeps object-valued outputs and extracts their url', async () => {
		const { context } = makeExecuteContext({
			apiResponses: [
				envelope({ id: 'task-1', status: 'created' }),
				envelope({
					id: 'task-1',
					status: 'completed',
					outputs: [
						{ url: 'https://cdn.wavespeed.ai/a.mp4', duration: 5 },
						{ audio: 'no url here' },
						'https://cdn.wavespeed.ai/b.png',
					],
				}),
			],
		});

		const result = await WaveSpeed.prototype.execute.call(context);

		expect(result[0][0].json.urls).toEqual([
			'https://cdn.wavespeed.ai/a.mp4',
			'https://cdn.wavespeed.ai/b.png',
		]);
		expect(result[0][0].json.outputs).toEqual([
			'https://cdn.wavespeed.ai/a.mp4',
			{ audio: 'no url here' },
			'https://cdn.wavespeed.ai/b.png',
		]);
	});

	it('raises when a completed prediction carries no output at all', async () => {
		const { context } = makeExecuteContext({
			apiResponses: [
				envelope({ id: 'task-1', status: 'created' }),
				envelope({ id: 'task-1', status: 'completed', outputs: [] }),
			],
		});

		await expect(WaveSpeed.prototype.execute.call(context)).rejects.toThrow(
			/completed without any output \(task ID: task-1\)/,
		);
	});

	it('sends only real schema fields for the image operation', async () => {
		const { context, apiCalls } = makeExecuteContext({
			params: {
				imageOptions: { resolution: '2k', aspectRatio: '16:9', additionalInputs: '{"output_format":"png"}' },
			},
			apiResponses: [
				envelope({ id: 'task-1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/a.png'] }),
			],
		});

		await WaveSpeed.prototype.execute.call(context);

		expect(apiCalls[0].body).toEqual({
			output_format: 'png',
			prompt: 'a lighthouse at dawn',
			resolution: '2k',
			aspect_ratio: '16:9',
		});
	});
});

describe('WaveSpeed.execute - per-item behaviour', () => {
	it('reads the operation for every item, not just the first', async () => {
		const { context, apiCalls } = makeExecuteContext({
			items: 2,
			params: {
				operation: (i: number) => (i === 0 ? 'generateImage' : 'generateVideo'),
				model: (i: number) =>
					i === 0 ? 'bytedance/seedream-v5.0-pro' : 'bytedance/seedance-2.5/text-to-video',
				videoOptions: { duration: 8 },
			},
			apiResponses: (opts) =>
				opts.method === 'POST'
					? envelope({ id: 'task-1', status: 'created' })
					: envelope({ id: 'task-1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/a.png'] }),
		});

		await WaveSpeed.prototype.execute.call(context);

		const submits = apiCalls.filter((call) => call.method === 'POST');
		expect(submits).toHaveLength(2);
		expect(submits[1].url).toContain('bytedance/seedance-2.5/text-to-video');
		expect(submits[1].body).toEqual({ prompt: 'a lighthouse at dawn', duration: 8 });
	});

	it('emits an error row with the task id and aligned pairedItem when continueOnFail is set', async () => {
		const { context } = makeExecuteContext({
			items: 2,
			continueOnFail: true,
			apiResponses: (opts) =>
				opts.method === 'POST'
					? envelope({ id: 'task-9', status: 'created' })
					: envelope({ id: 'task-9', status: 'failed', error: 'NSFW content' }),
		});

		const result = await WaveSpeed.prototype.execute.call(context);

		expect(result[0]).toHaveLength(2);
		expect(result[0][0].json.error).toMatch(/NSFW content \(task ID: task-9\)/);
		expect(result[0][0].json.id).toBe('task-9');
		expect(result[0][0].pairedItem).toEqual({ item: 0 });
		expect(result[0][1].pairedItem).toEqual({ item: 1 });
	});
});

describe('WaveSpeed.execute - binary download', () => {
	it('strips mime parameters and derives an extension when the URL has none', async () => {
		const { context, downloadCalls } = makeExecuteContext({
			params: { options: { downloadOutput: true } },
			apiResponses: [
				envelope({
					id: 'task-1',
					status: 'completed',
					outputs: ['https://cdn.wavespeed.ai/media/abc123', 'https://cdn.wavespeed.ai/media/clip.mp4'],
				}),
			],
			downloads: {
				'https://cdn.wavespeed.ai/media/abc123': {
					body: Buffer.from('png-bytes'),
					headers: { 'content-type': 'image/png; charset=utf-8' },
				},
				'https://cdn.wavespeed.ai/media/clip.mp4': {
					body: Buffer.from('mp4-bytes'),
					headers: { 'content-type': 'video/mp4' },
				},
			},
		});

		const result = await WaveSpeed.prototype.execute.call(context);
		const binary = result[0][0].binary as Record<string, { fileName: string; mimeType?: string }>;

		expect(binary.data).toEqual(
			expect.objectContaining({ fileName: 'abc123.png', mimeType: 'image/png' }),
		);
		expect(binary.data_1).toEqual(
			expect.objectContaining({ fileName: 'clip.mp4', mimeType: 'video/mp4' }),
		);
		expect(downloadCalls[0].timeout).toBe(120000);
	});
});
