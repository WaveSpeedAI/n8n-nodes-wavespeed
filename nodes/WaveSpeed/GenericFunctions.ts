import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

export const BASE_URL = 'https://api.wavespeed.ai';
export const CLIENT_NAME = 'n8n-nodes-wavespeed';
export const CREDENTIAL_NAME = 'wavespeedApi';

export interface WaveSpeedPrediction {
	id: string;
	model?: string;
	status: string;
	outputs?: Array<string | IDataObject>;
	error?: string;
	timings?: IDataObject;
	executionTime?: number;
	created_at?: string;
}

type WaveSpeedContext = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * Perform an authenticated request against the WaveSpeed v3 API and unwrap the
 * platform's `{ code, message, data }` envelope. Non-200 envelope codes are
 * surfaced as node errors with the platform's message.
 */
export async function waveSpeedApiRequest(
	this: WaveSpeedContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method,
		url: `${BASE_URL}${endpoint}`,
		headers: {
			'Content-Type': 'application/json',
			'X-Client-Name': CLIENT_NAME,
		},
		json: true,
	};
	if (body !== undefined) {
		options.body = body;
	}

	let response: IDataObject;
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as IDataObject;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}

	const envelope = response as { code?: number; message?: string; data?: IDataObject };
	if (envelope.code !== undefined && envelope.code !== 200) {
		throw new NodeApiError(this.getNode(), envelope as JsonObject, {
			message: envelope.message ?? `WaveSpeed API returned code ${envelope.code}`,
		});
	}
	return (envelope.data ?? response) as IDataObject;
}

/**
 * Submit a prediction without waiting for it, so the task ID exists the moment
 * the request returns - a dropped connection mid-generation must never orphan
 * a paid task.
 */
export async function submitPrediction(
	this: WaveSpeedContext,
	model: string,
	input: IDataObject,
): Promise<WaveSpeedPrediction> {
	const data = await waveSpeedApiRequest.call(this, 'POST', `/api/v3/${model}`, input);
	return data as unknown as WaveSpeedPrediction;
}

/** Fetch the current state of a prediction. */
export async function getPrediction(
	this: WaveSpeedContext,
	predictionId: string,
): Promise<WaveSpeedPrediction> {
	const data = await waveSpeedApiRequest.call(
		this,
		'GET',
		`/api/v3/predictions/${predictionId}/result`,
	);
	return data as unknown as WaveSpeedPrediction;
}

/**
 * Poll a prediction until it reaches a terminal status. Terminal statuses are
 * `completed` (returned), and `failed` / `cancelled` / `timeout` (thrown).
 * Throws when `timeoutMs` elapses first; the task keeps running server-side.
 */
export async function waitForPrediction(
	this: WaveSpeedContext,
	predictionId: string,
	options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<WaveSpeedPrediction> {
	const intervalMs = options.intervalMs ?? 2000;
	const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;

	for (;;) {
		const prediction = await getPrediction.call(this, predictionId);
		if (prediction.status === 'completed') {
			return prediction;
		}
		if (
			prediction.status === 'failed' ||
			prediction.status === 'cancelled' ||
			prediction.status === 'timeout'
		) {
			throw new NodeOperationError(
				this.getNode(),
				`WaveSpeed prediction ${prediction.status}${prediction.error ? `: ${prediction.error}` : ''} (task ID: ${predictionId})`,
			);
		}
		if (deadline !== undefined && Date.now() > deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`WaveSpeed prediction is still "${prediction.status}" after the configured timeout (task ID: ${predictionId}). The task keeps running server-side.`,
			);
		}
		await sleep(intervalMs);
	}
}

/** Parse a JSON string parameter, or pass through an already-parsed object. */
export function parseJsonParameter(value: unknown, parameterName: string): IDataObject {
	if (value === undefined || value === null || value === '') {
		return {};
	}
	if (typeof value === 'object') {
		return value as IDataObject;
	}
	let parsed: unknown;
	let invalid = false;
	try {
		parsed = JSON.parse(value as string);
	} catch {
		invalid = true;
	}
	if (invalid) {
		throw new Error(`Parameter "${parameterName}" must contain valid JSON`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Parameter "${parameterName}" must be a JSON object`);
	}
	return parsed as IDataObject;
}
