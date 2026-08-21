# @wavespeed/n8n-nodes-wavespeed

This is an n8n community node for [WaveSpeed AI](https://wavespeed.ai) - generate images and videos with hundreds of hosted AI models (Seedream, Nano Banana, GPT Image, Seedance, Wan, and more) directly from your n8n workflows.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation:

1. In n8n, go to **Settings > Community Nodes**.
2. Select **Install**.
3. Enter `@wavespeed/n8n-nodes-wavespeed` and confirm.

## Credentials

1. Create a WaveSpeed account at [wavespeed.ai](https://wavespeed.ai).
2. Create an API key under **Access Keys** in your dashboard.
3. In n8n, create a new **WaveSpeed API** credential and paste the key.

The credential test calls `GET /api/v3/balance`, so a green check also confirms the key has API access.

## Operations

All operations submit a prediction to `POST https://api.wavespeed.ai/api/v3/{model}` and poll `GET /api/v3/predictions/{id}/result` until it finishes. The output for each item is:

```json
{
	"urls": ["https://..."],
	"outputs": ["https://..."],
	"id": "<prediction id>",
	"model": "<model id>",
	"timings": { "executionTime": 1234 }
}
```

### Generate Image

Generate an image from a text prompt.

- **Model** - WaveSpeed model ID (default `bytedance/seedream-v5.0-pro`).
- **Prompt** - text description of the image.
- **Image Options** - optional `Resolution` (`1k` / `1.5k` / `2k`), `Aspect Ratio`, and `Additional Inputs (JSON)` merged into the request body. Anything else the model accepts (for example `output_format`) goes in Additional Inputs.

### Generate Video

Generate a video from a text prompt.

- **Model** - WaveSpeed model ID (default `bytedance/seedance-2.5/text-to-video`).
- **Prompt** - text description of the video.
- **Video Options** - optional `Duration (Seconds)` and `Additional Inputs (JSON)`.

### Run Model

The power operation: run any of the models on [wavespeed.ai/models](https://wavespeed.ai/models) by passing the model ID and the full request body as JSON. Use this for image-to-image, image-to-video, LoRA, upscaling, lipsync - anything the platform hosts.

### Shared options

- **Download Output** - download the generated files and attach them as n8n binary data (`data`, `data_1`, ...), ready for the next node (upload to S3, send via Slack, etc.).
- **Poll Interval (Seconds)** - how often to check progress (default 2).
- **Timeout (Seconds)** - how long to wait before the node fails (default 600). The prediction keeps running server-side even if the node times out; the error message includes the task ID.

Transient poll failures (network errors, HTTP 429 and 5xx) are retried automatically up to 5 times per poll, so one unlucky request never kills a running generation. Client errors (4xx) fail fast.

### Do not enable "Retry On Fail"

Leave n8n's node-level **Settings > Retry On Fail** switched **off** for generation operations. n8n retries by re-running the whole node, which submits a **new, separately billed** prediction instead of resuming the existing one. The node already retries the parts that are safe to retry (result polling) internally. If you need the task ID of a failed item, enable **Continue On Fail** instead - the error row carries `id` and the message names the task.

## Example workflow

A minimal prompt-to-image workflow you can paste into n8n (**Workflow > Import from Clipboard**):

```json
{
	"nodes": [
		{
			"parameters": {},
			"name": "When clicking \"Execute Workflow\"",
			"type": "n8n-nodes-base.manualTrigger",
			"typeVersion": 1,
			"position": [0, 0]
		},
		{
			"parameters": {
				"operation": "generateImage",
				"model": "bytedance/seedream-v5.0-pro",
				"prompt": "A lighthouse on a cliff at dawn, cinematic lighting",
				"imageOptions": {
					"size": "2048*2048"
				},
				"options": {
					"downloadOutput": true
				}
			},
			"name": "WaveSpeed",
			"type": "@wavespeed/n8n-nodes-wavespeed.waveSpeed",
			"typeVersion": 1,
			"position": [220, 0],
			"credentials": {
				"wavespeedApi": {
					"name": "WaveSpeed API"
				}
			}
		}
	],
	"connections": {
		"When clicking \"Execute Workflow\"": {
			"main": [[{ "node": "WaveSpeed", "type": "main", "index": 0 }]]
		}
	}
}
```

## Compatibility

Requires n8n 1.x and Node.js 20 or newer.

## Resources

- [WaveSpeed model catalog](https://wavespeed.ai/models)
- [WaveSpeed API documentation](https://wavespeed.ai/docs)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## Development

```bash
npm install
npm run build   # tsc + copy icons to dist
npm run lint    # eslint 9 flat config: @n8n/eslint-plugin-community-nodes
                # (n8n Cloud restrictions) + eslint-plugin-n8n-nodes-base
npm test        # jest unit tests for the request/poll logic
```

## License

[MIT](LICENSE)

---

**[WaveSpeed AI](https://wavespeed.ai/)** — AI image & video generation platform.
Try it in the browser: **[Image generator](https://wavespeed.ai/image-generator)** · **[Video generator](https://wavespeed.ai/video-generator)**
