import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	parseJsonParameter,
	submitPrediction,
	waitForPrediction,
	type WaveSpeedPrediction,
} from './GenericFunctions';

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
						displayName: 'Seed',
						name: 'seed',
						type: 'number',
						default: -1,
						description: 'Random seed for reproducible results. Use -1 for a random seed.',
					},
					{
						displayName: 'Size',
						name: 'size',
						type: 'string',
						default: '',
						placeholder: 'e.g. 2048*2048',
						description: 'Output resolution as width*height, if the model supports it',
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
				placeholder: 'e.g. wavespeed-ai/flux-dev',
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
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const model = this.getNodeParameter('model', i) as string;
				let input: IDataObject = {};

				if (operation === 'generateImage') {
					const options = this.getNodeParameter('imageOptions', i, {}) as IDataObject;
					input = parseJsonParameter(options.additionalInputs, 'Additional Inputs (JSON)');
					input.prompt = this.getNodeParameter('prompt', i) as string;
					if (options.size !== undefined && options.size !== '') {
						input.size = options.size;
					}
					if (options.seed !== undefined && options.seed !== -1) {
						input.seed = options.seed;
					}
				} else if (operation === 'generateVideo') {
					const options = this.getNodeParameter('videoOptions', i, {}) as IDataObject;
					input = parseJsonParameter(options.additionalInputs, 'Additional Inputs (JSON)');
					input.prompt = this.getNodeParameter('prompt', i) as string;
					if (options.duration !== undefined) {
						input.duration = options.duration;
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

				const submitted = await submitPrediction.call(this, model, input);
				const prediction: WaveSpeedPrediction = await waitForPrediction.call(this, submitted.id, {
					intervalMs: (options.pollInterval ?? 2) * 1000,
					timeoutMs: (options.timeout ?? 600) * 1000,
				});

				const urls = (prediction.outputs ?? []).filter(
					(output): output is string => typeof output === 'string',
				);

				const json: IDataObject = {
					urls,
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
						})) as { body: Buffer; headers: Record<string, string> };
						const fileName = new URL(url).pathname.split('/').pop() || `output-${urlIndex}`;
						const binaryKey = urlIndex === 0 ? 'data' : `data_${urlIndex}`;
						executionData.binary[binaryKey] = await this.helpers.prepareBinaryData(
							response.body,
							fileName,
							response.headers['content-type'],
						);
					}
				}

				returnData.push(executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
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
