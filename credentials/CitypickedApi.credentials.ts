import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CitypickedApi implements ICredentialType {
	name = 'citypickedApi';

	displayName = 'Citypicked API';

	icon: Icon = { light: 'file:../icons/citypicked.svg', dark: 'file:../icons/citypicked.dark.svg' };

	documentationUrl = 'https://www.npmjs.com/package/n8n-nodes-citypicked#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Make a key in Citypicked under Settings > API. To send review requests, give the key the "send" permission.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.citypicked.com/v1',
			description: 'Leave as it is',
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
			baseURL: '={{$credentials.baseUrl}}',
			url: '/me',
		},
	};
}
