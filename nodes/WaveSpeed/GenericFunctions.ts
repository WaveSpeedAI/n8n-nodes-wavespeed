import { platform } from 'node:os';

import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import { version as PACKAGE_VERSION } from '../../package.json';

export const BASE_URL = 'https://api.wavespeed.ai';
export const CLIENT_NAME = 'n8n-nodes-wavespeed';
export const CREDENTIAL_NAME = 'wavespeedApi';

/** Default wait deadline (10 minutes), used whenever the caller asks for <= 0. */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** Default gap between result polls. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
/**
 * Consecutive transient failures tolerated per poll, mirroring the Python SDK's
 * `max_connection_retries` (wavespeed/config.py). A paid task must not die
 * because one GET was unlucky.
 */
export const MAX_POLL_RETRIES = 5;
/** Base backoff between poll retries; actual delay is base * attempt. */
export const POLL_RETRY_BASE_MS = 1_000;
/** Transient HTTP statuses worth retrying, matching the Python SDK. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Normalised OS label, matching the other WaveSpeed clients. */
const CLIENT_OS = platform() === 'win32' ? 'windows' : platform();

/** Marker carrying the HTTP/envelope status of a failed request across the throw. */
const STATUS_CODE_PROPERTY = 'waveSpeedStatusCode';

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

/** Pull an HTTP status out of whatever shape the transport threw. */
function extractStatusCode(error: unknown): number | undefined {
	const candidate = error as
		| {
				statusCode?: unknown;
				status?: unknown;
				httpCode?: unknown;
				response?: { statusCode?: unknown; status?: unknown };
				cause?: { statusCode?: unknown; status?: unknown };
		  }
		| undefined;
	if (candidate === undefined || candidate === null) return undefined;
	const values = [
		candidate.statusCode,
		candidate.status,
		candidate.httpCode,
		candidate.response?.statusCode,
		candidate.response?.status,
		candidate.cause?.statusCode,
		candidate.cause?.status,
	];
	for (const value of values) {
		const numeric = typeof value === 'string' ? Number(value) : value;
		if (typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 100 && numeric < 600) {
			return numeric;
		}
	}
	return undefined;
}

function tagStatusCode<T>(error: T, statusCode: number | undefined): T {
	(error as unknown as IDataObject)[STATUS_CODE_PROPERTY] = statusCode;
	return error;
}

/**
 * Transient failures (no status at all = network/DNS/socket, plus 429 and 5xx)
 * are worth another poll. Client errors (4xx) are permanent - fail fast.
 */
export function isRetryableError(error: unknown): boolean {
	const tagged = (error as IDataObject | undefined)?.[STATUS_CODE_PROPERTY];
	const statusCode = typeof tagged === 'number' ? tagged : extractStatusCode(error);
	if (statusCode === undefined) return true;
	return RETRYABLE_STATUS_CODES.has(statusCode);
}

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
			'X-Client-Version': PACKAGE_VERSION,
			'X-Client-OS': CLIENT_OS,
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
		throw tagStatusCode(
			new NodeApiError(this.getNode(), error as JsonObject),
			extractStatusCode(error),
		);
	}

	const envelope = response as { code?: number; message?: string; data?: IDataObject };
	if (envelope.code !== undefined && envelope.code !== 200) {
		throw tagStatusCode(
			new NodeApiError(this.getNode(), envelope as JsonObject, {
				message: envelope.message ?? `WaveSpeed API returned code ${envelope.code}`,
			}),
			envelope.code,
		);
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
	const prediction = data as unknown as WaveSpeedPrediction;
	if (typeof prediction?.id !== 'string' || prediction.id === '') {
		throw new NodeOperationError(
			this.getNode(),
			`WaveSpeed did not return a task ID for model "${model}": ${JSON.stringify(data)}`,
		);
	}
	return prediction;
}

/**
 * Fetch the current state of a prediction, retrying transient failures so a
 * single unlucky GET cannot kill a paid task. 4xx client errors fail fast.
 */
export async function getPrediction(
	this: WaveSpeedContext,
	predictionId: string,
	options: { maxRetries?: number; retryBaseMs?: number } = {},
): Promise<WaveSpeedPrediction> {
	const maxRetries = options.maxRetries ?? MAX_POLL_RETRIES;
	const retryBaseMs = options.retryBaseMs ?? POLL_RETRY_BASE_MS;

	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const data = await waveSpeedApiRequest.call(
				this,
				'GET',
				`/api/v3/predictions/${predictionId}/result`,
			);
			return data as unknown as WaveSpeedPrediction;
		} catch (error) {
			if (!isRetryableError(error)) {
				throw error;
			}
			lastError = error;
			if (attempt < maxRetries) {
				await sleep(retryBaseMs * (attempt + 1));
			}
		}
	}

	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new NodeOperationError(
		this.getNode(),
		`WaveSpeed result poll failed after ${maxRetries + 1} attempts (task ID: ${predictionId}): ${reason}`,
	);
}

/**
 * Poll a prediction until it reaches a terminal status. Terminal statuses are
 * `completed` (returned), and `failed` / `cancelled` / `timeout` (thrown).
 * Throws when `timeoutMs` elapses first; the task keeps running server-side.
 * Every error leaving this function names the task ID.
 */
export async function waitForPrediction(
	this: WaveSpeedContext,
	predictionId: string,
	options: {
		intervalMs?: number;
		timeoutMs?: number;
		maxRetries?: number;
		retryBaseMs?: number;
	} = {},
): Promise<WaveSpeedPrediction> {
	const requestedInterval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	// A zero/negative interval would busy-loop the API; a zero/negative timeout
	// used to mean "wait forever", which strands executions.
	const intervalMs =
		Number.isFinite(requestedInterval) && requestedInterval >= 1
			? requestedInterval
			: DEFAULT_POLL_INTERVAL_MS;
	const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeoutMs =
		Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : DEFAULT_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;

	try {
		for (;;) {
			const prediction = await getPrediction.call(this, predictionId, {
				maxRetries: options.maxRetries,
				retryBaseMs: options.retryBaseMs,
			});
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
			if (Date.now() > deadline) {
				throw new NodeOperationError(
					this.getNode(),
					`WaveSpeed prediction is still "${prediction.status}" after the configured timeout (task ID: ${predictionId}). The task keeps running server-side.`,
				);
			}
			await sleep(intervalMs);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes(`(task ID: ${predictionId})`)) {
			throw error;
		}
		throw new NodeOperationError(
			this.getNode(),
			`${message} (task ID: ${predictionId})`,
			{ description: `WaveSpeed task ${predictionId} may still be running server-side.` },
		);
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
