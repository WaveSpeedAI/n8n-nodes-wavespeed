import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_TIMEOUT_MS,
	parseJsonParameter,
	submitPrediction,
	waitForPrediction,
	type WaveSpeedPrediction,
} from './GenericFunctions';

/** Cap on a single output download so a stalled CDN cannot hang the workflow. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Extensions for the media types WaveSpeed models actually return. */
const MIME_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/ogg': 'ogg',
	'application/json': 'json',
	'text/plain': 'txt',
};

/** `image/png; charset=utf-8` is not a MIME type n8n can match on - strip the parameters. */
function normalizeMimeType(contentType: string | undefined): string | undefined {
	if (typeof contentType !== 'string') return undefined;
	const mimeType = contentType.split(';')[0].trim().toLowerCase();
	return mimeType === '' ? undefined : mimeType;
}

function extensionForMimeType(mimeType: string | undefined): string | undefined {
	if (mimeType === undefined) return undefined;
	const known = MIME_EXTENSIONS[mimeType];
	if (known !== undefined) return known;
	const subtype = mimeType.split('/')[1]?.replace(/^x-/, '');
	return subtype !== undefined && /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : undefined;
}

/** Name a downloaded file from its URL, adding an extension from the MIME type when the URL has none. */
function buildFileName(url: string, mimeType: string | undefined, index: number): string {
	let fileName = '';
	try {
		fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
	} catch {
		fileName = '';
	}
	if (fileName === '') {
		fileName = `output-${index}`;
	}
	if (!/\.[a-z0-9]{1,8}$/i.test(fileName)) {
		const extension = extensionForMimeType(mimeType);
		if (extension !== undefined) {
			fileName = `${fileName}.${extension}`;
		}
	}
	return fileName;
}

export class WaveSpeed implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'WaveSpeed',
		name: 'waveSpeed',
		icon: { light: 'file:wavespeed.svg', dark: 'file:wavespeed.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Generate images and videos with AI models hosted on WaveSpeed',
		defaults: {
			name: 'WaveSpeed',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'wavespeedApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Media',
						value: 'media',
					},
				],
				default: 'media',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['media'],
					},
				},
				options: [
					{
						name: 'Generate Image',
						value: 'generateImage',
						description: 'Generate an image from a text prompt',
						action: 'Generate an image',
					},
					{
						name: 'Generate Video',
						value: 'generateVideo',
						description: 'Generate a video from a text prompt',
						action: 'Generate a video',
					},
					{
						name: 'Run Model',
						value: 'runModel',
						description: 'Run any WaveSpeed model with raw JSON inputs',
						action: 'Run a model',
					},
				],
				default: 'generateImage',
			},

			// ----------------------------------
			//         media: generateImage
			// ----------------------------------
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['generateImage'],
					},
				},
				default: 'bytedance/seedream-v5.0-pro',
				description:
					'WaveSpeed model ID to run. Browse all models at https://wavespeed.ai/models.',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				required: true,
				typeOptions: {
					rows: 4,
				},
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['generateImage'],
					},
				},
				default: '',
				description: 'Text prompt describing the image to generate',
			},
			{
				displayName: 'Image Options',
				name: 'imageOptions',
				type: 'collection',
				placeholder: 'Add option',
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['generateImage'],
					},
				},
				default: {},
				options: [
					{
						displayName: 'Additional Inputs (JSON)',
						name: 'additionalInputs',
						type: 'json',
						default: '{}',
						description:
							'Extra model inputs merged into the request body, e.g. {"image": "https://..."}. See the model page on wavespeed.ai for its full schema.',
					},
					{
						displayName: 'Aspect Ratio',
						name: 'aspectRatio',
						type: 'options',
						default: '1:1',
						description: 'Aspect ratio of the generated image',
						options: [
							{ name: '1:1', value: '1:1' },
							{ name: '16:9', value: '16:9' },
							{ name: '2:3', value: '2:3' },
							{ name: '21:9', value: '21:9' },
							{ name: '3:2', value: '3:2' },
							{ name: '3:4', value: '3:4' },
							{ name: '4:3', value: '4:3' },
							{ name: '4:5', value: '4:5' },
							{ name: '5:4', value: '5:4' },
							{ name: '9:16', value: '9:16' },
						],
					},
					{
						displayName: 'Resolution',
						name: 'resolution',
						type: 'options',
						default: '1k',
						description:
							'Output resolution tier used for billing. 1k is the lower-cost tier; 2k is the higher-cost tier.',
						options: [
							{ name: '1.5K', value: '1.5k' },
							{ name: '1K', value: '1k' },
							{ name: '2K', value: '2k' },
						],
					},
				],
			},

			// ----------------------------------
			//         media: generateVideo
			// ----------------------------------
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['generateVideo'],
					},
				},
				default: 'bytedance/seedance-2.5/text-to-video',
				description:
					'WaveSpeed model ID to run. Browse all models at https://wavespeed.ai/models.',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				required: true,
				typeOptions: {
					rows: 4,
				},
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['generateVideo'],
					},
				},
				default: '',
				description: 'Text prompt describing the video to generate',
			},
			{
				displayName: 'Video Options',
				name: 'videoOptions',
				type: 'collection',
				placeholder: 'Add option',
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['generateVideo'],
					},
				},
				default: {},
				options: [
					{
						displayName: 'Additional Inputs (JSON)',
						name: 'additionalInputs',
						type: 'json',
						default: '{}',
						description:
							'Extra model inputs merged into the request body, e.g. {"image": "https://..."}. See the model page on wavespeed.ai for its full schema.',
					},
					{
						displayName: 'Duration (Seconds)',
						name: 'duration',
						type: 'number',
						default: 5,
						description: 'Length of the generated video in seconds, if the model supports it',
					},
				],
			},

			// ----------------------------------
			//         media: runModel
			// ----------------------------------
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['runModel'],
					},
				},
				default: '',
				placeholder: 'e.g. wavespeed-ai/z-image/turbo',
				description:
					'WaveSpeed model ID to run. Browse all models at https://wavespeed.ai/models.',
			},
			{
				displayName: 'Inputs (JSON)',
				name: 'inputs',
				type: 'json',
				required: true,
				displayOptions: {
					show: {
						resource: ['media'],
						operation: ['runModel'],
					},
				},
				default: '{}',
				description:
					'Full request body for the model as a JSON object. See the model page on wavespeed.ai for its schema.',
			},

			// ----------------------------------
			//         shared options
			// ----------------------------------
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				displayOptions: {
					show: {
						resource: ['media'],
					},
				},
				default: {},
				options: [
					{
						displayName: 'Download Output',
						name: 'downloadOutput',
						type: 'boolean',
						default: false,
						description:
							'Whether to download the generated files and attach them as binary data',
					},
					{
						displayName: 'Poll Interval (Seconds)',
						name: 'pollInterval',
						type: 'number',
						typeOptions: {
							minValue: 1,
						},
						default: 2,
						description: 'How often to check whether the prediction has finished',
					},
					{
						displayName: 'Timeout (Seconds)',
						name: 'timeout',
						type: 'number',
						typeOptions: {
							minValue: 1,
						},
						default: 600,
						description:
							'Maximum time to wait for the prediction before the node fails. The task keeps running on WaveSpeed either way.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			let predictionId: string | undefined;
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const model = this.getNodeParameter('model', i) as string;
				let input: IDataObject = {};

				if (operation === 'generateImage') {
					const imageOptions = this.getNodeParameter('imageOptions', i, {}) as IDataObject;
					input = parseJsonParameter(imageOptions.additionalInputs, 'Additional Inputs (JSON)');
					input.prompt = this.getNodeParameter('prompt', i) as string;
					if (imageOptions.resolution !== undefined && imageOptions.resolution !== '') {
						input.resolution = imageOptions.resolution;
					}
					if (imageOptions.aspectRatio !== undefined && imageOptions.aspectRatio !== '') {
						input.aspect_ratio = imageOptions.aspectRatio;
					}
				} else if (operation === 'generateVideo') {
					const videoOptions = this.getNodeParameter('videoOptions', i, {}) as IDataObject;
					input = parseJsonParameter(videoOptions.additionalInputs, 'Additional Inputs (JSON)');
					input.prompt = this.getNodeParameter('prompt', i) as string;
					if (videoOptions.duration !== undefined) {
						input.duration = videoOptions.duration;
					}
				} else if (operation === 'runModel') {
					input = parseJsonParameter(this.getNodeParameter('inputs', i), 'Inputs (JSON)');
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, {
						itemIndex: i,
					});
				}

				const options = this.getNodeParameter('options', i, {}) as {
					downloadOutput?: boolean;
					pollInterval?: number;
					timeout?: number;
				};

				// A zero poll interval would hammer the API; a zero timeout used to
				// mean "wait forever" and could strand an execution.
				const pollIntervalSeconds =
					typeof options.pollInterval === 'number' && Number.isFinite(options.pollInterval)
						? Math.max(1, options.pollInterval)
						: DEFAULT_POLL_INTERVAL_MS / 1000;
				const timeoutSeconds =
					typeof options.timeout === 'number' &&
					Number.isFinite(options.timeout) &&
					options.timeout > 0
						? options.timeout
						: DEFAULT_TIMEOUT_MS / 1000;

				const submitted = await submitPrediction.call(this, model, input);
				predictionId = submitted.id;
				const prediction: WaveSpeedPrediction = await waitForPrediction.call(this, submitted.id, {
					intervalMs: pollIntervalSeconds * 1000,
					timeoutMs: timeoutSeconds * 1000,
				});

				// Object-valued outputs are real (some models return richer records);
				// keep them instead of silently dropping the whole generation.
				const urls: string[] = [];
				const outputs: Array<string | IDataObject> = [];
				for (const output of prediction.outputs ?? []) {
					if (typeof output === 'string') {
						urls.push(output);
						outputs.push(output);
					} else if (output !== null && typeof output === 'object') {
						const url = (output as IDataObject).url;
						if (typeof url === 'string') {
							urls.push(url);
							outputs.push(url);
						} else {
							outputs.push(output);
						}
					}
				}
				if (outputs.length === 0) {
					throw new NodeOperationError(
						this.getNode(),
						`WaveSpeed prediction completed without any output (task ID: ${prediction.id})`,
						{ itemIndex: i },
					);
				}

				const json: IDataObject = {
					urls,
					outputs,
					id: prediction.id,
					model: prediction.model ?? model,
				};
				if (prediction.timings !== undefined) {
					json.timings = prediction.timings;
				} else if (prediction.executionTime !== undefined) {
					json.timings = { executionTime: prediction.executionTime };
				}

				const executionData: INodeExecutionData = {
					json,
					pairedItem: { item: i },
				};

				if (options.downloadOutput === true && urls.length > 0) {
					executionData.binary = {};
					for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
						const url = urls[urlIndex];
						const response = (await this.helpers.httpRequest({
							url,
							method: 'GET',
							encoding: 'arraybuffer',
							returnFullResponse: true,
							timeout: DOWNLOAD_TIMEOUT_MS,
						})) as { body: Buffer; headers: Record<string, string> };
						const mimeType = normalizeMimeType(response.headers?.['content-type']);
						const fileName = buildFileName(url, mimeType, urlIndex);
						const binaryKey = urlIndex === 0 ? 'data' : `data_${urlIndex}`;
						executionData.binary[binaryKey] = await this.helpers.prepareBinaryData(
							response.body,
							fileName,
							mimeType,
						);
					}
				}

				returnData.push(executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					const message = error instanceof Error ? error.message : String(error);
					returnData.push({
						json: {
							error: message,
							...(predictionId !== undefined ? { id: predictionId } : {}),
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
