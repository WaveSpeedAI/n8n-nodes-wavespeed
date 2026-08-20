import type { IDataObject } from 'n8n-workflow';

import {
	getPrediction,
	parseJsonParameter,
	submitPrediction,
	waitForPrediction,
	waveSpeedApiRequest,
} from '../nodes/WaveSpeed/GenericFunctions';

// Minimal stand-in for the parts of IExecuteFunctions the helpers touch.
function makeContext(responses: Array<IDataObject | Error>) {
	const calls: Array<{ credential: string; options: IDataObject }> = [];
	let callIndex = 0;
	const context = {
		getNode: () => ({ name: 'WaveSpeed', type: 'waveSpeed', typeVersion: 1 }),
		helpers: {
			httpRequestWithAuthentication: async function (credential: string, options: IDataObject) {
				calls.push({ credential, options });
				const response = responses[Math.min(callIndex, responses.length - 1)];
				callIndex++;
				if (response instanceof Error) throw response;
				return response;
			},
		},
	};
	return { context: context as never, calls };
}

const envelope = (data: IDataObject): IDataObject => ({ code: 200, message: 'success', data });

describe('waveSpeedApiRequest', () => {
	it('sends the request with the WaveSpeed credential and attribution header', async () => {
		const { context, calls } = makeContext([envelope({ ok: true })]);
		const result = await waveSpeedApiRequest.call(context, 'GET', '/api/v3/balance');

		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(1);
		expect(calls[0].credential).toBe('wavespeedApi');
		expect(calls[0].options.url).toBe('https://api.wavespeed.ai/api/v3/balance');
		expect((calls[0].options.headers as IDataObject)['X-Client-Name']).toBe(
			'n8n-nodes-wavespeed',
		);
		expect((calls[0].options.headers as IDataObject)['X-Client-Version']).toBe(
			require('../package.json').version,
		);
		expect((calls[0].options.headers as IDataObject)['X-Client-OS']).toBe(
			process.platform === 'win32' ? 'windows' : process.platform,
		);
	});

	it('throws with the platform message when the envelope code is not 200', async () => {
		const { context } = makeContext([{ code: 403, message: 'insufficient role' }]);
		await expect(waveSpeedApiRequest.call(context, 'GET', '/api/v3/balance')).rejects.toThrow(
			'insufficient role',
		);
	});

	it('wraps transport errors as node errors', async () => {
		const { context } = makeContext([Object.assign(new Error('boom'), { message: 'boom' })]);
		await expect(waveSpeedApiRequest.call(context, 'GET', '/api/v3/balance')).rejects.toThrow();
	});
});

describe('submitPrediction', () => {
	it('POSTs the input to /api/v3/{model} and returns the prediction', async () => {
		const { context, calls } = makeContext([
			envelope({ id: 'task-1', status: 'created' }),
		]);
		const prediction = await submitPrediction.call(context, 'bytedance/seedream-v5.0-pro', {
			prompt: 'a lighthouse at dawn',
		});

		expect(prediction.id).toBe('task-1');
		expect(calls[0].options.method).toBe('POST');
		expect(calls[0].options.url).toBe(
			'https://api.wavespeed.ai/api/v3/bytedance/seedream-v5.0-pro',
		);
		expect(calls[0].options.body).toEqual({ prompt: 'a lighthouse at dawn' });
	});

	it('throws instead of returning an id-less prediction', async () => {
		const { context } = makeContext([envelope({ status: 'created' })]);
		await expect(
			submitPrediction.call(context, 'bytedance/seedream-v5.0-pro', { prompt: 'x' }),
		).rejects.toThrow('did not return a task ID');
	});
});

describe('getPrediction', () => {
	it('GETs /api/v3/predictions/{id}/result', async () => {
		const { context, calls } = makeContext([envelope({ id: 'task-1', status: 'processing' })]);
		const prediction = await getPrediction.call(context, 'task-1');

		expect(prediction.status).toBe('processing');
		expect(calls[0].options.method).toBe('GET');
		expect(calls[0].options.url).toBe(
			'https://api.wavespeed.ai/api/v3/predictions/task-1/result',
		);
	});

	it('retries transient failures before succeeding', async () => {
		const { context, calls } = makeContext([
			Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
			Object.assign(new Error('HTTP 502'), { statusCode: 502 }),
			envelope({ id: 'task-1', status: 'completed' }),
		]);
		const prediction = await getPrediction.call(context, 'task-1', { retryBaseMs: 1 });

		expect(prediction.status).toBe('completed');
		expect(calls).toHaveLength(3);
	});

	it('does not retry 4xx client errors', async () => {
		const { context, calls } = makeContext([
			Object.assign(new Error('HTTP 404'), { statusCode: 404 }),
		]);
		await expect(getPrediction.call(context, 'task-1', { retryBaseMs: 1 })).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});

	it('names the task when the retry budget is exhausted', async () => {
		const { context, calls } = makeContext([
			Object.assign(new Error('HTTP 500'), { statusCode: 500 }),
		]);
		await expect(
			getPrediction.call(context, 'task-1', { retryBaseMs: 1, maxRetries: 2 }),
		).rejects.toThrow('poll failed after 3 attempts (task ID: task-1)');
		expect(calls).toHaveLength(3);
	});
});

describe('waitForPrediction', () => {
	it('polls until the prediction completes', async () => {
		const { context, calls } = makeContext([
			envelope({ id: 'task-1', status: 'created' }),
			envelope({ id: 'task-1', status: 'processing' }),
			envelope({
				id: 'task-1',
				status: 'completed',
				outputs: ['https://cdn.wavespeed.ai/out.png'],
			}),
		]);
		const prediction = await waitForPrediction.call(context, 'task-1', { intervalMs: 1 });

		expect(prediction.status).toBe('completed');
		expect(prediction.outputs).toEqual(['https://cdn.wavespeed.ai/out.png']);
		expect(calls).toHaveLength(3);
	});

	it.each(['failed', 'cancelled', 'timeout'])('throws when the prediction is %s', async (status) => {
		const { context } = makeContext([envelope({ id: 'task-1', status, error: 'NSFW content' })]);
		await expect(
			waitForPrediction.call(context, 'task-1', { intervalMs: 1 }),
		).rejects.toThrow(`WaveSpeed prediction ${status}: NSFW content`);
	});

	it('throws when the wait deadline elapses while the task is still running', async () => {
		const { context } = makeContext([envelope({ id: 'task-1', status: 'processing' })]);
		await expect(
			waitForPrediction.call(context, 'task-1', { intervalMs: 1, timeoutMs: 5 }),
		).rejects.toThrow(/still "processing"/);
	});

	it('names the task in errors that are not terminal statuses', async () => {
		const { context } = makeContext([
			Object.assign(new Error('HTTP 401'), { statusCode: 401, message: 'unauthorized' }),
		]);
		await expect(
			waitForPrediction.call(context, 'task-1', { intervalMs: 1, retryBaseMs: 1 }),
		).rejects.toThrow('(task ID: task-1)');
	});
});

describe('parseJsonParameter', () => {
	it('parses a JSON object string', () => {
		expect(parseJsonParameter('{"size":"1024*1024"}', 'x')).toEqual({ size: '1024*1024' });
	});

	it('passes through objects and treats empty values as {}', () => {
		expect(parseJsonParameter({ a: 1 }, 'x')).toEqual({ a: 1 });
		expect(parseJsonParameter('', 'x')).toEqual({});
		expect(parseJsonParameter(undefined, 'x')).toEqual({});
	});

	it('rejects invalid JSON and non-object JSON', () => {
		expect(() => parseJsonParameter('{oops', 'Inputs (JSON)')).toThrow('valid JSON');
		expect(() => parseJsonParameter('[1,2]', 'Inputs (JSON)')).toThrow('JSON object');
	});
});
