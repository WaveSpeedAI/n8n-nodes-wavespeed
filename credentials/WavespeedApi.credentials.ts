import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class WavespeedApi implements ICredentialType {
	name = 'wavespeedApi';

	displayName = 'WaveSpeed API';

	icon: Icon = { light: 'file:wavespeed.svg', dark: 'file:wavespeed.dark.svg' };

	documentationUrl = 'https://wavespeed.ai/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Your WaveSpeed API key. Create one at https://wavespeed.ai under Access Keys.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.wavespeed.ai',
			url: '/api/v3/balance',
			method: 'GET',
			headers: {
				'X-Client-Name': 'n8n-nodes-wavespeed',
			},
		},
	};
}
